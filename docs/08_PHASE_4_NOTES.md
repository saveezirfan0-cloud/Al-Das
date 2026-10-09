# Phase 4 — Templates: what was built and how to use it

## Scope delivered

- **`/templates`** (needs `templates.manage`): list filtered by WhatsApp account/number and status (Draft, Pending, Approved, Rejected, Paused, Disabled, Flagged …, plus Archived), search, 30 per page. Columns: name + language + type, message preview, category, status pill (with Meta's rejection reason), updated. Row actions: **Edit**, **Map variables**, **Duplicate** (as a new draft), **Archive / Unarchive**, **Delete**. Header actions: **Sync templates** and **New template** (gallery).
- **Builder drawer** (`?new=1`, `?edit=<id>`; the URL keeps the list filters):
  - Name, category (Marketing / Utility), language (English, English US/UK, Arabic; Arabic switches the editors to right-to-left), number, type (**Standard**, **Media & interactive**, **Carousel**).
  - Header: none / text (one variable) / image / video / document. Media samples go through Meta's **resumable upload API** (`WhatsAppClient.uploadTemplateSample`, needs `META_APP_ID`) and the returned handle is stored as the example.
  - Body with **bold / italic / strikethrough / monospace** buttons, character counter, and **`@` to insert a dynamic field** (also an _Insert variable_ button). Inserting a field adds the next `{{n}}`, fills its example from a sample and records the mapping. Examples (required by Meta) and the source of each variable are edited under the body.
  - Footer; buttons (quick reply, link with optional `{{1}}` suffix, call, copy code) with Meta's per-type limits; carousel cards (2–10, same media type and button layout, 160-char text).
  - **Live phone preview** (shared `components/phone-preview`, now with carousel cards), inline problems (blocking) and warnings (advice), then **Save draft** (local only) or **Submit to Meta**. Editing an approved/rejected/paused template resubmits it for review in place (name and language are locked).
- **Gallery**: 13 original administrative templates × English and Arabic = **26 starters** (appointment confirmation/reminder/rescheduled/cancelled with Confirm · Reschedule · Cancel buttons, welcome, we-tried-to-reach-you, opening-hours change, visit feedback, review request, birthday greeting, health-check packages, news with an image, invoice ready). Filter by use case and language, preview, _Use this template_ or _Start from scratch_. Every one passes the builder's validation (tests enforce it); two need a clinic action before submitting (upload the header image, replace the placeholder link) and say so. No entry gives clinical advice; clinical recall wording stays with the signed-off recall programmes.
- **Variable mapping** (per template, `wa_templates.variable_map`): contact first/last/full name and appointment date/time/date-time/doctor/location/service/number, plus fixed text. Used by the inbox template picker, appointment reminders (Phase 6) and as the starting point in campaigns, where each campaign can override it.
- **Sync**: manual (_Sync templates_, all accounts of the workspace) and **nightly** (`templates_sync` task, pg_cron 03:40 UTC, one Meta call per WABA, failures logged per account). Local drafts are never archived by a sync.

## Under the hood

| Piece                                                                     | Where                                                                                                                                                                                                     |
| ------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Draft model, Meta authoring rules, draft ↔ components, `@`/format helpers | `lib/templates/builder.ts` (pure)                                                                                                                                                                         |
| Variable sources                                                          | `lib/templates/sources.ts`                                                                                                                                                                                |
| Starter templates                                                         | `lib/templates/gallery.ts`                                                                                                                                                                                |
| List/detail queries                                                       | `lib/templates/queries.ts`                                                                                                                                                                                |
| Server actions (all audited, `templates.manage`)                          | `app/(app)/templates/actions.ts`: `saveTemplateDraft`, `submitTemplate`, `duplicateTemplate`, `deleteTemplate`, `archiveTemplate`, `saveTemplateVariableMap`, `syncTemplatesAction`, `uploadHeaderSample` |
| Nightly sync                                                              | `lib/jobs/handlers/templates-sync.ts`                                                                                                                                                                     |
| Migration                                                                 | `20261010000200_templates.sql` (`created_by`, `submitted_at`, `gallery_key`; cron)                                                                                                                        |

## Rules the builder enforces (Meta, structural)

Name `[a-z0-9_]`; body ≤ 1024 with `{{1}}…` numbered without gaps, not at the start or end, never adjacent, one example per variable; header text ≤ 60 with at most `{{1}}`; footer ≤ 60, no variables; ≤ 10 buttons (≤ 2 links, ≤ 1 call, ≤ 1 copy code), button text ≤ 25, links `https://` with a `{{1}}` only at the end, phone in international format; carousel 2–10 cards with identical media type and button types. Advice only: too many variables for the text, marketing without an opt-out line, placeholder `example.com` links. Meta still decides on content.

## Behaviour worth knowing

- **Status changes arrive by webhook** (`message_template_status_update`, handled since Phase 3), so a submitted template flips from Pending to Approved/Rejected without a sync. The nightly sync is the safety net.
- **Category**: Meta may re-classify (e.g. Utility → Marketing); the response is stored and the toast says so.
- **Delete** removes the template on Meta (by id) and locally; if a campaign references it, the row is kept as archived/Deleted so history stays intact.
- **Campaigns** skip carousel templates (cards need a media item per card at send time, which the send path does not support yet), and the server rejects them too.
- **Arabic quick replies** in the appointment starters are recognised by the reminder button-reply handler (Confirm / Reschedule / Cancel in Arabic added to `classifyButtonReply`).
- `WhatsAppApiError` now carries Meta's own user-facing wording (`error_user_title` / `error_user_msg`), which the builder shows when Meta rejects a submission.

## Demo checklist

- [ ] Settings → Channels has a number; `/templates` → **Sync templates** mirrors the account's templates; filters and search work.
- [ ] **New template** → gallery → _Appointment reminder (Arabic)_: the preview is right-to-left, three buttons, four mapped variables; _Submit to Meta_ creates it (Pending), then it turns Approved by webhook.
- [ ] Type `@` in the body: the field menu appears; choosing _Contact: first name_ inserts `{{1}}` with the example “Sara”.
- [ ] Image header: upload a JPEG/PNG sample; without one the submit button stays disabled with the reason listed.
- [ ] Marketing template without an opt-out line shows the advice; the review-request starter warns about the placeholder link.
- [ ] Edit an approved template → _Save & resubmit_ returns it to Pending; name/language are locked.
- [ ] Duplicate → a `_copy` draft; Archive hides it from pickers; Delete asks first and archives instead if a campaign used it.
- [ ] A carousel with two cards and URL buttons previews as swipeable cards; it does not appear in the campaign template list.

## Open questions / follow-ups

- Needs `META_APP_ID` (already in the env list) for header sample uploads, and a real WABA token to submit; offline, submit shows Meta's mapped error.
- Named parameters (`{{first_name}}`) are read and sent when they come from a sync, but the builder authors positional variables only.
- Authentication (OTP) templates, catalogue/flow/MPM buttons and limited-time offers are not in the builder.
- Template-level analytics (performance per template) arrives with the reports in Phase 10.
