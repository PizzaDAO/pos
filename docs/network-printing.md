# Network kitchen printing

Tickets reach a real printer through a per-printer **pull** queue, so it works
from serverless (Vercel) with no inbound connection to the shop. The printer
polls HTTPS endpoints on this app; nothing connects to the printer.

Status: built and tested against a **simulated poller only**
(`scripts/simulate-printer.mjs`). No physical printer has been tried; the Star
markup and Epson XML follow the vendor docs but are unverified on hardware.

## Protocols

| Protocol | Endpoint (token in path) | Notes |
|---|---|---|
| Star CloudPRNT | `/api/print/star/<token>` | `POST` poll, `GET ?token=<job>` fetch, `DELETE ?token=<job>&code=` confirm |
| Epson Server Direct Print | `/api/print/epson/<token>` | form `POST`: `ConnectionType=GetRequest` / `SetResponse` |

**Star format.** Jobs are served as `text/vnd.star.markup` (Star Document
Markup): the simplest thing CloudPRNT accepts that still gives a large order
number (`[magnify: width 3; height 3]`, `[bold: on]`, `[align: centre]`,
`[cut: feed; partial]`). It needs no byte encoding. Printers whose firmware lacks
markup can be set to **Plain text** (`text/plain`, big text becomes uppercase).
Raw ESC/POS/StarPRNT binary was rejected: it needs per-model command sets.

**Epson.** Jobs are ePOS-Print XML (`<epos-print>`) wrapped in `PrintRequestInfo`;
`printjobid` is the job uuid as 22-char base64url (Epson's limit is 30).

## Data model (migration `20261113000000_print_network.sql`)

- `print_printers`: per printer; `token_hash` = sha256(secret); `columns` 42|48.
- `print_jobs`: per-printer queue, `document` jsonb (protocol-neutral lines),
  status `queued -> sent -> done|failed|expired`, `expires_at`, `dedupe_key`.
- `print_location_settings`: `auto_print` (default **off**).

All three: RLS enabled + forced, no policy, every grant revoked from
`anon`/`authenticated` (the token hash is a credential). Only the service-role
server path touches them; the admin UI goes through `/api/admin/printers`.

## Behaviour

- **Auth**: token = `<printerId>.<secret>` (printerId must be a uuid, junk is a bare 401);
  shown once at creation, only the hash is stored. **Rotate token** (Admin > Printers)
  issues a new secret and revokes the old one at once. Bad id and bad secret are both a
  bare 401. The printer id used for every query comes from the verified token, never the
  request, so a printer only sees its own jobs. Setup URLs use `NEXT_PUBLIC_APP_URL`
  when set (else the request origin).
- **The token is in the URL path, so it appears in request logs** (Vercel logs, any
  proxy). Limit log access, and rotate if a log leaks. Printers cannot send headers,
  which is why it is not an `Authorization` header.
- **Expiry**: tickets expire after 30 min (test tickets 10 min) and are never served late.
- **Reclaim**: a job served but not confirmed within **120 s** is served again (long
  enough for a slow printer; a lost confirm after a real print can still produce one
  duplicate, so keep it above the printer's worst print time).
- **Failures retry**: a failed print (Star non-2xx `code`, Epson `success="false"`: paper
  out, cover open) goes back to the queue with backoff 30 s / 60 s / 120 s, up to 4
  attempts or expiry, then is final (`failed`). A banner on the KDS and Admin > Printers
  ("Kitchen printer: 2 tickets not printed (paper out)", plus offline printers) offers
  **Retry**, which requeues failed, unexpired tickets (`/api/kitchen/printers`).
- **Duplicates**: the kitchen print page sends once per order per printer
  (`manual:<orderId>` dedupe key), so a refresh, a restored tab or a second KDS screen
  does not queue another ticket. Any ticket for an order that already has one on that
  printer (including the auto-print one) is stamped `*** REPRINT ***`. Only the explicit
  **Reprint** button queues another copy.
- **Auto-print**: per-location toggle, off by default. `scheduleAutoPrint` runs via
  `after()` (never on the money path, never throws) when an order fires: in-store
  (`POST /api/orders`), `/v1` placed orders, `/v1` held orders on release, and online
  orders after payment, including the crash-recovery sweep (`runPostPaymentSteps`).
  Keyed `fire:<orderId>` so each path is idempotent.
- **Retention**: done/failed/expired jobs are deleted after 3 days by the existing
  `/api/cron/expire-online-orders` cron.
- **Fallback**: `resolveTicketPrinter` uses the network printer when the location has
  one, else the browser print dialog.
- Ticket text is sanitised to ASCII; `[`/`]` become parentheses and `\` becomes `/`
  (whether Star markup treats backslash specially is unverified).

## Printer setup

- Star (mC-Print3, TSP100IV, ...): printer web UI -> CloudPRNT -> enable, Server URL = the setup URL.
- Epson (TM-T88VI/VII with Server Direct Print): Epson TM Server Direct Print settings -> URL 1 = the setup URL.

## Trying it without hardware

```
npm run dev -- -p 3401
# Admin > Printers > Add printer (copy the setup URL), "Print test ticket", then:
node scripts/simulate-printer.mjs <setup-url> --once      # add --fail to simulate a jam
```
