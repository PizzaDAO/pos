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

- **Auth**: token = `<printerId>.<secret>`; shown once at creation, only the hash
  is stored; rotate by removing and re-adding. Bad printer id and bad secret are
  both a bare 401. The printer id used for every query comes from the verified
  token, never the request, so a printer only sees its own jobs.
- **Expiry**: tickets expire after 30 min (test tickets 10 min) and are never served late.
- **Retry**: a served job not confirmed within 60 s is served again.
- **Confirm** is idempotent (repeat/unknown/foreign ids return 200 and change nothing;
  a finished job never flips state). A non-2xx Star `code` / Epson `success="false"` marks it `failed`.
- **Reprint** queues a fresh job (`POST /api/kitchen/print {orderId, reprint:true}`; the
  Reprint button on `/kitchen/ticket/<id>`), printed with a REPRINT banner.
- **Auto-print**: per-location toggle in Admin > Printers. `autoPrintOnFire` runs after
  an in-store order is placed (`POST /api/orders`) and after an online order is paid
  (`finalizeOnlinePayment`), keyed `fire:<orderId>` so a retry never double-prints.
  Orders released from a hold, and `/v1` API orders, do not auto-print yet (use Reprint).
- **Fallback**: `resolveTicketPrinter` uses the network printer when the location has
  one, else the browser print dialog.

## Printer setup

- Star (mC-Print3, TSP100IV, ...): printer web UI -> CloudPRNT -> enable, Server URL = the setup URL.
- Epson (TM-T88VI/VII with Server Direct Print): Epson TM Server Direct Print settings -> URL 1 = the setup URL.

## Trying it without hardware

```
npm run dev -- -p 3401
# Admin > Printers > Add printer (copy the setup URL), "Print test ticket", then:
node scripts/simulate-printer.mjs <setup-url> --once      # add --fail to simulate a jam
```
