# Phase 20b: flow parity (G0, G2, G3, G4)

Read with `docs/20_SANOFLOW_REA_PARITY.md` §4 (rows G0, G2, G3, G4) and `docs/21_SANOFLOW_PARITY_PROMPTS.md` (prompt 20b). The flow engine rules are unchanged: one `flow_steps` job per node, an advisory lock per conversation, at most 200 steps, waits and later checks through `scheduled_jobs`, every executor unit-tested, the dry run covering every node.

## G0: the CRM nodes now run (fixed first)

`registerCrmAdapter` was never called, so Create / update enquiry, Add task, Portal record and Book appointment failed closed, and so did the recall starter flow. The import-time registry (`lib/flow-engine/crm-registry.ts`) is **deleted**. `createFlowDeps(admin)` builds the port directly: `crm: createCrmAdapters(admin)` from `lib/flow-engine/crm-adapters.ts`. Nothing depends on import order.

Every adapter goes through the module's own service, so validation, audit, timeline and domain events cannot be skipped:

| Node | Service | Actor | Notes |
|---|---|---|---|
| `create_enquiry` | `createEnquiry` / `moveStage` (`lib/enquiries/service.ts`) | system (`user_id` null) | Empty pipeline = the default one (else the first). `if_open: "update"` (default) moves the patient's open enquiry in that pipeline instead of creating a duplicate. The id is kept as `{vars.enquiry_id}` for later steps |
| `update_enquiry` (new) | `moveStage`, `setStatus`, `movePipeline`, `updateEnquiry` | system | One change per node: stage, status (+ lost reason), pipeline (+ stage), or a field (title, source, est_value, appt_date, `custom.<key>` through `mergeEnquiryCustom`). Acts on `{vars.enquiry_id}`, else the run's enquiry (enquiry triggers) |
| `add_task` | `createTask` (`lib/tasks/service.ts`) | system | Due N hours after the step; linked to the run's contact and enquiry; unassigned unless chosen |
| `portal_record` | `createRecord` / `updateRecord` (`lib/portal/service.ts`) | **the person who published the flow version** (`flow_versions.published_by`) | Their CURRENT role permissions are re-read on every step: someone who lost the object's write permission (or is suspended) makes the step fail closed. Booleans accept yes/no/true/false/1/0; multi-selects are comma lists |
| `book_appointment` | `createAppointment` (`lib/appointments/service.ts`) | system, `source = 'bot'` | Free slot only (same per-specialist lock as the calendar, no override), time must be in the future. Nothing is written to Unite |
| `set_label` (new) | `conversation_labels` | — | Tag must be scope `conversation` in the same org |

"Emits the domain event exactly once": each node calls one service function once; the services return early when nothing changes (same stage, same status), so a replayed step after a crash does not emit a second event. Proven in `tests/db/flow-parity.test.ts` (two stage steps to the same stage → one `enquiry.stage_changed`).

## G2: triggers

| Trigger | When | Durability / guards |
|---|---|---|
| `message_received` | An inbound message on a conversation that was **already open** (`message.received` payload now carries `opened`; the opening message belongs to `conversation_opened`) | Keyword / Source / Ad conditions (keyword = this message). Debounced: no new run of the same flow in the same conversation within `debounce_seconds` (default 120, 30 to 3600), and a live run always owns the conversation. Never for reactions, system notices, template buttons or forms, never when a **person** is assigned (`assignee_user_id`), never for emergency wording (`detectEmergency`) |
| `window_closing` | `minutes_before` (default 60, 5 to 1380) before the 24-hour window ends | Every inbound message schedules one `scheduled_jobs` row `flow.window_closing` per active window_closing flow (dedupe `flow.window:<flow>:<message>`). On fire (`handleWindowClosing`) it re-checks: flow still active and of this type, conversation open, **no newer inbound since the scheduling message** (a reply makes it a no-op; that reply scheduled its own check), window not already closed, number and conditions |
| `wa_flow_completed` | A Meta WhatsApp Flow form reply (`interactive.nfm_reply`) | `lib/flow-engine/wa-flow.ts` parses `response_json`: max 8 000 raw characters, 30 flat fields, 300 characters each, keys `[A-Za-z][A-Za-z0-9_]{0,39}`; nested values dropped. Answers are run variables `{vars.form.<field>}`; optional `flow_token` filter |
| `segment_joined` (drip) | A contact is added to a **static** segment whose `segments.drip_flow_id` is this flow | Statement-level trigger `segment_members_queue_drip` inserts one `flow.drip` scheduled job per new member (only for an active `segment_joined` flow; duplicates ignored). The handler (`handleSegmentJoined`) re-checks segment, drip flow, membership (contact not deleted / erased / merged) and the flow. Runs have no conversation (like Recurring): use Template nodes |

