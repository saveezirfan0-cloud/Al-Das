-- 0103_clinical_followups.sql  (DRAFT — Phase 0)
-- Follow-up queue, feedback/outcomes, clinical message log, call scripts.
-- Depends on 0102, Phase 1 (teams, profiles), Phase 3 (messages), Phase 4 (wa_templates).
-- Source mapping: data-model-mapping.md §3.6–3.9, §4.1, §5.4–5.5.

do $$ begin
  if not exists (select 1 from pg_type where typname = 'followup_priority') then
    create type public.followup_priority as enum ('high','medium');
  end if;
  if not exists (select 1 from pg_type where typname = 'call_status') then
    create type public.call_status as enum ('pending','completed','escalated','no_answer');
  end if;
  if not exists (select 1 from pg_type where typname = 'followup_outcome') then
    create type public.followup_outcome as enum ('improving','same','worse');
  end if;
  if not exists (select 1 from pg_type where typname = 'escalation_status') then
    create type public.escalation_status as enum ('none','open','escalated','resolved');
  end if;
  if not exists (select 1 from pg_type where typname = 'feedback_stage') then
    create type public.feedback_stage as enum ('day3_antibiotics','after_antibiotics','after_probiotics','post_procedure');
  end if;
  if not exists (select 1 from pg_type where typname = 'clinical_send_status') then
    create type public.clinical_send_status as enum
      ('scheduled','suppressed_gate','suppressed_test_record','sent','delivered','read','failed','cancelled');
  end if;
end $$;

-- ---------------------------------------------------------------------------
-- clinical_followups — Acute.Follow-Up Queue (tblgX6wIqWefpwrBg) + legacy CFU queue
-- "PHASE 2 launches with internal nurse and call-centre tasks ONLY."
-- ---------------------------------------------------------------------------
create table if not exists public.clinical_followups (
  id                      uuid primary key default gen_random_uuid(),
  org_id                  uuid not null references public.orgs(id) on delete cascade,
  ref                     text,                                            -- fldXCi8apfSF1wGLH
  visit_id                uuid references public.visits(id) on delete set null,
  contact_id              uuid references public.contacts(id) on delete set null,
  rule_evaluation_id      uuid references public.visit_rule_evaluations(id) on delete set null,
  prescription_id         uuid references public.prescriptions(id) on delete set null,   -- sequence-driven items (ABX_UNWELL, no-reply)
  trigger_category        public.trigger_category,                         -- fldNOnLLHzKuEapJX
  priority                public.followup_priority not null default 'medium', -- fldX94COawJmYp0kb (OQ-30)
  due_date                date,                                            -- fldOVqtqfwRc7lOxx
  assigned_team_id        uuid references public.teams(id),                -- fldckx3vmXjysOFzf Nurse / Call Centre / Reception
  assigned_user_id        uuid references public.profiles(id),
  call_status             public.call_status not null default 'pending',   -- fldoS3vnm2UmJI21S
  outcome                 public.followup_outcome,                         -- fldbMjWZfeQfBYvJZ
  doctor_alert_required   boolean not null default false,                  -- fldKoC0xMVSjhKZ1g
  doctor_notified_at      timestamptz,                                     -- fldwfriyDgawIslbQ
  escalation_status       public.escalation_status not null default 'none', -- CFU fldVSf9u8lD3O97vp
  doctor_response_notes   text,                                            -- CFU fldfDWGbyIjyUKGy5
  notes                   text,                                            -- fldGJirPqdjyTo3e0
  dedupe_key              text,                                            -- R-11 (same value as the evaluation)
  closed_at               timestamptz,
  closed_reason           text,                                            -- completed | superseded | duplicate | …
  is_test_record          boolean not null default false,
  source                  text not null default 'engine',                  -- engine | airtable_acute | legacy_cfu
  created_at              timestamptz not null default now(),
  updated_at              timestamptz not null default now()
);
create unique index if not exists clinical_followups_dedupe on public.clinical_followups (org_id, dedupe_key) where closed_at is null and dedupe_key is not null;
create index if not exists clinical_followups_queue_idx on public.clinical_followups (org_id, call_status, due_date) where closed_at is null;

-- ---------------------------------------------------------------------------
-- clinical_feedback — Acute.Feedback & Outcomes (tbluNXftGwkP9rJDV) + PTF.Feedback & Outcomes
-- ---------------------------------------------------------------------------
create table if not exists public.clinical_feedback (
  id                        uuid primary key default gen_random_uuid(),
  org_id                    uuid not null references public.orgs(id) on delete cascade,
  ref                       text,                                          -- fldRthKkY016ceRta
  contact_id                uuid references public.contacts(id) on delete set null,
  prescription_id           uuid references public.prescriptions(id) on delete set null,
  visit_id                  uuid references public.visits(id) on delete set null,
  stage                     public.feedback_stage not null,                -- fldeR3gUWc5H3cRDh
  score                     int,                                           -- fld0yu7tTxBdtds2e
  symptoms_reported         text,                                          -- fldvGMaOXbeZKCZ13
  symptoms_improved         boolean,                                       -- PTF fldJmrHi2sP0foSH3
  side_effects_flagged      boolean not null default false,                -- fldwRxxa94xztwfpr (keyword scan, R-18)
  needs_doctor_review       boolean not null default false,                -- fldK1rGS5kkG5IL2G (stored result of R-18)
  red_flag_threshold_used   int,                                           -- snapshot of the threshold applied (null = evaluated fail-closed)
  doctor_notified_at        timestamptz,                                   -- fld0Hyt8i9QjKFPuB + fldq8lgUIHlHSc75b
  coordinator_notified_at   timestamptz,                                   -- flduYSDkd6Uc8VzPf + fldq8lgUIHlHSc75b
  source_message_id         uuid references public.messages(id),
  is_test_record            boolean not null default false,
  created_at                timestamptz not null default now(),
  updated_at                timestamptz not null default now(),
  constraint score_in_range check (score is null or score between 1 and 10),
  -- dual notification: a red flag must never end with only one party notified once both stamps exist
  constraint red_flag_notification_pair check (
    not needs_doctor_review
    or (doctor_notified_at is null and coordinator_notified_at is null)        -- not yet notified (job pending)
    or (doctor_notified_at is not null and coordinator_notified_at is not null))
);
create index if not exists clinical_feedback_redflag_idx on public.clinical_feedback (org_id, created_at desc) where needs_doctor_review;

