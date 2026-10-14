/**
 * One doctor, one identity (docs/40_MANAGEMENT_PLATFORM_PLAN.md §2): pure rules that suggest how a diary doctor
 * (`specialists`) links to the finance reference (`fin_ref_doctors`, by DHA id) and to the Unite collection report
 * (`fin_report_visits.doctor_key`). Nothing here writes: a person confirms every link on the Doctors page.
 *
 * - Finance: the licence number equal to the DHA id (spaces and case ignored), else the normalised name equal to the
 *   finance doctor's normalised name. A licence that matches nobody falls back to the name.
 * - Report: the normalised name equal to a report doctor key, with the same normaliser the Unite report uses.
 * - Never guessed: several candidates for one doctor, or one candidate wanted by several unlinked doctors on the same
 *   or a stronger rule, is "ambiguous"; a candidate already linked to another doctor is "taken". Doctors already
 *   linked (for that kind) get no suggestion and compete for nothing.
 */
import { NO_DOCTOR_KEY, normaliseDoctorKey } from "@/lib/finance/unite-report-mapping";

export type LinkDoctor = {
  id: string;
  name: string;
  licenceNumber: string | null;
  dhaId: string | null;
  reportDoctorKey: string | null;
};
export type FinanceDoctor = { dhaId: string; name: string | null };
export type ReportDoctor = { key: string; name: string };

export type LinkReason = "licence" | "name";
export type LinkSuggestion =
  | { status: "match"; value: string; reason: LinkReason }
  | { status: "ambiguous"; reason: LinkReason }
  | { status: "taken"; value: string; reason: LinkReason }
  | { status: "none" };
export type DoctorLinkSuggestions = { finance: LinkSuggestion; report: LinkSuggestion };

const RANK: Record<LinkReason, number> = { licence: 2, name: 1 };

/** A licence number or DHA id compared without spaces and case. */
export const licenceKey = (v: string | null | undefined): string =>
  (v ?? "").replace(/\s+/g, "").toUpperCase();

type Candidates = { values: string[]; reason: LinkReason };

function resolve(
  self: string,
  own: ReadonlyMap<string, Candidates>,
  linkedTo: ReadonlyMap<string, string>,
): LinkSuggestion {
  const mine = own.get(self);
  if (!mine || mine.values.length === 0) return { status: "none" };
  if (mine.values.length > 1) return { status: "ambiguous", reason: mine.reason };
  const value = mine.values[0];
  const holder = linkedTo.get(value);
  if (holder !== undefined && holder !== self)
    return { status: "taken", value, reason: mine.reason };
  for (const [id, other] of own) {
    if (id !== self && other.values.includes(value) && RANK[other.reason] >= RANK[mine.reason])
      return { status: "ambiguous", reason: mine.reason };
  }
  return { status: "match", value, reason: mine.reason };
}

const unique = (xs: string[]) => [...new Set(xs)];

/** Suggestions for every doctor, keyed by specialist id. */
export function suggestDoctorLinks(
  doctors: readonly LinkDoctor[],
  finance: readonly FinanceDoctor[],
  report: readonly ReportDoctor[],
): Map<string, DoctorLinkSuggestions> {
  const finByLicence = new Map<string, string[]>();
  const finByName = new Map<string, string[]>();
  for (const f of finance) {
    const lk = licenceKey(f.dhaId);
    if (lk) finByLicence.set(lk, [...(finByLicence.get(lk) ?? []), f.dhaId]);
    const nk = f.name ? normaliseDoctorKey(f.name) : "";
    if (nk) finByName.set(nk, [...(finByName.get(nk) ?? []), f.dhaId]);
  }
  const reportKeys = new Set(report.map((r) => r.key).filter((k) => k && k !== NO_DOCTOR_KEY));

  const finOwn = new Map<string, Candidates>();
  const repOwn = new Map<string, Candidates>();
  const finLinked = new Map<string, string>();
  const repLinked = new Map<string, string>();
  for (const d of doctors) {
    const nk = normaliseDoctorKey(d.name);
    if (d.dhaId) finLinked.set(d.dhaId, d.id);
    else {
      const byLicence = finByLicence.get(licenceKey(d.licenceNumber)) ?? [];
      if (licenceKey(d.licenceNumber) && byLicence.length > 0)
        finOwn.set(d.id, { values: unique(byLicence), reason: "licence" });
      else if (nk) finOwn.set(d.id, { values: unique(finByName.get(nk) ?? []), reason: "name" });
    }
    if (d.reportDoctorKey) repLinked.set(d.reportDoctorKey, d.id);
    else if (nk) repOwn.set(d.id, { values: reportKeys.has(nk) ? [nk] : [], reason: "name" });
  }

  const out = new Map<string, DoctorLinkSuggestions>();
  for (const d of doctors)
    out.set(d.id, {
      finance: resolve(d.id, finOwn, finLinked),
      report: resolve(d.id, repOwn, repLinked),
    });
  return out;
}

/** How a finance doctor is named in a picker: "Name · DHA id" (the id alone when there is no name). */
export function financeDoctorLabel(f: FinanceDoctor): string {
  return f.name?.trim() ? `${f.name.trim()} · ${f.dhaId}` : f.dhaId;
}

/** The doctor performance page, highlighting one report doctor when the key is known. */
export function performanceHref(reportDoctorKey: string | null | undefined): string {
  return reportDoctorKey
    ? `/finance/doctor-performance?doctor=${encodeURIComponent(reportDoctorKey)}`
    : "/finance/doctor-performance";
}
