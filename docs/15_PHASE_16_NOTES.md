# Phase 16 notes: Media Library and patient documents

Built on branch `claude/nifty-brown-y9l5ry` (from `main` at `a5ff28e`, Phases 13, 14 and 15 merged), 12 Oct 2026 session. Spec: `docs/10_NEXT_PHASE_PROMPTS.md`, Prompt 16. Everything was built in a cloud sandbox with Postgres 16, pgvector and PostgREST but **no Supabase Auth, no Supabase Storage, no Docker and no browser**. "Verified" below means unit tests, database tests with a fake storage bucket, a production build and a bundle check, not a click-through. The sections "NOT verified" and "Open questions" are the honest status.

## What exists

### Media Library (`/media`, permissions `media.view` / `media.manage`)

| Spec item | Where it lives |
|---|---|
| Org-wide library of images, PDFs, videos with folders, tags, search | `app/(app)/media/*`, tables `media_folders` (one flat level) and `media_assets`; search is name or tag; filters by type, tag and folder; paging |
| Used by template header media | Template builder button "Choose from the library" (`uploadHeaderSampleFromLibrary` gives Meta the sample, the template remembers `header.media = media:<id>`); the Map variables dialog; the inbox template picker pre-fills it |
| Used by campaigns | New-campaign form "Choose from the Media Library"; the campaign mapping can hold `media:<id>`; `checkMediaReferences` rejects a bad file before anything is sent |
| Used by quick replies | `quick_replies.media_asset_id`; Settings, Inbox attaches a file; the composer attaches it and sends it with the text as caption (`sendLibraryMedia`) |
| Send a library file in a conversation | Composer "Choose a file from the Media Library" button; `sendLibraryMedia` copies the object into the conversation's own folder and goes through the normal attachment path (24 h window, rate limit, queue) |
| WhatsApp limits and allowed types | `lib/media/limits.ts`: image 5 MB (JPEG, PNG), video 16 MB (MP4, 3GPP), document 100 MB (PDF, Office, TXT); template headers JPEG/PNG, MP4, PDF only. Checked in the browser, in `prepare*` and again on the stored object in `finalize*` |
| Compress images on upload | Browser canvas (no new dependency; `sharp` is not a dependency): `lib/media/client-image.ts` + `image-ops.ts` + `encode.ts`. Longest edge 2,048 px, JPEG quality ladder, PNG kept as PNG when it fits, WebP/HEIC always converted, shrink-and-retry up to three times. A small JPEG thumbnail is made and stored next to every image |
| Show where each file is used | Sheet on each file, from `public.media_asset_usage()` (templates, campaigns, quick replies, with a "live" marker) |
| Block deleting a file used by an active template or campaign | Action checks `media_asset_usage`; a `BEFORE DELETE` trigger repeats it; the quick-reply foreign key backs it. Live = template not archived and not REJECTED/DISABLED/DELETED, campaign preparing/scheduled/queued/sending/paused, any quick reply |
| Camera, rotate, crop (phone) | `capture="environment"` inputs; `components/media/image-editor.tsx` (turn left/right, four trim sliders, canvas preview) |
| Thumbnails and lightbox in conversations | `MediaBubble` shows a fixed-size lazy thumbnail; `components/media/lightbox.tsx` (arrow keys, buttons, swipe via `lib/hooks/gestures.ts`, zoom, open original) for every picture in the thread |

### Patient documents (contact drawer, Documents tab; permissions `documents.view` / `documents.manage`)

