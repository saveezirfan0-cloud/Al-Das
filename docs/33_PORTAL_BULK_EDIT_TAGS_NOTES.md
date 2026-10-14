# Portal bulk edit and tags: notes

Closes the `docs/09` §2.3 Portal gap ("No bulk edit; no per-object custom fields or tags"), except custom fields, which are deliberately left out (see Decisions). Built in a cloud sandbox with plain Postgres 16; the UI was type-checked and linted but not driven in a browser.

Migration `supabase/migrations/20261117000100_portal_bulk_edit_tags.sql`; paste file `deploy/supabase-paste/57_portal_bulk_edit_tags.sql` (same SQL).

## What exists

| Part | Where | What it does |
|---|---|---|
| Selection and bulk bar | `app/(app)/portal/portal-workspace.tsx`, `bulk-bar.tsx` | The DataGrid checkboxes (one per row, "select all on this page" in the header) show a bar for people who can edit the object: **Edit N records** and **Tags**. At most 500 records at a time (the largest page); more is refused in the bar, the action and SQL |
| Edit N records | `bulk-bar.tsx` (dialog), `lib/portal/bulk-edit.ts` (`planBulkEdit`, pure) | Choose one field and a value (the field's own input, `FieldInput`, and its own Zod rule, `columnSchema`), or **Clear it** (refused for a required field). Offered fields: the single edit's writable columns minus the record's title column. A result toast says how many were updated and how many skipped (already had the value, or not found) |
| Server action | `app/(app)/portal/actions.ts` `bulkEditPortalRecords` → `lib/portal/bulk.ts` `bulkUpdateRecords` | Same permission as a single edit (the object's write key, `portal.<object>.write`, covered by `portal.*`), checked in the action and again in the service. Admin client made with `createAdminClient(member.userId)`, so `record_history` names the person on every row. One `recordAudit` (`portal.records_bulk_updated`) with the field key, whether it was a clear, and the counts: never the value. One timeline event per changed record (like a single edit) and the usual `portal.record_updated` domain event per record |
| `public.portal_bulk_update(org, object, ids, column, value)` | migration | One SQL statement: `org_id = p_org_id` is part of the WHERE (another organisation's ids are ignored), rows that already hold the value are skipped (`is distinct from` after casting to the column type with `jsonb_populate_record`), returns `(record_id, old_value, new_value)` for the changed rows. Refuses `id`, `org_id`, `created_at`, `updated_at`, an unknown column, more than 500 ids and an unknown or disabled object. Service role only |
| Tags | `public.tags` scope `'portal'`, join table `portal_record_tags` | `tags_scope_check` now allows `contact`, `enquiry`, `conversation`, `portal`. `portal_record_tags (org_id, object_key, record_id, tag_id, created_by, created_at)`, primary key on all four ids. Triggers: the tag must belong to the same org (`check_parent_org`) and be a **portal** tag, and the record must exist in that object's table in the same org (`app.portal_record_tags_check`, via `app.portal_table`). RLS: SELECT with `app.portal_can_read(org_id, object_key)` (the object's read key, as for comments, timeline and attachments); **no write policies**: the server writes with the service role after `can()` |
| Tags in the drawer | `record-drawer.tsx` (`RecordTags`), `setPortalRecordTags` | Editors pick tags (and create one on the fly with `portal.tags.manage`); readers see coloured chips. Audited as `portal.record_tags_changed` (counts only), plus a `tags` timeline event |
| Tags in bulk | `bulkTagPortalRecords` → `bulkTagRecords` | Add and/or remove tags on the selected records (only records of this object in the member's org; only portal tags of the org). One audit row `portal.records_bulk_tagged` with counts |
| Tag column and filter | `portal-columns.tsx` (`_tags` column), `lib/portal/query.ts` (`compilePortalTagFilter`) | A Tags column in the grid and a "filter by tag" picker next to Filters: rows with ANY of the chosen tags, a parameterised `exists` over `portal_record_tags`. "Export view" honours it |
| Settings, Tags | `app/(app)/settings/tags/*` | A third tab, **Portal tags**, with the new permission `portal.tags.manage` (catalogue group Portal; covered by `portal.*`, so Manager and Care coordinator have it). Deleting a tag removes it from every record (foreign key cascade) |
| Record delete | `lib/portal/service.ts` `deleteRecord` | Also removes the record's tags (`record_id` cannot have a foreign key: it points at a different table per object) |

## Decisions

1. **Custom fields are out.** Portal objects have no configurable fields: their columns are defined in code (`lib/portal/objects/*`) and are the single source for the grid, filters, drawer, forms and Zod validation, and `portal_objects` only says which objects are on and with which permissions. Adding per-object custom fields would mean a second, data-driven field model next to that one. Not built; the docs row says so.
2. **One SQL statement for a bulk edit.** Either every selected row changes or none does (a database rule that fails, such as a duplicate natural key, refuses the whole edit with the same friendly message as a single edit). The statement, not the application, decides which rows belong to the organisation.
3. **No values in the audit log.** Portal objects are reference data, but the audit row still carries only the field key and counts; the per-record timeline keeps the from/to values exactly as a single edit already does.
4. **The title column is not bulk-editable** (giving many diagnoses the same code or many entry points the same source is never what was meant). Create-only columns (natural keys) were already excluded.
5. **Tags follow the object's permissions**: read with the object's read key, attach with its write key. Creating, renaming and deleting tags is the separate `portal.tags.manage`, so an editor of one object cannot rename tags other objects use.
6. **Selection is per page** (the grid's own checkboxes); there is no "select all matching" for the portal, since the cap is the largest page size.
7. **Not included**: tags in saved views (the tag filter is not saved with a view), tags in the CSV export, and erasure or merge handling (portal records are reference data, not patients).

## Tests

- `tests/unit/portal-bulk-edit.test.ts`: field list, value validation, clear rules, the 500 cap, tag schemas and diffs, result counts, the tag filter SQL.
- `tests/db/portal-bulk-tags.test.ts`: cross-org reads of `portal_record_tags` fail, reads follow the object's read key, no browser writes, the trigger refuses non-portal tags, other orgs' tags and records and missing records, `portal_bulk_update` touches only the caller's organisation and skips unchanged rows, names the actor in `record_history`, refuses system and unknown columns, more than 500 ids and signed-in callers.
- `portal_record_tags` is in the cross-org sweep (`PORTAL_TAGS_TABLES`, `seedPortalTagRows` in `tests/db/helpers.ts`).

## Review fixes (before merge)

- **Tag writes per scope in the database.** Restrictive policies on `public.tags` (`app.tag_scope_writable`) require the scope's own permission for a browser write: contact `contacts.manage`, enquiry `enquiries.manage`, conversation `settings.manage`, portal `portal.tags.manage`. Before this, any `contacts.manage` holder could rename or delete a portal or enquiry tag from the browser. A trigger (`tags_scope_fixed`) refuses any change of a tag's scope, for every role.
- **Clear is offered only where the database allows empty:** never for yes/no fields or for columns marked `notNull` (Condition groups, Priority), in the dialog and in `planBulkEdit` (`bulkClearable`).
- **Selection resets when the page changes**, so a bulk action only touches rows on screen (decision 6).

