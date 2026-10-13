"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";

import { recordAudit } from "@/lib/audit";
import { requirePerm } from "@/lib/auth/session";
import { CHOOSABLE_CLASSES } from "@/lib/clinical/medication-class";
import { createAdminClient } from "@/lib/supabase/admin";

export type ActionResult = { ok: true; message?: string } | { ok: false; error: string };

const schema = z.object({
  code: z.string().trim().min(1).max(60),
  drugClass: z.enum(CHOOSABLE_CLASSES),
  requiresProbiotics: z.boolean(),
  confirmed: z.literal(true),
});

/**
 * A clinician classifies one Unite medication code (R-05). Writes ref_medication_classes (a record-history table,
 * so the client carries the person's id) and moves the code's still-unclassified prescriptions to the new class.
 * "Unclassified" is not a choice and the legacy heuristic is never applied: a person decides. Classifying a code
 * as an antibiotic lets the sequence sweep plan its live prescriptions; nothing is sent while the clinical
 * messaging gate is off.
 */
export async function classifyMedication(input: z.input<typeof schema>): Promise<ActionResult> {
  const member = await requirePerm("portal.medication_classes.write");
  const parsed = schema.safeParse(input);
  if (!parsed.success) return { ok: false, error: "Choose a class and tick the confirmation." };
  const d = parsed.data;
  const admin = createAdminClient(member.userId);

  const { data: rx } = await admin
    .from("prescriptions")
    .select("medication_name")
    .eq("org_id", member.orgId)
    .eq("medication_code", d.code)
    .limit(1)
    .maybeSingle();
  if (!rx) return { ok: false, error: "No prescription uses that code." };

  const now = new Date().toISOString();
  const { data: existing } = await admin
    .from("ref_medication_classes")
    .select("id, class")
    .eq("org_id", member.orgId)
    .eq("unite_local_code", d.code)
    .maybeSingle();
  const row = {
    class: d.drugClass,
    requires_probiotics_default: d.drugClass === "antibiotic" ? d.requiresProbiotics : false,
    classified_by: `user:${member.userId}`,
    classified_at: now,
  };
  const write = existing
    ? await admin
        .from("ref_medication_classes")
        .update(row)
        .eq("id", existing.id)
        .eq("org_id", member.orgId)
        .select("id")
        .single()
    : await admin
        .from("ref_medication_classes")
        .insert({
          ...row,
          org_id: member.orgId,
          unite_local_code: d.code,
          medication_name: rx.medication_name,
        })
        .select("id")
        .single();
  if (write.error || !write.data) return { ok: false, error: "Could not save the classification." };

  const { data: moved, error: moveError } = await admin
    .from("prescriptions")
    .update({ class: d.drugClass })
    .eq("org_id", member.orgId)
    .eq("medication_code", d.code)
    .eq("class", "unclassified")
    .select("id");
  if (moveError)
    return { ok: false, error: "Saved the class, but could not update the prescriptions." };

  // Ids, the code and the class only: no patient, no prescription detail.
  await recordAudit(admin, {
    orgId: member.orgId,
    userId: member.userId,
    action: "medication_class.classify",
    entity: "ref_medication_class",
    entityId: write.data.id,
    diff: {
      code: d.code,
      from: existing?.class ?? "unclassified",
      to: d.drugClass,
      requires_probiotics: row.requires_probiotics_default,
      prescriptions_updated: moved?.length ?? 0,
    },
  });
  revalidatePath("/portal/unclassified-medications");
  return {
    ok: true,
    message: `Classified. ${moved?.length ?? 0} prescription${moved?.length === 1 ? "" : "s"} updated.`,
  };
}
