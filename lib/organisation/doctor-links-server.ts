import "server-only";

import {
  financeDoctorLabel,
  suggestDoctorLinks,
  type FinanceDoctor,
  type LinkDoctor,
  type LinkSuggestion,
  type ReportDoctor,
} from "@/lib/organisation/doctor-links";
import type { DoctorFinanceLink } from "@/lib/organisation/types";
import type { AdminClient } from "@/lib/supabase/admin";
import { fetchAll } from "@/lib/supabase/fetch-all";

/**
 * Service-role loaders for the doctor drawer's Finance link (specialists ↔ fin_ref_doctors ↔ Unite report key). Every
 * caller has already checked finance.reference.manage (and the doctor's branch). Ids, codes and doctor names only: no
 * amounts, no patients.
 */

export type LinkSources = {
  doctors: LinkDoctor[];
  finance: FinanceDoctor[];
  report: ReportDoctor[];
};

/** The report's doctor keys with their most frequent spelling (fin_report_doctor_keys, current rows only). */
export async function loadReportDoctors(
  admin: AdminClient,
  orgId: string,
): Promise<ReportDoctor[]> {
  const { data, error } = await admin.rpc("fin_report_doctor_keys", { p_org_id: orgId });
  if (error) throw new Error("Could not read the Unite report doctors.");
  return (Array.isArray(data) ? data : []).flatMap((r) => {
    const o = r as { key?: unknown; name?: unknown };
    return typeof o.key === "string" && o.key
      ? [{ key: o.key, name: typeof o.name === "string" ? o.name : o.key }]
      : [];
  });
}

export async function loadLinkSources(admin: AdminClient, orgId: string): Promise<LinkSources> {
  const [{ data: doctors, error }, finance, report] = await Promise.all([
    admin
      .from("specialists")
      .select("id, name, licence_number, dha_id, report_doctor_key")
      .eq("org_id", orgId),
    fetchAll<{ dha_id: string; name: string | null }>((f, t) =>
      admin
        .from("fin_ref_doctors")
        .select("dha_id, name")
        .eq("org_id", orgId)
        .order("dha_id")
        .range(f, t),
    ),
    loadReportDoctors(admin, orgId),
  ]);
  if (error || finance.error) throw new Error("Could not load the doctor links.");
  return {
    doctors: (doctors ?? []).map((d) => ({
      id: d.id,
      name: d.name,
      licenceNumber: d.licence_number,
      dhaId: d.dha_id,
      reportDoctorKey: d.report_doctor_key,
    })),
    finance: (finance.data ?? []).map((f) => ({ dhaId: f.dha_id, name: f.name })),
    report,
  };
}

const valueOf = (s: LinkSuggestion) =>
  s.status === "match" || s.status === "taken" ? s.value : null;

/** One doctor's Finance link view, or null when the doctor does not exist. */
export async function loadDoctorFinanceLink(
  admin: AdminClient,
  orgId: string,
  doctorId: string,
): Promise<DoctorFinanceLink | null> {
  const src = await loadLinkSources(admin, orgId);
  const me = src.doctors.find((d) => d.id === doctorId);
  if (!me) return null;
  const suggestions = suggestDoctorLinks(src.doctors, src.finance, src.report).get(doctorId)!;
  const finLabel = new Map(src.finance.map((f) => [f.dhaId, financeDoctorLabel(f)]));
  const repLabel = new Map(src.report.map((r) => [r.key, r.name]));
  const usedFin = new Set(src.doctors.filter((d) => d.id !== doctorId).map((d) => d.dhaId));
  const usedRep = new Set(
    src.doctors.filter((d) => d.id !== doctorId).map((d) => d.reportDoctorKey),
  );
  const fin = valueOf(suggestions.finance);
  const rep = valueOf(suggestions.report);
  return {
    finance: me.dhaId
      ? {
          dhaId: me.dhaId,
          label: finLabel.get(me.dhaId) ?? me.dhaId,
          missing: !finLabel.has(me.dhaId),
        }
      : null,
    report: me.reportDoctorKey
      ? {
          key: me.reportDoctorKey,
          label: repLabel.get(me.reportDoctorKey) ?? me.reportDoctorKey,
          missing: !repLabel.has(me.reportDoctorKey),
        }
      : null,
    suggestions,
    suggestedLabels: {
      finance: fin ? (finLabel.get(fin) ?? fin) : null,
      report: rep ? (repLabel.get(rep) ?? rep) : null,
    },
    financeOptions: src.finance
      .filter((f) => !usedFin.has(f.dhaId))
      .map((f) => ({ value: f.dhaId, label: financeDoctorLabel(f) }))
      .sort((a, b) => a.label.localeCompare(b.label)),
    reportOptions: src.report
      .filter((r) => !usedRep.has(r.key))
      .map((r) => ({ value: r.key, label: r.name }))
      .sort((a, b) => a.label.localeCompare(b.label)),
  };
}