Drip is chosen on the segment (Contacts → segment dialog, "Drip flow"; needs `contacts.manage` **and** `flows.manage`, audited in `segment.updated`) and shown in the builder's trigger panel ("Segments that start this flow"). It starts only for contacts added after it was chosen; existing members are never back-filled. A drip flow from another workspace is refused by the trigger `segments_drip_flow_org_check`. **Dynamic segments keep using the Recurring trigger** (`trigger_config.segment_id`), whose 200-per-tick cap is unchanged (not part of 20b).

## G3: nodes

- `update_enquiry`, `set_label`: above.
- `payment_link`: wraps `createPaymentRequest` (`lib/integrations/payments/request-server.ts`), which refuses when the integration is off, in a training workspace, without credentials or an approved UTILITY template, for an unknown invoice, an amount above the total or an invoice with an open link. New: `actorId` may be null (flow) and `expectContactId` refuses an invoice of another patient (the run's contact must be the invoice's patient or the guardian it resolves to). **Publishing a flow that contains it needs `finance.payment_links`** (`publishFlow`). The per-send tick staff do by hand is replaced by that publish-time permission: decision, see below.
- `meta_event`: wraps `queueCapiEvent` (`lib/integrations/capi/server.ts`), so the event is still built only by `buildCapiEvent()` with all its consent rules (checked when queued and again when sent; `stop_marketing` wins; training sends nothing; 7-day age limit). Uses the patient's latest ad click; no click → `no_ad_click` (normal outcome). Subject for the event id: the ad click for Contact, `{vars.enquiry_id}` / the run's enquiry for Lead, `{vars.appointment_id}` / the trigger's appointment for Schedule, so a flow event and the automatic sweep's event are the SAME Meta event. Off / training → the step fails (error output); report-only and consent skips are normal outcomes.
- `ai_router` (draft-safe): reads the newest inbound message of the conversation; **emergency wording (`detectEmergency`) is checked first, with AI off too, and ends the run (cancelled) without routing**; then asks the existing intent pipeline: a stored model label for that message is used as is, otherwise, only when `ai.enabled` and `intent_detection` are on, `processIntentJob` runs (daily cap, provider, usage row, closed-enum parse) and its stored label is read back. Routes to `intent:<label>` for the first label in the node's order, else `else`. AI off, no provider, cap, error or no label → `else`. A model "emergency" label also ends the run. It never writes, sends or stores model text (output is `{intent, ai}` only). `emergency` cannot be configured as a route.
- **`start_campaign` is NOT built**: a bot step that can message a whole audience is too easy to trigger by accident or in a loop (a flow starting per inbound message could launch a campaign per message), and campaigns have their own approval, guardrails, quiet hours and audit. Use a segment + campaign by hand, or a drip flow.

All new nodes are in `NODE_TYPES`, `NODE_DATA_SCHEMAS`, the catalogue, the builder form, `HANDLES` and `setupIssues` in `lib/flow-engine/graph.ts`, the dry run, and `STRIPPED_NODE_TYPES` (the Flow Copilot never generates them: they need ids, take money, send data to Meta or choose what AI acts on). The CRM nodes now have typed schemas (they were `z.record` before).

## G4: question node

