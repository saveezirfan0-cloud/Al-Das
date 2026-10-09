import { PageHeader } from "@/components/shell/page-header";
import { can } from "@/lib/auth/can";
import { requirePerm } from "@/lib/auth/session";
import { COMPARABLE, retirementReadiness, type ScenarioKey } from "@/lib/parallel-run/diff";
import { createAdminClient } from "@/lib/supabase/admin";

import { ParallelRunReport, type ScenarioVM } from "./parallel-run-report";

export const metadata = { title: "Parallel run" };

export default async function ParallelRunPage() {
  const member = await requirePerm("reports.view");
  const admin = createAdminClient();
  let { data: scenarios } = await admin.from("parallel_run_scenarios").select("*").eq("org_id", member.orgId).order("scenario_key");
  if (!scenarios?.length) {
    await admin.rpc("seed_phase8_defaults", { p_org: member.orgId });
    ({ data: scenarios } = await admin.from("parallel_run_scenarios").select("*").eq("org_id", member.orgId).order("scenario_key"));
  }
  const { data: diffs } = await admin.from("parallel_run_diffs").select("*").eq("org_id", member.orgId).order("run_date", { ascending: false }).limit(200);

  const order: ScenarioKey[] = ["token", "appointment_reminders", "birthday", "chronic_recall", "chronic_update", "mrd_sync", "airtable_automations"];
  const vms: ScenarioVM[] = [...(scenarios ?? [])]
    .sort((a, b) => order.indexOf(a.scenario_key as ScenarioKey) - order.indexOf(b.scenario_key as ScenarioKey))
    .map((s) => {
      const days = (diffs ?? []).filter((d) => d.scenario_key === s.scenario_key).map((d) => ({ run_date: d.run_date, make_count: d.make_count, native_count: d.native_count, only_in_make: d.only_in_make, only_in_native: d.only_in_native, explained: d.explained, reason: d.reason ?? "" }));
      const comparable = COMPARABLE.has(s.scenario_key as ScenarioKey);
      return {
        key: s.scenario_key,
        name: s.name,
        makeId: s.make_scenario_id,
        nativeBuilt: s.native_built,
        diffsExplained: s.diffs_explained,
        makeOff: s.make_off,
        blockedReason: s.blocked_reason,
        comparable,
        days,
        readiness: comparable ? retirementReadiness({ native_built: s.native_built, days: days.map((d) => ({ ...d })) }) : { ready: s.native_built, reasons: s.native_built ? [] : ["Native replacement is not built yet"] },
      };
    });

  return (
    <div className="flex flex-col gap-6">
      <PageHeader title="Parallel run" description="Native output (in Test mode) next to what Make produced, day by day. A Make scenario is switched off only after a clean week with every difference explained." />
      <ParallelRunReport scenarios={vms} canEdit={can(member, "settings.manage")} />
    </div>
  );
}
