"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";

import { recordAudit } from "@/lib/audit";
import { requirePerm } from "@/lib/auth/session";
import {
  buildSnapshot,
  checkAttestation,
  isValidPeriod,
  quarterOf,
  reviewSignature,
  type ReviewDecision,
  type ReviewEntry,
} from "@/lib/security/access-review";
import { gatherReviewUsers } from "@/lib/security/access-review-data";
import { readSecuritySettings } from "@/lib/security/settings";
import { createAdminClient } from "@/lib/supabase/admin";
import type { Json } from "@/lib/supabase/types";

export type ActionResult = { ok: true; message: string } | { ok: false; error: string };

const PATH = "/settings/access-review";
const uuid = z.string().uuid();

function entriesOf(snapshot: unknown): ReviewEntry[] {
  return Array.isArray(snapshot) ? (snapshot as ReviewEntry[]) : [];
}

/** Opens the review for a quarter (default: the current one) with a fresh snapshot of every member. */
export async function startAccessReview(period?: string): Promise<ActionResult> {
  const member = await requirePerm("security.manage");
  const chosen = period ?? quarterOf(new Date());
  if (!isValidPeriod(chosen)) return { ok: false, error: "Invalid period." };
  const admin = createAdminClient();
  const { data: existing } = await admin
    .from("access_reviews")
    .select("id")
    .eq("org_id", member.orgId)
    .eq("period", chosen)
    .maybeSingle();
  if (existing) return { ok: false, error: `A review for ${chosen} already exists.` };

  const users = await gatherReviewUsers(admin, member.orgId);
  const settings = readSecuritySettings(member.org.settings);
  const snapshot = buildSnapshot(users, new Date(), settings.dormant_days);
  const { data, error } = await admin
    .from("access_reviews")
    .insert({
      org_id: member.orgId,
      period: chosen,
      snapshot: snapshot as unknown as NonNullable<Json>,
      opened_by: member.userId,
    })
    .select("id")
    .single();
  if (error || !data) return { ok: false, error: "Could not open the review." };
  await recordAudit(admin, {
    orgId: member.orgId,
    userId: member.userId,
    action: "access_review.opened",
    entity: "access_review",
    entityId: data.id,
    diff: {
      period: chosen,
      users: snapshot.length,
      dormant: snapshot.filter((e) => e.dormant).length,
    },
  });
  revalidatePath(PATH);
  return { ok: true, message: `Review for ${chosen} opened with ${snapshot.length} people.` };
}

const decisionSchema = z.object({
  reviewId: uuid,
  userId: uuid,
  decision: z.enum(["keep", "revoke"]).nullable(),
});

/** Records the reviewer's keep/revoke decision for one person. */
export async function setReviewDecision(
  input: z.input<typeof decisionSchema>,
): Promise<ActionResult> {
  const member = await requirePerm("security.manage");
  const parsed = decisionSchema.safeParse(input);
  if (!parsed.success) return { ok: false, error: "Invalid input" };
  const admin = createAdminClient();
  const { data: review } = await admin
    .from("access_reviews")
    .select("id, status, snapshot")
    .eq("id", parsed.data.reviewId)
    .eq("org_id", member.orgId)
    .maybeSingle();
  if (!review) return { ok: false, error: "Review not found." };
  if (review.status !== "open") return { ok: false, error: "This review is already signed." };
  const snapshot = entriesOf(review.snapshot);
  const entry = snapshot.find((e) => e.userId === parsed.data.userId);
  if (!entry) return { ok: false, error: "That person is not in this review." };
  entry.decision = parsed.data.decision as ReviewDecision;
  const { error } = await admin
    .from("access_reviews")
    .update({ snapshot: snapshot as unknown as NonNullable<Json> })
    .eq("id", review.id)
    .eq("status", "open");
  if (error) return { ok: false, error: "Could not save the decision." };
  await recordAudit(admin, {
    orgId: member.orgId,
    userId: member.userId,
    action: "access_review.decision",
    entity: "access_review",
    entityId: review.id,
    diff: { user_id: parsed.data.userId, decision: parsed.data.decision },
  });
  revalidatePath(PATH);
  return { ok: true, message: "Saved." };
}

