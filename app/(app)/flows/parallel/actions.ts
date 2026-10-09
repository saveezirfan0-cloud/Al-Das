"use server";

import { revalidatePath } from "next/cache";
import { formatInTimeZone } from "date-fns-tz";
import { z } from "zod";

import { recordAudit } from "@/lib/audit";
import { requirePerm } from "@/lib/auth/session";
import {
  normaliseDate,
  parseMakeKeys,
  signOffBlockers,
  type DayDiff,
} from "@/lib/cutover/parallel-run";
import { orgTimezone } from "@/lib/flow-engine/scope";
import { createAdminClient } from "@/lib/supabase/admin";

type Result<T = undefined> =
  | (T extends undefined ? { ok: true; message?: string } : { ok: true; message?: string; data: T })
  | { ok: false; error: string };

const PERM = "flows.manage";
const uuid = z.string().uuid();
const bad = (error = "Invalid input"): { ok: false; error: string } => ({ ok: false, error });
const refresh = () => revalidatePath("/flows/parallel");
const dateOk = (v: string) => normaliseDate(v) === v;

export async function seedParallelScenarios(): Promise<Result> {
  const member = await requirePerm(PERM);
  const admin = createAdminClient();
  const { error } = await admin.rpc("seed_parallel_run_scenarios", { p_org: member.orgId });
  if (error) return bad("Could not set up the checklist.");
  await recordAudit(admin, {
    orgId: member.orgId,
    userId: member.userId,
    action: "parallel_run.seeded",
    entity: "parallel_run",
  });
  refresh();
  return { ok: true, message: "Checklist created." };
}

/** What Make handled on a day: identifiers only (appointment id or Unite PIN). */
export async function uploadMakeKeys(input: {
  scenario: string;
  date: string | null;
  text: string;
}): Promise<Result<{ stored: number; rejected: number; truncated: boolean }>> {
  const member = await requirePerm(PERM);
  const parsed = z
    .object({
      scenario: z.string().min(1).max(60),
      date: z.string().nullable(),
      text: z.string().max(400_000),
    })
    .safeParse(input);
  if (!parsed.success || (parsed.data.date && !dateOk(parsed.data.date))) return bad();
  const admin = createAdminClient();
  const { data: sc } = await admin
    .from("parallel_run_scenarios")
    .select("key, compare_kind")
    .eq("org_id", member.orgId)
    .eq("key", parsed.data.scenario)
    .maybeSingle();
  if (!sc || sc.compare_kind !== "ids") return bad("That scenario is not compared by identifiers.");
  const keys = parseMakeKeys(parsed.data.text, parsed.data.date);
  if (keys.rows.length === 0)
    return bad(
      keys.rejected
        ? "No usable identifiers. Use one id per line, optionally “id,date”; names are not accepted."
        : "Nothing to store.",
    );
  for (let i = 0; i < keys.rows.length; i += 500) {
    const chunk = keys.rows
      .slice(i, i + 500)
      .map((r) => ({ org_id: member.orgId, scenario: sc.key, run_date: r.date, key: r.key }));
    const { error } = await admin
      .from("parallel_run_make_keys")
      .upsert(chunk, { onConflict: "org_id,scenario,run_date,key", ignoreDuplicates: true });
    if (error) return bad("Could not store the identifiers.");
  }
  await recordAudit(admin, {
    orgId: member.orgId,
    userId: member.userId,
    action: "parallel_run.make_keys_uploaded",
    entity: "parallel_run",
    diff: { scenario: sc.key, stored: keys.rows.length, rejected: keys.rejected },
  });
  refresh();
  return {
    ok: true,
    data: { stored: keys.rows.length, rejected: keys.rejected, truncated: keys.truncated },
    message: `${keys.rows.length} identifiers stored.`,
  };
}

/** Recomputes the daily comparison for the last N days (including today). */
export async function computeComparison(days = 7): Promise<Result<{ computed: number }>> {
  const member = await requirePerm(PERM);
  const n = Math.max(1, Math.min(Math.floor(days), 31));
  const admin = createAdminClient();
  const tz = await orgTimezone(admin, member.orgId);
  const { data: scenarios } = await admin
    .from("parallel_run_scenarios")
    .select("key")
    .eq("org_id", member.orgId)
    .eq("compare_kind", "ids");
  let computed = 0;
  for (const s of scenarios ?? []) {
    for (let i = 0; i < n; i++) {
      const date = formatInTimeZone(new Date(Date.now() - i * 86_400_000), tz, "yyyy-MM-dd");
      const { error } = await admin.rpc("parallel_run_compare", {
        p_org: member.orgId,
        p_scenario: s.key,
        p_date: date,
        p_tz: tz,
      });
      if (!error) computed++;
    }
  }
  await recordAudit(admin, {
    orgId: member.orgId,
    userId: member.userId,
    action: "parallel_run.compared",
    entity: "parallel_run",
    diff: { days: n, computed },
  });
  refresh();
  return { ok: true, data: { computed }, message: `Compared ${computed} day(s).` };
}

export async function saveDayNote(scenario: string, date: string, note: string): Promise<Result> {
  const member = await requirePerm(PERM);
  if (!dateOk(date) || note.length > 500) return bad();
  const admin = createAdminClient();
  const { data, error } = await admin
    .from("parallel_run_diffs")
    .update({ note: note.trim() || null })
    .eq("org_id", member.orgId)
    .eq("scenario", scenario)
    .eq("run_date", date)
    .select("id");
  if (error || !data?.length) return bad("Compare that day first.");
  await recordAudit(admin, {
    orgId: member.orgId,
    userId: member.userId,
    action: "parallel_run.day_explained",
    entity: "parallel_run",
    diff: { scenario, date },
  });
  refresh();
  return { ok: true };
}

