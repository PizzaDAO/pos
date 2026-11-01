#!/usr/bin/env node
/**
 * Apply the auth shim + every migration + the seed to an in-memory PGlite, then
 * run optional SQL check files. No Docker needed.
 *
 *   PGLITE=../core/node_modules/@electric-sql/pglite \
 *     node scripts/pglite-migrate.mjs [check.sql ...]
 *
 * Exits non-zero on the first failing file.
 */
import { readdirSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const pglitePath = resolve(
  process.env.PGLITE ?? join(root, "node_modules/@electric-sql/pglite"),
);
const { PGlite } = await import(
  pathToFileURL(join(pglitePath, "dist/index.js")).href
);

const { pgcrypto } = await import(
  pathToFileURL(join(pglitePath, "dist/contrib/pgcrypto.js")).href
);
const db = new PGlite({ extensions: { pgcrypto } });
const run = async (label, file) => {
  try {
    await db.exec(readFileSync(file, "utf8"));
    console.log(`ok   ${label}`);
  } catch (e) {
    console.error(`FAIL ${label}: ${e.message}`);
    process.exit(1);
  }
};
await run("auth_shim", join(root, "supabase/tests/auth_shim.sql"));
const dir = join(root, "supabase/migrations");
for (const f of readdirSync(dir)
  .filter((f) => f.endsWith(".sql"))
  .sort()) {
  await run(f, join(dir, f));
}
await run("seed", join(root, "supabase/seed.sql"));
for (const check of process.argv.slice(2)) await run(`check ${check}`, resolve(check));
await db.close();
