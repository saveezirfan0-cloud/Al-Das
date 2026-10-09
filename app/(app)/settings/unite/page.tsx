import { PageHeader } from "@/components/shell/page-header";
import { APPOINTMENT_STATUSES, type AppointmentStatus } from "@/lib/appointments/status";
import { requirePerm } from "@/lib/auth/session";
import { serverEnv } from "@/lib/env";
import { createAdminClient } from "@/lib/supabase/admin";
import { hasCredentials, loadUniteAccount } from "@/lib/unite/store";
import { DEFAULT_UNITE_CONFIG } from "@/lib/unite/config";

import { UniteSettings } from "./unite-settings";

export const metadata = { title: "Unite settings" };

export default async function UniteSettingsPage() {
  const member = await requirePerm("settings.manage");
  const admin = createAdminClient();
  const org = member.orgId;
  const account = await loadUniteAccount(admin, org);
  let statusMap = (
    await admin
      .from("unite_appointment_status_map")
      .select("code, status, label, counts_as_no_show")
      .eq("org_id", org)
      .order("code")
  ).data;
  if (!statusMap?.length) {
    await admin.rpc("seed_unite_appointment_status_map", { p_org: org });
    statusMap = (
      await admin
        .from("unite_appointment_status_map")
        .select("code, status, label, counts_as_no_show")
        .eq("org_id", org)
        .order("code")
    ).data;
  }
  const [{ data: cursors }, { data: calls }, { data: locations }] = await Promise.all([
    admin
      .from("sync_cursors")
      .select("entity, scope, last_run_at, last_ok_at, error")
      .eq("org_id", org)
      .eq("source", "unite")
      .order("entity"),
    admin
      .from("unite_api_calls")
      .select("id, endpoint, unite_status, http_status, duration_ms, at")
      .eq("org_id", org)
      .order("id", { ascending: false })
      .limit(15),
    admin
      .from("locations")
      .select("name, external_id")
      .eq("org_id", org)
      .eq("active", true)
      .order("name"),
  ]);

  const env = serverEnv();
  const breakerUntil = account?.row.breaker_open_until;
  return (
    <div className="flex flex-col gap-6">
      <PageHeader
        title="Unite EMR"
        description="Read-only sync of appointments, doctors and patients. Pulse never writes to Unite and never calls its Finance API."
      />
      <UniteSettings
        exists={!!account}
        status={account?.row.status === "active" ? "active" : "paused"}
        config={account?.config ?? DEFAULT_UNITE_CONFIG}
        credentialSource={account && hasCredentials(account.row) ? "stored" : "missing"}
        envBaseUrl={env.UNITE_BASE_URL ?? null}
        breakerOpen={!!breakerUntil && new Date(breakerUntil) > new Date()}
        failures={account?.row.consecutive_failures ?? 0}
        tokenExpiresAt={account?.row.token_expires_at ?? null}
        cursors={cursors ?? []}
        calls={(calls ?? []).map((c) => ({ ...c, outcome: c.unite_status ?? "" }))}
        locations={locations ?? []}
        statusMap={(statusMap ?? []).map((r) => ({
          ...r,
          status: (APPOINTMENT_STATUSES as readonly string[]).includes(r.status ?? "")
            ? (r.status as AppointmentStatus)
            : null,
        }))}
        timezone={member.org.timezone}
      />
    </div>
  );
}
