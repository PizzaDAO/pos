# terminal-card-reader: in-store card reader (Stripe Terminal) for the terminal PWA

Status: PLAN (no code yet). Owner decisions needed on the open questions at the bottom.
Docs checked 2026-10-29 against docs.stripe.com (links inline).

**Depends on:**
- `connect-hardening`: `resolveCardConnectAccountId` / `CardPaymentsNotReadyError`, and the
  `takePayment` guard that refuses a card rail without a real `acct_`.
- `online-card-checkout` **track A** (server lifecycle):
  - `applyRailStatus()` with status precedence
  - the F7 coverage fix
  - the F8 `maybeMarkOrderPaid` fix
  - `driver.transitionOrderStatus` (compare-and-set)
  - the dual-secret Connect webhook with an `event.type` switch

  If the terminal work has to ship first, move those pieces into this task (+1 day, see the size estimate).

## Decision summary

| Question | Decision |
|---|---|
| Integration | **Server-driven** (Stripe API drives the reader: `POST /v1/terminal/readers/:id/process_payment_intent`). **Not** Terminal JS. No new npm dependency. |
| Reader | **Stripe Reader S700** (US $299). S710 ($299 + $10/mo cellular) if the shop's internet is flaky. Not M2. Not WisePOS E (no longer sold new). |
| Offline card | **Not possible from a web PWA.** Offline needs a native Terminal SDK. Card needs internet; when offline the terminal is cash-only. Correct PLAN.md and PRODUCTION_READINESS §3. |
| Capture | `capture_method=automatic`. Nothing to capture server-side. |
| Tips | **On-reader tipping** (Terminal Configuration on the connected account), with a per-location fallback to our tip UI (`skip_tipping`). |
| Order promotion | Only through `applyRailStatus` → `maybeMarkOrderPaid` → the online plan's compare-and-set finalize. No second promotion path. |
| CSP / Permissions-Policy | **No change** needed for server-driven: the tablet only calls our own origin. A service-worker change **is** needed (NetworkOnly for payment/terminal APIs). |

## Findings (verified in code + docs)

