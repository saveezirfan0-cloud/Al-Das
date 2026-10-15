"use server";

import { revalidatePath } from "next/cache";

import { recordAudit } from "@/lib/audit";
import { can } from "@/lib/auth/can";
import { requireMember } from "@/lib/auth/session";
import {
  DENIED,
  dbMessage,
  fail,
  firstIssue,
  uuid,
  type ActionResult,
} from "@/lib/finance/action-support";
import {
  buildScenarioReport,
  calendarEventSchema,
  recruitmentInputsSchema,
  scenarioTitleSchema,
} from "@/lib/finance/recruitment";
import { loadBenchmarks, loadCalendarEvents } from "@/lib/finance/recruitment-server";
import { createAdminClient } from "@/lib/supabase/admin";
import type { Json } from "@/lib/supabase/types";

/**
 * Recruitment calculator (M4). Saving or deleting a scenario needs finance.costs.manage on top of the page's own
 * finance.profit.view and finance.costs.compensation (the inputs are compensation data). The calendar is maintained
 * with finance.costs.manage and finance.profit.view (who reads it). Writes use the service role after the check and
 * are audited with ids, codes and counts only, never the title (free text) or the amounts.
 */

/** Saving a scenario: the page's two keys plus finance.costs.manage. */
async function gate() {
  const member = await requireMember();
  return can(member, "finance.profit.view") &&
    can(member, "finance.costs.compensation") &&
    can(member, "finance.costs.manage")
    ? member
    : null;
}

/** The seasonal calendar: who maintains costs and can read the calendar. */
async function gateCalendar() {
  const member = await requireMember();
  return can(member, "finance.profit.view") && can(member, "finance.costs.manage") ? member : null;
}

const refresh = () => revalidatePath("/finance/recruitment");

/**
 * Saves a scenario. The result is worked out HERE, from the inputs and the clinic's current benchmarks and calendar,
 * never taken from the browser.
 */
export async function saveScenario(payload: {
  title: string;
  inputs: unknown;
}): Promise<ActionResult<{ id: string }>> {
  const member = await gate();
  if (!member) return fail(DENIED);
  const title = scenarioTitleSchema.safeParse(payload?.title ?? "");
  if (!title.success) return fail(firstIssue(title.error));
  const inputs = recruitmentInputsSchema.safeParse(payload?.inputs ?? {});
  if (!inputs.success) return fail(firstIssue(inputs.error));

  const admin = createAdminClient(member.userId); // service role AFTER the permission check
  try {
    const [benchmarks, events] = await Promise.all([
      loadBenchmarks(admin, member),
      loadCalendarEvents(admin, member.orgId),
    ]);
    const report = buildScenarioReport(inputs.data, benchmarks, events);
    const { data, error } = await admin
      .from("fin_recruitment_scenarios")
      .insert({
        org_id: member.orgId,
        title: title.data,
        inputs: inputs.data as unknown as Json,
        result: report as unknown as Json,
        created_by: member.userId,
      })
      .select("id")
      .single();
    if (error || !data) return fail(dbMessage(error, "Could not save the scenario."));
    await recordAudit(admin, {
      orgId: member.orgId,
      userId: member.userId,
      action: "finance.recruitment.scenario_saved",
      entity: "fin_recruitment_scenarios",
      entityId: data.id,
      diff: {
        contract_type: inputs.data.contractType,
        viability: report.result.viability,
        benchmark: report.benchmark.source,
      },
    });
    refresh();
    return { ok: true, data: { id: data.id }, message: "Scenario saved." };
  } catch {
    return fail("Could not save the scenario.");
  }
}

export async function deleteScenario(id: string): Promise<ActionResult> {
  const member = await gate();
  if (!member) return fail(DENIED);
  if (!uuid.safeParse(id).success) return fail("Choose a scenario.");
  const admin = createAdminClient(member.userId);
  const { data, error } = await admin
    .from("fin_recruitment_scenarios")
    .delete()
    .eq("org_id", member.orgId)
    .eq("id", id)
    .select("id");
  if (error) return fail(dbMessage(error, "Could not delete the scenario."));
  if (!data?.length) return fail("That scenario no longer exists.");
  await recordAudit(admin, {
    orgId: member.orgId,
    userId: member.userId,
    action: "finance.recruitment.scenario_deleted",
    entity: "fin_recruitment_scenarios",
    entityId: id,
  });
  refresh();
  return { ok: true, message: "Scenario deleted." };
}

export async function saveCalendarEvent(values: Record<string, string>): Promise<ActionResult> {
  const member = await gateCalendar();
  if (!member) return fail(DENIED);
  const parsed = calendarEventSchema.safeParse(values);
  if (!parsed.success) return fail(firstIssue(parsed.error));
  const v = parsed.data;
  const id = (values.id ?? "").trim();
  if (id !== "" && !uuid.safeParse(id).success) return fail("Choose an event.");
  const row = {
    starts_on: v.starts_on,
    ends_on: v.ends_on,
    kind: v.kind,
    label: v.label,
    approximate: v.approximate === "on",
  };
  const admin = createAdminClient(member.userId);
  const { data, error } = id
    ? await admin
        .from("fin_ref_calendar_events")
        .update(row)
        .eq("org_id", member.orgId)
        .eq("id", id)
        .select("id")
    : await admin
        .from("fin_ref_calendar_events")
        .insert({ ...row, org_id: member.orgId, created_by: member.userId })
        .select("id");
  if (error) return fail(dbMessage(error, "Could not save the event."));
  if (!data?.length) return fail("That event no longer exists.");
  await recordAudit(admin, {
    orgId: member.orgId,
    userId: member.userId,
    action: id ? "finance.recruitment.calendar_updated" : "finance.recruitment.calendar_added",
    entity: "fin_ref_calendar_events",
    entityId: data[0].id,
    diff: {
      kind: row.kind,
      starts_on: row.starts_on,
      ends_on: row.ends_on,
      approximate: row.approximate,
    },
  });
  refresh();
  return { ok: true, message: "Event saved." };
}

export async function deleteCalendarEvent(id: string): Promise<ActionResult> {
  const member = await gateCalendar();
  if (!member) return fail(DENIED);
  if (!uuid.safeParse(id).success) return fail("Choose an event.");
  const admin = createAdminClient(member.userId);
  const { data, error } = await admin
    .from("fin_ref_calendar_events")
    .delete()
    .eq("org_id", member.orgId)
    .eq("id", id)
    .select("id, kind, starts_on");
  if (error) return fail(dbMessage(error, "Could not delete the event."));
  if (!data?.length) return fail("That event no longer exists.");
  await recordAudit(admin, {
    orgId: member.orgId,
    userId: member.userId,
    action: "finance.recruitment.calendar_deleted",
    entity: "fin_ref_calendar_events",
    entityId: id,
    diff: { kind: data[0].kind, starts_on: data[0].starts_on },
  });
  refresh();
  return { ok: true, message: "Event deleted." };
}
