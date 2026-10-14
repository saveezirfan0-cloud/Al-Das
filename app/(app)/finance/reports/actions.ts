"use server";

import { z } from "zod";

import { recordAudit } from "@/lib/audit";
import { can } from "@/lib/auth/can";
import { requireMember } from "@/lib/auth/session";
import { DENIED, fail, firstIssue, todayIn, type ActionResult } from "@/lib/finance/action-support";
import { documentSpec, maskAddress, plausibleEmail, recipientHash } from "@/lib/finance/document-email";
import { queueDocumentEmail } from "@/lib/finance/document-email-server";
import { REPORT_EMAIL_PERMISSION } from "@/lib/finance/report-emails";
import { checkRateLimit, RATE_RULES, waitText } from "@/lib/rate-limit";
import { recordExport } from "@/lib/security/access-log";
import { createAdminClient } from "@/lib/supabase/admin";

/**
 * Reports hub, "E-mail me" (Phase G): the daily flash or the monthly summary for the picked period, e-mailed to the
 * person asking, at the address on their own profile (never a typed one). Each needs the report's own key (the card's),
 * re-checked by the job when it sends. Rate limited, audited (kind and period only) and logged as an export.
 */

async function gate(permission: string) {
  const member = await requireMember();
  return can(member, permission) ? member : null;
}

const input = z.discriminatedUnion("report", [
  z.object({
    report: z.literal("daily_flash"),
    day: z.string(),
    recipient: z.string().trim().min(3).max(200),
  }),
  z.object({
    report: z.literal("monthly_summary"),
    from: z.string(),
    to: z.string(),
    branch: z.string().nullable(),
    recipient: z.string().trim().min(3).max(200),
  }),
]);

export async function emailHubReport(raw: unknown): Promise<ActionResult> {
  const parsed = input.safeParse(raw);
  if (!parsed.success) return fail(firstIssue(parsed.error));
  const v = parsed.data;
  const member = await gate(REPORT_EMAIL_PERMISSION[v.report]);
  if (!member) return fail(DENIED);
  const email = member.profile.email ?? "";
  if (!plausibleEmail(email)) return fail("Your profile has no e-mail address.");
  if (recipientHash(email) !== recipientHash(v.recipient))
    return fail("Your e-mail address changed since the page was opened. Reload and try again.");
  const spec = documentSpec.safeParse(
    v.report === "daily_flash"
      ? { kind: "daily_flash", day: v.day, recipient_user_id: member.userId, run_id: null }
      : {
          kind: "monthly_summary",
          from: v.from,
          to: v.to,
          branch: v.branch,
          recipient_user_id: member.userId,
          run_id: null,
        },
  );
  if (!spec.success) return fail(firstIssue(spec.error));
  const d = spec.data;
  const today = todayIn(member.org.timezone);
  if (d.kind === "daily_flash" && d.day > today) return fail("Choose a day that has passed.");
  if (d.kind === "monthly_summary" && d.from > today.slice(0, 7))
    return fail("Choose months that have started.");

  const admin = createAdminClient(member.userId); // service role AFTER the permission check
  const limit = await checkRateLimit(
    admin,
    "finance-document-email",
    member.userId,
    RATE_RULES.financeDocumentEmailPerUser,
  );
  if (!limit.allowed)
    return fail(`Too many e-mails sent. Try again in ${waitText(limit.retryAfter)}.`);
  try {
    const requestId = await queueDocumentEmail({
      orgId: member.orgId,
      userId: member.userId,
      document: d,
      recipientEmail: email,
    });
    const period =
      d.kind === "daily_flash"
        ? { day: d.day }
        : d.kind === "monthly_summary"
          ? { from: d.from, to: d.to, branch: d.branch }
          : {};
    await recordAudit(admin, {
      orgId: member.orgId,
      userId: member.userId,
      action: "finance.report.emailed",
      entity: d.kind === "daily_flash" ? "fin_invoices" : "v_fin_monthly_measures",
      diff: { kind: d.kind, ...period, request_id: requestId },
    });
    await recordExport(admin, member, {
      dataset: `finance:${d.kind}:email`,
      rows: 1,
      format: "xlsx",
    });
    return { ok: true, message: `The report is on its way to ${maskAddress(email)}.` };
  } catch {
    return fail("The report could not be queued. Try again.");
  }
}
