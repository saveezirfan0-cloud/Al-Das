# Pulse Tally bridge connector

A small program for the PC where TallyPrime runs. It keeps Tally in step with Pulse until the ledger start (Phase 22J,
`docs/22_PHASE_22J_NOTES.md`):

- it talks to Tally **only on this PC**, at `http://127.0.0.1:9000` (the port is a setting);
- it calls Pulse **only over HTTPS, outbound**. Nothing on this PC listens for connections, so no port forwarding or VPN
  is needed and Tally is never exposed to the internet;
- it runs **four kinds of job and nothing else**: export the masters changed since an AlterID, export the vouchers changed
  since an AlterID, export the ledger closing balances for the trial-balance check, and import **one** voucher that Pulse
  created (its REMOTEID starts with `pulse-`, ACTION Create). It refuses anything else, including any delete;
- after an import whose answer never came, the next attempt first looks the voucher up in Tally by its REMOTEID and sends
  it only if Tally does not have it, so a voucher is never created twice;
- it keeps nothing except its own device token, and logs job types, outcomes and timings only (no amounts, names or XML).

It needs **Node.js 20 or newer** and has **no dependencies** (nothing to `npm install`).

| File | What it is |
|---|---|
| `bridge.mjs` | the command line: `pair`, `check`, `once`, `run` |
| `lib/core.mjs` | the loop: poll Pulse, run each job, post the answer |
| `lib/envelopes.mjs` | the export requests sent to Tally (built here from numbers and dates, never taken from Pulse) |
| `lib/validate.mjs` | what is accepted from Pulse (the job allow-list and the single-voucher import check) |
| `bridge.config.json` | written by `pair`: the Pulse address, the Tally port and the device token (keep it private) |

## 1. Prepare TallyPrime (once)

Menu names move a little between releases (OQ-127); these are TallyPrime 2.x to 7.x.

1. **XML server on this PC only.** Press **F1 (Help) > Settings > Connectivity** (older releases: **F12 Configure >
   Advanced Configuration**). Set *TallyPrime acts as* = **Server** (or Both), *Enable ODBC* = **Yes**, *Port* =
   **9000** (any free port; then pass `--port` when pairing). Restart TallyPrime. The company must be **open** for the
   bridge to work; leave Tally running during working hours (or use TallyPrime Server, which runs as a service).
