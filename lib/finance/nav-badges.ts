import "server-only";

import { addDays } from "@/lib/documents/expiry";
import { badgesNeeded, type NavBadges } from "@/lib/finance/nav";
import { loadFinanceSettings } from "@/lib/finance/settings-db";
import { can, type MemberLike } from "@/lib/auth/can";
import type { SupabaseClient } from "@supabase/supabase-js";
import type { Database } from "@/lib/supabase/types";

/**
 * Counts for the Finance navigation badges, read with the member's OWN client (row level security applies) and only for the
 * entries the member can see. Head-only counts; each is one cheap query.
 */
export async function loadFinanceBadges(
  supabase: SupabaseClient<Database>,
  member: MemberLike & { userId: string },
  today: string,
): Promise<NavBadges> {
  const needed = badgesNeeded(member);
  if (needed.length === 0) return {};
  const settings = needed.some((b) => b === "preauth" || b === "denials")
    ? await loadFinanceSettings(supabase, member.orgId)
    : null;
  const out: NavBadges = {};
  const run: Array<Promise<void>> = [];
  const count = (key: keyof NavBadges, q: PromiseLike<{ count: number | null }>) =>
    run.push(Promise.resolve(q).then((r) => void (out[key] = r.count ?? 0)));
  for (const b of needed) {
    if (b === "exceptions")
      count(
        "exceptions",
        supabase
          .from("ops_exceptions")
          .select("id", { count: "exact", head: true })
          .in("status", ["open", "in_progress"]),
      );
    if (b === "preauth" && settings)
      count(
        "preauth",
        supabase
          .from("fin_pre_authorisations")
          .select("id", { count: "exact", head: true })
          .in("status", ["approved", "partially_approved"])
          .lte("expires_on", addDays(today, settings.preauthExpiryLeadDays) ?? today),
      );
    if (b === "denials" && settings)
      count(
        "denials",
        supabase
          .from("ins_denial_cases")
          .select("id", { count: "exact", head: true })
          .in("status", ["open", "in_progress"])
          .lte("deadline_on", addDays(today, settings.denialWarnDays) ?? today),
      );
    if (b === "notReady")
      count(
        "notReady",
        supabase
          .from("v_fin_billing_readiness")
          .select("invoice_id", { count: "exact", head: true }),
      );
    if (b === "remittance")
      count(
        "remittance",
        supabase
          .from("ins_remittance_lines")
          .select("id", { count: "exact", head: true })
          .is("reviewed_at", null)
          .or("match_status.neq.matched,short_amount.gt.0"),
      );
    if (b === "inbox")
      count(
        "inbox",
        supabase
          .from("fin_documents")
          .select("id", { count: "exact", head: true })
          .eq("status", "ready")
          .not("inbox_at", "is", null)
          .is("routed_at", null),
      );
    if (b === "close") {
      // months waiting for THIS member's signature
      const waiting: string[] = [];
      if (can(member, "finance.close.signoff.finance")) waiting.push("built");
      if (can(member, "finance.close.signoff.ceo")) waiting.push("finance_signed");
      if (waiting.length)
        count(
          "close",
          supabase
            .from("fin_period_closes")
            .select("id", { count: "exact", head: true })
            .in("status", waiting),
        );
    }
  }
  await Promise.all(run);
  return out;
}
