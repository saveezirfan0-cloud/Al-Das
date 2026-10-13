# Sanoflow flow inventory (fill by hand)

One row per flow in Sanoflow → Flows. Use it to decide what Pulse must rebuild before cut-over and to prove nothing was forgotten. Fill it from the Sanoflow flow list and each flow's canvas. **No patient data**: flow names, triggers and what the flow does only.

How to fill each column:

- **Trigger**: what starts the flow in Sanoflow: conversation opened / closed / waiting, new message, template button, WhatsApp Flow completed, shortcut, drip on a segment, enquiry added / stage / status changed, incoming webhook, recurring, 24 h window closing.
- **What it does**: the nodes in plain words, e.g. "asks for preferred branch (buttons), assigns to Front desk team, adds tag New patient".
- **Calls Make / an API?**: any API Action node. Name the Make scenario if you know it (docs/audit/make-scenarios.md).
- **Pulse equivalent**: a starter flow, a native trigger or node, a Pulse setting (reminders, round-robin, office hours), or **gap**. Gaps are tracked in docs/20 §4 (rows G0 to G4 for flows).
- **Rebuilt?**: `yes`, `no`, `not needed` (say why in Notes).
- **Checked by / date**: who tested the Pulse version end to end (webhook simulator or training mode).

| # | Sanoflow flow name | Active? | Trigger | What it does | Calls Make / an API? | Pulse equivalent | Rebuilt? | Checked by / date | Notes |
|---|---|---|---|---|---|---|---|---|---|
| 1 | | | | | | | | | |
| 2 | | | | | | | | | |
| 3 | | | | | | | | | |
| 4 | | | | | | | | | |
| 5 | | | | | | | | | |
| 6 | | | | | | | | | |
| 7 | | | | | | | | | |
| 8 | | | | | | | | | |
| 9 | | | | | | | | | |
| 10 | | | | | | | | | |

## Things to know before mapping

- Pulse's **Create/update enquiry, Add task, Portal record and Book appointment** nodes are not wired yet (docs/20 §4, row G0). A Sanoflow flow that creates or moves enquiries cannot be rebuilt natively until Phase 20b fixes that.
- Pulse has no **new-message**, **24 h window closing** or **WhatsApp Flow completed** trigger yet (G2); the Question node has no typed validation or re-ask (G4).
- Drip flows attached to segments: list them here with the segment name; the segment itself comes over with `pnpm import:sanoflow:all` (static) or is rebuilt by hand (dynamic, listed in the import report).
- Appointment reminders, round-robin assignment, office hours and SLA alerts are **settings** in Pulse, not flows. Mark such flows "Pulse equivalent: setting" and note which one.
