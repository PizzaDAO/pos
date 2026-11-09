# Friday-rush load test

Zero-dependency Node harness (Node >= 20, built-in `fetch`) that replays a pizzeria rush
against a **local** POS server. It refuses any host that is not `localhost`, `127.0.0.1`
or `::1`, so it cannot be pointed at production or a Vercel URL.

## Run it

```bash
# terminal 1: production build + server on 3405, rate limiter off (one IP would trip it)
npm run loadtest:serve

# terminal 2: ramp 1x,3x,10x,...; add --pid to sample the server's cpu/rss
npm run loadtest -- --preseed 800 --pid "$(lsof -ti tcp:3405 -sTCP:LISTEN | head -1)" --label mock-friday
npm run loadtest -- --quick          # 2 short stages, ~1 minute
```

Stop the server by port only: `lsof -ti tcp:3405 | xargs kill`.

## What it does

Open-loop Poisson arrivals (offered load does not back off when the server slows, so
latency growth and errors show up). Factor 1 = 3 locations x 120 orders/hour = 360/hour;
factor 3 = the "3x busy peak" target (1,080/hour). Default ramp:
`1,3,10,30,100,200` (override with `--factors`). Per stage:

| Actor | Calls |
|---|---|
| Tills (70% of orders) | `POST /api/orders`, then `POST /api/payments` (cash or simulated card), then 3 kitchen bumps |
| Storefront (30%, 15% of those delivery) | `POST /api/shop/orders`, `POST /api/payments` (simulated), `GET /api/shop/track` every 4 s, bumps |
| Kitchen screens (2 per location) | `GET /api/kitchen/orders` every 4 s, `POST /api/kitchen/orders` bumps |
| Till open-orders (3 tills per location) | `GET /api/orders/open` every 30 s |
| Dispatch board (1 per location) | `GET /api/delivery/dispatch` every 5 s, `POST` assign for new deliveries |

Kitchen/customer waits are compressed by `--lifecycle-scale` (default 0.1). `--preseed N`
creates N completed orders first, to mimic a location late in a busy day (the KDS
endpoint reads recent history). The mock seed has 2 real locations, so the 3 virtual
locations map round-robin onto them.

Breaking point = first stage where the error rate or order-flow failure rate is over 1%,
till/storefront p95 is over 1,000 ms (`--p95-ms`), or the generator itself lags over 250 ms.
The ramp continues one stage past the first failure, then stops.

Results are printed and written to `loadtest/results/<label>.json` (git-ignored).

## Caveats

- The zero-env default is the in-memory **mock** driver. It exercises routing, auth guards,
  pricing, JSON and the Node event loop, but says almost nothing about Postgres/PostgREST
  latency. To test the real driver, set `NEXT_PUBLIC_SUPABASE_URL` + keys to a LOCAL or
  disposable Supabase project before `loadtest:serve` (never production). No local Postgres
  was available when this harness was written. See `REPORT.md` for the Supabase driver review.
- `ps %cpu` on macOS is a decayed average and understates short bursts.
- Everything runs on one machine: the generator competes with the server for CPU.
