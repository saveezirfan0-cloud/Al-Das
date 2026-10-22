# Sending through Sanoflow (OQ-182)

Owner decision, 20 Oct 2026: **Sanoflow stays.** It keeps the clinic's WhatsApp numbers and its inbox. What moves to Pulse is
Make, the Airtable automations and the Airtable data. Make sends its reminders, birthday and chronic recall messages through the
Sanoflow API, so Pulse's native replacements send the same way. The logic each Make scenario carried, and how Pulse matches it,
is in `docs/49_MAKE_LOGIC_MATRIX.md`.

## What was built

| Part | Where |
|---|---|
| A WhatsApp number can send through Sanoflow: `channels.transport` (`meta` default, or `sanoflow`). A Sanoflow number has `waba_id 'sanoflow'` and `phone_number_id 'sanoflow:<uuid>'`, so no Meta id is ever on it; its transport cannot change (trigger) | `supabase/migrations/20261224000100_sanoflow_transport.sql` (paste file `107_`) |
| Each Pulse template can carry Sanoflow's template number (`wa_templates.sanoflow_template_id`, for example 11885) | same migration |
| The integration "Send through Sanoflow" (kind `sanoflow`): API key and webhook token encrypted, phone format, off by default, Admin and the typed words `SEND THROUGH SANOFLOW` | `lib/integrations/catalog.ts` |
| The adapter on the shared integration client: `send-template` with Make's exact body `{template_id, phone, mapper_value}` and the `access-token` header; the key check asks for contact id 0 (no patient comes back) | `lib/integrations/sanoflow/client.ts`, `config.ts` |
| The outbound job hands a Sanoflow number's messages over after all its own guards (training mode, campaign withdrawal, paused number, template time limit, the per-number send slot); no Meta client is built | `lib/jobs/handlers/outbound.ts`, `lib/integrations/sanoflow/deliver.ts` |
| `clientForChannel` refuses a Sanoflow number (`SanoflowNumberError`); the nightly template and pricing syncs skip them | `lib/whatsapp/channel.ts`, `lib/jobs/handlers/templates-sync.ts`, `wa-pricing.ts` |
| The "replied / booked" webhook that replaces Make's "Chronic Update": a Sanoflow flow posts `{"Mobile", "Status"}`; Pulse credits the patient's newest open recall send | `app/api/webhooks/integrations/sanoflow/[accountId]/route.ts`, `lib/integrations/sanoflow/webhook.ts`, `attributeExternalReply` in `lib/recall/attribution.ts` |
| Settings, Integrations, Send through Sanoflow: add the Sanoflow number, link templates to their Sanoflow numbers, copy in a template that is approved in Sanoflow, and the webhook address | `app/(app)/settings/integrations/sanoflow-panel.tsx`, `sanoflow-actions.ts` |

## Make's contact writes (owner decision 22 Oct 2026, docs/49 D9 and D11)

The owner asked for Make's behaviour around its sends to be kept, so the Sanoflow sender now also writes to Sanoflow contacts.

| Make step | Pulse | Where |
|---|---|---|
| Reminder refused with `{"error":"Bad Request","message":"Invalid channel details.", …}`: `contacts/list?phone=`, then for a contact found `v1/contacts/add` (first and last word of the name, phone) and the template sent again | Same, for messages queued as an appointment reminder (`payload.context.kind = "appointment_reminder"`, set by `sendAppointmentTemplate`). No contact found, or any failed or ambiguous answer, stops it and the reminder fails as before (task, notice, SMS fallback). The second answer is final: nothing is sent a third time, and nothing is sent again after an answer nobody can read. The new Sanoflow contact id is kept in `external_refs` | `lib/integrations/sanoflow/deliver.ts` (`recoverInvalidChannel`) |
| Birthday: after the send, `contacts/list?contact_id=` (only when the patient has a Sanoflow Contact Id), then `contacts/edit` with the contact's tags plus **3590** and the first and last name | Same, after a **Live** birthday send. The Sanoflow contact id comes from `external_refs` (source `sanoflow`); none means skipped, as in Make. A blank Pulse name keeps Sanoflow's | `lib/integrations/sanoflow/tagging.ts` |
| Chronic recall: `contacts/list?phone=`, then `contacts/edit` with the tags plus **4654** and **label 1800**, names unchanged | Same, after a **Live** chronic send | same |

