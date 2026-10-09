# Phase 4 — Templates: what was built and what is left

## Scope delivered

`/templates` is now a real screen (it was a "coming soon" page). Staff can build WhatsApp templates in Pulse, preview them as they will look on a phone, submit them to Meta, track review status, edit, duplicate, archive and delete them, and map variables to CRM/appointment fields. The Inbox picker, appointment reminders and (later) campaigns keep reading the same `wa_templates` rows; only `APPROVED` templates stay sendable (`isTemplateSendable`).

| Plan item                                                                                                                                                                                     | Status                                                                                 |
| --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------- |
| List with filters (number, status, category, language, search, archived)                                                                                                                      | Done                                                                                   |
| Builder drawer: identity, header (text / image / video / document / location), body with formatting and `Add variable`, footer, buttons, carousel cards, live phone preview, validation panel | Done                                                                                   |
| Meta rules as pure, unit-tested checks (named constants in `LIMITS`)                                                                                                                          | Done: `lib/whatsapp/template-validate.ts`                                              |
| Resumable header-sample upload (`4::…` handle)                                                                                                                                                | Done: `WhatsAppClient.uploadTemplateSample`; needs `META_APP_ID`                       |
| Submit / edit submitted / delete / duplicate / archive / variable map                                                                                                                         | Done: `lib/templates/service.ts` + `app/(app)/templates/actions.ts`                    |
| Edit-limit handling (APPROVED editable once per 24 h, etc.)                                                                                                                                   | Done: blocked early with a message instead of burning Meta attempts                    |
| Starter gallery, EN + AR                                                                                                                                                                      | Done: 26 entries (13 EN, 13 AR); install creates **drafts** only                       |
| Nightly sync                                                                                                                                                                                  | Done: `templates_sync` task, `pg_cron` 02:40 UTC; the manual button runs the same code |
| Offline happy path                                                                                                                                                                            | Done: mock Graph template/upload endpoints + simulator overrides (below)               |
| Real approval by Meta, real sample upload                                                                                                                                                     | **Not verifiable here** (needs the System User token and a live WABA)                  |

## Code map

- **Pure library** (no I/O, unit-tested): `lib/whatsapp/template-draft.ts` (form model ⇄ Meta `components`, variable insert/renumber, sample-file limits), `template-validate.ts`, `template-gallery.ts`, `format.ts` (WhatsApp `*bold* _italic_ ~strike~ ```mono```` tokenizer); `components/whatsapp/phone-preview.tsx` (reusable by Campaigns).
- **Service** `lib/templates/{service,rules,schema}.ts`: all writes go through the service role after `requirePerm("templates.manage")`, each with `recordAudit`. `rules.ts` holds status labels and the edit-limit rules.
- **Job** `lib/jobs/handlers/templates-sync.ts`; `lib/whatsapp/sync.ts` was made draft-safe (a local `DRAFT` row is never archived because Meta does not list it).
- **Migration** `20261009000990_templates.sql`: `source`, `gallery_key`, `submitted_at`, `last_error`, `last_edited_at`, `header_sample_path`, `card_sample_paths`, `needs_review`, internal-key columns, local `DRAFT` status, index on `(org_id, channel_id, status)`, private bucket `wa-template-media`, cron entry.
- **UI** `app/(app)/templates/`: `page.tsx` (server), `templates-workspace.tsx` (list + dialogs), `template-drawer.tsx` (builder), `template-dialogs.tsx` (variable mapper, duplicate, starter gallery), `status-badge.tsx`.
- **Rate limit** `RATE_RULES.templateSubmitPerUser`: 30 submits/user/hour, fails closed.

## Decisions (as in the plan)

1. Gallery templates install as drafts and are never auto-submitted.
2. Arabic gallery entries are marked **needs review** and cannot be submitted until a person marks them reviewed. I can write grammatical Arabic but cannot vouch for tone; a native speaker must read all 13 before they go to Meta.
3. Editing a submitted template respects Meta's edit limits by blocking early with an explanation.
4. EN and AR are separate language variants of the same name; there is no auto-translation.
5. Archive/delete of a template that is in use (appointment settings, recent sends) asks for confirmation and lists where it is used.

## Security notes

- A client-supplied sample path could have pointed at another organisation's file (the server downloads it and uploads it to Meta). Fixed in this phase: only `<org>/<template>/…` paths with a strict character set are trusted (`ownSamplePath`), covered by a forged-path test.
- New table columns inherit the existing `wa_templates` RLS; the new bucket policies mirror `wa-media`. `pnpm test:db` (security-guard sweep) passes; `pnpm audit:security` reports 160 entry points, 0 unguarded.
- Template bodies, examples and sample files are never logged; Meta error text is passed through `redactText` before it is stored in `last_error`.

## Offline happy path

```bash
# 1. mock Graph with template endpoints (loopback only)
pnpm load:mock-graph --port 4010
# 2. app with META_GRAPH_BASE_URL=http://127.0.0.1:4010 and META_APP_ID set to any digits
# 3. /templates → Starter templates → add a draft → open it → Submit to Meta → row shows Pending
# 4. approve it the way Meta would: deliver the webhook
pnpm wa:simulate template-status-update --template-id <meta id shown in the mock: GET /__templates> \
  --template-name <name> --template-language en --waba <waba id>
pnpm jobs:run meta_events
# 5. row turns Approved and appears in the Inbox template picker
```

`POST /__templates/<id>/status?status=REJECTED` on the mock changes its own copy, which the nightly/manual sync then mirrors.

## Verification run

`pnpm typecheck`, `pnpm lint`, the full unit suite (881 tests) and `pnpm test:db` (193 tests) pass. The security audit shows no unguarded or unaudited entry points. The browser walk-through (Playwright screenshots at desktop and phone width) was **not** run in this environment.

## Demo checklist

- [ ] `/templates` shows the starter button, filters and an empty state before any template exists.
- [ ] Add three English starter templates for a number; they appear as drafts, not submitted.
- [ ] Open one: edit the body, add a variable with an example, watch the phone preview and the validation panel; remove the example and confirm Submit is blocked.
- [ ] Submit with the mock Graph running: status becomes Pending; trying to submit a duplicate name shows Meta's error in the drawer.
- [ ] Deliver the approval webhook; the template becomes Approved and shows in the Inbox picker.
- [ ] Add an Arabic starter: it shows "needs review" and Submit stays disabled until it is marked reviewed.
- [ ] Archive an approved template used by appointment reminders: a confirmation lists the usage.
- [ ] Sign in as a member without `templates.manage`: the list is visible, edit controls are not.

## Open items

- Native-speaker review of the 13 Arabic starter templates (blocks their submission by design).
- Run the real header-sample upload and a real submission against a throwaway Meta test number before relying on this at go-live.
- Playwright smoke test for the builder (not written).
- Authentication-category (OTP) templates are validated only; WhatsApp Flow buttons are parsed but not built.
- Campaigns (Phase 7) will reuse `PhonePreview` and the variable map.
