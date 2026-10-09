-- Phase 6: org-consistency triggers fire only when the reference column is written.
-- As created in 20261009000100 they ran on every UPDATE, as the caller, so a user who may change an
-- appointment but cannot read contacts (no contacts.view) could not change it at all.

drop trigger services_department_org_check on public.services;
create trigger services_department_org_check before insert or update of department_id on public.services
  for each row execute function app.check_parent_org('departments', 'department_id');
drop trigger specialists_department_org_check on public.specialists;
create trigger specialists_department_org_check before insert or update of department_id on public.specialists
  for each row execute function app.check_parent_org('departments', 'department_id');
drop trigger specialist_locations_specialist_org_check on public.specialist_locations;
create trigger specialist_locations_specialist_org_check before insert or update of specialist_id on public.specialist_locations
  for each row execute function app.check_parent_org('specialists', 'specialist_id');
drop trigger specialist_locations_location_org_check on public.specialist_locations;
create trigger specialist_locations_location_org_check before insert or update of location_id on public.specialist_locations
  for each row execute function app.check_parent_org('locations', 'location_id');
drop trigger specialist_services_specialist_org_check on public.specialist_services;
create trigger specialist_services_specialist_org_check before insert or update of specialist_id on public.specialist_services
  for each row execute function app.check_parent_org('specialists', 'specialist_id');
drop trigger specialist_services_service_org_check on public.specialist_services;
create trigger specialist_services_service_org_check before insert or update of service_id on public.specialist_services
  for each row execute function app.check_parent_org('services', 'service_id');
drop trigger working_hours_specialist_org_check on public.working_hours;
create trigger working_hours_specialist_org_check before insert or update of specialist_id on public.working_hours
  for each row execute function app.check_parent_org('specialists', 'specialist_id');
drop trigger working_hours_location_org_check on public.working_hours;
create trigger working_hours_location_org_check before insert or update of location_id on public.working_hours
  for each row execute function app.check_parent_org('locations', 'location_id');
drop trigger time_blocks_specialist_org_check on public.time_blocks;
create trigger time_blocks_specialist_org_check before insert or update of specialist_id on public.time_blocks
  for each row execute function app.check_parent_org('specialists', 'specialist_id');
drop trigger time_blocks_location_org_check on public.time_blocks;
create trigger time_blocks_location_org_check before insert or update of location_id on public.time_blocks
  for each row execute function app.check_parent_org('locations', 'location_id');
drop trigger appointments_contact_org_check on public.appointments;
create trigger appointments_contact_org_check before insert or update of contact_id on public.appointments
  for each row execute function app.check_parent_org('contacts', 'contact_id');
drop trigger appointments_location_org_check on public.appointments;
create trigger appointments_location_org_check before insert or update of location_id on public.appointments
  for each row execute function app.check_parent_org('locations', 'location_id');
drop trigger appointments_specialist_org_check on public.appointments;
create trigger appointments_specialist_org_check before insert or update of specialist_id on public.appointments
  for each row execute function app.check_parent_org('specialists', 'specialist_id');
drop trigger appointments_service_org_check on public.appointments;
create trigger appointments_service_org_check before insert or update of service_id on public.appointments
  for each row execute function app.check_parent_org('services', 'service_id');
drop trigger appointments_department_org_check on public.appointments;
create trigger appointments_department_org_check before insert or update of department_id on public.appointments
  for each row execute function app.check_parent_org('departments', 'department_id');
drop trigger appointments_channel_org_check on public.appointments;
create trigger appointments_channel_org_check before insert or update of channel_id on public.appointments
  for each row execute function app.check_parent_org('channels', 'channel_id');
drop trigger appointment_reminders_appointment_org_check on public.appointment_reminders;
create trigger appointment_reminders_appointment_org_check before insert or update of appointment_id on public.appointment_reminders
  for each row execute function app.check_parent_org('appointments', 'appointment_id');
