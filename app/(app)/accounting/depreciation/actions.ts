"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";

import { assetErrorMessage } from "@/lib/accounting/assets/errors";
import { RUN_KINDS } from "@/lib/accounting/assets/runs";
import { defaultEntityId, prepareRun } from "@/lib/accounting/assets/server";
import { recordAudit } from "@/lib/audit";
import { can } from "@/lib/auth/can";
import { requireMember } from "@/lib/auth/session";
import { DENIED, fail, firstIssue, uuid, type ActionResult } from "@/lib/finance/action-support";
import { createAdminClient } from "@/lib/supabase/admin";

/**
 * Monthly runs (Phase 22H): depreciation, schedule releases and reversing accruals. Preparing needs
 * accounting.assets.manage; posting needs accounting.journals.approve and a different person from the preparer, bound to
 * the sha256 of the lines they reviewed (all checked again in SQL: acc_asset_run_prepare / acc_asset_run_post). Audited.
 */

async function gate(permission: string) {
  const member = await requireMember();
  return can(member, permission) ? member : null;
}

function refresh() {
  revalidatePath("/accounting/depreciation");
  revalidatePath("/accounting/schedules");
  revalidatePath("/accounting/assets");
}

const prepareSchema = z.object({
  kind: z.enum(RUN_KINDS as unknown as ["depreciation", "schedules", "reversing_accruals"]),
  month: z
    .string()
    .trim()
    .regex(/^\d{4}-(0[1-9]|1[0-2])$/, "Choose the month."),
});

export async function prepareRunAction(values: Record<string, string>): Promise<ActionResult> {
  const member = await gate("accounting.assets.manage");
  if (!member) return fail(DENIED);
  const p = prepareSchema.safeParse(values);
  if (!p.success) return fail(firstIssue(p.error));
  const admin = createAdminClient(member.userId); // service role AFTER the permission check
  const entityId = await defaultEntityId(admin, member.orgId);
  if (!entityId) return fail("Set up the accounting entity first.");
  try {
    const res = await prepareRun(admin, {
      orgId: member.orgId,
      entityId,
      kind: p.data.kind,
      month: `${p.data.month}-01`,
      userId: member.userId,
    });
    if (!res) return fail("Nothing to prepare.");
    await recordAudit(admin, {
      orgId: member.orgId,
      userId: member.userId,
      action: "accounting.run.prepared",
      entity: "acc_depreciation_runs",
      entityId: res.id,
      diff: {
        kind: p.data.kind,
        month: p.data.month,
        version: res.version,
        total: res.total,
        changed: res.changed,
      },
    });
    refresh();
    return {
      ok: true,
      message: res.changed
        ? `Prepared ${res.lines} line${res.lines === 1 ? "" : "s"}. Someone else with journal approval posts it.`
        : "Nothing changed since it was last prepared or posted.",
    };
  } catch (err) {
    return fail(
      assetErrorMessage(err as { hint?: string; code?: string }, "The run could not be prepared."),
    );
  }
}

export async function postRunAction(input: { id: string; hash: string }): Promise<ActionResult> {
  const member = await gate("accounting.journals.approve");
  if (!member) return fail(DENIED);
  if (!uuid.safeParse(input.id).success || !/^[0-9a-f]{64}$/.test(input.hash))
    return fail("Reload the page and try again.");
  const admin = createAdminClient(member.userId);
  const { data, error } = await admin.rpc("acc_asset_run_post", {
    p_org_id: member.orgId,
    p_run_id: input.id,
    p_user_id: member.userId,
    p_hash: input.hash,
  });
  if (error) return fail(assetErrorMessage(error, "The run could not be posted."));
  const r = data as { status?: string; journal_id?: string | null; number?: string | null } | null;
  await recordAudit(admin, {
    orgId: member.orgId,
    userId: member.userId,
    action: "accounting.run.posted",
    entity: "acc_depreciation_runs",
    entityId: input.id,
    diff: {
      status: r?.status ?? null,
      journal_id: r?.journal_id ?? null,
      number: r?.number ?? null,
    },
  });
  refresh();
  if (r?.status === "waiting_ledger_start")
    return {
      ok: true,
      message:
        "The month is before the ledger start date. The run waits and can be posted once the start date allows it.",
    };
  return {
    ok: true,
    message: r?.number ? `Posted as ${r.number}.` : "Posted (nothing to journal).",
  };
}
