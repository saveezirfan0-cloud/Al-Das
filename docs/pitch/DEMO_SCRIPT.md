# Demo script and recording plan

For a 25-minute guided demo of Pulse to Al Das management, and the same path recorded as a fallback video. **Use the demo organisation with synthetic patients only.** Never show real patient data in a demo, a recording or a screenshot. Companion files: `Pulse_Pitch_Deck.pptx` (slides), the client proposal doc, `docs/09_STATUS_AND_ROADMAP.md` (what is real and what is planned).

## Before the demo (the morning of)

1. Stack is up on staging, not a laptop. `pnpm demo:reset` has run (Phase 12b builds it; until then run `pnpm db:reset` locally, which loads the fake seed).
2. A test WhatsApp number is connected, so one message can arrive live. If not, use `pnpm wa:simulate message-text` and say so.
3. Three logins ready: Admin, Receptionist, Finance. Browser profiles named after them. Phone with the app installed (Add to Home Screen).
4. Recorded fallback video loaded and tested. Slides open on the first slide.
5. Check the clinic timezone shows correctly and the dashboard has numbers (`pnpm jobs:run metrics_refresh`).

## The story (25 minutes)

| Min | Screen | What to do and say | Proof point |
|---|---|---|---|
| 0-2 | Slides 1-4 | One platform instead of three tools. Be clear: built and tested, not yet live | Honest status builds trust |
| 2-6 | Inbox (as Receptionist) | A WhatsApp message arrives. Assign it, add an internal note, reply. Show delivery ticks. Try a free-form reply on a conversation older than 24 hours: the composer asks for a template | 24-hour rule built in |
| 6-9 | Same conversation, AI | Suggest a reply from the knowledge base; show it is a draft, edit and send. Send a message mentioning symptoms: it is flagged for staff | AI assists, never decides |
| 9-12 | Appointments | Book from the diary, move it, show the slot rules. Open a reminder and its Confirm / Reschedule / Cancel buttons; show a failed reminder turn into a call task | Reminders without Make |
| 12-14 | Contacts | Filter a segment, open a patient, show timeline, consent, duplicates merge suggestion | One record per person |
| 14-17 | Templates, Campaigns | Pick a starter template (English and Arabic preview), build an audience, show the count and the results screen of a finished campaign | Sanoflow replacement |
| 17-19 | Flows, Recall | Open a flow in the builder; open Recall in Test mode and show who would be messaged (counts only) | Make replacement, safely off |
| 19-21 | Finance (as Finance) | Invoices, claim matching, an exception queue, the monthly summary | Insurance visibility |
| 21-23 | Dashboard, Reports | Management dashboard, team view, CSV export | Numbers management wants |
| 23-24 | Settings (as Admin) | Quick search (Ctrl+K), Users and Roles, then **Activity log**: who changed what | Control and audit |
| 24-25 | Phone | Open the installed app; bottom tab bar; reply to a message from the phone | Works in the pocket |
| 25 | Slides 12-16 | Roadmap, rollout, what we need, ask for the demo date and pilot number | The decision |

## Things not to say or do

- Do not claim anything is live with real patients, real Meta traffic or real Unite data. It is not yet.
- Do not open the Unite finance capture screen beyond "this is off by design: the Unite feed delivers each record once".
- Do not promise savings: the numbers need their invoices.
- Do not use real names, phone numbers or screenshots from anywhere.

## Likely questions and straight answers

| Question | Answer |
|---|---|
| Is the data safe? | Row-level security per organisation, role permissions, encrypted credentials, an activity log, tests for all of it. Hosting location is a pending legal decision, not assumed |
| Who owns the WhatsApp number? | Confirm Al Das owns the WABA; that is the first item on the needs list |
| What if WhatsApp goes down or a send fails? | Failed messages list, failed reminders become call tasks, retries with back-off |
| Can the AI say something wrong to a patient? | It only drafts for staff, cannot send by itself, and is barred from diagnosis and dosing |
| Will it replace Unite? | No. Unite stays the record of visits and invoices; Pulse reads from it and never writes |
| How long to go live? | A week to prove it on a real system, then a one-week parallel run and a number-by-number cut-over |
| Can it run in Arabic? | Messages, templates and AI drafts handle Arabic and right-to-left today; staff screens in Arabic are planned |

## Recording the walkthroughs

Method (details in `docs/09_STATUS_AND_ROADMAP.md` section 8):

1. Write each clip as a scripted Playwright scenario against the demo organisation, with video on, 1280 by 720, and a caption bar and cursor highlight injected by the script. Re-recording after a UI change is then one command.
2. Add a voice-over (human or text to speech) in English and Arabic; export MP4; host privately (Supabase Storage, Vimeo or unlisted YouTube).
3. Surface them in the app under Help, Training, grouped by role, with a "?" on each page opening the matching clip. Pair each with a one-page PDF card and a three-question check.
4. Order for reception: install and sign in; your day at a glance; inbox basics; the 24-hour rule; book, move, cancel; reminder replies; call tasks; walk-ins and families; merging duplicates; failed messages; end-of-day checklist; privacy rules.
5. Until the scripted recorder exists (Phase 14), record the demo path above with a screen recorder on the demo organisation as the interim fallback video.

Never record, upload or share a video that shows a real patient.
