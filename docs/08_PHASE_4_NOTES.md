# Phase 4 — Templates: what was built and how to use it

## Scope delivered

- **Migration** `20261009000990_templates.sql`: `wa_templates` gains `created_by`, `submitted_at`, `submit_error`, `media_paths` (sample files per header / carousel card in the private `wa-media` bucket), `gallery_key`; a listing index; the nightly cron `pulse:templates_sync` (02:00 UTC → `/api/jobs/templates_sync`). RLS is unchanged from Phase 3 (read = org member, write = `templates.manage`) and is covered by `tests/db/templates-rls.test.ts`. Drafts are rows with `status = 'DRAFT'` and no `meta_template_id`.
- **Templates page** (`/templates`, needs `templates.manage`): list with filters (number, every Meta status, category, language, archived), search (name or text), badges with Meta's rejection reason / last submit error, **Sync templates**, **Gallery**, **New template**. Row actions: Edit/View, Map variables, Duplicate, Archive/Unarchive, Delete.
- **Builder drawer** (right-side sheet): name, category, language (EN/AR with RTL editing and preview), number, type (Standard text / Media & interactive / Carousel); header (none / text with one variable / image / video / PDF; samples go browser → Storage via a signed URL, then to Meta's **Resumable Upload API**, so Vercel's request-body limit never applies; samples are capped at 5 MB image, 16 MB video, 15 MB PDF); body with a bold/italic/strike/mono toolbar and **`@` variables** (inserts `{{n}}`, pre-fills the example and the contact-field mapping, renumbers and keeps examples/mappings with their variable when one is deleted or moved); footer; buttons (quick reply, URL with `{{1}}` suffix, phone, copy code) with Meta's limits; carousel cards (2–10, image or video, per-card text and buttons); authentication templates (fixed OTP format). A live **phone preview** renders WhatsApp formatting safely (no HTML injection), RTL, and carousel cards.
- **Submit to Meta** (`submitTemplate`): validates every Meta rule first (fail closed, nothing is sent while anything is wrong), re-uploads stored samples for a fresh handle, creates the template (or edits an APPROVED / REJECTED / PAUSED one through Meta's edit API), stores Meta's id / status / category, emits `template.status_changed`. On a Meta error the draft is kept with `submit_error`; a failed edit of an already-submitted template only records the error so the local mirror never shows unsent edits.
- **Sync**: manual (`Sync templates`, per WABA) and nightly. One sync per (org, WABA); a failing WABA does not stop the others. Sync never archives drafts or never-submitted rows, keeps `channel_id`, `variable_map` and local archive flags, archives rows Meta no longer lists (status `DELETED`) and revives them if they come back. Status / category / quality webhooks from Phase 3 keep rows current in between.
- **Variable mapper**: map each text / URL variable to a contact field (`contact.first_name|last_name|name|phone`, the same keys the inbox picker already reads) and toggle **retry on fail**.
- **Starter gallery**: 23 original clinic templates × EN + AR (appointments, reminders, follow-up, recalls, billing, information, promotions, one carousel, one verification code). Placeholders only; no PHI. Entries that need media, a clinic phone number or a real link say so, and submission is blocked until they are supplied (`placeholder.invalid` links and empty phone numbers fail validation).
- **Send support for the new shapes**: `lib/whatsapp/templates.ts` now lists variables, previews and builds the Cloud API `template` object for carousel cards and one-time-code templates, so they are sendable from the inbox.

## Where things live

| Concern                                              | Path                                                                                                  |
| ---------------------------------------------------- | ----------------------------------------------------------------------------------------------------- |
| Builder state, Meta limits, conversion, text helpers | `lib/whatsapp/template-builder.ts`                                                                    |
| Gallery                                              | `lib/whatsapp/template-gallery.ts`                                                                    |
| WhatsApp formatting parser (preview)                 | `lib/whatsapp/format.ts`                                                                              |
| Resumable upload                                     | `WhatsAppClient.uploadTemplateSample` (`lib/whatsapp/client.ts`), sample rules in `template-media.ts` |
| Sync planning + nightly handler                      | `lib/whatsapp/sync.ts`, `lib/jobs/handlers/templates-sync.ts`                                         |
| Server actions                                       | `app/(app)/templates/actions.ts`                                                                      |
| UI                                                   | `app/(app)/templates/*`                                                                               |

## Local happy path

```bash
pnpm db:reset && pnpm dev          # seed has a fake channel; no Meta token needed to build drafts
# /templates → Gallery → pick a template → Use → edit → Save draft
# Submit without a real token shows a mapped Meta error and keeps the draft.
pnpm wa:simulate template-status-update   # fixtures from Phase 3; then:
pnpm jobs:run meta_events                   # the list badge moves to Approved
pnpm jobs:run templates_sync                # needs a real token; without one it logs the failure per WABA
```

Tests: `pnpm test` (unit), `pnpm test:db` (RLS + cron; needs the plain-Postgres harness in `supabase/test/README.md`).

## Going live

1. Set `META_APP_ID` (Meta app → Settings → Basic). Without it text templates work, but header / card sample uploads are refused with a clear message.
2. Hosted Supabase: run the migration (`supabase db push`); `app.ping_jobs('templates_sync')` uses the same Vault secrets as the other crons.
3. Have an Arabic-speaking colleague read the Arabic gallery copy before submitting it.
4. Submit one template, wait for the `message_template_status_update` webhook, and confirm the badge changes.

## Decisions and assumptions

- WhatsApp formatting is plain markup, so the body editor is a textarea with a toolbar rather than a rich-text editor (Tiptap is not needed here).
- Templates belong to a WABA (`unique(waba_id, name, language)`); the "number" is the channel it was created from. Numbers sharing a WABA share templates.
- Delete: drafts are removed (and their stored samples). Submitted templates are deleted at Meta for that language only (`hsm_id`) and kept locally as `DELETED` + archived so history stays intact.
- Templates the builder cannot round-trip (named parameters, Flow buttons, location headers…) open read-only with an explanation rather than silently losing parts. Edit them in Meta Business Manager and sync.
- Templates in review (`PENDING`, `IN_APPEAL`, …) open read-only: Meta does not allow edits then.

## Not built / follow-ups

- Sanoflow's per-template **SMS fallback** and **performance analytics** are out of scope (no SMS provider yet; analytics belong with Campaigns, Phase 7).
- Editing a synced media template re-submits Meta's returned sample reference; confirm against a real WABA that Meta accepts it (if not, upload a fresh sample).
- Authentication templates use Meta's fixed OTP format; request/verify-code logic is not part of this phase.
- Flow buttons and location headers are parsed and preserved on sync but cannot be authored yet.