- Tagging runs as its own job on the `sanoflow_tags` queue (ids only: org, contact, programme), queued by the sender after a successful send. A failed or slow tag write is logged with an outcome word and never touches or repeats the message (`maxReads` 1).
- Test-mode sends never tag (the recall engine passes `live` with each send; the native Pulse tags follow the same rule).
- The tag and label numbers are settings on the integration (defaults 3590, 4654, 1800, Make's), and "Tag Sanoflow contacts after recall sends" can be switched off.
- Unverified: the contacts answers' shapes (read from Make's mapping: `contact_list.data[]` with `contact_id`, `first_name`, `last_name`, `tags[].tag_id`), the id a `contacts/add` answer carries, and the phone format the contacts endpoints expect. Make looked contacts up with the number after the "-" of Unite's text; Pulse uses the same phone format as the sends. Check one of each with a clinic test contact before going Live.

## Rules the sender follows

- Only APPROVED templates, never an authentication (code) template, and only one with a Sanoflow template number.
- Values go in body order (`{{1}}`, `{{2}}`, …). Named variables, header or button variables, carousels, gaps in the numbering and
  missing values are refused rather than guessed (`lib/integrations/sanoflow/params.ts`).
- A Marketing template never reaches someone with `stop_marketing` (checked again at send time, rule 11). Consent and opt-in are
  decided where the message is queued, exactly as for Meta numbers. A 131050 in Sanoflow's answer sets `stop_marketing`.
- The send has no idempotency key. The message is claimed `queued -> sending` first; a 5xx, a timeout or a message found already
  "sending" is marked failed and never sent again, and emits no `message.failed`, so neither the template retry nor the SMS
  fallback sends a second copy. A 429 is retried by the queue.
- Text, media and interactive messages are refused on a Sanoflow number: replies to patients stay in Sanoflow.
- The call log (`integration_calls`) holds provider, operation, outcome, status and latency only.

## Set-up, in order

1. In Sanoflow, create a **new** API key (the one inside Make is rotated at cut-over; OQ-26).
2. Settings, Integrations, **Send through Sanoflow**: paste the key, choose a webhook token (32+ letters or digits) and save.
   Press Test connection.
3. In the same page, **Add Sanoflow number** (name, the clinic's number, speed; 5 a second is a safe start).
4. For each template the automations use, **Add a template that is approved in Sanoflow**: the Sanoflow template number, the
   name, language, category and the body text exactly as in Sanoflow. The numbers Make uses today: appointment reminder 11885;
   birthday 12289, 12291, 12294, 12295, 12296; chronic recall 13159 to 13169 (and 13170 as Make's default, OQ-24).
5. Map the templates as usual: Settings, Appointments (reminder template), Recall (each segment's template), flows and campaigns.
6. In Sanoflow, add an API Action to the flow that called Make's "Chronic Update", posting to the webhook address shown on the
   page with the header `x-pulse-token: <token>` and the same body Make received.
7. Switch the integration on with the typed words. Keep the recall programmes in Test mode and reminders in test mode during the
   parallel week (docs/49 D-items), then switch Make's scenario off on the same day Pulse's goes live.

## Not verified

Nothing here has been sent to the real Sanoflow API. The request shape is copied from Make's live blueprints; the answer's shape
is unknown (Make never reads it), so a 2xx is accepted unless its JSON says it failed. Confirm with one test send to a clinic
phone: the phone format (digits only is the default, from Make's inputs), the answer, and whether Sanoflow counts the message in
its own inbox. The contact writes described above are unverified the same way.

## Tests

`tests/unit/integrations/sanoflow.test.ts` (adapter, mapping, webhook, set-up, catalogue, source guards),
`tests/unit/integrations/sanoflow-contacts.test.ts` (contact list parsing, tag merge, name split, the D9 and D11 decisions, the
contacts calls on the shared client) and `tests/db/sanoflow-service.test.ts` (constraints, the outbound job end to end with a fake
fetch, the invalid-channel retry, the tag job and its contacts/edit bodies, the webhook crediting the newest send).
`tests/setup.ts` blocks `sanoflow.io`.