const checklistSchema = z.object({
  native_ready: z.boolean().optional(),
  parallel_started_on: z.string().nullable().optional(),
  notes: z.string().max(1000).nullable().optional(),
});

export async function updateScenario(
  id: string,
  input: z.input<typeof checklistSchema>,
): Promise<Result> {
  const member = await requirePerm(PERM);
  const parsed = checklistSchema.safeParse(input);
  if (!uuid.safeParse(id).success || !parsed.success) return bad();
  const d = parsed.data;
  if (d.parallel_started_on && !dateOk(d.parallel_started_on))
    return bad("Use a date like 2026-10-12.");
  const admin = createAdminClient();
  const { data: sc } = await admin
    .from("parallel_run_scenarios")
    .select("key, compare_kind")
    .eq("id", id)
    .eq("org_id", member.orgId)
    .maybeSingle();
  if (!sc) return bad("Not found.");
  if (sc.compare_kind === "none" && d.native_ready)
    return bad("There is no native replacement for this scenario yet.");
  await admin.from("parallel_run_scenarios").update(d).eq("id", id).eq("org_id", member.orgId);
  await recordAudit(admin, {
    orgId: member.orgId,
    userId: member.userId,
    action: "parallel_run.checklist_updated",
    entity: "parallel_run",
    entityId: id,
    diff: { scenario: sc.key },
  });
  refresh();
  return { ok: true };
}

async function evidence(
  admin: ReturnType<typeof createAdminClient>,
  orgId: string,
  scenarioKey: string,
  tz: string,
) {
  const { data } = await admin
    .from("parallel_run_diffs")
    .select("run_date, make_count, native_count, only_in_make, only_in_native, note")
    .eq("org_id", orgId)
    .eq("scenario", scenarioKey)
    .order("run_date", { ascending: false })
    .limit(60);
  const diffs: DayDiff[] = (data ?? []).map((r) => ({
    runDate: r.run_date,
    makeCount: r.make_count,
    nativeCount: r.native_count,
    onlyInMake: r.only_in_make.length,
    onlyInNative: r.only_in_native.length,
    noted: !!r.note?.trim(),
  }));
  const today = formatInTimeZone(new Date(), tz, "yyyy-MM-dd");
  return { diffs, today };
}

/** Records who signed off. The server recomputes the evidence; the page's own view of it is not trusted. */
export async function signOffScenario(id: string, signedBy: string): Promise<Result> {
  const member = await requirePerm(PERM);
  const name = signedBy.trim();
  if (!uuid.safeParse(id).success || name.length < 2 || name.length > 80)
    return bad("Enter the name of the person signing off.");
  const admin = createAdminClient();
  const { data: sc } = await admin
    .from("parallel_run_scenarios")
    .select("*")
    .eq("id", id)
    .eq("org_id", member.orgId)
    .maybeSingle();
  if (!sc) return bad("Not found.");
  const tz = await orgTimezone(admin, member.orgId);
  const { diffs, today } = await evidence(admin, member.orgId, sc.key, tz);
  let health: { total: number; ok: number } | null = null;
  if (sc.compare_kind === "health") {
    const { data } = await admin.rpc("parallel_run_unite_health", {
      p_org: member.orgId,
      p_days: 7,
    });
    health = data?.[0] ?? null;
  }
  const blockers = signOffBlockers({
    compareKind: sc.compare_kind as "ids" | "health" | "none",
    nativeReady: sc.native_ready,
    parallelStartedOn: sc.parallel_started_on,
    today,
    diffs,
    health,
  });
  if (blockers.length)
    return bad(
      `Not ready: ${blockers[0]}${blockers.length > 1 ? ` (+${blockers.length - 1} more)` : ""}`,
    );
  await admin
    .from("parallel_run_scenarios")
    .update({ signed_off_by: name, signed_off_on: today })
    .eq("id", id)
    .eq("org_id", member.orgId);
  await recordAudit(admin, {
    orgId: member.orgId,
    userId: member.userId,
    action: "parallel_run.signed_off",
    entity: "parallel_run",
    entityId: id,
    diff: { scenario: sc.key, signed_by: name },
  });
  refresh();
  return { ok: true, message: "Signed off. Now turn the Make scenario off and record the date." };
}

export async function recordMakeOff(id: string, date: string): Promise<Result> {
  const member = await requirePerm(PERM);
  if (!uuid.safeParse(id).success || !dateOk(date)) return bad();
  const admin = createAdminClient();
  const { data: sc } = await admin
    .from("parallel_run_scenarios")
    .select("key, signed_off_on")
    .eq("id", id)
    .eq("org_id", member.orgId)
    .maybeSingle();
  if (!sc) return bad("Not found.");
  if (!sc.signed_off_on) return bad("Sign the scenario off before turning Make off.");
  await admin
    .from("parallel_run_scenarios")
    .update({ make_off_on: date })
    .eq("id", id)
    .eq("org_id", member.orgId);
  await recordAudit(admin, {
    orgId: member.orgId,
    userId: member.userId,
    action: "parallel_run.make_turned_off",
    entity: "parallel_run",
    entityId: id,
    diff: { scenario: sc.key, on: date },
  });
  refresh();
  return { ok: true };
}
