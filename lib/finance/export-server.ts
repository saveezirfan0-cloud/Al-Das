import "server-only";

import {
  buildJournal,
  parseJournalSource,
  requiredAccounts,
  type AccountMapRow,
  type ExportResult,
} from "@/lib/finance/accounting-export";
import { dayNumber } from "@/lib/documents/expiry";
import type { AdminClient } from "@/lib/supabase/admin";

/** Gathers the journal source and the account map and builds the export. The period is limited to 13 months. */

export const MAX_PERIOD_DAYS = 400;

export type ExportBuild = {
  result: ExportResult;
  status: "provisional" | "final";
  /** Months in the period that are not locked yet (so the figures may still change). */
  openMonths: string[];
  needed: Array<{ kind: string; key: string; mapped: boolean }>;
};

function monthsIn(from: string, to: string): string[] {
  const out: string[] = [];
  let [y, m] = from.split("-").map(Number);
  const [ty, tm] = to.split("-").map(Number);
  while (y < ty || (y === ty && m <= tm)) {
    out.push(`${y}-${String(m).padStart(2, "0")}`);
    m++;
    if (m > 12) {
      m = 1;
      y++;
    }
  }
  return out;
}

export function validPeriod(from: string, to: string): string | null {
  const f = dayNumber(from);
  const t = dayNumber(to);
  if (f === null || t === null) return "Choose valid dates.";
  if (t < f) return "The end date is before the start date.";
  if (t - f + 1 > MAX_PERIOD_DAYS) return "Choose a period of 13 months or less.";
  return null;
}

export async function loadAccountMap(admin: AdminClient, orgId: string): Promise<AccountMapRow[]> {
  const { data } = await admin
    .from("fin_ref_account_map")
    .select("kind, key, account_code, account_name")
    .eq("org_id", orgId);
  return (data ?? []) as AccountMapRow[];
}

export async function buildAccountingExport(
  admin: AdminClient,
  orgId: string,
  from: string,
  to: string,
): Promise<ExportBuild> {
  const [{ data: src, error }, accounts, { data: closes }] = await Promise.all([
    admin.rpc("fin_journal_source", { p_org_id: orgId, p_from: from, p_to: to }),
    loadAccountMap(admin, orgId),
    admin
      .from("fin_period_closes")
      .select("month, status")
      .eq("org_id", orgId)
      .gte("month", `${from.slice(0, 7)}-01`)
      .lte("month", `${to.slice(0, 7)}-01`),
  ]);
  if (error) throw new Error(`journal source: ${error.code ?? "unknown"}`);
  const source = parseJournalSource(src);
  const locked = new Set(
    (closes ?? []).filter((c) => c.status === "locked").map((c) => c.month.slice(0, 7)),
  );
  const openMonths = monthsIn(from, to).filter((m) => !locked.has(m));
  const status = openMonths.length === 0 ? "final" : "provisional";
  const have = new Set(accounts.map((a) => `${a.kind}\u0000${a.key}`));
  const needed = requiredAccounts(source).map((n) => ({
    ...n,
    mapped: have.has(`${n.kind}\u0000${n.key}`),
  }));
  return { result: buildJournal(source, accounts, { status }), status, openMonths, needed };
}
