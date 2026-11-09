#!/usr/bin/env node
/**
 * Friday-rush load test for the POS (zero dependencies: Node >= 20 fetch).
 *
 * LOCAL ONLY: refuses any host that is not localhost / 127.0.0.1 / ::1.
 * Open-loop (Poisson arrivals): offered load does not slow down when the server
 * does, so latency growth and errors show up instead of being hidden by
 * coordinated omission.
 *
 * Models, per location: tills ringing in-store orders (create, pay cash or
 * simulated card), the storefront (shop order, simulated online pay, tracking
 * page polls, some delivery), the kitchen screens (4s poll + bumps), the till
 * open-orders poll (30s), and the dispatch board (5s poll + manual assign).
 *
 * See loadtest/README.md. Usage: node loadtest/run.mjs --help
 */
import { randomUUID } from "node:crypto";
import { execFileSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));

const DEMO_TENANT = "10000000-0000-0000-0000-000000000001";
const DEMO_LOCS = [
  "10000000-0000-0000-0000-000000000101", // downtown (pickup + delivery)
  "10000000-0000-0000-0000-000000000102", // uptown
];
const DEMO_LOC_SLUGS = { [DEMO_LOCS[0]]: "tonys-downtown", [DEMO_LOCS[1]]: "tonys-uptown" };

// ---------------------------------------------------------------- args -----
const opts = {
  base: "http://localhost:3405",
  tenant: DEMO_TENANT,
  tenantSlug: "tonys-pizza",
  locations: 3, // virtual locations; round-robin over the available real ones
  perLocationPeak: 120, // orders/hour at 1x
  factors: "1,3,10,30,100,200",
  stageSec: 30,
  warmupSec: 5,
  lifecycleScale: 0.1, // 1 = real-time kitchen/customer waits; 0.1 = 10x compressed
  tillsPerLocation: 3,
  kdsPerLocation: 2,
  onlineShare: 0.3,
  deliveryShare: 0.15,
  cardShare: 0.5,
  preseed: 0,
  allowDb: "", // supabase host you explicitly allow the server to be using
  pid: "", // optional: pid of `next start` for cpu/rss sampling
  out: join(HERE, "results"),
  label: "run",
  p95Ms: 1000,
  errPct: 1,
};
const argv = process.argv.slice(2);
for (let i = 0; i < argv.length; i++) {
  const a = argv[i];
  if (a === "--help" || a === "-h") {
    console.log(`node loadtest/run.mjs [--base URL] [--factors 1,3,10] [--stage-sec N]
  [--lifecycle-scale 0.1] [--preseed N] [--pid PID] [--label name] [--quick]
Factor 1 = ${opts.locations} locations x ${opts.perLocationPeak} orders/hour. Factor 3 = the "3x busy peak" target.`);
    process.exit(0);
  }
  if (a === "--quick") {
    opts.factors = "1,3";
    opts.stageSec = 8;
    opts.warmupSec = 2;
    continue;
  }
  if (!a.startsWith("--")) continue;
  const key = a.slice(2).replace(/-([a-z])/g, (_, c) => c.toUpperCase());
  const v = argv[++i];
  if (!(key in opts)) {
    console.error(`unknown option ${a}`);
    process.exit(2);
  }
  opts[key] = typeof opts[key] === "number" ? Number(v) : v;
}

const baseUrl = new URL(opts.base);
if (!["localhost", "127.0.0.1", "[::1]", "::1"].includes(baseUrl.hostname)) {
  console.error(`Refusing to load test ${baseUrl.hostname}: local servers only.`);
  process.exit(2);
}

// ------------------------------------------------------------- helpers -----
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const rnd = (a, b) => a + Math.random() * (b - a);
const pick = (arr) => arr[Math.floor(Math.random() * arr.length)];
const expo = (rate) => -Math.log(1 - Math.random()) / rate; // seconds

let stage = null; // current stage record
const all = []; // finished stage records

function newStage(factor) {
  return { factor, samples: new Map(), started: Date.now(), flows: { started: 0, done: 0, failed: 0 }, lagMs: [], res: [] };
}

async function call(label, method, path, body) {
  const st = stage;
  const t0 = performance.now();
  let status = 0;
  let json = null;
  try {
    const res = await fetch(baseUrl.origin + path, {
      method,
      headers: body ? { "content-type": "application/json" } : undefined,
      body: body ? JSON.stringify(body) : undefined,
    });
    status = res.status;
    const text = await res.text();
    try {
      json = JSON.parse(text);
    } catch {
      json = null;
    }
  } catch {
    status = 0; // connection error / reset
  }
  const ms = performance.now() - t0;
  if (st) {
    let s = st.samples.get(label);
    if (!s) st.samples.set(label, (s = { ms: [], ok: 0, err: 0, codes: {} }));
    s.ms.push(ms);
    status >= 200 && status < 400 ? s.ok++ : s.err++;
    s.codes[status] = (s.codes[status] ?? 0) + 1;
  }
  return { status, json, ms };
}