| Spec item | Where it lives |
|---|---|
| Categories | referral, lab report, insurance card, consent, other (`lib/documents/categories.ts`) |
| Expiry date and a task/notification before insurance cards expire | `patient_documents.expires_on`; the daily `documents_maintenance` task (pg_cron 03:40 UTC): one `notify()` per organisation (`document.expiring`, added to the catalogue, generic push text, ids only) to people with `documents.manage`, plus a follow-up task per card (due two days before expiry or now). Lead time (default 14 days) and the task switch are in Settings, Patient documents. The reminder is claimed with an atomic update of `expiry_notified_at`; two overlapping runs remind once |
| Uploader | `uploaded_by`, shown with the date |
| View/download log feeding Phase 15's access log | `getDocumentUrl` calls `recordAccess({ entity: "document", action: "view" \| "download", detail: { category, contact_id } })`; opening the tab logs a sampled `list`; "Who opened it" shows the latest 50 (documents.manage) |
| Separate permissions, not inherited from `contacts.view` | Catalogue group "Media & documents"; presets: Manager, Receptionist, Care coordinator hold `documents.*`; Agent, Marketing and finance roles do not. Data migration grants existing system roles; tests prove `contacts.*`, inbox rights and `documents.manage` alone cannot read |
| Private bucket, short signed URLs, strict paths, org checks | Buckets `media-library` and `patient-documents`, no storage policies, links of 60 s (documents) and 5 min (library preview) / 1 h (outbound header); `lib/media/paths.ts` (same model as `lib/inbox/media-path.ts`) |
| Malware-scan hook | `lib/media/scan.ts`: `MalwareScanner` interface, no-op default returning "unscanned", provider registry named by `MALWARE_SCAN_PROVIDER`. "Not scanned" is flagged in the library grid, the file sheet, the Documents tab and Settings; "infected" files can never be opened or sent. No real provider exists yet (OQ-70) |
| Storage usage dashboard | Settings, Patient documents: counts and bytes by category and type, documents added per month, not scanned / blocked / unfinished uploads, cards expiring (`public.storage_usage_summary`). WhatsApp inbound media is not counted (no size is stored) |
| Retention policy per category | `document_retention_policies` (30 days to 100 years, or keep for ever). Never deletes by default. Past-retention documents are listed with a count and a "Delete N now" button; the nightly task deletes only where "delete automatically" is ticked |
| Audit and history | `recordAudit` on upload, rejection, change, delete, rescan, settings, retention; `recordAccess` on every open. `record_history` is **not** attached: the only editable fields are the title, category and expiry date, every change is audited with the names of the changed fields, and a history table would repeat the title (health data) |
| Erasure (Phase 15) | Migration `…300` replaces `erase_contact` (adds `documents_deleted` to the result). `executeErasure` removes the patient's document files first and changes nothing if any removal fails. The export bundle gains a `documents` section (metadata, not the files) |
| Switched off until the residency question is answered | `settings.documents.enabled` is false by default; uploads are refused until an administrator types `STORAGE REGION APPROVED` (audited). Existing documents stay readable if it is switched off again |
| Merging two patients | A trigger on `contacts.merged_into_id` moves the documents to the surviving patient (the file keeps its original path; the server compares only org and document id) |

### Migrations

`20261015000100_media_library.sql` (permission grants, `media-library` bucket, folders, assets, quick-reply link, usage function and delete guard, RLS), `…200_patient_documents.sql` (bucket, documents, retention, merge trigger, RLS, cron), `…300_documents_erasure.sql` (`erase_contact`), `…400_storage_usage.sql`. Concatenated in `deploy/supabase-paste/16_phase_16_media_documents.sql`. Types in `lib/supabase/types.ts` were patched from the test database with the same script approach as Phases 13 to 15 (not the Supabase CLI), then formatted.

### Other changes outside the new files

`lib/jobs/handlers/outbound.ts` resolves a `media:<id>` header just before sending (fails the message, without retries, if the file is gone, blocked or not usable). `lib/campaigns/variables.ts` accepts the new source. `lib/notify/*` gained the `document.expiring` event. `lib/security/policy.ts` has two reasoned audit exemptions (the two `prepare*Upload` actions only create an invisible `pending` row; finalise, reject and cancel are audited). Help guides, a training clip and two what's-new entries were added.

## How it was verified

