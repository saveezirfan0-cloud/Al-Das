"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";

import { recordAudit } from "@/lib/audit";
import { requirePerm } from "@/lib/auth/session";
import { createAdminClient } from "@/lib/supabase/admin";
import { resolveSyncReview } from "@/lib/unite/review";

export type ActionResult = { ok: true; message?: string } | { ok: false; error: string };

const schema = z.discriminatedUnion("action", [
  z.object({ id: z.string().uuid(), action: z.literal("link"), contactId: z.string().uuid() }),
  z.object({ id: z.string().uuid(), action: z.literal("create") }),
  z.object({ id: z.string().uuid(), action: z.literal("dismiss") }),
]);

export async function resolveReview(input: z.input<typeof schema>): Promise<ActionResult> {
  const member = await requirePerm("portal.sync_review.write");
  const parsed = schema.safeParse(input);
  if (!parsed.success) return { ok: false, error: "Invalid request." };
  const d = parsed.data;
  const admin = createAdminClient();
  const res = await resolveSyncReview(admin, {
    orgId: member.orgId,
    reviewId: d.id,
    userId: member.userId,
    action:
      d.action === "link"
        ? { kind: "link", contactId: d.contactId }
        : d.action === "create"
          ? { kind: "create" }
          : { kind: "dismiss" },
  });
  if (!res.ok) return { ok: false, error: res.error };
  await recordAudit(admin, {
    orgId: member.orgId,
    userId: member.userId,
    action: `sync_review.${d.action}`,
    entity: "sync_review",
    entityId: d.id,
    diff: { appointments: res.linkedAppointments },
  });
  revalidatePath("/portal/sync-review");
  return {
    ok: true,
    message:
      d.action === "dismiss"
        ? "Dismissed."
        : res.linkedAppointments
          ? `Linked. ${res.linkedAppointments} appointment${res.linkedAppointments === 1 ? "" : "s"} attached.`
          : "Linked.",
  };
}
