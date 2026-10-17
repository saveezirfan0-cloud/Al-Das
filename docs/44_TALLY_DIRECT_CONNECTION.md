# Tally bridge: the direct HTTPS connection to a hosted Tally

_Built 17 Oct 2026 after the 16 Oct meeting (docs/43, workstream W7): the Tally partner is to supply "API authentication,
endpoints and integration details". This prepares Pulse so that, when they arrive, an administrator types them in and
switches the bridge on. Builds on the 22J bridge (`docs/22_PHASE_22J_NOTES.md`); nothing of 22J changes._

## What Tally's "API" is

TallyPrime has no cloud API and no API keys of its own. Every integration goes through **Tally's built-in HTTP server**
on the PC (or TallyPrime Server host) where the company is open: requests are XML (`ENVELOPE` / `HEADER` / `BODY`, the
`Export` and `Import Data` requests the bridge already uses), and from **TallyPrime 7.0** the same server also accepts
**JSON**. It listens on a port (9000 by default) and **has no password**: anyone who can reach the port can read and
change the books.

So "API credentials" from a partner can only mean one of two set-ups, and Pulse supports both:

| Set-up | What the partner gives | In Pulse |
|---|---|---|
| **Tally on a clinic PC** (the usual case) | Nothing to authenticate: Tally's port stays on that PC | The 22J **connector** (provider "Pulse Tally connector"): installed on the PC, pairs with a one-time code, calls Pulse outbound only |
| **Hosted Tally** (partner cloud server, Tally on a remote desktop host, TallyPrime Server behind a gateway) | An **https address** in front of Tally's port and a **token, user name and password, or API key** that the gateway checks | **Hosted Tally over HTTPS** (provider `https`): Pulse sends the same jobs itself, every 15 minutes |

A partner's gateway that publishes Tally's port on plain `http://`, or on an IP address, is refused: the books would be
open to anyone on the network path. Ask for TLS and a host name.

## How the direct connection works

- **Settings** (Settings, Integrations, Tally bridge, `integrations.manage`, typed words `CONNECT TALLY`): the Tally
  company name (as before), the address (`https`, public host name, any port, no query string), the sign-in (Bearer
  token, HTTP Basic, or an API key in a named header) and the secret, stored AES-256-GCM in `integration_accounts.config_enc`.
  `tallyDirectConfigProblems` (`lib/accounting/tally/direct.ts`) is applied on save and again before switching on.
- **Test connection** sends one GET to the address with the sign-in (Tally answers its root with a short "running"
  line); it reads and writes nothing in Tally. A 401/403 is reported as rejected credentials.
- **Pulse as its own device.** The bridge's job protocol is device-centric, so the 15-minute `accounting_tally_bridge`
  task asks `acc_tally_bridge_direct_device` for the organisation's direct device (`acc_tally_devices.transport =
  'direct'`, a token nobody holds and the connector door refuses), recording whether Tally answered. While it does, the
  task claims jobs with `acc_tally_bridge_claim`, runs each with `runDirectJob` (the connector's `runJob`, line for
  line) and hands the answer to the same `applyResult`. Pulls, the trial-balance check, pushes, the ten-minute
  no-answer rule and the look-up before a resend are therefore exactly 22J's.
- **The requests** are the connector's own (`lib/accounting/tally/envelopes.ts`, a TypeScript copy of
  `connector/tally-bridge/lib/envelopes.mjs`; a test checks both give the same bytes). The only XML taken from the
  database is one Pulse voucher, built by `buildBridgeVoucherXml`.
- **Calls** go through `createIntegrationClient`: only the configured host, https, no redirects, 60 s timeout, a 32 MB
  answer cap, the stored circuit breaker, one `integration_calls` row per attempt under `tally_direct` (operation names
  only, never the address, a header or a body). Exports and look-ups are reads and are retried; an **import is never
  sent twice by the client**: after a timeout or a 5xx it is reported as no answer, and the bridge looks the voucher up
  by its REMOTEID before sending it again (exactly the connector's rule). A 4xx from the gateway (sign-in, address) means
  nothing reached Tally and the job is asked again later. The client now also returns the answer's raw bytes, because
  Tally can answer in UTF-16.
- **One connection per organisation.** Taking the direct connection revokes an active connector and re-queues its
  unanswered jobs (an import only after a look-up); pairing a connector revokes the direct device. Revoking the direct
  device on the Tally bridge page keeps it off until the integration's settings are saved again or it is switched off and
  on. Training workspaces never push (22J rule, unchanged).

## Setting it up when the credentials arrive

1. On the partner call (docs/43, seven questions) confirm which set-up it is. If Tally stays on a clinic PC, use the 22J
   connector and its README; nothing here is needed.
2. For a hosted Tally, get: the https address (host name and port), the sign-in method and secret, the exact company
   name(s), the TallyPrime release, and that the address is reachable from the internet only through the gateway.
3. In Tally create the eight Pulse voucher types (22J notes, step 3) in each company Pulse will write to.
4. Settings, Integrations, Tally bridge: choose **Hosted Tally over HTTPS**, enter the company name, address, sign-in and
   secret, save, **Test connection**, then switch on (typed words).
5. Accounting, Setup, Tally bridge: pull only first; check the trial balance card; then push from a chosen date (22J
   notes, steps 7 and 8). The page shows the device as "Direct HTTPS connection".

## Not done yet (on purpose)

- **Several Tally companies.** One company name per organisation, as in 22J. Al Das runs several companies in Tally; a
  second company needs its own Pulse entity mapping and a company per job (docs/43 W7).
- **JSON.** TallyPrime 7.0's JSON format is not used: the XML requests work on every TallyPrime release and the parser,
  tests and voucher writer are XML. Switch only if the partner's gateway accepts JSON alone.
- **Partner REST add-ons.** Some partners sell a TDL add-on that exposes their own REST endpoints. Those shapes are the
  partner's, not Tally's; they need a separate adapter once the documentation is in hand.
- **Not verified against a live hosted Tally.** The request shapes are the connector's (themselves unverified against a
  real company, 22J notes); the gateway behaviour is from the general HTTP rules above.

## Tests

- `tests/unit/accounting/tally/direct.test.ts`: envelopes equal to the connector's; UTF-16 answers; address rules (http,
  IP, internal names, credentials in the address, query string, trailing dot refused; a port allowed); sign-in per mode;
  readiness and save validation; a job run (exports, look-up found, look-up then import, look-up only, ambiguous and not
  sent); through the shared client: only the configured host, the sign-in header, Tally's bytes kept, an import not
  retried after a 502 while a read is, a refused sign-in reported, Tally down.
- `tests/db/tally-direct.test.ts`: created only while the integration is on; replaces the connector and re-queues its
  jobs; reused; its token refused at the connector door; an administrator's revoke holds until the integration changes;
  a connector pairing replaces it; service role only.

Migration `20261209000400_tally_direct_connection.sql` (paste `94_tally_direct_connection.sql`, after 93).
