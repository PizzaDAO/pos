# Pizzeria Point of Sale — SaaS Platform Plan

> **Product:** A multi-tenant SaaS POS that independent pizzerias sign up for. Each tenant (pizzeria business) runs one or more locations, takes in-store + online orders, and gets paid into **their own** bank/wallet. We operate the platform and bill tenants a subscription.

## Decisions (locked)

| Area | Choice |
|---|---|
| Product shape | **Multi-tenant SaaS** — many independent pizzerias sign up |
| Terminal | **Web PWA** — installable, offline-first, tablet |
| Back office | Web app, role-gated (tenant) |
| Platform admin | Super-admin surface (us): tenants, billing, support |
| Customer app | **Online ordering** — web, pickup + delivery, tracking |
| Footprint | **Multi-location** per tenant |
| Backend | **Supabase** (Postgres + Auth + Realtime + Storage) |
| Money routing | **Stripe Connect** (per-tenant connected accounts → their payouts) |
| Card payments | Stripe Terminal (in-store, incl. offline) + Stripe (online) |
| Crypto payments | In scope, **pluggable rail** — onchain USDC (Privy stack) *and* processor (Coinbase Commerce) |
| Delivery | **Pluggable provider** — in-house manual dispatch *and* 3rd-party (DoorDash Drive) |
| Subscription billing | **Stripe Billing** (we charge tenants) |
| Revenue model | **Subscription (Stripe Billing) + per-order platform fee (Connect `application_fee`)** |
| Onchain network | **Base** (low fees, Coinbase USDC on/off-ramp, EVM ≈ your Privy stack) |
| Go-to-market | **Pilot first** — build Phases 0–5 for one real pizzeria, self-serve in Phase 6 |
| Intent | Real production use |
| Hosting | Vercel |

