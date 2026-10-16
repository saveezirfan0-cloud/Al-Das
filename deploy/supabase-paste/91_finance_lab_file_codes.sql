-- Paste this whole file into Supabase > SQL Editor > New query, then Run.
-- Run the files in numeric order. A failed file rolls back as a whole, so it is safe to retry.
-- Lab provider files: composite test codes and voucher numbers with ":".
-- Needs every earlier file first, up to and including 90_finance_recruitment.sql.
-- Check the project name in the Supabase header first: this is for the Pulse project only.

-- ======================================================================
-- 20261209000100_finance_lab_file_codes.sql
-- ======================================================================
-- Lab provider files as the clinic's send-out lab really writes them (docs/41_REPORT_REVIEW_OCT_2026.md, lab section).
--
--   * A test code may be a composite of components joined by "+" (for example "87177+87209" or "87070X3+87186"):
--     the lab bills one line for a culture and its follow-up tests. Kept as one code so the line is never split or
--     guessed; it shows as unmatched until Finance links it (never auto-paired).
--   * A provider invoice number may contain ":" (the lab's voucher numbers are written "Req:19998").
--
-- Still only codes and invoice numbers: no space is allowed, so a name can never pass either check.

alter table public.fin_provider_lines drop constraint if exists fin_provider_lines_code_check;
alter table public.fin_provider_lines add constraint fin_provider_lines_code_check
  check (code = upper(btrim(code)) and code ~ '^[A-Z0-9][A-Z0-9._/+-]{0,59}$');

alter table public.fin_provider_lines drop constraint if exists fin_provider_lines_invoice_no_check;
alter table public.fin_provider_lines add constraint fin_provider_lines_invoice_no_check
  check (invoice_no is null or invoice_no ~ '^[A-Za-z0-9][A-Za-z0-9._/:-]{0,39}$');