function pct(sorted, p) {
  if (!sorted.length) return 0;
  return sorted[Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length))];
}

// ------------------------------------------------------------ fixtures -----
let menu;
const realLocs = DEMO_LOCS;
const virtLocs = Array.from({ length: opts.locations }, (_, i) => realLocs[i % realLocs.length]);

function cartLines(n) {
  const items = menu.categories.flatMap((c) => c.items);
  const lines = [];
  for (let i = 0; i < n; i++) {
    const it = pick(items);
    lines.push({
      id: randomUUID(),
      item_id: it.id,
      size_id: it.sizes.length ? pick(it.sizes).id : null,
      quantity: 1 + Math.floor(Math.random() * 2),
      modifiers: it.modifierGroups
        .filter((g) => g.min_select >= 1 && g.modifiers.length)
        .map((g) => ({ group_id: g.id, modifier_id: pick(g.modifiers).id, placement: "whole" })),
      notes: null,
      voided: false,
    });
  }
  return lines;
}

// --------------------------------------------------------------- flows -----
async function bumpAll(orderId, count = 3) {
  for (let i = 0; i < count; i++) {
    await sleep(rnd(3000, 8000) * opts.lifecycleScale);
    const r = await call("POST /api/kitchen/orders (bump)", "POST", "/api/kitchen/orders", { id: orderId, action: "bump" });
    if (r.status !== 200) return false;
  }
  return true;
}

async function inStoreFlow(loc) {
  const orderId = randomUUID();
  const r = await call("POST /api/orders (till create)", "POST", "/api/orders", {
    id: orderId,
    tenant_id: opts.tenant,
    location_id: loc,
    items: cartLines(1 + Math.floor(Math.random() * 4)),
  });
  if (r.status !== 201) return false;
  const total = r.json.order.totals.total_cents;
  await sleep(rnd(1000, 6000) * opts.lifecycleScale);
  const card = Math.random() < opts.cardShare;
  const p = await call(
    card ? "POST /api/payments (till card sim)" : "POST /api/payments (till cash)",
    "POST",
    "/api/payments",
    {
      paymentId: randomUUID(),
      orderId,
      tenantId: opts.tenant,
      locationId: loc,
      rail: card ? "stripe_terminal" : "cash",
      amountCents: total,
      currency: "USD",
      ...(card ? {} : { cashTenderedCents: total }),
    },
  );
  if (p.status !== 201) return false;
  return bumpAll(orderId);
}

async function onlineFlow(loc) {
  const orderId = randomUUID();
  const delivery = loc === DEMO_LOCS[0] && Math.random() < opts.deliveryShare;
  const r = await call("POST /api/shop/orders (storefront)", "POST", "/api/shop/orders", {
    id: orderId,
    tenantSlug: opts.tenantSlug,
    locationSlug: DEMO_LOC_SLUGS[loc],
    items: cartLines(1 + Math.floor(Math.random() * 3)),
    fulfillmentType: delivery ? "delivery" : "pickup",
    scheduledFor: "asap",
    customer: { email: `lt-${orderId.slice(0, 8)}@example.com`, name: "Load Test" },
    ...(delivery ? { address: { line1: "1 Test St", city: "Springfield", region: "NY", postal_code: "10001", country: "US" } } : {}),
  });
  if (r.status !== 201) return false;
  await sleep(rnd(2000, 8000) * opts.lifecycleScale);
  const p = await call("POST /api/payments (online sim)", "POST", "/api/payments", {
    paymentId: randomUUID(),
    orderId,
    tenantId: opts.tenant,
    locationId: loc,
    rail: "stripe_online",
    amountCents: 0,
    currency: "USD",
  });
  if (p.status !== 201) return false;
  // Customer sits on the tracking page (polls every 4s) while the kitchen works.
  let polling = true;
  const tracker = (async () => {
    while (polling) {
      await call("GET /api/shop/track (customer poll)", "GET", `/api/shop/track?orderId=${orderId}`);
      await sleep(4000);
    }
  })();
  const ok = await bumpAll(orderId, delivery ? 2 : 3);
  polling = false;
  await tracker;
  return ok;
}

// ------------------------------------------------ steady background load ---
const bg = { stop: false, tasks: [] };

