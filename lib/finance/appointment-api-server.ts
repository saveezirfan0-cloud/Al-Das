import "server-only";

import { createHash } from "node:crypto";

import { fromZonedTime } from "date-fns-tz";

import { isAppointmentStatus, type AppointmentStatus } from "@/lib/appointments/status";
import { settledOf, uniteDayRows, type SyncedAppointment } from "@/lib/finance/appointment-api";
import type { AdminClient } from "@/lib/supabase/admin";
import { fetchAll } from "@/lib/supabase/fetch-all";
import type { Json } from "@/lib/supabase/types";

/** The sync_cursors entity holding each clinic's settled days, `{ settled: ['yyyy-mm-dd', …] }` (scope = the Unite clinic id). */
export const SETTLED_ENTITY = "appointments_settled";

export type HandOverResult = {
  imported: string[];
  /** day → why it was not handed over (codes only, never a record). */
  held: Record<string, string>;
};

type Log = {
  info: (m: string, x?: Record<string, unknown>) => void;
  warn: (m: string, x?: Record<string, unknown>) => void;
};

/**
 * Hands each finished day to W2 (`fin_appt_import`, source 'unite_api') once EVERY active Unite clinic has settled it,
 * so a day never looks covered while one clinic is missing. Idempotent: the same rows give the same checksum and the
 * import returns the existing upload; changed rows replace the day's earlier rows for the same clinics.
 */
export async function handOverUniteDays(
  admin: AdminClient,
  orgId: string,
  timezone: string,
  days: readonly string[],
  log: Log,
): Promise<HandOverResult> {
  const out: HandOverResult = { imported: [], held: {} };
  if (days.length === 0) return out;

  const [{ data: clinics, error: cErr }, { data: branches }, { data: codes }] = await Promise.all([
    admin
      .from("locations")
      .select("external_id, branch_code")
      .eq("org_id", orgId)
      .eq("active", true)
      .not("external_id", "is", null),
    admin.from("fin_ref_branches").select("code, unite_clinic_long_name").eq("org_id", orgId),
    admin.from("unite_appointment_status_map").select("code, status").eq("org_id", orgId),
  ]);
  if (cErr) throw new Error("Could not load the clinics.");
  const clinicIds = (clinics ?? []).map((c) => c.external_id as string);
  if (clinicIds.length === 0) {
    for (const d of days) out.held[d] = "no_clinics";
    return out;
  }

  const { data: cursors } = await admin
    .from("sync_cursors")
    .select("scope, cursor")
    .eq("org_id", orgId)
    .eq("source", "unite")
    .eq("entity", SETTLED_ENTITY)
    .in("scope", clinicIds);
  const settled = new Map<string, Set<string>>(
    (cursors ?? []).map((c) => [c.scope, new Set(settledOf(c.cursor))]),
  );

  const longName = new Map(
    (branches ?? []).flatMap((b) =>
      b.unite_clinic_long_name ? [[b.code, b.unite_clinic_long_name] as const] : [],
    ),
  );
  const clinicName = new Map(
    (clinics ?? []).map((c) => [
      c.external_id as string,
      c.branch_code ? (longName.get(c.branch_code) ?? null) : null,
    ]),
  );
  const statusMap = new Map<string, AppointmentStatus | null>(
    (codes ?? []).map((r) => [
      r.code.trim().toUpperCase(),
      isAppointmentStatus(r.status) ? r.status : null,
    ]),
  );

  for (const day of days) {
    if (clinicIds.some((id) => !settled.get(id)?.has(day))) {
      out.held[day] = "clinic_not_settled";
      continue;
    }
    const from = fromZonedTime(`${day}T00:00:00`, timezone);
    const to = new Date(from.getTime() + 86_400_000);
    const apptR = await fetchAll(
      (lo, hi) =>
        admin
          .from("appointments")
          .select(
            "id, external_id, starts_at, ends_at, external_status, unite_clinic_id, custom, specialist:specialists(name)",
          )
          .eq("org_id", orgId)
          .eq("source", "unite")
          .in("unite_clinic_id", clinicIds)
          .gte("starts_at", from.toISOString())
          .lt("starts_at", to.toISOString())
          .order("id")
          .range(lo, hi),
      { max: 29_000 },
    );
    if (apptR.error || apptR.truncated) {
      out.held[day] = apptR.error ? "read_failed" : "too_many_rows";
      continue;
    }
    const synced: SyncedAppointment[] = apptR.data.map((a) => {
      const custom =
        a.custom && typeof a.custom === "object" && !Array.isArray(a.custom)
          ? (a.custom as Record<string, unknown>)
          : {};
      const specialist = a.specialist as { name?: string | null } | null;
      return {
        externalId: a.external_id as string,
        startsAt: a.starts_at,
        endsAt: a.ends_at,
        externalStatus: a.external_status,
        endGiven: custom.unite_end_given === true,
        patientPin: typeof custom.unite_patient_pin === "string" ? custom.unite_patient_pin : null,
        doctorName:
          specialist?.name ??
          (typeof custom.unite_doctor_name === "string" ? custom.unite_doctor_name : null),
        clinicName: a.unite_clinic_id ? (clinicName.get(a.unite_clinic_id) ?? null) : null,
      };
    });
    const built = uniteDayRows(synced, { day, timezone, statusMap });
    if (!built.ok) {
      out.held[day] = `unmapped_status:${built.codes.join(",")}`;
      log.warn("unite day held: status code without a meaning", { day, codes: built.codes });
      continue;
    }
    if (built.rows.length === 0) {
      out.held[day] = "no_appointments";
      continue;
    }
    const sha = createHash("sha256")
      .update(`unite-api:v1:${day}:`)
      .update(JSON.stringify(built.rows))
      .digest("hex");
    const { error } = await admin.rpc("fin_appt_import", {
      p_org_id: orgId,
      p_user_id: null as unknown as string,
      p_meta: { file_sha256: sha, from_date: day, to_date: day, source: "unite_api" },
      p_rows: built.rows as unknown as Json,
    });
    if (error) {
      out.held[day] = "import_refused";
      log.warn("unite day held: import refused", { day, code: error.code });
      continue;
    }
    out.imported.push(day);
  }
  if (out.imported.length) log.info("unite days handed to finance", { days: out.imported.length });
  return out;
}
