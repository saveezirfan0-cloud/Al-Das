-- Phase 3 / 1: contacts core (the subset of the Phase 2 CRM that the inbox needs).
-- Phase 2 extends this with custom fields, segments and timeline events in its
-- own migrations; nothing here is edited afterwards.
--
-- Contacts are matched by BSUID (wa_bsuid = Meta `user_id`) and/or E.164 phone.
-- Either may be null (WhatsApp username users have no phone), never both.

create table public.contacts (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references public.orgs (id) on delete cascade,
  first_name text not null default '',
  last_name text not null default '',
  phone_e164 text,
  wa_bsuid text,
  wa_profile_name text,                              -- profile.name from the last inbound webhook
  email text,
  gender text check (gender is null or gender in ('female', 'male', 'other', 'unknown')),
  nationality text,
  language text,
  dob date,
  owner_id uuid references public.profiles (id) on delete set null,
  assignee_id uuid references public.profiles (id) on delete set null,
  source text not null default 'manual',             -- manual | whatsapp | import | unite | webhook
  external_id text,                                  -- Unite patient id (Phase 6)
  promotions_opt_in boolean not null default false,
  stop_marketing boolean not null default false,     -- set by Meta error 131050; honoured by campaigns
  custom jsonb not null default '{}'::jsonb,
  last_interaction_at timestamptz,
  deleted_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  check (phone_e164 is null or phone_e164 ~ '^\+[1-9][0-9]{6,14}$'),
  check (jsonb_typeof(custom) = 'object')
);
create unique index contacts_org_phone_idx on public.contacts (org_id, phone_e164)
  where phone_e164 is not null and deleted_at is null;
create unique index contacts_org_bsuid_idx on public.contacts (org_id, wa_bsuid)
  where wa_bsuid is not null and deleted_at is null;
create index contacts_org_external_idx on public.contacts (org_id, external_id) where external_id is not null;
create index contacts_org_last_interaction_idx on public.contacts (org_id, last_interaction_at desc nulls last);
create index contacts_org_name_trgm_idx on public.contacts using gin ((first_name || ' ' || last_name) gin_trgm_ops);
create trigger contacts_set_updated_at before update on public.contacts for each row execute function app.set_updated_at();

create table public.contact_phones (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references public.orgs (id) on delete cascade,
  contact_id uuid not null references public.contacts (id) on delete cascade,
  phone_e164 text not null check (phone_e164 ~ '^\+[1-9][0-9]{6,14}$'),
  label text,
  created_at timestamptz not null default now(),
  unique (contact_id, phone_e164)
);
create index contact_phones_org_phone_idx on public.contact_phones (org_id, phone_e164);

-- Tags are shared by contacts, conversations (as "labels") and enquiries.
create table public.tags (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references public.orgs (id) on delete cascade,
  name text not null,
  color text not null default 'gray',
  scope text not null default 'contact' check (scope in ('contact', 'conversation', 'enquiry')),
  sort integer not null default 0,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (org_id, scope, name)
);
create trigger tags_set_updated_at before update on public.tags for each row execute function app.set_updated_at();

create table public.contact_tags (
  org_id uuid not null references public.orgs (id) on delete cascade,
  contact_id uuid not null references public.contacts (id) on delete cascade,
  tag_id uuid not null references public.tags (id) on delete cascade,
  created_at timestamptz not null default now(),
  primary key (contact_id, tag_id)
);

-- ---------------------------------------------------------------------------
-- RLS. Reads for org members with contacts.view; writes for contacts.manage.
-- The inbound webhook handler writes through the service role.
-- ---------------------------------------------------------------------------

alter table public.contacts enable row level security;
alter table public.contact_phones enable row level security;
alter table public.tags enable row level security;
alter table public.contact_tags enable row level security;

create policy contacts_select on public.contacts for select to authenticated
  using (app.is_org_member(org_id) and (app.has_perm(org_id, 'contacts.view') or app.has_perm(org_id, 'inbox.send') or app.has_perm(org_id, 'inbox.view_all')));
create policy contacts_insert on public.contacts for insert to authenticated
  with check (app.has_perm(org_id, 'contacts.manage'));
create policy contacts_update on public.contacts for update to authenticated
  using (app.has_perm(org_id, 'contacts.manage'))
  with check (app.has_perm(org_id, 'contacts.manage'));
create policy contacts_delete on public.contacts for delete to authenticated
  using (app.has_perm(org_id, 'contacts.manage'));

create policy contact_phones_select on public.contact_phones for select to authenticated
  using (app.is_org_member(org_id) and (app.has_perm(org_id, 'contacts.view') or app.has_perm(org_id, 'inbox.send') or app.has_perm(org_id, 'inbox.view_all')));
create policy contact_phones_insert on public.contact_phones for insert to authenticated
  with check (app.has_perm(org_id, 'contacts.manage'));
create policy contact_phones_update on public.contact_phones for update to authenticated
  using (app.has_perm(org_id, 'contacts.manage'))
  with check (app.has_perm(org_id, 'contacts.manage'));
create policy contact_phones_delete on public.contact_phones for delete to authenticated
  using (app.has_perm(org_id, 'contacts.manage'));

create policy tags_select on public.tags for select to authenticated
  using (app.is_org_member(org_id));
create policy tags_insert on public.tags for insert to authenticated
  with check (app.has_perm(org_id, 'settings.manage') or app.has_perm(org_id, 'contacts.manage'));
create policy tags_update on public.tags for update to authenticated
  using (app.has_perm(org_id, 'settings.manage') or app.has_perm(org_id, 'contacts.manage'))
  with check (app.has_perm(org_id, 'settings.manage') or app.has_perm(org_id, 'contacts.manage'));
create policy tags_delete on public.tags for delete to authenticated
  using (app.has_perm(org_id, 'settings.manage'));

create policy contact_tags_select on public.contact_tags for select to authenticated
  using (app.is_org_member(org_id));
create policy contact_tags_insert on public.contact_tags for insert to authenticated
  with check (app.has_perm(org_id, 'contacts.manage'));
create policy contact_tags_delete on public.contact_tags for delete to authenticated
  using (app.has_perm(org_id, 'contacts.manage'));

-- Integrity: a contact's tag/phone must belong to the same org as the contact.
create or replace function app.check_contact_child_org()
returns trigger
language plpgsql
set search_path = ''
as $$
declare
  v_org uuid;
begin
  select org_id into v_org from public.contacts where id = new.contact_id;
  if v_org is distinct from new.org_id then
    raise exception 'contact % does not belong to org %', new.contact_id, new.org_id
      using errcode = 'check_violation';
  end if;
  if tg_table_name = 'contact_tags' then
    select org_id into v_org from public.tags where id = new.tag_id;
    if v_org is distinct from new.org_id then
      raise exception 'tag % does not belong to org %', new.tag_id, new.org_id
        using errcode = 'check_violation';
    end if;
  end if;
  return new;
end;
$$;
create trigger contact_phones_org_check before insert or update on public.contact_phones
  for each row execute function app.check_contact_child_org();
create trigger contact_tags_org_check before insert or update on public.contact_tags
  for each row execute function app.check_contact_child_org();