| Check | Result |
|---|---|
| `pnpm typecheck`, `pnpm lint` | clean |
| `pnpm test` | **147 files / 1,824 tests pass** (was 139 / 1,619). 43 database test files are skipped without `TEST_DATABASE_URL` |
| `bash scripts/test-db.sh` then `pnpm exec vitest run tests/db` | **43 files, 613 tests pass** (was 41 / 570). New: `media-documents.test.ts` (24), `media-documents-service.test.ts` (18), additions to `security-guard.test.ts` and `jobs.test.ts`. `send-pacing` failed once in a full run and passed on its own (timing); `finance-diligence` has flaked in earlier phases |
| `pnpm build` (placeholder Supabase env) and `pnpm bundle:check` | Build passes; `pnpm bundle:check` passes with **no budget raised**. `/media` is 181 kB, `/settings/documents` 162 kB (default budget 215). `/contacts` stayed at 312 kB and `/inbox` at 299 kB because the Documents tab, the photo editor and the picture viewer load through `next/dynamic` (without that `/contacts` was 388 kB and `/media` 254 kB, over budget) |
| `pnpm audit:security` | `pnpm audit:security`: 355 entry points, 0 unguarded and unreviewed; the two `prepare*Upload` actions are listed with reasons in `lib/security/policy.ts` |
| Paste file | `deploy/supabase-paste/16_phase_16_media_documents.sql` applied in one transaction on a database built from the pre-Phase-16 migrations; the resulting schema (pg_dump) equals a full build |

What the new tests cover (new files: `tests/unit/media-*.test.ts*`, `documents-*.test.ts`, `tests/db/media-documents*.test.ts`, plus additions to six existing files):

- **Limits and content**: every WhatsApp limit at the boundary, header rules, sniffing (an executable renamed `.pdf` is rejected after upload), compression plan and the shrink-and-retry loop with a fake encoder.
- **Paths**: traversal, wrong depth, person-typed names, encoded slashes, cross-org and cross-document comparisons.
- **Permissions**: every Phase 16 server action is refused before the service role is even created for a member who lacks the permission (including a member with every `contacts.*` right); viewers cannot change anything; settings need `settings.manage`.
- **Database**: RLS and cross-org isolation for all four tables; browser sessions cannot write; the data migration (idempotent, right roles only); usage and delete guard for every template/campaign status, quick replies, other-org ids, and that deleting a whole org still works; check constraints; merge moves documents; `erase_contact` deletes only that patient's documents; the cron entry; the new functions are service-role only; the cross-org sweeps in `security-guard.test.ts` include the new tables with seeded rows.
- **Services through PostgREST** with a fake storage bucket: reminders (window, lead time setting, expired cards, already notified, other categories, other organisations, one summary instead of many, no names in task, notification or queue, overlapping runs remind once, changed expiry reminds again), unfinished-upload cleanup (file kept on storage failure), retention (never without policy, never when auto-delete is off, right category and organisation only, audited counts), usage numbers, and the **outbound job end to end**: a template with a library header sends a fresh one-hour link to a stubbed Meta; blocked, unfinished, missing and other-organisation files fail without a Meta call.
- **Erasure ordering**: files removed before the database function; nothing changes if a removal fails; a path outside the org stops the erasure.
- **Rendering** (server-side markup): library grid flags "Not scanned" and "Blocked", controls appear only with `media.manage`, the settings page states the OFF state and the usage numbers.

## NOT verified

