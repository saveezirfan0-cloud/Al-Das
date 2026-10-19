import "server-only";

import { can, type MemberLike } from "@/lib/auth/can";
import {
  claimFactsFromRow,
  claimStatus,
  denialOutcomeOf,
  takenBackByClaim,
  type ClaimActivityRow,
  type ClaimStatusResult,
} from "@/lib/finance/claim-status";
import type { AdminClient } from "@/lib/supabase/admin";
import { fetchAll } from "@/lib/supabase/fetch-all";

/**
 * One status per claim (docs/48), server side. The claims list and the claim page read the claim activities with the
 * member's own client (RLS); the facts Pulse holds elsewhere sit in tables with their own keys (advice lines:
 * finance.remittance.manage; denial cases: finance.denials.manage), so this reads ONLY what the status needs from them
 * with the service role, after the claims key: per claim id, the summed take-backs (an amount) and the case statuses.
 * No line, case, note or name leaves this file. The rule itself is pure (lib/finance/claim-status.ts).
 */

export type ClaimStatusSettings = {
  tolerance: number;
  acceptedStatuses: string[];
  /** null = not confirmed (Hardik): the page uses the proposed treatment and says so. */
  remittedNetsTakebacks: boolean | null;
};

const CHUNK = 200;
const ORG_WIDE_FROM = 1000; // more ids than this: read the org's rows once instead of in id chunks

export async function loadClaimStatusSettings(
  admin: AdminClient,
  member: MemberLike,
): Promise<ClaimStatusSettings> {
  if (!can(member, "finance.claims.view")) throw new Error("claim status: forbidden");
  const { data } = await admin
    .from("fin_ref_finance_settings")
    .select(
      "short_pay_tolerance_amount, accepted_claim_statuses, diligence_remitted_nets_takebacks",
    )
    .eq("org_id", member.orgId)
    .maybeSingle();
  const tol = Number(data?.short_pay_tolerance_amount);
  return {
    tolerance: data && Number.isFinite(tol) ? tol : 1,
    acceptedStatuses: data?.accepted_claim_statuses ?? [],
    remittedNetsTakebacks:
      typeof data?.diligence_remitted_nets_takebacks === "boolean"
        ? data.diligence_remitted_nets_takebacks
        : null,
  };
}

/** Status per claim activity id for the rows given. Throws without finance.claims.view. */
export async function claimStatusesFor<T extends ClaimActivityRow & { id: string }>(
  admin: AdminClient,
  member: MemberLike,
  rows: readonly T[],
  settings: ClaimStatusSettings,
): Promise<Map<string, ClaimStatusResult & { takenBack: number }>> {
  if (!can(member, "finance.claims.view")) throw new Error("claim status: forbidden");
  const out = new Map<string, ClaimStatusResult & { takenBack: number }>();
  if (rows.length === 0) return out;
  const ids = rows.map((r) => r.id);
  const orgWide = ids.length > ORG_WIDE_FROM;
  const wanted = new Set(ids);

  // Payments taken back: the negative advice lines (rare), amounts only.
  const lines: Array<{ claim_activity_id: string | null; paid_amount: number }> = [];
  const cases: Array<{ claim_activity_id: string; status: string; denied_on: string }> = [];
  if (orgWide) {
    const [l, c] = await Promise.all([
      fetchAll((from, to) =>
        admin
          .from("ins_remittance_lines")
          .select("claim_activity_id, paid_amount")
          .eq("org_id", member.orgId)
          .lt("paid_amount", 0)
          .not("claim_activity_id", "is", null)
          .order("id")
          .range(from, to),
      ),
      fetchAll((from, to) =>
        admin
          .from("ins_denial_cases")
          .select("claim_activity_id, status, denied_on")
          .eq("org_id", member.orgId)
          .order("id")
          .range(from, to),
      ),
    ]);
    if (l.error || c.error) throw new Error("claim status: load failed");
    lines.push(...l.data.filter((x) => x.claim_activity_id && wanted.has(x.claim_activity_id)));
    cases.push(...c.data.filter((x) => wanted.has(x.claim_activity_id)));
  } else {
    for (let i = 0; i < ids.length; i += CHUNK) {
      const part = ids.slice(i, i + CHUNK);
      const [l, c] = await Promise.all([
        admin
          .from("ins_remittance_lines")
          .select("claim_activity_id, paid_amount")
          .eq("org_id", member.orgId)
          .lt("paid_amount", 0)
          .in("claim_activity_id", part),
        admin
          .from("ins_denial_cases")
          .select("claim_activity_id, status, denied_on")
          .eq("org_id", member.orgId)
          .in("claim_activity_id", part),
      ]);
      if (l.error || c.error) throw new Error("claim status: load failed");
      lines.push(...(l.data ?? []));
      cases.push(...(c.data ?? []));
    }
  }

  const takenBack = takenBackByClaim(lines);
  const casesBy = new Map<string, Array<{ status: string; denied_on: string }>>();
  for (const c of cases) {
    const list = casesBy.get(c.claim_activity_id) ?? [];
    list.push(c);
    casesBy.set(c.claim_activity_id, list);
  }
  for (const r of rows) {
    const tb = takenBack.get(r.id) ?? 0;
    const facts = claimFactsFromRow(r, {
      takenBack: tb,
      denialOutcome: denialOutcomeOf(casesBy.get(r.id) ?? []),
      bankReceived: false, // not linked per claim yet (docs/48): a fully paid claim shows Paid, never Closed by bank
      acceptedStatuses: settings.acceptedStatuses,
      remittedNetsTakebacks: settings.remittedNetsTakebacks,
    });
    out.set(r.id, { ...claimStatus(facts, settings.tolerance), takenBack: tb });
  }
  return out;
}