## Scope
1. **Platform/tenancy** — signup, onboarding, Stripe Connect onboarding, subscription billing, super-admin
2. **Order taking + menu** — pizza builder, modifiers, combos, half-and-half (in-store + online)
3. **Payments** — card (Terminal + online via Connect), cash, **crypto (pluggable)**, tips, split, refunds, receipts
4. **Kitchen display / tickets** — KDS per location, station routing, printed tickets
5. **Back office** — menu, inventory, reports, staff/shift, end-of-day — per-location + tenant rollup
6. **Customer online ordering** — browse, cart, checkout, pickup/**delivery (pluggable)**, tracking

---

## Architecture

```
   Pizzeria signs up ─▶ /onboarding (tenant + Stripe Connect + subscription)
   Customers ────────▶ /shop/{location}  (online ordering)

┌────────────────────────────────────────────────────────────────────────────┐
│                          Vercel (Next.js, one repo)                           │
│                                                                               │
│ /terminal(PWA)  /kitchen  /admin(tenant)  /shop(customer)  /platform(super)   │
│       │             │           │              │                 │            │
│       └────────────────── tRPC / Route Handlers (tenant-scoped) ─────────────┘│
└──────┬──────────────────────┬──────────────────────┬─────────────────────────┘
       │                      │                       │
┌──────▼──────┐    ┌──────────▼───────────┐   ┌───────▼──────────────────────┐
│  Supabase   │    │  Payment rails        │   │  Delivery providers           │
│ Postgres    │    │  (PaymentRail iface):  │   │  (DeliveryProvider iface):    │
│ + strict    │    │   • Stripe Terminal    │   │   • InHouseManual             │
│   RLS by    │    │   • Stripe Connect      │   │   • DoorDashDrive             │
│   tenant    │    │   • Crypto: onchain     │   │   ...                         │
│ + Realtime  │    │     USDC (Privy)        │   └───────────────────────────────┘
│ + Auth      │    │   • Crypto: Coinbase    │
└──────▲──────┘    │  Stripe Billing (us→tenant)
       │           └─────────────────────────┘
┌──────┴──────┐
│ Terminal PWA│  offline queue (IndexedDB) → idempotent sync
└─────────────┘
```

### Tenancy & isolation (the core of a SaaS)
- Hierarchy: **`tenants` (a pizzeria business) → `locations` → operational data.** Every row is tenant-scoped.
- **Strict isolation via RLS** keyed on a `memberships` table (user ↔ tenant ↔ role). No query can cross tenants. This is the #1 correctness/security concern and gets dedicated test coverage.
- **Super-admin** (`/platform`) is a separate role outside tenant RLS, for support/billing/impersonation (audited).
- Per-tenant config: branding, menu, locations, payment rails enabled, delivery providers enabled, tax.

### Money: Stripe Connect (critical)
- Each tenant completes **Stripe Connect onboarding** → a connected account; card payments (Terminal + online) are created **on behalf of** the tenant so funds settle to **their** account. We never custody their card revenue.
- **Two revenue streams:** (1) **subscription** via Stripe Billing (tiers), and (2) **per-order platform fee** via Connect **`application_fee`** taken off each card transaction. Disclose the fee clearly to tenants at onboarding.
- Crypto payouts go to the tenant's own wallet/processor account — never pooled by us. (Platform fee on crypto orders, if any, handled separately — likely subscription-only on crypto in v1.)

### Pluggable rails & providers (because you said "both")
- **`PaymentRail` interface**: `quote()`, `createCharge()`, `capture()`, `refund()`, `status()`. Implementations: `StripeTerminal`, `StripeOnline`, `CryptoOnchainUSDC` (Privy + watcher), `CryptoCoinbase`. Tenant enables which rails they accept.
- **`DeliveryProvider` interface**: `quote()`, `dispatch()`, `track()`, `cancel()`. Implementations: `InHouseManual` (zones/fees + staff dispatch UI), `DoorDashDrive`. Tenant/location enables which.
- New rails/providers = new implementation, no core changes.

### Stack
- Next.js 15 (App Router) on Vercel; route groups per surface; shared tenant-scoped domain layer.
- PWA: Serwist + IndexedDB (Dexie), offline order queue + cached per-location menu.
- Supabase: Postgres, RLS, Realtime (per-location KDS + customer tracker), Auth (staff PIN, customer + tenant-user magic-link/social).
- TanStack Query + Zustand; Tailwind + shadcn/ui (tablet-first terminal, mobile-first shop).

### Offline-first (terminal)
- Per-location menu cached; orders queued in IndexedDB with client UUID; idempotent upsert-by-UUID on reconnect.
- **Offline card** via Stripe Terminal store-and-forward (reader secure element queues txn, forwards on reconnect). Trade-offs: per-txn cap + window, card-present only, no offline refunds, merchant carries decline risk. Crypto/online need connectivity.

---

## Data model (core)

**Platform/tenancy:** `tenants`, `locations`, `users`, `memberships` (user↔tenant↔role), `subscriptions` (Stripe Billing), `connect_accounts` (Stripe Connect status per tenant), `platform_admins`

**Provider config:** `payment_rail_configs` (per tenant: which rails, keys/wallets), `delivery_provider_configs` (per tenant/location)

**Menu (tenant-level + per-location override):** `menu_categories`, `menu_items`, `item_sizes`, `modifier_groups`, `modifiers`, `item_modifier_groups`, `location_menu_overrides`

**Orders:** `orders` (uuid, tenant_id, location_id, status, channel = in_store|online_pickup|online_delivery, fulfillment time, totals, staff_id|customer_id, sync), `order_items`, `order_item_modifiers` (half: left/right/whole)

**Payments:** `payments` (order_id, rail, method, amount, status, stripe_payment_intent_id, connect_account_id, crypto_tx_hash/chain/token, offline_forwarded_at)

**Delivery:** `deliveries` (order_id, provider, status, driver/zone, fee, ETA, tracking_ref)

**Inventory (per location):** `inventory_items`, `inventory_movements`

**People:** `staff` (pin_hash, role), `shifts`, `customers`

**Config:** `tax_rates` (per location), `store_settings` (hours, prep time, delivery zones/fees)

Order status: `draft → placed → in_kitchen → ready → (out_for_delivery) → completed` (+ `voided`, `refunded`).

---

## Build phases

### Phase 0 — Platform foundations
- Next.js + Vercel + Supabase + CI.
- **Tenancy + strict RLS** (tenants/locations/memberships) — with isolation tests.
- Auth + roles (super-admin / owner / manager / cashier / kitchen / customer).
- Schema migrations + **sample pizzeria seed** (a demo tenant, 2 locations, full menu).

### Phase 1 — Order taking + menu (terminal core)
- Pizza builder (size, crust, sauce, toppings, half-and-half, combos); cart, edits, void, discounts; tax + totals; place order.
- **Offline queue + sync**; PWA install + service worker; iPad Safari validation.

### Phase 2 — Payments + money routing
- **Stripe Connect onboarding** for a tenant; **`PaymentRail` interface**.
- Stripe Terminal (incl. offline) + Stripe online charges on connected account; cash drawer; tips, split, refund/void; receipts.
- **Crypto rails (both):** onchain **USDC on Base** (Privy + confirmation watcher) and Coinbase Commerce, behind the interface.

### Phase 3 — Kitchen display / tickets
- `/kitchen` KDS per location: realtime orders, bump, recall, age coloring, station routing; optional printed ticket.

### Phase 4 — Customer online ordering (`/shop/{location}`)
- Storefront per location, pizza builder, cart, checkout (online card via Connect + crypto).
- Pickup + **delivery via `DeliveryProvider` interface** (in-house zones/manual dispatch **and** DoorDash Drive); scheduled/ASAP, hours/prep gating; realtime customer tracking; orders into KDS.

### Phase 5 — Back office (tenant)
- Menu mgmt (CRUD, 86, per-location overrides, pricing); inventory + low-stock; reports (by location/day/item/channel/rail, payment mix incl. crypto, tips, voids) with **tenant rollup**; staff/shifts, drawer reconciliation, **end-of-day Z-report**.

### Phase 6 — Self-serve SaaS layer
- **Tenant signup + onboarding wizard** (business → locations → Connect → menu import → go live).
- **Subscription billing** (Stripe Billing tiers, trials, dunning); plan gating of features.
- **Super-admin `/platform`**: tenant list, health, billing, support impersonation (audited).

### Phase 7 — Hardening for production
- RLS/tenant-isolation audit + automated tests; idempotency/double-charge tests; offline + crypto-confirmation edge cases; Connect/PCI review.
- Hardware field test (reader, printer, drawer, tablet); backups; observability; training mode.

---

## Key risks & handling
- **Tenant data leakage** → RLS on every table keyed to `memberships`; isolation test suite; no service-role queries without tenant filter. Highest priority.
- **Money routing / compliance** → Stripe Connect so we never custody tenant card funds; clear separation between tenant revenue and our subscription billing; KYC handled by Stripe onboarding.
- **Double charges / dupe orders** → client UUID + Stripe idempotency keys end-to-end.
- **Offline card risk** → store-and-forward caps + clear UX; merchant accepts decline risk.
- **Crypto volatility & finality** → quote + settle in **USDC**; hold order until N confirmations (onchain) or processor-guaranteed settlement; handle under/overpay + expiry.
- **Pluggable-interface leakage** → keep rails/providers behind clean interfaces; no Stripe/DoorDash specifics in core order logic.
- **Scope** → this is a multi-quarter platform. Suggested GTM: build Phases 0–5 against a **single pilot tenant** (tenancy in from day one, but skip self-serve), validate in a real shop, then open self-serve in Phase 6.

---

## Resolved decisions
1. ✅ **Pilot first** — build Phases 0–5 for one real pizzeria; self-serve onboarding/billing in Phase 6.
2. ✅ **Revenue:** subscription (Stripe Billing) **+** per-order platform fee (Connect `application_fee`).
3. ✅ **Onchain network:** **Base** (USDC).
4. **Customer accounts:** default to **guest checkout + optional magic-link account** unless told otherwise.

## Open (can settle at Phase start, not blocking)
- Subscription tiers/pricing + whether the pilot tenant is on a free/internal plan.
- Specific in-store hardware (Stripe reader model, receipt printer, tablet) — decide before Phase 7 field test.
- Platform fee on crypto orders (v1 leaning: subscription-only on crypto).
