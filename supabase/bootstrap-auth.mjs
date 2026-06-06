#!/usr/bin/env node
/**
 * Bootstrap real auth accounts (run ONCE per environment by the orchestrator,
 * with the SERVICE-ROLE key). Creates the Supabase Auth user(s) for the demo
 * tenant owner + the platform admin via the Admin API, with email confirmed so
 * they can sign in immediately (magic-link or password). The identity-bridge
 * trigger (20260606000000_auth_user_bridge.sql) links each auth user to the
 * matching seeded public.users / memberships / platform_admins row BY EMAIL, so
 * after this runs the seeded owner can actually log in and operate the tenant.
 *
 * Idempotent: re-running finds the existing auth user by email and (optionally)
 * resets the password rather than erroring.
 *
 * Required env:
 *   NEXT_PUBLIC_SUPABASE_URL      — the project URL
 *   SUPABASE_SERVICE_ROLE_KEY     — service-role key (Admin API; NEVER ship to client)
 * Optional env (passwords; if omitted, accounts are magic-link only):
 *   BOOTSTRAP_OWNER_EMAIL    (default tony@tonys-pizza.example)
 *   BOOTSTRAP_OWNER_PASSWORD
 *   BOOTSTRAP_ADMIN_EMAIL    (default ops@pizzapos.example)
 *   BOOTSTRAP_ADMIN_PASSWORD
 *
 * Usage:
 *   node supabase/bootstrap-auth.mjs
 */
import { createClient } from "@supabase/supabase-js";

const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;

if (!url || !serviceKey) {
  console.error(
    "Missing NEXT_PUBLIC_SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY. Aborting.",
  );
  process.exit(1);
}

const admin = createClient(url, serviceKey, {
  auth: { autoRefreshToken: false, persistSession: false },
});

/** Find an existing auth user by email (paginates the Admin list). */
async function findUserByEmail(email) {
  const target = email.toLowerCase();
  let page = 1;
  // 50 pages * 1000 is plenty for a bootstrap; stop when a page is short.
  for (; page <= 50; page += 1) {
    const { data, error } = await admin.auth.admin.listUsers({
      page,
      perPage: 1000,
    });
    if (error) throw error;
    const found = data.users.find((u) => (u.email ?? "").toLowerCase() === target);
    if (found) return found;
    if (data.users.length < 1000) break;
  }
  return null;
}

async function ensureAuthUser({ email, password, label }) {
  const existing = await findUserByEmail(email);
  if (existing) {
    if (password) {
      await admin.auth.admin.updateUserById(existing.id, { password });
      console.log(`✓ ${label}: existing auth user ${email} — password reset.`);
    } else {
      console.log(`✓ ${label}: existing auth user ${email} (magic-link only).`);
    }
    return existing.id;
  }
  const { data, error } = await admin.auth.admin.createUser({
    email,
    password: password || undefined,
    email_confirm: true,
  });
  if (error) throw error;
  console.log(
    `✓ ${label}: created auth user ${email}${password ? " (with password)" : " (magic-link only)"}.`,
  );
  return data.user.id;
}

async function main() {
  const ownerEmail =
    process.env.BOOTSTRAP_OWNER_EMAIL || "tony@tonys-pizza.example";
  const adminEmail =
    process.env.BOOTSTRAP_ADMIN_EMAIL || "ops@pizzapos.example";

  await ensureAuthUser({
    email: ownerEmail,
    password: process.env.BOOTSTRAP_OWNER_PASSWORD,
    label: "Demo tenant owner",
  });
  await ensureAuthUser({
    email: adminEmail,
    password: process.env.BOOTSTRAP_ADMIN_PASSWORD,
    label: "Platform admin",
  });

  // Verify the bridge linked them to the seeded rows.
  const { data: owner } = await admin
    .from("users")
    .select("id,email")
    .ilike("email", ownerEmail)
    .maybeSingle();
  const { data: membership } = owner
    ? await admin
        .from("memberships")
        .select("role,tenant_id")
        .eq("user_id", owner.id)
        .maybeSingle()
    : { data: null };
  const { data: adminRow } = await admin
    .from("users")
    .select("id,email")
    .ilike("email", adminEmail)
    .maybeSingle();
  const { data: pa } = adminRow
    ? await admin
        .from("platform_admins")
        .select("user_id")
        .eq("user_id", adminRow.id)
        .maybeSingle()
    : { data: null };

  console.log("\nLink check:");
  console.log(
    `  owner ${ownerEmail}: users=${owner ? "yes" : "NO"}, membership=${
      membership ? `${membership.role}` : "NO"
    }`,
  );
  console.log(
    `  admin ${adminEmail}: users=${adminRow ? "yes" : "NO"}, platform_admin=${
      pa ? "yes" : "NO"
    }`,
  );
  console.log(
    "\nDone. Owner can sign in at /login; platform admin at /platform/login.",
  );
}

main().catch((err) => {
  console.error("Bootstrap failed:", err);
  process.exit(1);
});
