"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";

import { retryItems } from "@/lib/accounting/posting/runner";
import { POSTING_SOURCES, type PostingSource } from "@/lib/accounting/posting/types";
import { recordAudit } from "@/lib/audit";
import { can } from "@/lib/auth/can";
import { requireMember } from "@/lib/auth/session";
import { DENIED, fail, type ActionResult } from "@/lib/finance/action-support";
import { createAdminClient } from "@/lib/supabase/admin";

/**
 * Waiting to post (Phase 22D): try items again now, accounting.journals.approve (posting is what it does). The engine
 * posts through acc_post_from_source with the same rules as the scheduled run; nothing here bypasses a period lock, the
 * ledger start or a missing rule. Audited with counts only.
 */

async function gate(permission: string) {
  const member = await requireMember();
  return can(member, permission) ? member : null;
}

const MAX_RETRY = 200;

const schema = z.object({
  kind: z.enum(POSTING_SOURCES).optional(),
  id: z.string().trim().min(1).max(200).optional(),
  reason: z
    .string()
    .regex(/^[a-z_]{1,40}$/)
    .optional(),
});

export async function retryWaiting(raw: z.input<typeof schema>): Promise<ActionResult> {
  const member = await gate("accounting.journals.approve");
  if (!member) return fail(DENIED);
  const p = schema.safeParse(raw);
  if (!p.success) return fail("Reload the page and try again.");
  const admin = createAdminClient(member.userId); // service role AFTER the permission check
  let query = admin
    .from("acc_posting_status")
    .select("source_kind, source_id")
    .eq("org_id", member.orgId)
    .eq("state", "waiting")
    .order("last_attempt_at")
    .limit(MAX_RETRY);
  if (p.data.kind) query = query.eq("source_kind", p.data.kind);
  if (p.data.id) query = query.eq("source_id", p.data.id);
  if (p.data.reason) query = query.eq("reason", p.data.reason);
  const { data, error } = await query;
  if (error) return fail("The waiting items could not be read.");
  const items = (data ?? [])
    .filter((d) => (POSTING_SOURCES as readonly string[]).includes(d.source_kind))
    .map((d) => ({ kind: d.source_kind as PostingSource, id: d.source_id }));
  if (items.length === 0) return { ok: true, message: "Nothing is waiting." };
  let totals;
  try {
    totals = await retryItems(admin, member.orgId, items);
  } catch {
    return fail("The items could not be tried again. Try later.");
  }
  await recordAudit(admin, {
    orgId: member.orgId,
    userId: member.userId,
    action: "accounting.posting.retried",
    entity: "acc_posting_status",
    diff: {
      items: items.length,
      posted: totals.posted,
      preview: totals.preview,
      waiting: totals.waiting,
      kind: p.data.kind ?? null,
      reason: p.data.reason ?? null,
    },
  });
  revalidatePath("/accounting/waiting");
  return {
    ok: true,
    message: `${items.length} tried: ${totals.posted} posted, ${totals.preview} previewed, ${totals.waiting} still waiting.`,
  };
}
