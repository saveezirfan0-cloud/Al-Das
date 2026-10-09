import Link from "next/link";
import { formatInTimeZone } from "date-fns-tz";
import { ArrowLeft } from "lucide-react";

import { PageHeader } from "@/components/shell/page-header";
import { Button } from "@/components/ui/button";
import { requirePerm } from "@/lib/auth/session";
import { signOffBlockers } from "@/lib/cutover/parallel-run";
import { orgTimezone } from "@/lib/flow-engine/scope";
import { createAdminClient } from "@/lib/supabase/admin";
import { createClient } from "@/lib/supabase/server";

import { ParallelWorkspace, type ScenarioView } from "./parallel-workspace";

export const metadata = { title: "Parallel run" };
export const dynamic = "force-dynamic";

export default async function ParallelRunPage() {
  const member = await requirePerm("flows.manage");
  const supabase = await createClient();
  const admin = createAdminClient();
  const tz = await orgTimezone(admin, member.orgId);
  const today = formatInTimeZone(new Date(), tz, "yyyy-MM-dd");

  const [{ data: scenarios }, { data: diffs }, health] = await Promise.all([
    supabase
      .from("parallel_run_scenarios")
      .select("*")
      .eq("org_id", member.orgId)
      .order("created_at"),
    supabase
      .from("parallel_run_diffs")
      .select("scenario, run_date, make_count, native_count, only_in_make, only_in_native, note")
      .eq("org_id", member.orgId)
      .order("run_date", { ascending: false })
      .limit(400),
    admin.rpc("parallel_run_unite_health", { p_org: member.orgId, p_days: 7 }),
  ]);

  const views: ScenarioView[] = (scenarios ?? []).map((s) => {
    const mine = (diffs ?? []).filter((d) => d.scenario === s.key);
    const h = s.compare_kind === "health" ? (health.data?.[0] ?? { total: 0, ok: 0 }) : null;
    const blockers = signOffBlockers({
      compareKind: s.compare_kind as "ids" | "health" | "none",
      nativeReady: s.native_ready,
      parallelStartedOn: s.parallel_started_on,
      today,
      diffs: mine.map((d) => ({
        runDate: d.run_date,
        makeCount: d.make_count,
        nativeCount: d.native_count,
        onlyInMake: d.only_in_make.length,
        onlyInNative: d.only_in_native.length,
        noted: !!d.note?.trim(),
      })),
      health: h,
    });
    return {
      id: s.id,
      key: s.key,
      label: s.label,
      makeIds: s.make_scenario_ids,
      nativeSummary: s.native_summary,
      compareKind: s.compare_kind as ScenarioView["compareKind"],
      nativeReady: s.native_ready,
      startedOn: s.parallel_started_on,
      makeOffOn: s.make_off_on,
      signedOffBy: s.signed_off_by,
      signedOffOn: s.signed_off_on,
      notes: s.notes,
      health: h,
      blockers,
      days: mine.slice(0, 10).map((d) => ({
        date: d.run_date,
        make: d.make_count,
        native: d.native_count,
        onlyInMake: d.only_in_make,
        onlyInNative: d.only_in_native,
        note: d.note ?? "",
      })),
    };
  });

  return (
    <div className="space-y-4">
      <PageHeader
        title="Parallel run"
        description="Each Make scenario runs next to its replacement for a week. Compare what they did, explain every difference, and only then sign off and turn Make off."
      >
        <Button asChild variant="outline" size="sm">
          <Link href="/flows">
            <ArrowLeft className="size-4" />
            Flows
          </Link>
        </Button>
      </PageHeader>
      <ParallelWorkspace scenarios={views} today={today} />
    </div>
  );
}