- Answer types for free-text questions: text, number (min / max; Arabic-Indic digits and thousands commas accepted), phone (saved as E.164), e-mail (lower-cased), date (ISO or day-first, real dates only, saved as YYYY-MM-DD), regex (≤ 200 characters; nested repeats like `(a+)+` and back-references are refused at publish and never match at run time; replies are capped at 500 characters before any check). Choice questions match the tapped id, the title, or the option's number ("2").
- `reask_max` (0 to 5, default 0 so existing flows behave as before) with optional `reask_text`. Each re-ask is one more step on the same node (so it counts against the 200-step cap and a redelivered job does not send twice); the count lives in `run.context.asks` and is cleared when the question is answered, falls back or times out.
- After the last re-ask: the "No / other answer" output. **Without that output the run now ends (failed, "The patient's answer did not fit …") and the conversation goes back to people; it never waits silently** (the old `unmatched_reply` wait is gone).
- Store to a run variable and/or a contact field (`save_to`: first_name, last_name, language, label, `custom.<key>`; e-mail only from an e-mail answer; never phone or gender). The contact is written before the run moves, so a failure retries cleanly.

## Builder checks (`validateGraph`)

- Every question option and every router label must be connected (error, kind `setup`); an output pointing at an option or label that no longer exists is a structure error; a router without its Else output is an error; a question without "No / other answer" is a warning.
- Router: at least one label, each label once, never `emergency`.
- Question: a refused pattern, or `save_to: email` without an e-mail answer, blocks publishing.
- The trigger must still be connected (unchanged).

## Files

- New: `lib/flow-engine/crm-adapters.ts`, `answers.ts`, `wa-flow.ts`, `node-options.ts` (client-safe lists: router labels, Meta event names, answer types, `patternProblem`), `executors/ai.ts`; migration `supabase/migrations/20261024000100_flow_parity.sql`; tests `tests/unit/flow-parity.test.ts`, `tests/unit/flow-answers.test.ts`, `tests/db/flow-parity.test.ts`.
- Changed: `lib/flow-engine/{types,deps,run,triggers,graph,catalog,labels,node-schemas,simulate,supabase-deps,starter-flows}.ts`, `executors/{crm,integrations,messaging,index}.ts`, `lib/jobs/handlers/flow-steps.ts` (job kinds `flow.window_closing`, `flow.drip`), `lib/inbox/inbound.ts` (`opened` in the `message.received` payload), `lib/integrations/payments/request-server.ts` (`actorId` nullable, `expectContactId`), `lib/ai/flow-copilot/policy.ts`, `lib/contacts/server.ts` (segment summary has `drip_flow_id`), flows builder (`node-form`, `trigger-form`, `page`, `flow-builder` lookups, `actions.ts`), contacts (`segment-dialog`, `actions.ts` `saveSegment`, `page`, `types`, `contacts-workspace`).
- Deleted: `lib/flow-engine/crm-registry.ts`.
- Starter flows: the recall starter's text no longer says Enquiries is "not installed"; new starter `window_closing_check_in`.
- No new tables, permissions or settings keys. No change to `lib/supabase/types.ts` (the new SQL is a constraint, two trigger functions in `app` and an index).

## How it was verified

