import { PageHeader } from "@/components/shell/page-header";
import { requirePerm } from "@/lib/auth/session";
import { readAppointmentSettings } from "@/lib/appointments/settings";
import { createAdminClient } from "@/lib/supabase/admin";

import { AppointmentsSettings } from "./appointments-settings";

export const metadata = { title: "Appointment settings" };

export default async function AppointmentSettingsPage() {
  const member = await requirePerm("settings.manage");
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
    { data: templates },
    { data: channels },
    { data: exclusions },
    { data: members },
  ] = await Promise.all([
    admin.from("orgs").select("settings, timezone").eq("id", org).single(),
    admin.from("locations").select("*").eq("org_id", org).order("name"),
    admin.from("departments").select("*").eq("org_id", org).order("name"),
    admin.from("services").select("*").eq("org_id", org).order("name"),
    admin.from("specialists").select("*").eq("org_id", org).order("name"),
    admin.from("specialist_locations").select("specialist_id, location_id").eq("org_id", org),
    admin.from("specialist_services").select("specialist_id, service_id").eq("org_id", org),
    admin
      .from("working_hours")
      .select("specialist_id, location_id, weekday, start_min, end_min")
      .eq("org_id", org),
    admin
      .from("wa_templates")
      .select("id, name, language, status, category")
      .eq("org_id", org)
      .is("archived_at", null)
      .order("name"),
    admin.from("channels").select("id, name, display_phone").eq("org_id", org).order("name"),
    admin
      .from("reminder_exclusions")
      .select("id, kind, match_type, value, reason, active")
      .eq("org_id", org)
      .order("kind")
      .order("value"),
    admin
      .from("memberships")
      .select("user_id, profiles(first_name, last_name)")
      .eq("org_id", org)
      .eq("status", "active"),
  ]);

  return (
    <div className="flex flex-col gap-6">
      <PageHeader
        title="Appointments"
        description="Locations, services, specialists and working hours, plus the booking rules and WhatsApp templates behind reminders."
      />
      <AppointmentsSettings
        orgTimezone={orgRow?.timezone ?? "Asia/Dubai"}
        rules={readAppointmentSettings(orgRow?.settings)}
        locations={locations ?? []}
        departments={departments ?? []}
        services={services ?? []}
        specialists={(specialists ?? []).map((s) => ({
          ...s,
          location_ids: (links ?? [])
            .filter((l) => l.specialist_id === s.id)
            .map((l) => l.location_id),
          service_ids: (svcLinks ?? [])
            .filter((l) => l.specialist_id === s.id)
            .map((l) => l.service_id),
          working_hours: (hours ?? []).filter((h) => h.specialist_id === s.id),
        }))}
        templates={templates ?? []}
        channels={channels ?? []}
        exclusions={exclusions ?? []}
        users={(members ?? []).map((m) => ({
          id: m.user_id,
          name: `${m.profiles?.first_name ?? ""} ${m.profiles?.last_name ?? ""}`.trim() || "User",
        }))}
      />
    </div>
  );
}
