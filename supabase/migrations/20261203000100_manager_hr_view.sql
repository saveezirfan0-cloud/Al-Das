-- Organisation view: the Manager reads staff records, duties and the rota (hr.view), so the CRM shows patients,
-- doctors, staff and appointments together. Editing staff (hr.manage) stays with HR and Admin. Pay is never part of
-- hr.view (it stays in Finance).
--
-- New workspaces get the key from SYSTEM_ROLES in lib/auth/permissions.ts; this adds it to the system Manager role of
-- every existing workspace. Additive and idempotent; it never removes a key.

update public.roles r
   set permissions = r.permissions || to_jsonb('hr.view'::text)
 where r.is_system
   and r.name = 'Manager'
   and jsonb_typeof(r.permissions) = 'array'
   and not (r.permissions ? 'hr.view');