2. **Block the port from the network.** Tally's XML port has no password: anyone who can reach it can read and change the
   books. In *Windows Defender Firewall with Advanced Security* add an **inbound rule** that **blocks** TCP 9000 for all
   remote addresses, or run once in an administrator PowerShell:

   ```powershell
   New-NetFirewallRule -DisplayName "Block Tally XML port (Pulse bridge uses 127.0.0.1 only)" `
     -Direction Inbound -Protocol TCP -LocalPort 9000 -RemoteAddress Any -Action Block
   ```

   The connector itself only needs **outbound HTTPS (443)** to the Pulse address.
3. **The Pulse voucher types.** Pulse sends its vouchers in dedicated types so they never mix with the ones the team types
   in. In Tally: **Create > Voucher Type**, once for each line below. *Select type of voucher* = the base type,
   *Method of voucher numbering* = **Manual**, *Prevent duplicates* = **Yes**; everything else as offered.

   | Name | Select type of voucher |
   |---|---|
   | Pulse Journal | Journal |
   | Pulse Payment | Payment |
   | Pulse Receipt | Receipt |
   | Pulse Contra | Contra |
   | Pulse Sales | Sales |
   | Pulse Purchase | Purchase |
   | Pulse Credit Note | Credit Note |
   | Pulse Debit Note | Debit Note |

   Pulse numbers each voucher itself (`PB-` and ten characters; a reversal ends in `-R`).

## 2. Install the connector

1. Install Node.js 20 LTS (or newer) from nodejs.org, for all users.
2. Copy this folder to `C:\PulseTallyBridge` (any folder only administrators and the service account can write to).
3. In Pulse, an administrator switches on **Settings > Integrations > Tally bridge** (type `CONNECT TALLY`) and enters
   the Tally company name exactly as Tally shows it. That is the default entity's company; each other Pulse entity
   gets its own under **Accounting > Setup > Entities and fiscal years**. One connector serves every company loaded in
   this Tally: Pulse names the company in each job and the connector refuses an import whose voucher names another one.
   Every company the bridge serves must be **open** in Tally (that several can be loaded at once is not yet checked
   against a real TallyPrime: ask the Tally partner).
4. In Pulse, **Accounting > Setup > Tally bridge > Create a pairing code** (it is shown once and works for 30 minutes).
   On the Tally PC, in a command prompt:

   ```bat
   cd C:\PulseTallyBridge
   node bridge.mjs pair --url https://<your Pulse address> --code XXXX-XXXX-XXXX-XXXX
   node bridge.mjs check
   ```

   `check` should say `Tally on 127.0.0.1:9000: ok`. Pairing a new connector revokes the previous one.
5. **Protect the settings file** (it holds the device token):

   ```bat
   icacls C:\PulseTallyBridge\bridge.config.json /inheritance:r /grant:r "SYSTEM:F" "Administrators:F"
   ```

   (On Linux or macOS the file is written readable by its owner only.)

## 3. Run it as a Windows service (NSSM)

1. Download NSSM from nssm.cc (`nssm.exe`, 64-bit) and put it in `C:\PulseTallyBridge\nssm`.
2. In an administrator command prompt:

   ```bat
   cd C:\PulseTallyBridge
   nssm\nssm.exe install PulseTallyBridge "C:\Program Files\nodejs\node.exe" "C:\PulseTallyBridge\bridge.mjs run"
   nssm\nssm.exe set PulseTallyBridge AppDirectory C:\PulseTallyBridge
   nssm\nssm.exe set PulseTallyBridge AppStdout C:\PulseTallyBridge\logs\bridge.log
   nssm\nssm.exe set PulseTallyBridge AppStderr C:\PulseTallyBridge\logs\bridge.log
   nssm\nssm.exe set PulseTallyBridge AppRotateFiles 1
   nssm\nssm.exe set PulseTallyBridge AppRotateBytes 5000000
   nssm\nssm.exe set PulseTallyBridge Start SERVICE_AUTO_START
   mkdir logs
   nssm\nssm.exe start PulseTallyBridge
   ```

   If Tally runs under a user session rather than as TallyPrime Server, the service still works: it only needs Tally's
   XML port on 127.0.0.1, which answers while that user has Tally open with the company loaded.
3. Within a minute the Tally bridge page in Pulse shows the connector as seen, and whether Tally answers.

Stop or remove it with `nssm\nssm.exe stop PulseTallyBridge` / `nssm\nssm.exe remove PulseTallyBridge confirm`.

## 4. What it does every round

Every 30 seconds (Pulse can ask for longer): it checks that Tally answers on 127.0.0.1, asks Pulse for jobs (sending
its version and Tally's state; Pulse hands out jobs only while Tally answers), runs them one after another and posts each
answer back. Tally's own bytes are gzip-compressed (UTF-8 or UTF-16, as Tally wrote them) and Pulse reads them with its
Tally reader. When a round fails it waits 15 seconds, doubling up to 5 minutes.

## 5. At the cut-over

When Pulse's ledger start is set, Pulse stops sending vouchers by itself. Leave the connector running while the last
Tally adjustments are copied into Pulse, then switch pulling off on the Tally bridge page, revoke the connector there,
stop and remove the service, and delete the folder (the token is useless once revoked).

## Not verified

Nothing here was run against a real TallyPrime. The request shapes ($AlterID filters, $RemoteID, ClosingBalance,
SVFROMDATE / SVTODATE), the import answer's counters and the REMOTEID behaviour follow Tally's documentation and community
sources (research addendum A and C). Try it first with a **test company** in Tally (a copy of the books), pull only,
then push a few items and check them in Tally before using it on the live company.
