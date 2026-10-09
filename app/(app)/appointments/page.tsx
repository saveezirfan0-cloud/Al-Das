import { can } from "@/lib/auth/can";
import { requirePerm } from "@/lib/auth/session";
import { readAppointmentSettings } from "@/lib/appointments/settings";
import { localDate } from "@/lib/appointments/slots";
import { formatPhone } from "@/lib/phone";
import { createAdminClient } from "@/lib/supabase/admin";

import type { GridPrefs } from "../contacts/actions";
import { AppointmentsWorkspace } from "./appointments-workspace";
import type { AppointmentsBootstrap } from "./types";

export const metadata = { title: "Appointments" };

const DATE = /^\d{4}-\d{2}-\d{2}$/;

export default async function AppointmentsPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const member = await requirePerm("appointments.view");
  const sp = await searchParams;
  const one = (k: string) => (typeof sp[k] === "string" ? (sp[k] as string) : undefined);
  const admin = createAdminClient();
  const org = member.orgId;

  const [
    { data: orgRow },
    { data: locations },
    { data: departments },
    { data: services },
    { data: specialists },
    { data: links },
    { data: svcLinks },
    { data: hours },
    { data: prefs },
  ] = await Promise.all([
    admin.from("orgs").select("settings, timezone").eq("id", org).single(),
    admin
      .from("locations")
      .select("id, name, timezone")
      .eq("org_id", org)
      .eq("active", true)
      .order("name"),
    admin.from("departments").select("id, name").eq("org_id", org).eq("active", true).order("name"),
    admin
      .from("services")
      .select("id, name, duration_min, department_id")
      .eq("org_id", org)
      .eq("active", true)
      .order("name"),
    admin
      .from("specialists")
      .select("id, name, title, department_id")
      .eq("org_id", org)
      .eq("active", true)
      .order("name"),
    admin.from("specialist_locations").select("specialist_id, location_id").eq("org_id", org),
    admin.from("specialist_services").select("specialist_id, service_id").eq("org_id", org),
    admin
      .from("working_hours")
      .select("specialist_id, location_id, weekday, start_min, end_min")
      .eq("org_id", org),
    admin
      .from("user_grid_prefs")
      .select("prefs")
      .eq("org_id", org)
      .eq("user_id", member.userId)
      .eq("grid_key", "appointments")
      .maybeSingle(),
  ]);

  const timezone = orgRow?.timezone ?? "Asia/Dubai";
  const rules = readAppointmentSettings(orgRow?.settings);
  const today = localDate(new Date(), timezone);

  const bootstrap: AppointmentsBootstrap = {
    timezone,
    today,
    can: {
      manage: can(member, "appointments.manage"),
      export: can(member, "contacts.export"),
      contacts: can(member, "contacts.manage"),
    },
    locations: locations ?? [],
    departments: departments ?? [],
    services: services ?? [],
    specialists: (specialists ?? []).map((s) => ({
      ...s,
      location_ids: (links ?? []).filter((l) => l.specialist_id === s.id).map((l) => l.location_id),
      service_ids: (svcLinks ?? [])
        .filter((l) => l.specialist_id === s.id)
        .map((l) => l.service_id),
      working_hours: (hours ?? []).filter((h) => h.specialist_id === s.id),
    })),
    rules: {
      working_weekdays: rules.working_weekdays,
      holidays: rules.holidays,
      auto_confirm: rules.auto_confirm,
      slot_granularity_min: rules.slot_granularity_min,
      templates: rules.templates,
    },
    gridPrefs: (prefs?.prefs as GridPrefs | null) ?? null,
  };

  // "Book appointment" from the inbox / a contact: /appointments?new=<contactId>
  let newContact = null;
  const newId = one("new");
  if (newId && can(member, "appointments.manage")) {
    const { data: c } = await admin
      .from("contacts")
      .select("id, full_name, phone_e164")
      .eq("id", newId)
      .eq("org_id", org)
      .is("deleted_at", null)
      .maybeSingle();
    if (c)
      newContact = {
        id: c.id,
        name: c.full_name || formatPhone(c.phone_e164) || "Patient",
        phone: c.phone_e164 ? formatPhone(c.phone_e164) : null,
      };
  }

  const view = one("view");
  return (
    <AppointmentsWorkspace
      bootstrap={bootstrap}
      initial={{
        view: view === "calendar" || view === "table" ? view : "day",
        date: DATE.test(one("date") ?? "") ? (one("date") as string) : today,
        newContact,
      }}
    />
  );
}