/** Re-reads roles, activity and API keys into an open review, keeping every decision already made. */
export async function refreshAccessReview(reviewId: string): Promise<ActionResult> {
  const member = await requirePerm("security.manage");
  if (!uuid.safeParse(reviewId).success) return { ok: false, error: "Invalid input" };
  const admin = createAdminClient();
  const { data: review } = await admin
    .from("access_reviews")
    .select("id, status, snapshot")
    .eq("id", reviewId)
    .eq("org_id", member.orgId)
    .maybeSingle();
  if (!review) return { ok: false, error: "Review not found." };
  if (review.status !== "open") return { ok: false, error: "This review is already signed." };
  const decisions = new Map(entriesOf(review.snapshot).map((e) => [e.userId, e.decision]));
  const users = await gatherReviewUsers(admin, member.orgId);
  const settings = readSecuritySettings(member.org.settings);
  const fresh = buildSnapshot(users, new Date(), settings.dormant_days).map((e) => ({
    ...e,
    decision: decisions.get(e.userId) ?? null,
  }));
  const { error } = await admin
    .from("access_reviews")
    .update({ snapshot: fresh as unknown as NonNullable<Json> })
    .eq("id", reviewId)
    .eq("status", "open");
  if (error) return { ok: false, error: "Could not refresh the review." };
  await recordAudit(admin, {
    orgId: member.orgId,
    userId: member.userId,
    action: "access_review.refreshed",
    entity: "access_review",
    entityId: reviewId,
    diff: { users: fresh.length },
  });
  revalidatePath(PATH);
  return { ok: true, message: "Review refreshed." };
}

const attestSchema = z.object({
  reviewId: uuid,
  typedName: z.string().trim().min(2).max(200),
  confirmed: z.boolean(),
  note: z.string().trim().max(1000).default(""),
});

/** Signs the review: the signer types their own name; the signature hash and an audit entry are written. */
export async function attestAccessReview(
  input: z.input<typeof attestSchema>,
): Promise<ActionResult> {
  const member = await requirePerm("security.manage");
  const parsed = attestSchema.safeParse(input);
  if (!parsed.success) return { ok: false, error: "Type your full name to sign." };
  const admin = createAdminClient();
  const { data: review } = await admin
    .from("access_reviews")
    .select("id, period, status, snapshot")
    .eq("id", parsed.data.reviewId)
    .eq("org_id", member.orgId)
    .maybeSingle();
  if (!review) return { ok: false, error: "Review not found." };
  if (review.status !== "open") return { ok: false, error: "This review is already signed." };
  const snapshot = entriesOf(review.snapshot);

  const check = checkAttestation({
    typedName: parsed.data.typedName,
    signerName: `${member.profile.first_name} ${member.profile.last_name}`,
    signerEmail: member.user.email ?? "",
    snapshot,
    confirmed: parsed.data.confirmed,
  });
  if (!check.ok) return { ok: false, error: check.error };

  const attestedAt = new Date().toISOString();
  const signature = reviewSignature({
    orgId: member.orgId,
    period: review.period,
    snapshot,
    signerId: member.userId,
    attestedAt,
  });
  const { data: updated, error } = await admin
    .from("access_reviews")
    .update({
      status: "attested",
      attested_by: member.userId,
      attested_at: attestedAt,
      attestation_name: parsed.data.typedName,
      attestation_note: parsed.data.note || null,
      signature,
    })
    .eq("id", review.id)
    .eq("status", "open")
    .select("id");
  if (error || !updated?.length) return { ok: false, error: "Could not sign the review." };
  await recordAudit(admin, {
    orgId: member.orgId,
    userId: member.userId,
    action: "access_review.attested",
    entity: "access_review",
    entityId: review.id,
    diff: {
      period: review.period,
      signature,
      users: snapshot.length,
      keep: snapshot.filter((e) => e.decision === "keep").length,
      revoke: snapshot.filter((e) => e.decision === "revoke").length,
    },
  });
  revalidatePath(PATH);
  return { ok: true, message: `Review for ${review.period} signed.` };
}