function poller(label, intervalMs, fn) {
  bg.tasks.push(
    (async () => {
      await sleep(rnd(0, intervalMs));
      while (!bg.stop) {
        const t = performance.now();
        await fn(label);
        await sleep(Math.max(0, intervalMs - (performance.now() - t)));
      }
    })(),
  );
}

function startBackground() {
  virtLocs.forEach((loc, li) => {
    for (let k = 0; k < opts.kdsPerLocation; k++)
      poller("GET /api/kitchen/orders (KDS poll 4s)", 4000, (l) =>
        call(l, "GET", `/api/kitchen/orders?tenantId=${opts.tenant}&locationId=${loc}`));
    for (let k = 0; k < opts.tillsPerLocation; k++)
      poller("GET /api/orders/open (till poll 30s)", 30000, (l) =>
        call(l, "GET", `/api/orders/open?tenantId=${opts.tenant}&locationId=${loc}`));
    const assigned = new Set();
    poller("GET /api/delivery/dispatch (board poll 5s)", 5000, async (l) => {
      const r = await call(l, "GET", `/api/delivery/dispatch?tenantId=${opts.tenant}&locationId=${loc}`);
      for (const row of r.json?.deliveries ?? []) {
        const d = row.delivery;
        if (d.status === "pending_assignment" && !assigned.has(d.id)) {
          assigned.add(d.id);
          await call("POST /api/delivery/dispatch (assign)", "POST", "/api/delivery/dispatch", {
            deliveryId: d.id,
            driverName: `Driver ${li}`,
          });
        }
      }
    });
  });
}

// ---------------------------------------------------------- scheduling -----
async function runStage(factor) {
  stage = newStage(factor);
  const st = stage;
  const perSec = (opts.perLocationPeak * opts.locations * factor) / 3600;
  const online = perSec * opts.onlineShare;
  const inStore = perSec - online;
  const end = Date.now() + opts.stageSec * 1000;
  const inflight = new Set();
  const fire = (kind) => {
    const loc = pick(virtLocs);
    st.flows.started++;
    const p = (kind === "online" ? onlineFlow(loc) : inStoreFlow(loc))
      .then((ok) => (ok ? st.flows.done++ : st.flows.failed++))
      .catch(() => st.flows.failed++)
      .finally(() => inflight.delete(p));
    inflight.add(p);
  };
  const arrivals = async (rate, kind) => {
    if (rate <= 0) return;
    let next = performance.now() + expo(rate) * 1000;
    while (Date.now() < end) {
      const wait = next - performance.now();
      if (wait > 0) await sleep(wait);
      else st.lagMs.push(-wait);
      fire(kind);
      next += expo(rate) * 1000;
    }
  };
  const sampler = setInterval(() => {
    if (!opts.pid) return;
    try {
      const [cpu, rss] = execFileSync("ps", ["-o", "%cpu=,rss=", "-p", String(opts.pid)]).toString().trim().split(/\s+/);
      st.res.push({ cpu: Number(cpu), rssMb: Number(rss) / 1024 });
    } catch {
      /* server gone */
    }
  }, 1000);
  await Promise.all([arrivals(inStore, "instore"), arrivals(online, "online")]);
  // let in-flight lifecycles drain, but never wait long (lifecycle is compressed)
  await Promise.race([Promise.allSettled([...inflight]), sleep(60000)]);
  clearInterval(sampler);
  st.ended = Date.now();
  st.offeredPerHour = Math.round(perSec * 3600);
  all.push(st);
  stage = null;
}

function summarize(st) {
  const rows = [];
  let total = 0;
  let errs = 0;
  for (const [label, s] of [...st.samples].sort()) {
    const sorted = [...s.ms].sort((a, b) => a - b);
    total += sorted.length;
    errs += s.err;
    rows.push({
      endpoint: label,
      n: sorted.length,
      p50: pct(sorted, 50),
      p95: pct(sorted, 95),
      p99: pct(sorted, 99),
      max: sorted[sorted.length - 1] ?? 0,
      errPct: (100 * s.err) / Math.max(1, sorted.length),
      codes: s.codes,
    });
  }
  const dur = (st.ended - st.started) / 1000;
  const lag = [...st.lagMs].sort((a, b) => a - b);
  return {
    factor: st.factor,
    offeredOrdersPerHour: st.offeredPerHour,
    durationSec: dur,
    requests: total,
    reqPerSec: total / dur,
    errPct: (100 * errs) / Math.max(1, total),
    flows: st.flows,
    flowFailPct: (100 * st.flows.failed) / Math.max(1, st.flows.started),
    schedLagP95Ms: pct(lag, 95),
    maxCpuPct: Math.max(0, ...st.res.map((r) => r.cpu)),
    maxRssMb: Math.max(0, ...st.res.map((r) => r.rssMb)),
    rows,
  };
}