-- ---------------------------------------------------------------------------
-- clinical_message_log — Acute.Message Log (tblXNWAh1hdaueUbs) + PTF.Whatsapp Automation Log
-- "Idempotency Key blocks duplicate sends when Unite re-syncs. Raw reply text is stored verbatim."
-- ---------------------------------------------------------------------------
create table if not exists public.clinical_message_log (
  id                   uuid primary key default gen_random_uuid(),
  org_id               uuid not null references public.orgs(id) on delete cascade,
  ref                  text,                                              -- fld0vFJUNeSuuwaRG
  template_key         text not null,                                     -- fldU0k0N5b3RiqfOl (RX_START, ABX_DAY3, ABX_UNWELL, PROBIOTIC_START, TREATMENT_OUTCOME, FU_*, LAB_*)
  wa_template_id       uuid references public.wa_templates(id),
  trigger_category     public.trigger_category,                           -- fld10J2UlPe3KH1gn
  idempotency_key      text not null,                                     -- fldYJRG3KcI8YyQbo  '<prescription or visit external key>:<template_key>'
  contact_id           uuid references public.contacts(id) on delete set null,
  visit_id             uuid references public.visits(id) on delete set null,
  prescription_id      uuid references public.prescriptions(id) on delete set null,
  followup_id          uuid references public.clinical_followups(id) on delete set null,
  send_mode            text not null default 'test',                      -- test | live (clinical_settings.recall_send_mode at send)
  status               public.clinical_send_status not null default 'scheduled',
  scheduled_at         timestamptz,                                       -- fldZ1PwpI2xNXRm4I
  sent_at              timestamptz,                                       -- fldBN7AFKvB77rHaV
  delivered_at         timestamptz,                                       -- fldigImLLUJ11a6ce
  read_at              timestamptz,
  replied_at           timestamptz,                                       -- fld8DkJbXI3agZomH
  reply_text           text,                                              -- fld5hfgCqvHX5R8Fo (verbatim)
  reply_parsed_score   int,                                               -- fldQgZnNj0k86Wckg (null when unparseable, R-16)
  message_id           uuid references public.messages(id),
  reply_message_id     uuid references public.messages(id),
  error_code           text,
  is_test_record       boolean not null default false,
  created_at           timestamptz not null default now(),
  updated_at           timestamptz not null default now(),
  unique (org_id, idempotency_key),
  constraint parsed_score_in_range check (reply_parsed_score is null or reply_parsed_score between 1 and 10),
  -- a live send to a test record is impossible
  constraint test_records_never_live check (not (is_test_record and send_mode = 'live' and status in ('sent','delivered','read')))
);
create index if not exists clinical_message_log_sched_idx on public.clinical_message_log (org_id, status, scheduled_at);

-- ---------------------------------------------------------------------------
-- clinical_call_scripts — FU_* rows of Acute.Message Templates are call scripts, not WhatsApp templates
-- ---------------------------------------------------------------------------
create table if not exists public.clinical_call_scripts (
  id                 uuid primary key default gen_random_uuid(),
  org_id             uuid not null references public.orgs(id) on delete cascade,
  key                text not null,                                       -- FU_CLINICAL, FU_PAEDS, FU_POSTPROC
  purpose            text,
  trigger_category   public.trigger_category,
  script             text not null,
  clinical_approval  text not null default 'awaiting',                    -- approved | awaiting | to_be_drafted
  phase              int,
  notes              text,
  created_at         timestamptz not null default now(),
  updated_at         timestamptz not null default now(),
  unique (org_id, key)
);

-- Portal: Follow-Up Queue list
create or replace view public.v_followup_queue with (security_invoker = true) as
select f.*, e.rules_fired, e.age_at_visit, e.department_effective, v.visit_date, v.doctor_name
from public.clinical_followups f
left join public.visit_rule_evaluations e on e.id = f.rule_evaluation_id
left join public.visits v on v.id = f.visit_id
where f.closed_at is null;

-- ---------------------------------------------------------------------------
-- RLS + updated_at
-- ---------------------------------------------------------------------------
select app.add_tenant_rls('clinical_followups',   'portal.clinical_followups.write');
select app.add_tenant_rls('clinical_feedback',     'portal.clinical_feedback.write');
select app.add_tenant_rls('clinical_message_log');                                   -- written by the sequence engine only
select app.add_tenant_rls('clinical_call_scripts', 'clinical.settings.manage');
