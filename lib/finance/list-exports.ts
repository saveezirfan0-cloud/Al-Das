import { safe } from "@/lib/finance/invoice-list";
import { isClaimStatus, type ClaimStatus } from "@/lib/finance/claim-status";
import { ACTIVE_STATUSES, CASE_STATUSES } from "@/lib/finance/denials";

/**
 * List exports (Phase G, pure): the filters the Claims and Denials lists read, parsed once so the page and its Excel
 * download select the same rows, and the query string that carries the page's filters to the download. Exports read every
 * row in pages (fetchAll), up to EXPORT_MAX_ROWS; a larger list says so in the workbook's heading.
 */

export const EXPORT_MAX_ROWS = 50_000;

type Search = Record<string, string | string[] | undefined>;
const one = (v: string | string[] | undefined) => (Array.isArray(v) ? v[0] : v);

export type ClaimFilters = {
  q: string;
  status: string;
  payer: string;
  denial: string;
  match: "matched" | "ambiguous" | "unmatched" | null;
  /** Pulse's one status per claim (claimStatus), worked out after the query; null = any. */
  cstatus: ClaimStatus | null;
};

export function parseClaimFilters(sp: Search): ClaimFilters {
  const match = one(sp.match);
  return {
    q: safe(one(sp.q)),
    status: safe(one(sp.status)),
    payer: safe(one(sp.payer)),
    denial: safe(one(sp.denial)),
    match: match === "matched" || match === "ambiguous" || match === "unmatched" ? match : null,
    cstatus: isClaimStatus(one(sp.cstatus)) ? (one(sp.cstatus) as ClaimStatus) : null,
  };
}

export type DenialFilters = {
  q: string;
  /** One case status, every status ("all") or the active ones (the list's default). */
  status: string | "all" | "active";
  payer: string;
  mine: boolean;
  due: boolean;
};

export function parseDenialFilters(sp: Search): DenialFilters {
  const status = one(sp.status) ?? "";
  return {
    q: safe(one(sp.q)).slice(0, 60),
    status: (CASE_STATUSES as readonly string[]).includes(status)
      ? status
      : status === "all"
        ? "all"
        : "active",
    payer: safe(one(sp.payer)).slice(0, 60),
    mine: one(sp.mine) === "1",
    due: one(sp.due) === "1",
  };
}

export const ACTIVE_DENIAL_STATUSES: readonly string[] = ACTIVE_STATUSES;

/** The list's current filters as a query string for its download link (paging dropped). */
export function exportQuery(sp: Search, keys: readonly string[]): string {
  const q = new URLSearchParams();
  for (const k of keys) {
    const v = one(sp[k]);
    if (v) q.set(k, v.slice(0, 120));
  }
  const s = q.toString();
  return s ? `?${s}` : "";
}

/** The heading line of a workbook whose list was cut at the ceiling. */
export function truncatedLine(truncated: boolean): string[] {
  return truncated
    ? [
        `Only the first ${EXPORT_MAX_ROWS.toLocaleString("en-GB")} rows: narrow the filters for the rest.`,
      ]
    : [];
}