- `tests/unit/flow-parity.test.ts` (41): recall starter through the port, production deps wire every port method, every new executor (incl. the router's emergency pre-emption, AI-off Else, error Else, no model text in output), builder checks, question re-ask / fallback / end-without-fallback / save to contact / step cap, `message_received` (conditions on this message, debounce, opened / emergency / assigned / reaction skips), `wa_flow_completed` (vars, token filter), `window_closing` (scheduling, dedupe, fire, **race with an inbound reply**, window already closed), drip re-checks, dry run of every new node and trigger. `tests/unit/flow-answers.test.ts` (10): answer types, pattern guard, option matching, nfm_reply parsing and caps.
- `tests/db/flow-parity.test.ts` (13) on a fresh test database **with PostgREST in front** (real supabase-js adapters): drip SQL trigger (static only, active segment_joined only, no duplicates, cross-org drip flow refused), new trigger types accepted; recall starter creates one enquiry (system actor, audited) and a second run reuses it; update_enquiry stage + status with exactly one event each, add_task, set_label (wrong scope refused); portal_record denied for a publisher without the permission, allowed for one with it, refused with no recorded publisher; book_appointment books a slot (`source = 'bot'`) and a second booking of the same slot fails; message_received debounce and window_closing scheduling + reply no-op through the real store; wa_flow_completed from a stored nfm_reply; payment_link and meta_event refused while the integrations are off (nothing written), meta_event `no_ad_click`; ai_router Else with AI off and routing on a stored model label; drip job start and "not a member" re-check.
- Existing suites updated where behaviour changed on purpose: the CRM port test now uses typed settings; "unmatched text without a fallback keeps waiting" became "… ends the run with a clear error"; a structure test ignores the new unconnected-option setup error.

## Not verified / not built

- Nothing ran against Meta, a payment gateway or the Conversions API (tests block them). The nfm_reply shape (`response_json` as a JSON string with `flow_token`) is from Meta's documentation, not a live account. Sending a WhatsApp Flow (the form itself) is not part of this phase; only receiving the reply.
- `payment_link` and `meta_event` with the integrations switched ON were exercised through fakes only (unit), plus the existing Phase 19a/19b suites for the wrapped functions; the DB test covers the switched-off refusals.
- `ai_router` with a live model call was not run (fake / stored labels only). It adds model latency to that step when AI is on (inside the 60 s job visibility).
- The builder and segment dialog UI were type-checked and linted, not clicked through in a browser.
- `start_campaign`: deliberately not built (above). Appointment / enquiry "agent" nodes from Sanoflow: not built.
- The Recurring trigger's 200-contact cap (G2 evidence) is unchanged.

## Decisions (conservative)

1. Adapters act as the **system** (null user), except portal records, which need a member and use the flow publisher's current permissions.
2. `message_received` never starts on the opening message, when a person is assigned, or on emergency wording; default debounce 120 s.
3. `window_closing` schedules on every inbound kind that moves `last_inbound_at` (as the existing 24 h window logic does, reactions included); stale checks are no-ops.
4. Drip only for contacts added after the drip flow was chosen; dynamic segments stay on Recurring.
5. Payment links from a flow need `finance.payment_links` at publish time and must match the run's patient; the flow never sends a link for someone else's invoice.
6. Meta events from a flow share the event id of the automatic ones (no double counting).
7. Re-ask default 0 (existing flows keep their behaviour); the catalogue default for a NEW question is 1 re-ask with a polite re-ask text. Unconnected options are now a publish-blocking error.
8. The new nodes are never generated by the Flow Copilot (`STRIPPED_NODE_TYPES`); its allowed triggers are unchanged (the four new triggers are not offered to it).

## For the lead (shared docs not edited here)

- **CLAUDE.md** (flow engine section, suggested lines): "CRM / integration / AI ports are built per job in `createFlowDeps` (`lib/flow-engine/crm-adapters.ts`); never reintroduce an import-time registry. Adapters call the module services; portal records run with the flow publisher's current permissions." "A question that cannot accept an answer re-asks (`reask_max`), then follows its fallback, else the run ends: never wait silently." "`message_received` never starts on the opening message, an assigned conversation or emergency wording." "`window_closing` and drip use `scheduled_jobs` (`flow.window_closing`, `flow.drip`) and re-check everything at fire time." "`payment_link` needs `finance.payment_links` to publish; `ai_router` never routes or writes model text and stops on emergency wording." "No `start_campaign` node."
- **docs/09**: §2.3 can now say the CRM nodes are wired (they were not before this phase); add the four triggers and five nodes; question validation / re-ask.
- **docs/20 §4**: G0 closed; G2 closed (Recurring 200 cap remains); G3 closed except campaign node (not built, by design) and appointment / enquiry agents; G4 closed ("request contact info" = a phone / e-mail question with `save_to`).
- **lib/help/whats-new.ts**: suggested entry "Flows: new triggers (message received, before the 24-hour window closes, WhatsApp form submitted, segment drip), new steps (Update enquiry, Set label, Payment link, Meta ad event, AI router), questions check the answer and ask again, and the enquiry, task, portal and booking steps now work."
