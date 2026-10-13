import type { SupabaseClient } from "@supabase/supabase-js";

import type { AdminClient } from "@/lib/supabase/admin";
import type { Database, Tables } from "@/lib/supabase/types";

/** The F8 settings on fin_ref_finance_settings: doctor basis, evidenced statuses, completion evidence, escalation. */

export type OwnerRole = "insurance" | "billing" | "finance" | "admin";
export const OWNER_ROLES: readonly OwnerRole[] = ["insurance", "billing", "finance", "admin"];

export type BlueprintSettings = {
  /** null = not decided: reports show the invoice doctor and say so */
  doctorBasis: "ordering" | "performing" | null;
  acceptedClaimStatuses: string[];
  /** null = the visit-versus-invoice checks (E11, E12) are switched off */
  evidenceStartDate: string | null;
  evidenceGraceDays: number;
  escalationDays: number;
  escalationRole: OwnerRole;
};

export const DEFAULT_BLUEPRINT_SETTINGS: BlueprintSettings = {
  doctorBasis: null,
  acceptedClaimStatuses: [],
  evidenceStartDate: null,
  evidenceGraceDays: 2,
  escalationDays: 14,
  escalationRole: "finance",
};

export function blueprintFromRow(r: Tables<"fin_ref_finance_settings"> | null): BlueprintSettings {
  if (!r) return DEFAULT_BLUEPRINT_SETTINGS;
  const d = DEFAULT_BLUEPRINT_SETTINGS;
  return {
    doctorBasis:
      r.doctor_basis === "ordering" || r.doctor_basis === "performing" ? r.doctor_basis : null,
    acceptedClaimStatuses: r.accepted_claim_statuses ?? [],
    evidenceStartDate: r.evidence_start_date,
    evidenceGraceDays: Number.isFinite(Number(r.evidence_grace_days))
      ? Number(r.evidence_grace_days)
      : d.evidenceGraceDays,
    escalationDays: Number.isFinite(Number(r.escalation_days))
      ? Number(r.escalation_days)
      : d.escalationDays,
    escalationRole: (OWNER_ROLES as readonly string[]).includes(r.escalation_role)
      ? (r.escalation_role as OwnerRole)
      : d.escalationRole,
  };
}

export async function loadBlueprintSettings(
  client: AdminClient | SupabaseClient<Database>,
  orgId: string,
): Promise<BlueprintSettings> {
  const { data } = await client
    .from("fin_ref_finance_settings")
    .select("*")
    .eq("org_id", orgId)
    .maybeSingle();
  return blueprintFromRow(data);
}

/** "Approved, Paid" or one per line -> unique, trimmed, at most 30 entries of 60 characters. */
export function parseStatusList(raw: string): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const part of raw.split(/[\n,;]+/)) {
    const v = part.trim().slice(0, 60);
    if (v && !seen.has(v.toLowerCase())) {
      seen.add(v.toLowerCase());
      out.push(v);
    }
  }
  return out.slice(0, 30);
}

export const DOCTOR_BASIS_LABEL: Record<"ordering" | "performing", string> = {
  ordering: "ordering doctor",
  performing: "performing doctor",
};

/** One sentence that states which doctor a report counts, so nobody assumes. */
export function doctorBasisNote(b: BlueprintSettings["doctorBasis"]): string {
  return b
    ? `Doctor figures use the ${DOCTOR_BASIS_LABEL[b]} (set in Workflow settings). Where that doctor is missing, the invoice's doctor is used.`
    : "Which doctor governs these figures (ordering or performing) has not been decided, so the doctor on the invoice is used. Management and the Medical Director set this in Workflow settings.";
}