const f1 = (n) => n.toFixed(1);

async function main() {
  const m = await call("setup menu", "GET", `/api/menu?tenantId=${opts.tenant}&locationId=${realLocs[0]}`);
  if (m.status !== 200) {
    console.error(`Cannot reach ${opts.base} (status ${m.status}). Start it with: npm run loadtest:serve`);
    process.exit(1);
  }
  menu = m.json.menu;
  const PROD_REF = "dnazcilebqietfbrodtd";
  if (m.json.driver !== "mock") {
    const host = opts.allowDb.toLowerCase();
    if (!host || host.includes(PROD_REF)) {
      console.error(
        `Refusing: server driver is "${m.json.driver}" (a real database). Pass --allow-db <supabase-host> naming a local/disposable DB (never the production project).`,
      );
      process.exit(2);
    }
    console.log(`real database allowed by flag: ${opts.allowDb}`);
  }
  console.log(`target ${opts.base}  driver=${m.json.driver}  virtual locations=${opts.locations}`);
  if (m.json.driver === "mock")
    console.log("NOTE: mock driver (in-memory). It says little about Postgres/PostgREST latency; see REPORT.md.");

  if (opts.preseed > 0) {
    console.log(`preseeding ${opts.preseed} completed orders...`);
    stage = null;
    for (let i = 0; i < opts.preseed; i += 20) {
      await Promise.all(
        Array.from({ length: Math.min(20, opts.preseed - i) }, async () => {
          const loc = pick(virtLocs);
          const id = randomUUID();
          const r = await call("seed", "POST", "/api/orders", { id, tenant_id: opts.tenant, location_id: loc, items: cartLines(2) });
          if (r.status === 201) for (let b = 0; b < 3; b++) await call("seed", "POST", "/api/kitchen/orders", { id, action: "bump" });
        }),
      );
    }
  }

  startBackground();
  console.log(`warmup ${opts.warmupSec}s`);
  await sleep(opts.warmupSec * 1000);

  const factors = opts.factors.split(",").map(Number);
  let breakAt = null;
  for (const f of factors) {
    await runStage(f);
    const s = summarize(all[all.length - 1]);
    const till = s.rows.filter((r) => /till|storefront|online sim/.test(r.endpoint));
    const worstP95 = Math.max(0, ...till.map((r) => r.p95));
    const reason = [];
    if (s.errPct > opts.errPct) reason.push(`error rate ${f1(s.errPct)}%`);
    if (worstP95 > opts.p95Ms) reason.push(`till/storefront p95 ${f1(worstP95)}ms`);
    if (s.schedLagP95Ms > 250) reason.push(`generator lag ${f1(s.schedLagP95Ms)}ms`);
    if (s.flowFailPct > opts.errPct) reason.push(`order flows failing ${f1(s.flowFailPct)}%`);
    s.breaking = reason.length ? reason.join(", ") : null;
    if (reason.length && breakAt == null) breakAt = f;
    console.log(
      `\n=== factor ${f}x (${s.offeredOrdersPerHour} orders/hr offered) ${s.reqPerSec.toFixed(0)} req/s, errors ${f1(s.errPct)}%` +
        (opts.pid ? `, server cpu max ${s.maxCpuPct}% rss ${s.maxRssMb.toFixed(0)}MB` : "") +
        (s.breaking ? `  <-- BREAKING: ${s.breaking}` : ""),
    );
    console.log("endpoint".padEnd(46), "n".padStart(6), "p50".padStart(8), "p95".padStart(8), "p99".padStart(8), "max".padStart(8), "err%".padStart(6));
    for (const r of s.rows)
      console.log(r.endpoint.padEnd(46), String(r.n).padStart(6), f1(r.p50).padStart(8), f1(r.p95).padStart(8), f1(r.p99).padStart(8), f1(r.max).padStart(8), f1(r.errPct).padStart(6));
    // Run one stage past the first failure to confirm, then stop to protect the box.
    if (breakAt != null && f > breakAt) break;
  }
  bg.stop = true;
  await Promise.allSettled(bg.tasks);

  mkdirSync(opts.out, { recursive: true });
  const result = { opts, when: new Date().toISOString(), driver: m.json.driver, breakAtFactor: breakAt, stages: all.map(summarize) };
  const file = join(opts.out, `${opts.label}.json`);
  writeFileSync(file, JSON.stringify(result, null, 2));
  console.log(`\nbreaking point: ${breakAt == null ? "not reached" : breakAt + "x"}\nresults: ${file}`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
