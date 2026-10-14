import { PageHeader } from "@/components/shell/page-header";
import { requirePerm } from "@/lib/auth/session";
import { readAppointmentSettings } from "@/lib/appointments/settings";
import { initialSettingsTab } from "@/lib/appointments/settings-tabs";
import { createAdminClient } from "@/lib/supabase/admin";
import { createClient } from "@/lib/supabase/server";

import { AppointmentsSettings } from "./appointments-settings";

export const metadata = { title: "Clinic and appointments" };

export default async function AppointmentSettingsPage({
  searchParams,
}: {
  searchParams: Promise<{ tab?: string | string[] }>;
}) {
  const member = await requirePerm("settings.manage");
  const { tab } = await searchParams;
  const admin = createAdminClient();
  const supabase = await createClient();
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
    { data: weekly },
    { data: financeBranches },
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
      .neq("category", "AUTHENTICATION")
      .is("archived_at", null)
      .order("name"),
    admin
      .from("channels")
      .select("id, name, display_phone")
      .eq("org_id", org)
      .eq("type", "whatsapp")
      .order("name"),
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
    admin
      .from("specialist_recurring_blocks")
      .select("specialist_id, location_id, weekday, start_min, end_min, reason")
      .eq("org_id", org)
      .order("weekday")
      .order("start_min"),
    // Phase B: the finance branch codes for the location picker, read with the member's own rights (RLS: finance
    // readers only). Without them the code is typed instead.
    supabase
      .from("fin_ref_branches")
      .select("code, name")
      .eq("org_id", org)
      .eq("active", true)
      .order("code"),
  ]);

  return (
    <div className="flex flex-col gap-6">
      <PageHeader
        title="Clinic and appointments"
        description="Set up in this order: your branches (locations), the services patients can book, then the doctors with the branches and hours they work. Booking rules and the WhatsApp templates behind reminders are on the last tab."
      />
      <AppointmentsSettings
        initialTab={initialSettingsTab(tab, (locations ?? []).length)}
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
          recurring_blocks: (weekly ?? [])
            .filter((b) => b.specialist_id === s.id)
            .map(({ location_id, weekday, start_min, end_min, reason }) => ({
              location_id,
              weekday,
              start_min,
              end_min,
              reason,
            })),
        }))}
        templates={templates ?? []}
        channels={channels ?? []}
        exclusions={exclusions ?? []}
        financeBranches={(financeBranches ?? []).map((b) => ({ code: b.code, name: b.name }))}
        users={(members ?? []).map((m) => ({
          id: m.user_id,
          name: `${m.profiles?.first_name ?? ""} ${m.profiles?.last_name ?? ""}`.trim() || "User",
        }))}
      />
    </div>
  );
}
