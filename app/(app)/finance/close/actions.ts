"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";

import { recordAudit } from "@/lib/audit";
import { can } from "@/lib/auth/can";
import { requireMember } from "@/lib/auth/session";
import {
  DENIED,
  fail,
  firstIssue,
  todayIn,
  uuid,
  type ActionResult,
} from "@/lib/finance/action-support";
import { buildAndStorePack, lastClosedMonth, MONTH_RE } from "@/lib/finance/close-server";
import { createAdminClient } from "@/lib/supabase/admin";

/**
 * Month-end close. Building the pack needs finance.close.manage; the two sign-offs need their own permissions
 * (finance.close.signoff.finance, finance.close.signoff.ceo) and must come from two different people. The database enforces
 * the order, the hash the signer saw, and that a locked month can never change again (migration 20261016000600).
 */

async function gate(perm: string) {
  const member = await requireMember();
  return can(member, perm) ? member : null;
}

/** Our own check_violation messages are safe to show; anything else is not. */
const rpcMessage = (error: { code?: string; message: string }, fallback: string) =>
  error.code === "23514" || error.code === "P0001" ? error.message : fallback;

const monthSchema = z.object({ month: z.string().regex(MONTH_RE, "Choose a month.") });

export async function buildClosePackAction(raw: {
  month: string;
}): Promise<ActionResult<{ closeId: string }>> {
  const member = await gate("finance.close.manage");
  if (!member) return fail(DENIED);
  const p = monthSchema.safeParse(raw);
  if (!p.success) return fail(firstIssue(p.error));
  if (p.data.month > lastClosedMonth(todayIn(member.org.timezone)))
    return fail("A month can only be closed after it has ended.");
  const admin = createAdminClient(member.userId);
  try {
    const { closeId } = await buildAndStorePack(admin, {
      orgId: member.orgId,
      orgName: member.org.name,
      month: p.data.month,
      userId: member.userId,
    });
    await recordAudit(admin, {
      orgId: member.orgId,
      userId: member.userId,
      action: "finance.close.built",
      entity: "fin_period_closes",
      entityId: closeId,
      diff: { month: p.data.month },
    });
    revalidatePath("/finance/close");
    revalidatePath(`/finance/close/${p.data.month}`);
    return {
      ok: true,
      data: { closeId },
      message: "The pack was built from the current figures. Review it, then sign.",
    };
  } catch (err) {
    const e = err as { code?: string; message?: string };
    return fail(
      e.code === "23514"
        ? (e.message ?? "The pack could not be built.")
        : "The pack could not be built.",
    );
  }
}

const signSchema = z.object({
  id: uuid,
  month: z.string().regex(MONTH_RE),
  hash: z.string().regex(/^[0-9a-f]{64}$/),
  note: z.string().trim().max(500).default(""),
});

export async function signOffFinance(raw: {
  id: string;
  month: string;
  hash: string;
  note?: string;
}): Promise<ActionResult> {
  const member = await gate("finance.close.signoff.finance");
  if (!member) return fail(DENIED);
  const p = signSchema.safeParse(raw);
  if (!p.success) return fail("Reload the page and try again.");
  const admin = createAdminClient(member.userId);
  const { error } = await admin.rpc("fin_close_sign_finance", {
    p_org_id: member.orgId,
    p_close_id: p.data.id,
    p_user_id: member.userId,
    p_hash: p.data.hash,
    p_note: p.data.note,
  });
  if (error) return fail(rpcMessage(error, "The sign-off could not be saved."));
  await recordAudit(admin, {
    orgId: member.orgId,
    userId: member.userId,
    action: "finance.close.signed_finance",
    entity: "fin_period_closes",
    entityId: p.data.id,
    diff: { month: p.data.month },
  });
  revalidatePath(`/finance/close/${p.data.month}`);
  revalidatePath("/finance/close");
  return { ok: true, message: "Signed for Finance. The CEO signs next." };
}

export async function signOffCeo(raw: {
  id: string;
  month: string;
  hash: string;
  note?: string;
}): Promise<ActionResult> {
  const member = await gate("finance.close.signoff.ceo");
  if (!member) return fail(DENIED);
  const p = signSchema.safeParse(raw);
  if (!p.success) return fail("Reload the page and try again.");
  const admin = createAdminClient(member.userId);
  const { error } = await admin.rpc("fin_close_sign_ceo", {
    p_org_id: member.orgId,
    p_close_id: p.data.id,
    p_user_id: member.userId,
    p_hash: p.data.hash,
    p_note: p.data.note,
  });
  if (error) return fail(rpcMessage(error, "The sign-off could not be saved."));
  await recordAudit(admin, {
    orgId: member.orgId,
    userId: member.userId,
    action: "finance.close.signed_ceo_locked",
    entity: "fin_period_closes",
    entityId: p.data.id,
    diff: { month: p.data.month },
  });
  revalidatePath(`/finance/close/${p.data.month}`);
  revalidatePath("/finance/close");
  return { ok: true, message: "Signed. The month is now locked for good." };
}

/** Takes the finance sign-off back so the pack can be rebuilt (only before the CEO signs). */
export async function withdrawFinanceSignoff(raw: {
  id: string;
  month: string;
}): Promise<ActionResult> {
  const member = await gate("finance.close.manage");
  if (!member) return fail(DENIED);
  const p = z.object({ id: uuid, month: z.string().regex(MONTH_RE) }).safeParse(raw);
  if (!p.success) return fail("Reload the page and try again.");
  const admin = createAdminClient(member.userId);
  const { error } = await admin.rpc("fin_close_withdraw", {
    p_org_id: member.orgId,
    p_close_id: p.data.id,
  });
  if (error) return fail(rpcMessage(error, "The sign-off could not be withdrawn."));
  await recordAudit(admin, {
    orgId: member.orgId,
    userId: member.userId,
    action: "finance.close.signoff_withdrawn",
    entity: "fin_period_closes",
    entityId: p.data.id,
    diff: { month: p.data.month },
  });
  revalidatePath(`/finance/close/${p.data.month}`);
  return { ok: true, message: "The finance sign-off was withdrawn. The pack can be rebuilt." };
}
