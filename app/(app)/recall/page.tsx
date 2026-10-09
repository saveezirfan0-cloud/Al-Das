import { PageHeader } from "@/components/shell/page-header";
import { can } from "@/lib/auth/can";
import { requirePerm } from "@/lib/auth/session";
import { createAdminClient } from "@/lib/supabase/admin";

import { settingValue } from "./actions";
import { RecallWorkspace, type ProgrammeVM } from "./recall-workspace";

export const metadata = { title: "Recall" };

export default async function RecallPage() {
  const member = await requirePerm("campaigns.view");
  const admin = createAdminClient();

  let { data: programmes } = await admin.from("recall_programmes").select("*").eq("org_id", member.orgId).order("created_at");
  if (!programmes?.length) {
    // First visit: create the programmes, settings rows and exclusion lists (idempotent).
    await admin.rpc("seed_phase8_defaults", { p_org: member.orgId });
    ({ data: programmes } = await admin.from("recall_programmes").select("*").eq("org_id", member.orgId).order("created_at"));
  }
  const ids = (programmes ?? []).map((p) => p.id);
  const [{ data: maps }, { data: templates }, { data: weekly }, { data: recent }, mode, testNumbers, clinicalOn] = await Promise.all([
    admin.from("recall_programme_templates").select("id, programme_id, segment_key, wa_template_id, legacy_sanoflow_template_id, active").in("programme_id", ids),
    admin.from("wa_templates").select("id, name, status, category").eq("org_id", member.orgId).is("archived_at", null).order("name"),
    admin.from("v_recall_weekly").select("programme_id, send_mode, week_start, sent, failed, replied, booked").eq("org_id", member.orgId).order("week_start", { ascending: false }).limit(60),
    admin.from("recall_sends").select("programme_id, status").eq("org_id", member.orgId).gte("created_at", new Date(Date.now() - 7 * 86_400_000).toISOString()).limit(5000),
    settingValue(admin, member.orgId, "recall_send_mode"),
    settingValue(admin, member.orgId, "test_recipient_numbers"),
    settingValue(admin, member.orgId, "clinical_messaging_enabled"),
  ]);

  const last7 = new Map<string, Record<string, number>>();
  for (const r of recent ?? []) {
    const m = last7.get(r.programme_id) ?? {};
    m[r.status] = (m[r.status] ?? 0) + 1;
    last7.set(r.programme_id, m);
  }
  const vms: ProgrammeVM[] = (programmes ?? []).map((p) => ({
    id: p.id,
    key: p.key,
    name: p.name,
    kind: p.kind,
    status: p.status as ProgrammeVM["status"],
    eligibility_view: p.eligibility_view,
    cron_expression: p.cron_expression,
    max_per_run: p.max_per_run,
    send_mode_override: (p.send_mode_override as "test" | "live" | null) ?? null,
    config: (p.config as Record<string, unknown>) ?? {},
    last_run_at: p.last_run_at,
    templates: (maps ?? []).filter((m) => m.programme_id === p.id).map((m) => ({ id: m.id, segment_key: m.segment_key, wa_template_id: m.wa_template_id, legacy: m.legacy_sanoflow_template_id, active: m.active })),
    last7: last7.get(p.id) ?? {},
    weekly: (weekly ?? []).filter((w) => w.programme_id === p.id).slice(0, 4).map((w) => ({ week_start: w.week_start ?? "", send_mode: w.send_mode ?? "", sent: Number(w.sent), failed: Number(w.failed), replied: Number(w.replied), booked: Number(w.booked) })),
  }));

  return (
    <div className="flex flex-col gap-6">
      <PageHeader title="Recall programmes" description="Automatic reminders and recalls. Everything starts in Test mode: messages go to your internal test numbers only, never to patients." />
      <RecallWorkspace
        programmes={vms}
        templates={templates ?? []}
        workspace={{ mode: mode === "live" ? "live" : "test", testNumbers: testNumbers ?? "", clinicalMessagingEnabled: clinicalOn?.toLowerCase() === "true" }}
        perms={{ manage: can(member, "campaigns.create"), mapTemplates: can(member, "templates.manage"), signOff: can(member, "clinical.settings.manage") }}
      />
    </div>
  );
}