| # | Finding | Where |
|---|---|---|
| T1 | `stripe_terminal` creates a `card_present` PI and never hands it to a reader. The header comment claims "confirm it server-side", but no confirm exists. Stripe says to **never** confirm card_present server-side: confirmation must happen on the reader ([collect-card-payment JS](https://docs.stripe.com/terminal/payments/collect-card-payment.md?terminal-sdk-platform=js)). | `src/lib/payments/rails/stripe-terminal.ts:93-116` |
| T2 | `coveredCents` counts `requires_action`, so the unprocessed PI shows a $0 balance and the cashier thinks the order is paid (online plan F7). | `src/lib/payments/service.ts:76-80` |
| T3 | `/api/payments/stripe/connection-token` has no caller. It isn't needed for server-driven (["If you're using a server-driven integration, you don't need to create a connection token"](https://docs.stripe.com/terminal/features/connect.md?connect-charge-type=direct)). A token lets the holder take payments on the tenant's account, so it is attack surface. | `src/app/api/payments/stripe/connection-token/route.ts` |
| T4 | The terminal rail picker lists every rail, including **"Card — Stripe (online)"**, which makes no sense in-store. | `payment-screen.tsx:137`, `registry.ts` |
| T5 | Every `takeTender` mints a new UUID. A retry after a lost response or a reload creates a **second** tender and a second PI. | `src/lib/store/use-checkout.ts:147` |
| T6 | The refund rail sends `reverse_transfer: true` on a **direct** charge. That parameter only applies to destination charges. | `stripe-terminal.ts:150` |
| T7 | Serwist `defaultCache` puts same-origin `GET /api/*` behind **NetworkFirst** (cache `apis`, 10s timeout). A payment-status poll that fails while offline would get a **stale cached status**. The cross-origin NetworkFirst rule would also cache GETs to Stripe origins. | `node_modules/@serwist/next/dist/index.worker.mjs:155-215`, `src/app/sw.ts` |
| T8 | `TRAINING_MODE=1` with a live `STRIPE_SECRET_KEY` still runs **real** card rails, because rails only check `isStripeConfigured()`. The training badge would lie for card-present. | `src/lib/demo/mode.ts`, `stripe-terminal.ts:82` |
| T9 | Platform fee includes the tip (`feeForTender(amount + tip)`). With on-reader tipping the tip is unknown when the PI (and its `application_fee_amount`) is created. | `stripe-terminal.ts:48-55` |
| T10 | `locations.address` is a single free-text string. A Stripe Terminal Location needs a structured address (`line1/city/state/postal_code/country`). | `src/lib/db/types.ts:21-29` |
| T11 | Any tenant member, including `kitchen`, can refund. | `api/payments/refund/route.ts:73` |

## Research answers

### What Terminal JS supports, and can a tablet PWA drive a reader?

- **Terminal JS and server-driven both support smart readers only:** S700/S710, T600,
  WisePOS E and Verifone. Neither supports M2, WisePad 3 or Tap to Pay. Bluetooth/USB
  readers need the iOS, Android or React Native SDK
  ([reader comparison](https://docs.stripe.com/terminal/payments/setup-reader)).
- **Stripe explicitly recommends server-driven over Terminal JS** for WisePOS E and S700/S710.
  The reason given: "The JavaScript SDK requires your POS and reader on the same local network
  with working local DNS"
  ([JS setup](https://docs.stripe.com/terminal/payments/setup-integration?terminal-sdk-platform=js),
  [network requirements](https://docs.stripe.com/terminal/network-requirements.md)).
- **What Terminal JS needs from the network and browser.** The browser talks HTTPS directly to
  the reader on the LAN, using `*.stripe-terminal-local-reader.net` names that must resolve to
  private IPs. That means:
  - No DNS-rebinding protection on the router.
  - No client isolation between WiFi and Ethernet.
  - Chrome 142+ and Firefox **Local Network Access** permission prompts.
  - The SDK script must load live from `js.stripe.com` and must not be bundled.

  Stripe lists "Chrome and Safari on all platforms" as supported, and says mobile browsers
  work on the same LAN. **iPad Safari in standalone-PWA mode is not specifically documented,
  so treat it as unverified.**
- **Server-driven has no browser constraints.** The tablet only calls our server, and our
  server calls the Stripe API. The reader talks to Stripe over its own internet connection
  (WiFi, Ethernet, or S710 cellular). Any browser works, including iPad Safari standalone,
  on any network, with no LAN pairing and no CSP change. **A tablet PWA can drive the reader
  this way.** This is why server-driven is recommended.

### Offline
- Stripe's [offline overview](https://docs.stripe.com/terminal/features/operate-offline/overview.md?reader-type=internet)
  lists the **iOS, Android and React Native SDKs only** for smart readers. The reader table
  footnote says "Offline mode requires the Terminal mobile SDK."
- The **server-driven** docs say: "doesn't support … Collect card payments while offline"
  ([server-driven setup](https://docs.stripe.com/terminal/payments/setup-integration?terminal-sdk-platform=server-driven)).
- The **JS** collect page says: "This integration type doesn't support offline card payments."
- An S700 *can* go offline when it runs our own Android app (**Apps on Devices**, a paid
  feature), or when it is driven by a native iOS/Android POS app. Native offline also has
  conditions: the reader must have connected online within the last 24 hours on the same
  LAN, the cap is **$10,000** per transaction, there is no swipe, there are no refunds until
  the payment is forwarded, and **the merchant carries all decline risk**
  ([collect offline, iOS](https://docs.stripe.com/terminal/features/operate-offline/collect-card-payments.md?terminal-card-present-integration=terminal&reader-type=internet&terminal-sdk-platform=ios)).
- **Conclusion: the web-PWA architecture cannot do offline card, whichever web integration we
  pick.** PLAN.md's "store-and-forward" line is wrong for this stack.

### Options and recommendation

| Option | Offline card | PWA fit | iPad Safari | Network fragility | Effort |
|---|---|---|---|---|---|
| **A. Server-driven (recommended)** | No | Excellent: plain fetch to our API | Yes | Low: the reader needs internet, no LAN pairing | ~5–6 d |
| B. Terminal JS | No | OK: the SDK in the page | Documented, but unverified in standalone PWA | High: local DNS, LNA prompts, same LAN | ~5 d, plus field risk |
| C. Native wrapper (Capacitor plus the iOS/Android Terminal SDK) | Yes (needs the same LAN) | Leaves "pure PWA". App Store or MDM distribution. | Native | Medium | Weeks |
| D. Apps on Devices (our POS UI on the S700 itself) | Yes | Different product: Android app on a 5.5" screen | n/a | Low | Weeks, plus fees |

**Recommend A.** Mitigate outages operationally:
- Offline means cash-only, with a banner on the terminal.
- Use an **S710** (cellular reader) plus a phone hotspot for the tablet when the shop's
  internet is unreliable.

Revisit C only if a pilot shop's outages actually cost card sales.

### Hardware for the pilot (US)

| Reader | US price | Server-driven / JS | Notes |
|---|---|---|---|
| **Stripe Reader S700** | **$299** ([stripe.com/terminal](https://stripe.com/terminal); cut from $349 in Feb 2026) | Yes / Yes | Recommended. Android smart reader, 5.5" customer-facing screen, on-reader tipping, customer cancel button, WiFi or Ethernet (dock). |
| Stripe Reader S710 | $299, plus $10/mo cellular | Yes / Yes | The S700 with LTE. Pick it if the shop's internet is unreliable. |
| Stripe Reader T600 | US price not published in sources found (CA$459, £249) | Yes / Yes | Countertop, 8" screen, continuously powered. Check the Dashboard shop. A good fit for a fixed counter. |
| BBPOS WisePOS E | Dropped from Stripe's hardware shop in Feb 2026 (was $249) | Yes / Yes | Still supported, but **not sold new**. Avoid buying it. |
| Stripe Reader M2 | $59 | **No / No** | Bluetooth. Needs a native SDK and cannot be driven from a browser. Rejected. |

Also buy a **Stripe physical test card**, from the Dashboard → Terminal shop. It is required
for the sandbox field test.

**Ordering for a connected account:** with direct charges the **connected account owns the
reader**. Either the platform orders centrally and assigns the readers, or the tenant orders
their own ([setup-reader](https://docs.stripe.com/terminal/payments/setup-reader)).
Registration is done by **us** through the API with `Stripe-Account`, using the reader's
pairing code.

## Approach (server-driven)

### 1. Stripe objects per pizzeria (direct charges)

- Everything lives **on the connected account**: Location, Reader, Configuration and
  PaymentIntent. We create them with the platform key plus `Stripe-Account: acct_…`
  ([Terminal + Connect, direct](https://docs.stripe.com/terminal/features/connect.md?connect-charge-type=direct)).
  The account needs the `card_payments` capability, which Express accounts have.
- **Location mapping:**
  - One Stripe Terminal Location (`tml_`) per our `locations` row, created lazily by
    `ensureTerminalLocation(locationId)`.
  - It runs when an admin first opens **Admin → Payments → Card readers**, and needs a
    structured address form (T10).
  - It also runs, best-effort, from `account.updated` when `charges_enabled` first turns
    true. That handler is owned by `connect-hardening`; skip that hook if the address is
    missing.
  - Stored in the new `terminal_locations` table, keyed by our `location_id`, together with
    `connect_account_id` and `livemode`.
  - A test↔live key flip, or a re-onboarded account, invalidates the row. The rule is:
    `connect_account_id` and `livemode` must match the current resolution, otherwise recreate.
- **Configuration (tipping):** one `tmc_` per location, created by
  `ensureTerminalConfiguration`. `tipping[usd][percentages][]` comes from the location's
  `payment_settings.tip_presets_bps`. Assign it to the Location
  ([on-reader tips](https://docs.stripe.com/terminal/features/collecting-tips/on-reader.md)).
  Re-sync whenever tip presets change. Readers can take ~5 min to pick up a change.
- **Reader registration (admin UI):**
  1. The owner or manager taps **Generate pairing code** on the S700 (Settings), or enters
     `0-7-1-3-9`.
  2. They type the code and a label.
  3. `POST /api/admin/terminal/readers` runs `POST /v1/terminal/readers`
     `{registration_code, label, location: tml_}` with `Stripe-Account`, then inserts a
     `terminal_readers` row.
  4. Delete runs `DELETE /v1/terminal/readers/:id`.
  5. **Test mode only:** an "Add simulated reader" button sends `registration_code=simulated-wpe`
     ([create reader](https://docs.stripe.com/api/terminal/readers/create)). Check during
     implementation whether an S700 simulated code exists. `simulated-wpe` is the documented one.

### 2. Taking a card tender (terminal)

**State machine.** The tender is a `payments` row, rail `stripe_terminal`:

```
created (PI requires_payment_method → our requires_action, reader action in_progress)
   ├─ action_succeeded / PI succeeded ─▶ captured ─▶ applyRailStatus ─▶ maybeMarkOrderPaid (placed → paid)
   ├─ action_failed card_declined      ─▶ requires_action + raw.last_error  (retry same PI, or cancel)
   ├─ action_failed customer_canceled  ─▶ requires_action + last_error      (retry or cancel)
   ├─ action_failed connection_error   ─▶ re-read PI; succeeded ⇒ captured, else as decline
   └─ cashier Cancel ─▶ cancel_action on reader ─▶ cancel PI ─▶ canceled
```

**Flow:**
1. **Reader selection.**
   - The terminal loads `GET /api/terminal/readers?locationId=`, which returns DB rows merged
     with live `status` and `action` from `GET /v1/terminal/readers/:id`.
   - The device remembers its reader in `localStorage["pos.reader.<locationId>"]`. Auto-pick
     when there is exactly one reader.
   - The status bar shows the reader as online or offline. Stripe considers a reader offline
     after 2 min with no signal.
   - "Discovery and connect" in server-driven terms is just this list plus the choice. There
     is no SDK connection and no reconnect logic. A reader that comes back online simply works.
2. **Charge.** `POST /api/terminal/payments` with
   `{ paymentId, orderId, readerId, amountCents, tipMode }`.
   - **Auth:** `requireTenantRole(order.tenant_id, ['owner','manager','cashier'])`.
     `orderId`, `tenantId` and `locationId` come from the **order**, never the body.
   - Check that the reader belongs to that tenant and location (`terminal_readers`).
   - `amountCents` must be ≤ the server-computed balance.
   - `connectAccountId = resolveCardConnectAccountId(order.tenant_id)`. A
     `CardPaymentsNotReadyError` returns 409.
   - **One live terminal tender per order:** if a `stripe_terminal` tender in
     `requires_action|pending` exists for the order, return or resume it. The DB backs this
     with a partial unique index.
   - `takePayment(...)` with `paymentId` as the PI `Idempotency-Key`. That is the existing
     guard, and a repeat id returns the existing row.
   - The PI is created with:
     - `payment_method_types[]=card_present`, `capture_method=automatic`
     - `application_fee_amount`: see Tips
     - `metadata{order_id,payment_id,tenant_id,location_id,reader_id}`
     - `description: "Order #n — Location"`
   - Then `process_payment_intent` on the reader with
     `process_config[enable_customer_cancellation]=true`, and either
     `process_config[skip_tipping]=true` (POS tip mode) or `process_config[tipping][amount_eligible]`
     (the pre-tax subtotal, if Snax wants pre-tax tip suggestions). Use
     `Idempotency-Key: <paymentId>:process:<n>`, where `n = raw.process_attempts`, persisted
     **before** the call.
   - Returns `{ payment, readerAction }`.
3. **Completion: polling plus a webhook.** Both feed `applyRailStatus`.
   - **Polling.** The client polls `GET /api/terminal/payments/[id]` every ~1.5s while
     `requires_action|pending`. The server reads the Reader and the PI (`expand[]=latest_charge`),
     verifies `pi.metadata.payment_id`, `pi.amount == amount_cents + tip`, `currency` and
     account, then maps the result:
     - **`succeeded`:** record the tip from `pi.amount_details.tip.amount` into `tip_cents`,
       record the receipt fields (section 5), then `applyRailStatus(id,'captured')`.
     - **Reader `action.status=failed`:** record `api_error.code`, `decline_code` and `message`
       (reader software ≥2.42; otherwise `failure_code` plus `pi.last_payment_error`) in
       `raw.last_error`.
   - **Webhook.** The Connect webhook (the online plan's route) adds
     `terminal.reader.action_succeeded|action_failed` and runs the same server-side sync. The
     existing `payment_intent.succeeded` branch already settles terminal PIs through
     `metadata.payment_id`. That covers the tablet dying mid-payment.
4. **Decline or customer cancel.** The UI shows the message from `api_error.type=card_error`
   (display-only; never parse it). Two buttons:
   - **Try again:** `POST /api/terminal/payments/[id]/retry`, optionally with another
     `readerId`. It runs `process_payment_intent` on the **same PI**, as Stripe requires
     ("Don't recreate a PaymentIntent if a card is declined").
   - **Cancel tender**.
5. **Cancel.** `POST /api/terminal/payments/[id]/cancel` does two things:
   - `POST /v1/terminal/readers/:id/cancel_action`. If that returns `terminal_reader_busy`
     (mid-authorization), show "Customer is paying, wait" and keep polling.
   - `POST /v1/payment_intents/:id/cancel`, which sets the tender to `canceled`. If the PI
     already `succeeded`, treat it as captured. The cashier then refunds if they really meant
     to cancel.
6. **Error states:**
   - `terminal_reader_offline`: "Reader offline, check power/WiFi". Offer another reader, or cash.
   - `terminal_reader_busy`: "Reader busy".
   - `terminal_reader_timeout`: retry once with the same idempotency key, because it can be a
     false negative.
   - `intent_invalid_state`: re-sync. The PI already succeeded or was canceled.
   - Our server unreachable: the tablet is offline, so card is disabled.
   - **Stuck `in_progress` with no webhook**, which happens when the reader dropped mid-payment:
     a **Reset reader** button calls `POST /api/terminal/readers/[id]/reset` (`cancel_action`),
     then the cashier re-syncs.
   ([handle errors](https://docs.stripe.com/terminal/payments/collect-card-payment.md?terminal-sdk-platform=server-driven))
7. **Resume after a reload.** The in-flight `paymentId` is persisted in `sessionStorage`
   keyed by `orderId` (fixes T5 for card). When the screen reopens it resumes polling instead
   of minting a new tender.
8. **Reconcile.** Add `reconcileTerminalTenders(olderThan)`: tenders in `requires_action`
   older than 15 min get their PI re-read. If it succeeded, capture. Otherwise cancel the PI.
   Run it from the online plan's cron route (same `CRON_SECRET`) and from EOD close.

### 3. Capture

`capture_method=automatic`. On-reader tipping, processing and capture are one step, so the
`/capture` path in the rail is unused for terminal.

Manual capture would buy two things: recomputing the application fee to include the tip
(T9), and a void-before-capture. It costs a server capture call that can fail, plus a
two-day authorization expiry
([collect, server-driven](https://docs.stripe.com/terminal/payments/collect-card-payment.md?terminal-sdk-platform=server-driven)).
It isn't worth it for a counter-service pizzeria **unless** Snax wants the platform fee
charged on tips (open question 2).

### 4. Tips

- **Per-location setting** `terminal_tip_mode: 'reader' | 'pos' | 'none'` (default `reader`),
  stored on `terminal_locations`.
  - **`reader`:** the customer picks a tip on the S700. Our tip selector is hidden for card.
    The tip arrives in `pi.amount_details.tip.amount` and is written into `payments.tip_cents`.
    `amount_cents` stays at the base.
  - **`pos`:** the existing `TipSelector`. The tip is added to the PI amount at creation, with
    `skip_tipping=true`.
  - **`none`:** `skip_tipping=true` and no tip UI.
- **Fee (T9):** with `reader` mode and automatic capture, `application_fee_amount` is computed
  on the **pre-tip base only**. In `pos` mode, keep today's fee on base plus tip, for parity
  with online. See open question 2.
- Reports already take in-store tips from tenders (`reports.ts:189-206`). No change.
- **Testing tips:**
  - Simulated reader: `present_payment_method` with `amount_tip`.
  - Physical test card: the total *including* the tip drives the decline cents, so pick tips
    that keep `.00`.

### 5. Receipts

- On success, store these in `payments.raw.card_receipt`, taken from
  `latest_charge.payment_method_details.card_present`:
  - `brand`, `last4`, `read_method`
  - `receipt.application_preferred_name` and `receipt.dedicated_file_name` (AID): required
  - `receipt.account_type`: optional in the US
  - `receipt.authorization_response_code`
  - `authorization_code`

  Truncated card data only; no PAN. This stays within the SAQ-A posture in §4.
- **`ReceiptView`** prints the required EMV fields for card tenders
  ([receipts](https://docs.stripe.com/terminal/features/receipts.md)).
- **Optional "Email receipt":** `POST /api/terminal/payments/[id]/receipt { email }` updates
  the PI's `receipt_email`, and Stripe sends a compliant receipt. Stripe doesn't send these in
  test mode. Ask Snax whether this is in v1 (open question 5).

### 6. Refunds

- **US card_present** is refunded **online** through the Refunds API on the connected account,
  and the customer doesn't need to present the card again. Partial refunds are OK.
- **In-person refunds** (`refund_payment` on the reader) exist **only for Interac (Canada)**,
  which is out of scope for a US pilot
  ([refunds](https://docs.stripe.com/terminal/features/refunds.md?terminal-sdk-platform=server-driven)).
- Fix T6: send `refund_application_fee: true` and **drop `reverse_transfer`** for direct
  charges. Do the same in `stripe-online.ts`, in coordination with the online plan.
- A tender that is still `requires_action` is **cancelled**, not refunded.
- Refunds can fail asynchronously (`refund.failed`). Log it now; handling is a follow-up.
- Restrict card refunds to owner/manager (T11, open question 4).

### 7. Fit with our model

- **Payment rows:** rail stays `stripe_terminal`. No enum change.
  - **Status mapping:** `requires_payment_method` → `requires_action` (in flight, or declined
    and retryable). `processing` → `pending`. `succeeded` → `captured`. `canceled` → `canceled`.
  - **`raw` fields:** `reader_id`, `process_attempts`, `reader_action_status`, `last_error`,
    `card_receipt`, `stripe_status`. **Never** `client_secret`, because server-driven never
    needs it.
- **Idempotency:**
  - The client UUID is the tender id **and** the PI `Idempotency-Key` (unchanged).
  - `process_payment_intent` gets the per-attempt key `<paymentId>:process:<n>`.
  - One live terminal tender per order is enforced by the route check plus a partial unique index.
  - The webhook and polling converge through `applyRailStatus`, which never downgrades
    `captured`/`refunded`.
- **Card-readiness gate:** card shows on the terminal only when **both**
  `resolveCardConnectAccountId` succeeds **and** the location has at least one registered
  reader. This comes from `GET /api/terminal/readers`, which returns `{ mode, ready, readers }`.
  Otherwise the Card button is disabled with a reason: "Finish Stripe onboarding" or "Add a
  card reader in Admin". This replaces the online plan's "hide Card on terminal" stop-gap. Hide
  `stripe_online` from the terminal picker (T4).
- **Order promotion:** the terminal code never writes order status. It only calls
  `applyRailStatus`, which runs `maybeMarkOrderPaid`. That uses the online plan's
  compare-and-set from `draft|placed|awaiting_payment` to `paid`. Online-only side effects
  (depletion, dispatch) run only for `awaiting_payment`, so in-store orders (`placed`) promote
  through the same single function. **Ask the online-plan implementer to name it generically**
  (`finalizeOrderPayment`) or document that it handles `placed`.
- **Simulated mode (zero env) and training mode.** `cardReaderMode()` in
  `src/lib/payments/env.ts` returns:

  | Mode | When | Behaviour |
  |---|---|---|
  | `simulated` | No `STRIPE_SECRET_KEY`, **or** `isTrainingModeEnv()` (fixes T8 for card-present) | One virtual reader per location, `tmr_sim_<locationId>`, always online. Creating a tender returns `requires_action` with a `sim_` PI id. **No Stripe call ever.** |
  | `stripe_test` | `sk_test_…` | Real Stripe sandbox with simulated or physical readers |
  | `stripe_live` | `sk_live_…` | Real money |

  - In `simulated` mode, the status poll returns `captured` once the cashier taps **Simulate
    approve** (or **Simulate decline**). These buttons show in `simulated` and `stripe_test`
    only. In `stripe_test` they call `POST /v1/test_helpers/terminal/readers/:id/present_payment_method`,
    with `card_present[number]=4000000000000002` for a decline and `amount_tip` for a tip
    ([testing](https://docs.stripe.com/terminal/references/testing.md)).
  - An env flag `TERMINAL_SIM_AUTO_APPROVE_MS` (default off) lets demos auto-approve.
  - `takePayment` called directly without a reader (existing unit tests) keeps the instant
    simulated capture.
  - The generic `POST /api/payments` **rejects `stripe_terminal`** with a 400 pointing to
    `/api/terminal/payments`. Cash and crypto are unchanged.

### 8. CSP, Permissions-Policy, service worker

- **CSP:** no change for server-driven. Every reader call goes to our origin (`connect-src 'self'`).
  - *If Terminal JS is ever chosen:* `script-src https://js.stripe.com` is already present.
    `connect-src` would need the local reader hosts (`https://*.stripe-terminal-local-reader.net`).
    Stripe doesn't publish a CSP list for Terminal JS, so verify with `Content-Security-Policy-Report-Only`
    against a real reader.
- **Permissions-Policy:** no change. Server-driven needs no browser device APIs. Keep
  `usb=()`; there is no Bluetooth key, and none is needed.
- **Service worker (T7), required.** Add these to `src/app/sw.ts` `runtimeCaching`, **before**
  `...defaultCache`:
  - `NetworkOnly` for same-origin `/api/terminal/*`, `/api/payments*` and `/api/admin/terminal/*`.
    Payment state must never come from a cache.
  - `NetworkOnly` for `https://*.stripe.com` and `https://js.stripe.com`. This also protects
    Stripe.js for the shop. Stripe says its scripts must load live.
  - Keep `/api/menu` StaleWhileRevalidate.
  - **Offline UX:** when `navigator.onLine` is false, or a status poll throws, the payment screen
    shows "Offline: card unavailable, take cash". An in-flight tender keeps its id and resumes
    when back online. No new card tender is started while offline. (The reader may still finish
    the authorization itself; the resume-and-sync path picks it up.)
  - `skipWaiting`/`clientsClaim` are fine because in-flight state persists in `sessionStorage`.

## Files to change (step by step)

Order: **DB → server lib → routes → UI → SW/docs → tests.** Prerequisites: `connect-hardening`
merged, and online plan track A merged.

1. `supabase/migrations/20261110000000_terminal_readers.sql` (new):
   - `terminal_locations(location_id pk → locations, tenant_id, connect_account_id, stripe_location_id, configuration_id, livemode, address jsonb, tip_mode text check in ('reader','pos','none') default 'reader', created_at, updated_at)`
   - `terminal_readers(id text pk /*tmr_*/, tenant_id, location_id, connect_account_id, label, device_type, serial_number, livemode, created_at, updated_at)`
   - RLS: `select` for `is_tenant_member(tenant_id)` or platform admin; writes for platform
     admin or owner/manager only, mirroring existing policies. Add `FORCE ROW LEVEL SECURITY`
     and least-privilege grants, as in `20260605000200`.
   - `create unique index payments_one_live_terminal on payments(order_id) where rail='stripe_terminal' and status in ('requires_action','pending');`
   - Extend `supabase/tests/rls_isolation.sql`: tenant B can't read A's readers.
2. `src/lib/db/payment-types.ts`: `TerminalLocation`, `TerminalReader`, `TerminalTipMode` types.
3. `src/lib/db/driver.ts`, `mock.ts`, `supabase.ts`:
   - `getTerminalLocation`, `upsertTerminalLocation`
   - `listTerminalReaders(tenantId, locationId)`, `getTerminalReader(id)`, `upsertTerminalReader`, `deleteTerminalReader`
   - `listStaleTerminalTenders(olderThan)`
   - The mock driver seeds nothing; simulated readers are virtual.
4. `src/lib/payments/env.ts`: `cardReaderMode()` and `isStripeTestKey()`.
5. `src/lib/payments/providers/stripe-terminal-api.ts` (new): thin wrappers over `stripeRequest`/`stripeGet`, all taking `stripeAccount`:
   - `createLocation`, `updateLocation`
   - `createConfiguration`, `updateConfiguration`
   - `registerReader`, `deleteReader`, `retrieveReader`
   - `processPaymentIntent`, `cancelReaderAction`
   - `retrievePaymentIntent` (with `expand[]=latest_charge`), `cancelPaymentIntent`, `updatePaymentIntent`
   - `presentPaymentMethod`: test helper, which throws unless the key is `sk_test`

   Add a `stripeDelete` helper to `stripe-client.ts`. Parse `error.code` into `StripeError.code`
   (busy/offline/timeout/intent_invalid_state).
6. `src/lib/payments/terminal/` (new module):
   - `locations.ts`: `ensureTerminalLocation`, `ensureTerminalConfiguration` (tip presets → `tipping[usd][percentages]`).
   - `readers.ts`: `registerReader`, `removeReader`, `listReadersWithStatus` (DB plus a live
     Stripe merge, or the virtual sim reader).
   - `flow.ts`: `startCardTender`, `syncCardTender` (verification, tip, receipt fields, then
     `applyRailStatus`), `retryCardTender`, `cancelCardTender`, `resetReader`, `simulateCardTender`,
     `reconcileTerminalTenders`.
   - `simulated.ts`: in-memory or driver-backed sim reader state, deterministic.
7. `src/lib/payments/rails/stripe-terminal.ts`:
   - Real path: drop the false header claims, and add `description` and `metadata.payment_id`.
     The fee is on base only when `metadata.tip_mode === 'reader'`.
   - The simulated path returns `requires_action` when `metadata.reader_id` is set (the reader
     flow), and otherwise keeps instant capture.
   - `refund` drops `reverse_transfer` (T6).
   - Rewrite the offline comment to say that offline card is unsupported in a web POS, citing the docs.
8. `src/lib/payments/service.ts`: export `liveTerminalTender(orderId)`. Make sure `applyRailStatus`
   (from the online plan) accepts a patch (`tip_cents`, `raw` merge), not just a status.
9. **Routes (all `runtime = "nodejs"` and rate-limited with the `payments` bucket):**
   - `src/app/api/admin/terminal/route.ts`: `GET` returns the location's terminal setup plus
     readers. `PUT` sets the address and tip mode, and ensures the Location and Configuration.
     Owner/manager only.
   - `src/app/api/admin/terminal/readers/route.ts`: `POST` registers by code. In test mode it
     also allows `simulated-wpe`.
   - `src/app/api/admin/terminal/readers/[id]/route.ts`: `DELETE`.
   - `src/app/api/terminal/readers/route.ts`: `GET ?locationId` returns
     `{ mode, ready, notReadyReason, readers }`. Cashier and up.
   - `src/app/api/terminal/readers/[id]/reset/route.ts`: `POST`.
   - `src/app/api/terminal/payments/route.ts`: `POST` starts or resumes a tender.
   - `src/app/api/terminal/payments/[id]/route.ts`: `GET` syncs.
   - `src/app/api/terminal/payments/[id]/retry/route.ts`, `/cancel/route.ts`,
     `/simulate/route.ts` (simulated and `stripe_test` only; 404 in live), and
     `/receipt/route.ts` (optional email).
   - `src/app/api/payments/route.ts`: reject `stripe_terminal` (and `stripe_online`, per the
     online plan). Strip `raw` from the GET (online plan F12); return `card_receipt` explicitly.
   - `src/app/api/payments/stripe/webhook/route.ts`: add the `terminal.reader.action_succeeded`
     and `terminal.reader.action_failed` branches, which call `syncCardTender(metadata.payment_id`
     from the PI on `event.data.object.action.process_payment_intent.payment_intent)`. Check
     `event.account` against the tender.
   - `src/app/api/payments/stripe/connection-token/route.ts`: **delete** (T3), after
     `connect-hardening` merges (open question 7).
   - `src/app/api/payments/refund/route.ts`: card rails require owner/manager (open question 4).
   - The online plan's cron route also calls `reconcileTerminalTenders`.
10. **Admin UI:** `src/app/(admin)/admin/components/card-readers.tsx` (new), mounted next to
    `connect-onboarding.tsx` on the payments page. It contains:
    - A structured address form, and a tip-mode select.
    - A reader list with online/offline, label, device type and remove.
    - An "Add reader" dialog with a pairing-code input and instructions ("S700: Settings →
      Generate pairing code").
    - "Add simulated reader" (test mode only).
    - A not-ready state when Connect isn't `charges_enabled`.
11. **Terminal UI:**
    - `src/lib/store/use-card-reader.ts` (new): reader list, the selected reader (localStorage),
      `startCard`, `poll`, `retry`, `cancel`, `reset` and `simulate`, and in-flight id persistence
      (sessionStorage per order).
    - `payment-screen.tsx`: drop `stripe_online` from the terminal rails. Card state panel:
      "Present card on <reader>…" / "Approved" / decline message with Try again / Cancel /
      Reset reader / Simulate approve|decline. Hide `TipSelector` for card when the tip mode is
      `reader`. Disable Charge while a card tender is live. Show the offline notice.
    - `status-bar.tsx`: reader online/offline chip.
    - `receipt-view.tsx`: card brand/last4, entry method, application name, AID and
      (if present) account type.
    - `use-checkout.ts`: the card path delegates to `use-card-reader`, and stops polling only
      when the tender is terminal.
12. `src/app/sw.ts`: the NetworkOnly rules from section 8.
13. **Docs:**
    - `PLAN.md`: Decisions row "Card payments: Stripe Terminal (in-store, **online only;
      server-driven**)". Replace the Offline-first "Offline card" bullet with the finding plus
      the cash-only/S710 mitigation.
    - `docs/PRODUCTION_READINESS.md`:
      - §3: rewrite the offline-card paragraph.
      - §4: receipts and truncated card data only.
      - §9: `TERMINAL_SIM_AUTO_APPROVE_MS`.
      - §10: hardware + Connect webhook events `terminal.reader.action_*`.
    - `docs/IDEMPOTENCY_REVIEW.md`: the terminal tender flow and the per-attempt process key.

## Testing

**Unit tests (Vitest, zero env, mock driver).** New `src/lib/payments/terminal/flow.test.ts`:
- **Start:** the tender is `requires_action`, the balance is **not** reduced (T2/F7 regression),
  and the order stays `placed`.
- **Simulate approve:** the sync sets `captured`, the order becomes `paid` once via the
  compare-and-set, and the tip from the reader lands in `tip_cents`.
- **Simulate decline:** `last_error` is set, the order is still `placed`. Retry uses the same
  tender id and the same PI id, and `process_attempts` is incremented.
- **Concurrent sync** (webhook and poll ×2) promotes once.
- **Repeat start with the same `paymentId`** returns the existing tender. A second start with a
  new id while one is live returns the live one.
- **Cancel:** the tender is `canceled` and the balance is restored. Cancel after success
  yields `captured`.
- **Amount guard:** `amountCents` > balance gives 422. A reader from another location or tenant
  gives 403/404.
- **Training:** `TRAINING_MODE=1` plus a fake `sk_live` gives mode `simulated`, and `fetch` is
  never called (spy).
- `stripe_test` with a `fetch` stub:
  - `process_payment_intent` is sent with `Stripe-Account` and the per-attempt `Idempotency-Key`.
  - `terminal_reader_busy` on cancel maps to the "customer paying" result.
  - A PI amount or account mismatch is refused.
- Refunds omit `reverse_transfer` and keep `refund_application_fee`.
- `cardReaderMode()` matrix. `ensureTerminalLocation` recreates on an account or livemode mismatch.
- **Route tests:** auth (kitchen is 403, cashier is OK), the `/api/payments` rejection of
  `stripe_terminal`, and `/simulate` returning 404 in live.
- **Webhook:** `terminal.reader.action_failed` records the error, and `action_succeeded` settles.
  Wrong `event.account` is ignored.
- **SW:** a small test that the runtimeCaching array places the NetworkOnly matchers before
  `defaultCache`. Import a matcher list from a pure module `src/lib/offline/sw-routes.ts` so it
  is testable.
- `headers.test.ts` is unchanged, which asserts there is no CSP drift.

**Playwright, zero env (CI, required):** `e2e/terminal.spec.ts` adds "card via simulated reader":
1. Place an order and open payment.
2. Pick **Card**. The "Simulated reader" is auto-selected.
3. Charge. Expect "Present card".
4. Click **Simulate decline** and expect the decline text.
5. **Try again**, then **Simulate approve**, and expect "Payment complete".
6. The receipt shows "Visa •••• 4242" (simulated fixture).

Add a reload-resume variant: reload while pending and expect the same tender to resume. The
existing cash flow must stay green.

**Playwright, Stripe test mode (gated):** new `e2e/terminal-stripe.spec.ts` with
`test.skip(!process.env.E2E_STRIPE_TERMINAL)`.
- **Prereqs:** `sk_test` in the target env, a test-mode Express account onboarded for the e2e
  tenant, and the Connect webhook endpoint subscribed to `terminal.reader.action_*` and
  `payment_intent.*`. Locally use `stripe listen --forward-connect-to localhost:3100/api/payments/stripe/webhook`.
- **Setup via admin API:** set the address, then register `simulated-wpe` (idempotent: reuse it
  if one exists).
- **Cases:**
  - Charge, then simulate approve (calls `present_payment_method`): the order is `paid`, and the
    PI on the connected account is `succeeded` with `application_fee_amount` set (check via
    `GET /api/payments?orderId=` fields).
  - **Decline** `4000000000000002`, then retry with the same `pi_`, then approve.
  - **Tip:** `amount_tip=300` with tip mode `reader`, so `tip_cents=300` and the PI amount is
    base + 300.
  - **Cancel** mid-collect: the reader action is cleared and the PI is `canceled`.
  - **Refund** from the payment screen: refund `succeeded`, tender `refunded`.
  - **Webhook proof:** `raw.webhook_seen_at` is eventually set.
- **Run:** `BASE_URL=… E2E_STRIPE_TERMINAL=1 VERCEL_AUTOMATION_BYPASS_SECRET=… npx playwright test terminal-stripe`.
  Use the same staging decision as online plan question 2.

**Manual field-test checklist (real S700, sandbox first, then live):**
- [ ] Shop network: the reader gets a private IPv4 address, uses WPA2/WPA3 (not WiFi 6-only),
      and the reader diagnostics screen passes DNS/Stripe/events. Ethernet dock if WiFi is weak.
- [ ] Register by pairing code from Admin on the iPad (Safari, installed PWA). The reader appears
      online in the terminal status bar within a minute.
- [ ] The tipping config shows the location presets on the reader (allow ~5 min to propagate).
- [ ] Physical test card, sandbox, at these amounts:
  - [ ] `$x.00` approve: tap, chip and swipe.
  - [ ] `$x.05` generic decline, then retry with the same order.
  - [ ] `$x.55` incorrect PIN.
  - [ ] Tip chosen so the total ends `.00`.
- [ ] The customer presses cancel on the reader: the POS shows "Customer canceled" and retry works.
- [ ] The cashier cancels mid-collect: the reader returns to the splash screen and the PI is canceled.
- [ ] Pull the reader's power mid-payment. The POS shows offline. Reset the reader, then sync;
      no double charge (check the Dashboard via "View as" for one PI).
- [ ] Turn the iPad's WiFi off mid-payment, then back on. The tender resumes, and its status
      matches the Dashboard.
- [ ] Shop internet down: the terminal banner reads cash-only, cash orders queue and sync later,
      and card is disabled.
- [ ] Two tablets on the same reader: the second gets "Reader busy" and nothing breaks.
- [ ] Printed receipt shows the application name, AID and last4. Email receipt (if enabled)
      arrives in live mode.
- [ ] Full and partial refund of a captured card tender. The application fee is refunded
      proportionally.
- [ ] Reader software update overnight: the next morning's first payment works. Readers update
      when idle and powered.
- [ ] Live mode: one real $1.00 sale and refund on Snax's card. The payout lands in the
      **tenant's** account, and the application fee lands on the platform.

## Alternatives considered

- **Terminal JS SDK:** rejected for the pilot (see the comparison). It adds LAN/local-DNS
  coupling, browser Local Network Access prompts, a runtime script that must load live from
  js.stripe.com (bad for an offline-cached PWA), and connection-token handling. It buys no
  offline capability. If ever needed, the server-side pieces in this plan carry over: Locations,
  readers, PI creation, sync/verification, `applyRailStatus`, refunds and receipts. Only the
  client swaps to `discoverReaders({location})` / `connectReader(r, {fail_if_in_use: true})` /
  `collectPaymentMethod(clientSecret, {config_override})` / `processPayment`, plus the
  `onUnexpectedReaderDisconnect` re-discover-by-saved-serial flow, plus
  `discoverReaders({simulated: true})` and `setSimulatorConfiguration` for tests.
- **Collect-inspect-confirm** (`collect_payment_method` then `confirm_payment_intent`): only
  needed for business logic on the card before authorization. Not needed here; process-immediately
  has fewer calls and fewer webhooks.
- **Manual capture:** see section 3. It is only worth it if fees must include on-reader tips.
- **Platform-owned readers** (private preview, server-driven): this would let us own the hardware
  across tenants. It isn't needed while each pizzeria has its own readers. Reconsider if we
  lease hardware.
- **Native wrapper for offline:** see Offline. Defer until the pilot shows outage pain.

## Risks

- **No offline card.** This is a product-promise change from PLAN.md. Mitigate with the
  cash-only banner, an S710 plus hotspot, and clear tenant onboarding copy.
- **Webhook misconfiguration.** Polling sync makes webhooks non-critical while the tablet is up.
  The reconcile cron covers a dead tablet, and the E2E asserts `webhook_seen_at`.
- **Reader stuck `in_progress` after a mid-payment disconnect.** Covered by the Reset button and
  the sync-before-retry rule. The PI is the source of truth, so no double charge.
- **Stripe API latency on Vercel cold starts while polling.** Acceptable. Keep the poll at 1.5s
  and abort in-flight polls on unmount.
- **Address data quality** for Locations. The admin form validates US state and ZIP.
- **Test↔live key flip** leaves stale `tml_`/`tmr_` rows. Handled by `livemode` and account
  matching, with a "re-register readers" notice.
- **Dependency ordering** with the online plan and connect-hardening. Merge both first, or move
  the listed pieces here.
- **Pricing drift:** reader prices are from stripe.com as of Oct 2026. Re-check in the Dashboard
  shop before ordering.

## Open questions for Snax

1. **Hardware:** S700 ($299) for the pilot? S710 (+$10/mo LTE) if the shop's internet is shaky?
   Or a T600 countertop (check the US price in the Dashboard)? Does the platform order and ship
   it, or does the pizzeria order it on their own account?
2. **Platform fee on tips:** with on-reader tipping, take the fee on the pre-tip amount only
   (recommended, simple, automatic capture), or include tips, which needs manual capture plus a
   fee update at capture (+0.5 d)?
3. **Offline:** accept "card needs internet, cash when offline" for the pilot, and update PLAN.md?
   Native offline (Capacitor or Apps on Devices) would be a separate multi-week project.
4. **Who can refund card payments:** owner/manager only, or cashier with a manager PIN?
5. **Email receipts** through Stripe (`receipt_email`) in v1, or printed only?
6. **Test-mode E2E environment:** same answer as online plan question 2 (staging with `sk_test`)?
7. **Delete `/api/payments/stripe/connection-token`** now that we're server-driven? (Recommended.)
8. **Default tip mode** per location: `reader` (recommended for counter service) or `pos`?

## Size estimate

About **5.5–6 dev-days**, roughly 1.8–2.2k LOC including tests. Add **+1 day** if online-plan
track A (`applyRailStatus`, F7, F8, compare-and-set, Connect webhook) hasn't landed and has to
be done here.

| Area | Estimate |
|---|---|
| Migration, types, driver methods (mock + supabase), RLS test | 0.75 d |
| Stripe terminal API wrapper, terminal module (locations/config/readers/flow/sim), rail fixes | 1.25 d |
| Routes (admin, terminal, webhook branch, refund auth) | 0.75 d |
| Admin card-readers UI | 0.5 d |
| Terminal UI (reader picker/status, card states, resume, receipt fields) | 1.0 d |
| Service-worker rules, docs | 0.25 d |
| Unit tests + zero-env E2E | 0.75 d |
| Stripe test-mode E2E + sandbox setup | 0.5 d |
| *Optional:* reader cart display (`set_reader_display`) | +0.25 d |
| *Optional:* manual capture with fee-on-tip | +0.5 d |

Suggested implementer split:
- **(A)** DB, server module and routes in simulated plus `stripe_test` mode, fully unit-tested.
  Shippable dark behind the readiness gate.
- **(B)** Admin and terminal UI plus SW, with the zero-env E2E.
- **(C)** Test-mode E2E plus the field test with real hardware.

## Decisions (Snax, 2026-10-29)
- Hardware: **Stripe Reader S700** ($299), plus a Stripe physical test card. Snax orders them. Develop against the simulated reader until they arrive.
- Offline: **cash-only when offline** for the pilot. Card needs internet; a phone hotspot is the backup. Correct PLAN.md, PRODUCTION_READINESS §3 and the rail header comment, which wrongly promise offline cards.
- Integration: server-driven, as recommended.
