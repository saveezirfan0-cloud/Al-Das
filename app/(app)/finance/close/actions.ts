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
import {
  buildAndStorePack,
  lastClosedMonth,
  loadCloseByMonth,
  MONTH_RE,
} from "@/lib/finance/close-server";
import { EXPLANATION_MAX, EXPLANATION_MIN } from "@/lib/finance/insurance-receivable-control";
import { closePackPdfFile } from "@/lib/finance/signed-pdfs-server";
import { checkRateLimit, RATE_RULES, waitText } from "@/lib/rate-limit";
import { redactText } from "@/lib/redact";
import { signApprovalStatement } from "@/lib/signing/personal-server";
import { createAdminClient } from "@/lib/supabase/admin";
import type { Json } from "@/lib/supabase/types";

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
  /** Phase 22C: the PIN of the signer's own certificate (optional; never stored or logged). */
  pin: z.string().max(200).default(""),
});

type SignInput = { id: string; month: string; hash: string; note?: string; pin?: string };

/**
 * Phase 22C: with a PIN, the sign-off is first signed with the person's own certificate (a wrong PIN stops here and the
 * sign-off is not given), then the sign-off and the signature are stored together (fin_close_sign_signed).
 */
async function storeSignOff(
  member: NonNullable<Awaited<ReturnType<typeof gate>>>,
  step: "finance" | "ceo",
  data: z.output<typeof signSchema>,
): Promise<
  { ok: true; signed: boolean; fingerprint: string | null } | { ok: false; error: string }
> {
  const admin = createAdminClient(member.userId);
  if (data.pin === "") {
    const { error } = await admin.rpc(
      step === "finance" ? "fin_close_sign_finance" : "fin_close_sign_ceo",
      {
        p_org_id: member.orgId,
        p_close_id: data.id,
        p_user_id: member.userId,
        p_hash: data.hash,
        p_note: data.note,
      },
    );
    if (error) return fail(rpcMessage(error, "The sign-off could not be saved."));
    return { ok: true, signed: false, fingerprint: null };
  }
  const limit = await checkRateLimit(
    admin,
    "signing-pin",
    member.userId,
    RATE_RULES.signingPinPerUser,
  );
  if (!limit.allowed)
    return fail(`Too many signing attempts. Try again in ${waitText(limit.retryAfter)}.`);
  const signed = await signApprovalStatement(admin, {
    orgId: member.orgId,
    userId: member.userId,
    pin: data.pin,
    docType: "close_pack",
    docId: data.id,
    docRef: data.month,
    step,
    boundSha256: data.hash,
    remarks: data.note || null,
  });
  if (!signed.ok) return fail(`${signed.error} The sign-off was not saved.`);
  const { error } = await admin.rpc("fin_close_sign_signed", {
    p_org_id: member.orgId,
    p_close_id: data.id,
    p_user_id: member.userId,
    p_step: step,
    p_hash: data.hash,
    p_note: data.note,
    p_signature: signed.signature as unknown as Json,
  });
  if (error) return fail(rpcMessage(error, "The sign-off could not be saved."));
  return { ok: true, signed: true, fingerprint: signed.signature.fingerprint };
}

export async function signOffFinance(raw: SignInput): Promise<ActionResult> {
  const member = await gate("finance.close.signoff.finance");
  if (!member) return fail(DENIED);
  const p = signSchema.safeParse(raw);
  if (!p.success) return fail("Reload the page and try again.");
  const r = await storeSignOff(member, "finance", p.data);
  if (!r.ok) return r;
  const admin = createAdminClient(member.userId);
  await recordAudit(admin, {
    orgId: member.orgId,
    userId: member.userId,
    action: "finance.close.signed_finance",
    entity: "fin_period_closes",
    entityId: p.data.id,
    diff: {
      month: p.data.month,
      signed: r.signed,
      ...(r.fingerprint ? { cert_fingerprint: r.fingerprint } : {}),
    },
  });
  revalidatePath(`/finance/close/${p.data.month}`);
  revalidatePath("/finance/close");
  return {
    ok: true,
    message: `Signed for Finance${r.signed ? " with your certificate" : ""}. The CEO signs next.`,
  };
}

export async function signOffCeo(raw: SignInput): Promise<ActionResult> {
  const member = await gate("finance.close.signoff.ceo");
  if (!member) return fail(DENIED);
  const p = signSchema.safeParse(raw);
  if (!p.success) return fail("Reload the page and try again.");
  const r = await storeSignOff(member, "ceo", p.data);
  if (!r.ok) return r;
  const admin = createAdminClient(member.userId);
  await recordAudit(admin, {
    orgId: member.orgId,
    userId: member.userId,
    action: "finance.close.signed_ceo_locked",
    entity: "fin_period_closes",
    entityId: p.data.id,
    diff: {
      month: p.data.month,
      signed: r.signed,
      ...(r.fingerprint ? { cert_fingerprint: r.fingerprint } : {}),
    },
  });
  // The month is locked: seal and keep the close pack PDF now (best effort; the download tries again).
  let sealed = false;
  try {
    const close = await loadCloseByMonth(admin, member.orgId, p.data.month);
    if (close?.pack && close.status === "locked")
      sealed = (
        await closePackPdfFile(
          admin,
          {
            orgId: member.orgId,
            orgName: member.org.name,
            timezone: member.org.timezone,
            userId: member.userId,
          },
          close,
        )
      ).sealed;
  } catch (err) {
    console.error("[signing] close pack not sealed", {
      month: p.data.month,
      reason: redactText(err, 200),
    });
  }
  revalidatePath(`/finance/close/${p.data.month}`);
  revalidatePath("/finance/close");
  return {
    ok: true,
    message: `Signed${r.signed ? " with your certificate" : ""}. The month is now locked for good.${sealed ? " The close pack was sealed." : ""}`,
  };
}

const explainSchema = z.object({
  id: uuid,
  month: z.string().regex(MONTH_RE),
  hash: z.string().regex(/^[0-9a-f]{64}$/),
  note: z
    .string()
    .trim()
    .min(EXPLANATION_MIN, `Write at least ${EXPLANATION_MIN} characters.`)
    .max(EXPLANATION_MAX, `At most ${EXPLANATION_MAX} characters.`),
});

/**
 * docs/48: the preparer explains why the insurance receivable in this pack differs from Tally. Required (in SQL) before
 * the finance sign-off, which a different person gives. The text is stored on the close, never in the audit row.
 */
export async function explainInsReceivable(raw: {
  id: string;
  month: string;
  hash: string;
  note: string;
}): Promise<ActionResult> {
  const member = await gate("finance.close.manage");
  if (!member) return fail(DENIED);
  const p = explainSchema.safeParse(raw);
  if (!p.success) return fail(firstIssue(p.error));
  const admin = createAdminClient(member.userId);
  const { error } = await admin.rpc("fin_close_explain_ins_receivable", {
    p_org_id: member.orgId,
    p_close_id: p.data.id,
    p_user_id: member.userId,
    p_hash: p.data.hash,
    p_note: p.data.note,
  });
  if (error) return fail(rpcMessage(error, "The explanation could not be saved."));
  await recordAudit(admin, {
    orgId: member.orgId,
    userId: member.userId,
    action: "finance.close.ins_receivable_explained",
    entity: "fin_period_closes",
    entityId: p.data.id,
    diff: { month: p.data.month, field: "ins_control_note", length: p.data.note.length },
  });
  revalidatePath(`/finance/close/${p.data.month}`);
  return {
    ok: true,
    message: "Explanation saved. Someone else reviews it when they sign for Finance.",
  };
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
