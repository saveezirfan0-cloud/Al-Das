"use server";

import { z } from "zod";

import { recordAudit } from "@/lib/audit";
import { canAny } from "@/lib/auth/can";
import { requireMember } from "@/lib/auth/session";
import { DENIED, fail, firstIssue, type ActionResult } from "@/lib/finance/action-support";
import { loadCloseByMonth, MONTH_RE } from "@/lib/finance/close-server";
import { plausibleEmail, recipientHash } from "@/lib/finance/document-email";
import { closeSigners, queueDocumentEmail } from "@/lib/finance/document-email-server";
import { checkRateLimit, RATE_RULES, waitText } from "@/lib/rate-limit";
import { recordExport } from "@/lib/security/access-log";
import { createAdminClient } from "@/lib/supabase/admin";

/**
 * E-mail the month-end close pack to the people who signed it (Phase G). Same permission as downloading the pack (one of
 * the close keys). Only signers who are still active members and have an address get it, and only the ones the person
 * confirmed (by user id and address). The pack is the stored snapshot, rendered by the `notifications` job exactly as the
 * download route renders it. Audited (counts and ids) and logged as an export.
 */

const CLOSE_KEYS = [
  "finance.close.view",
  "finance.close.manage",
  "finance.close.signoff.finance",
  "finance.close.signoff.ceo",
];

async function gate() {
  const member = await requireMember();
  return canAny(member, CLOSE_KEYS) ? member : null;
}

const schema = z.object({
  month: z.string().regex(MONTH_RE, "Choose a month."),
  recipients: z
    .array(z.object({ userId: z.string().uuid(), email: z.string().trim().min(3).max(200) }))
    .min(1, "Nobody to send it to.")
    .max(2),
});

export async function emailClosePack(raw: {
  month: string;
  recipients: Array<{ userId: string; email: string }>;
}): Promise<ActionResult> {
  const member = await gate();
  if (!member) return fail(DENIED);
  const p = schema.safeParse(raw);
  if (!p.success) return fail(firstIssue(p.error));
  const admin = createAdminClient(member.userId); // service role AFTER the permission check
  const limit = await checkRateLimit(
    admin,
    "finance-document-email",
    member.userId,
    RATE_RULES.financeDocumentEmailPerUser,
  );
  if (!limit.allowed)
    return fail(`Too many e-mails sent. Try again in ${waitText(limit.retryAfter)}.`);
  const close = await loadCloseByMonth(admin, member.orgId, p.data.month);
  if (!close?.pack) return fail("There is no pack for that month yet.");
  const signers = await closeSigners(admin, member.orgId, close);
  const chosen = p.data.recipients.map((r) => {
    const s = signers.find((x) => x.userId === r.userId);
    return s && plausibleEmail(s.email) && recipientHash(s.email) === recipientHash(r.email)
      ? s
      : null;
  });
  if (chosen.some((s) => !s))
    return fail("The people who signed, or their addresses, changed. Reload and try again.");
  try {
    const requestIds: string[] = [];
    for (const s of chosen) {
      requestIds.push(
        await queueDocumentEmail({
          orgId: member.orgId,
          userId: member.userId,
          document: { kind: "close_pack", month: p.data.month, recipient_user_id: s!.userId },
          recipientEmail: s!.email!,
        }),
      );
    }
    await recordAudit(admin, {
      orgId: member.orgId,
      userId: member.userId,
      action: "finance.close.emailed",
      entity: "fin_period_closes",
      entityId: close.id,
      diff: {
        month: p.data.month,
        status: close.status,
        recipient_ids: chosen.map((s) => s!.userId),
        request_ids: requestIds,
      },
    });
    await recordExport(admin, member, {
      dataset: "finance:close-pack:email",
      rows: close.pack.by_branch.length * chosen.length,
      format: "pdf",
    });
    return {
      ok: true,
      message:
        chosen.length === 1
          ? "The close pack is on its way to the signer."
          : "The close pack is on its way to both signers.",
    };
  } catch {
    return fail("The close pack could not be queued. Try again.");
  }
}