- **Nothing was seen in a browser or on a phone.** The library page, uploader, camera capture, rotate/trim dialog, picker, Documents tab, lightbox and settings page were typechecked, linted, built and server-rendered, not clicked. Camera capture (`capture="environment"`), HEIC decoding (Safari only), `createImageBitmap` orientation handling and canvas JPEG quality were written from the platform documentation and never run. Swipe in the lightbox is covered only by the existing gesture unit tests.
- **Real Supabase Storage.** Signed upload URLs, `uploadToSignedUrl`, `info()`, ranged reads through a signed URL, `copy` across buckets, `createSignedUrls` and the bucket `allowed_mime_types` / size limits were written against the supabase-js 2.117 types and exercised only against fakes. The first real upload should be watched. Supabase's own global upload size limit (50 MB on some plans) may be lower than the 100 MB WhatsApp document limit.
- **A real malware scanner**: none exists; only the interface and the no-op path are tested.
- **Meta**: the header sample from a library file, and a send with a signed-link header, ran against a stub. Whether Meta accepts Supabase signed URLs as media links (they need to be publicly fetchable for the hour) is expected but unchecked. A library file larger than 16 MB cannot be a template header sample (existing limit).
- **pg_cron** for `documents_maintenance` (the harness has a stub); push/e-mail delivery of the reminder.
- **Performance**: the Documents tab and library listing were not measured with thousands of rows; the dashboard aggregates in SQL, the list pages page at 48/200 rows.
- **Types** were not produced by the Supabase CLI.

## Decisions and deviations worth knowing

1. **Separate `media.*` permissions.** The prompt only named `documents.*`; the library needed its own gate so that a role that may use templates cannot browse everyone's files unasked. Agent, Receptionist and Care coordinator get `media.view` (to send library files); Marketing and Manager get `media.manage`.
2. **Flat folders** (one level). Nested folders were not built.
3. **Compression is in the browser.** A file uploaded by any other client (API, script) is only checked, not shrunk; the server rejects what is over a limit instead of resizing it.
4. **"Unscanned" files are usable**, flagged. Blocking them until a scanner exists would stop the feature working at all; the badge, the Settings counter and the audit trail make the state visible. Infected files are never served.
5. **Retention never deletes by default**, and the manual "Delete N now" button works per category, 200 at a time.
6. **Insurance card reminder is per organisation, not per person**, and goes to everyone with `documents.manage` (people tune it under Settings, Notifications).
7. **Quick-reply files and the template header are sent as references**, resolved at send time. A deleted-then-recreated file with the same name is a different file.
8. **Appointment reminders and flows do not yet resolve library headers** (they build their own values); a template bound to a library file can be sent from the inbox and campaigns, and from reminders only if their template has no media header.
9. **Inbound WhatsApp media is not part of the library or the dashboard.**
10. The `20261014…` demo wipe empties the new tables (it works from the catalogue) but cannot remove demo files from storage.

## Open questions

OQ-68 to OQ-71 in `docs/audit/open-questions.md`. The one that blocks real use: **OQ-68, where may patient documents be stored** (region, in-country copy, customer-managed keys). Until answered, leave Settings, Patient documents OFF. Also: retention periods and whether erasure may remove documents that belong to the medical record (OQ-69), which malware scanner may see file content (OQ-70), and who holds `documents.*` (OQ-71).

## Before first use on the real stack

1. Apply `deploy/supabase-paste/16_phase_16_media_documents.sql` to the **Pulse** project only (check the project name first), or `supabase db push`. Confirm the two buckets exist and are private (`media-library`, `patient-documents`) and that the Storage global upload limit allows the sizes you want.
2. The `app_url` / `job_secret` cron secrets from earlier phases are enough; `pulse:documents_maintenance` runs daily at 03:40 UTC.
3. Optional: set `MALWARE_SCAN_PROVIDER` once a provider is implemented and registered (see `lib/media/scan.ts`).
4. Click through as Marketing (upload a photo from a phone, compress, put it in a folder, use it as a template header, in a campaign, in a quick reply, try to delete it while it is live), as a Receptionist (switch documents on as an admin first; add an insurance card with an expiry date a few days away; run the task with `pnpm jobs:run documents_maintenance`; check the notification and the task; open and download; look at Activity log, Record access), as an Agent (no Documents tab), and as an admin (retention, usage, erase a synthetic patient who has a document).
