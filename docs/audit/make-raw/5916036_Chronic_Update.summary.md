### Chronic Update (id 5916036) — ACTIVE
Trigger: Make custom webhook (hook 2679889, label "chronic update"), max 100 runs/min. Called by a Sanoflow flow's API Action node. Historical ops ≈ 2.
Blueprint not stored in this repo: the saved sample bundle contains a real patient (name, phone, PIN). Module tree below is complete; nothing else is in the blueprint.

Webhook payload (keys): `Mobile` (E.164 phone), `Status` (`Replied` | `Booked`), `Trigger Data` (JSON string `{"workflow_id": "<sanoflow flow id>", "contact_channel_id": "<id>"}`).

- [2] gateway:CustomWebHook
- [3] builtin:BasicRouter
  ↳ route A (filter `{{2.Status}} = "Replied"`)
    - [4] airtable:ActionSearchRecords: base=appkOnjPr1SMD83CP; table=tbldCbNEKeF5NrTCs (Chronic Recall Messages); formula `{Phone} = '{{2.Mobile}}'`; maxRecords 10
    - [6] airtable:ActionUpdateRecords (filter `{{4.id}}` exists): `Patient Replied = Yes`, `Reply Date = today` — runs once **per matching row**
  ↳ route B (filter `{{2.Status}} = "Booked"`)
    - [7] airtable:ActionSearchRecords: same table, same phone formula, maxRecords 10
    - [8] airtable:ActionUpdateRecords (filter `{{7.id}}` exists): `Appointment Booked = Yes`, `Booking Date = today`

**Behavioural notes**
- Matching is by phone only, so every recall row ever sent to that number is updated (test and live, any condition). No link to the template or send that was actually replied to.
- `Follow Up Status` (the call-list field) is **not** touched; a webhook "Booked" clears the call list only indirectly, because `Reply Date` becomes non-blank.
- The Sanoflow side (the flow that posts here) was not exported; it is replaced natively by the inbound-reply handler on `recall_sends` (see `make-replacement-design.md` §6).
