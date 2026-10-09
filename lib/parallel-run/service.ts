import "server-only";

import {
  COMPARABLE,
  diffSets,
  hashRef,
  makeOutputRows,
  previousDay,
  type ScenarioKey,
} from "@/lib/parallel-run/diff";
import type { AdminClient } from "@/lib/supabase/admin";

const PROGRAMME_FOR: Partial<Record<ScenarioKey, string>> = {
  birthday: "birthday",
  chronic_recall: "chronic_90d",
  chronic_update: "chronic_90d",
  appointment_reminders: "appointment_reminder_48h",
};

/** Clinic-local day [start, end) as UTC instants. Asia/Dubai has no DST (UTC+4). */
function dayBounds(day: string): { from: string; to: string } {
  const from = new Date(`${day}T00:00:00+04:00`);
  return { from: from.toISOString(), to: new Date(from.getTime() + 86_400_000).toISOString() };
}

/**
 * The native side of the comparison for one scenario and clinic-local day: hashed Unite PINs
 * (appointment ids for reminders) of everything the native engine did — queued, delivered, or recorded in Test mode.
 * `chronic_update` compares patients who replied that day.
 */
export async function nativeRefs(
  admin: AdminClient,
  orgId: string,
  scenario: ScenarioKey,
  day: string,
): Promise<string[] | null> {
  if (!COMPARABLE.has(scenario)) return null;
  const key = PROGRAMME_FOR[scenario];
  const { data: prog } = await admin
    .from("recall_programmes")
    .select("id")
    .eq("org_id", orgId)
    .eq("key", key!)
    .maybeSingle();
  if (!prog) return [];
  const { from, to } = dayBounds(day);

  const q = admin
    .from("recall_sends")
    .select("contact_id, appointment_id, contacts(external_id), appointments(external_id)")
    .eq("org_id", orgId)
    .eq("programme_id", prog.id);
  const { data } =
    scenario === "chronic_update"
      ? await q.gte("replied_at", from).lt("replied_at", to).limit(5000)
      : await q
          .in("status", ["queued", "eligible", "sent", "delivered", "read"])
          .gte("eligible_at", from)
          .lt("eligible_at", to)
          .limit(5000);

  const refs = new Set<string>();
  for (const r of data ?? []) {
    const id =
      scenario === "appointment_reminders" ? r.appointments?.external_id : r.contacts?.external_id;
    if (id) refs.add(hashRef(orgId, id));
  }
  return [...refs];
}

export async function ingestMakeOutputs(
  admin: AdminClient,
  orgId: string,
  scenario: ScenarioKey,
  day: string,
  ids: string[],
): Promise<number> {
  const rows = makeOutputRows(orgId, scenario, day, ids);
  if (rows.length === 0) return 0;
  const { error } = await admin
    .from("parallel_run_make_outputs")
    .upsert(rows, { onConflict: "org_id,scenario_key,run_date,ref_hash", ignoreDuplicates: true });
  if (error) throw new Error(`ingest: ${error.message}`);
  return rows.length;
}

/** Compute and store the diff for one org/scenario/day. Returns null when there is nothing to compare yet. */
export async function computeDiff(
  admin: AdminClient,
  orgId: string,
  scenario: ScenarioKey,
  day: string,
) {
  const native = await nativeRefs(admin, orgId, scenario, day);
  if (native === null) return null;
  const { data: made } = await admin
    .from("parallel_run_make_outputs")
    .select("ref_hash")
    .eq("org_id", orgId)
    .eq("scenario_key", scenario)
    .eq("run_date", day);
  if (!made?.length) return null; // no Make output imported for that day: nothing to compare
  const d = diffSets(
    made.map((m) => m.ref_hash),
    native,
  );

  const { data: prev } = await admin
    .from("parallel_run_diffs")
    .select("only_in_make, only_in_native, explained")
    .eq("org_id", orgId)
    .eq("scenario_key", scenario)
    .eq("run_date", day)
    .maybeSingle();
  const same =
    prev &&
    JSON.stringify(prev.only_in_make) === JSON.stringify(d.only_in_make) &&
    JSON.stringify(prev.only_in_native) === JSON.stringify(d.only_in_native);
  await admin
    .from("parallel_run_diffs")
    .upsert(
      {
        org_id: orgId,
        scenario_key: scenario,
        run_date: day,
        ...d,
        computed_at: new Date().toISOString(),
        explained: same ? prev.explained : false,
      },
      { onConflict: "org_id,scenario_key,run_date" },
    );
  return d;
}

export { previousDay };
