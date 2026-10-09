/**
 * Unite → Pulse incremental syncs. READ-ONLY towards Unite; every write here lands in Pulse.
 *
 * Idempotent by construction: appointments are keyed on (org, source = 'unite', external_id),
 * patients on external_refs / contacts.external_id (the Unite PIN), doctors on specialists.external_id.
 * Replaying the same payload changes nothing and emits no events.
 */
import { syncAppointmentReminders } from "@/lib/appointments/service";
import { isAppointmentStatus, type AppointmentStatus } from "@/lib/appointments/status";
import { addTimelineEvent } from "@/lib/contacts/timeline";
import {
  findExternalRef,
  matchContact,
  queueSyncReview,
  upsertExternalRef,
  writePreparedContact,
} from "@/lib/contacts/import-writer";
import type { PreparedContact } from "@/lib/contacts/import";
import { emit } from "@/lib/events/emit";
import type { JobLogger } from "@/lib/jobs/types";
import type { AdminClient } from "@/lib/supabase/admin";
import type { Json, TablesUpdate } from "@/lib/supabase/types";
import type { RawRecord } from "@/lib/unite/client";
import type { UniteConfig } from "@/lib/unite/config";
import { mapAppointment, mapDoctor, mapPatient, type MappedPatient } from "@/lib/unite/mappers";

const SOURCE = "unite";

export type SyncCounters = {
  fetched: number;
  created: number;
  updated: number;
  unchanged: number;
  skipped: number;
  /** Patients put in the Sync Review queue (ambiguous, or unknown while auto-create is off). */
  reviews: number;
  /** Appointments saved without a linked patient. */
  unlinked: number;
  /** Contacts created for patients we had never seen. */
  patientsCreated: number;
  errors: Record<string, number>;
};

export function emptyCounters(): SyncCounters {
  return {
    fetched: 0,
    created: 0,
    updated: 0,
    unchanged: 0,
    skipped: 0,
    reviews: 0,
    unlinked: 0,
    patientsCreated: 0,
    errors: {},
  };
}

function bump(c: SyncCounters, reason: string) {
  c.errors[reason] = (c.errors[reason] ?? 0) + 1;
}

// ---------------------------------------------------------------------------
// Cursors
// ---------------------------------------------------------------------------

async function touchCursor(
  admin: AdminClient,
  orgId: string,
  entity: string,
  scope: string,
  patch: { ok: boolean; cursor?: NonNullable<Json>; error?: string | null },
) {
  const now = new Date().toISOString();
  await admin.from("sync_cursors").upsert(
    {
      org_id: orgId,
      source: SOURCE,
      entity,
      scope,
      last_run_at: now,
      ...(patch.ok ? { last_ok_at: now, error: null } : { error: patch.error ?? "failed" }),
      ...(patch.cursor !== undefined ? { cursor: patch.cursor } : {}),
    },
    { onConflict: "org_id,source,entity,scope" },
  );
}

export async function readCursor(
  admin: AdminClient,
  orgId: string,
  entity: string,
  scope = "",
): Promise<Record<string, unknown>> {
  const { data } = await admin
    .from("sync_cursors")
    .select("cursor")
    .eq("org_id", orgId)
    .eq("source", SOURCE)
    .eq("entity", entity)
    .eq("scope", scope)
    .maybeSingle();
  const c = data?.cursor;
  return c && typeof c === "object" && !Array.isArray(c) ? (c as Record<string, unknown>) : {};
}

// ---------------------------------------------------------------------------
// Patients
// ---------------------------------------------------------------------------

/** Stable key of a Unite patient in the review queue: the PIN, else the phone number. */
export function patientKey(p: { pin: string | null; phoneE164: string | null }): string | null {
  return p.pin ?? (p.phoneE164 ? `phone:${p.phoneE164}` : null);
}

type Resolution = {
  contactId: string | null;
  outcome: "linked" | "matched" | "created" | "review" | "unidentified" | "failed";
};

function splitName(full: string): { first: string; last: string } {
  const parts = full.trim().split(/\s+/).filter(Boolean);
  return parts.length <= 1
    ? { first: parts[0] ?? "", last: "" }
    : { first: parts[0], last: parts.slice(1).join(" ") };
}

function prepared(p: {
  first: string;
  last: string;
  phone: string | null;
  pin: string | null;
  nationality?: string | null;
  email?: string | null;
  dob?: string | null;
  gender?: PreparedContact["gender"];
}): PreparedContact {
  return {
    first_name: p.first,
    last_name: p.last,
    phone_e164: p.phone,
    alternate_phones: [],
    email: p.email ?? null,
    gender: p.gender ?? null,
    nationality: p.nationality ?? null,
    country: null,
    language: null,
    dob: p.dob ?? null,
    label: null,
    external_id: p.pin,
    promotions_opt_in: null,
    stop_marketing: null,
    tags: [],
    source: SOURCE,
    note: null,
    custom: {},
  };
}

/**
 * Finds (or creates) the contact for a Unite patient: PIN → E.164 phone (primary and alternates)
 * → name + date of birth. More than one candidate goes to the Sync Review queue and is never
 * auto-merged. Results are cached per sync run.
 */
export async function resolvePatient(
  admin: AdminClient,
  orgId: string,
  patient: {
    pin: string | null;
    name: string;
    phoneE164: string | null;
    nationality?: string | null;
    email?: string | null;
    dob?: string | null;
    gender?: PreparedContact["gender"];
  },
  opts: { createMissing: boolean; cache?: Map<string, Resolution>; counters: SyncCounters },
): Promise<Resolution> {
  const key = patientKey(patient);
  if (!key) return { contactId: null, outcome: "unidentified" };
  const hit = opts.cache?.get(key);
  if (hit) return hit;
  const done = (r: Resolution) => {
    opts.cache?.set(key, r);
    return r;
  };

  if (patient.pin) {
    const ref = await findExternalRef(admin, {
      orgId,
      source: SOURCE,
      entity: "patient",
      externalId: patient.pin,
    });
    if (ref) {
      const { data: still } = await admin
        .from("contacts")
        .select("id")
        .eq("id", ref.localId)
        .eq("org_id", orgId)
        .is("deleted_at", null)
        .maybeSingle();
      if (still) return done({ contactId: still.id, outcome: "linked" });
    }
  }

  // A reviewer already decided: never put the patient back in the queue.
  const { data: prior } = await admin
    .from("sync_reviews")
    .select("status, resolved_contact_id")
    .eq("org_id", orgId)
    .eq("source", SOURCE)
    .eq("entity", "patient")
    .eq("external_id", key)
    .maybeSingle();
  if (prior?.status === "resolved" && prior.resolved_contact_id)
    return done({ contactId: prior.resolved_contact_id, outcome: "linked" });
  if (prior?.status === "dismissed") return done({ contactId: null, outcome: "review" });

  const match = await matchContact(admin, orgId, {
    externalId: patient.pin,
    phone: patient.phoneE164,
    fullName: patient.name || null,
    dob: patient.dob ?? null,
  });

  if (match.kind === "match") {
    if (patient.pin) {
      // Adopt the PIN when the contact has none yet (a unique clash is left for a reviewer).
      await admin
        .from("contacts")
        .update({ external_id: patient.pin })
        .eq("id", match.id)
        .eq("org_id", orgId)
        .is("external_id", null);
      await upsertExternalRef(admin, {
        orgId,
        source: SOURCE,
        entity: "patient",
        externalId: patient.pin,
        localTable: "contacts",
        localId: match.id,
        meta: { matched_on: match.on },
      });
    }
    return done({ contactId: match.id, outcome: "matched" });
  }

  const incoming = {
    pin: patient.pin,
    name: patient.name,
    phone_e164: patient.phoneE164,
    dob: patient.dob ?? null,
  };

  if (match.kind === "ambiguous") {
    await queueSyncReview(admin, {
      orgId,
      source: SOURCE,
      entity: "patient",
      externalId: key,
      reason: `multiple_${match.candidates[0]?.matched_on ?? "identifier"}_matches`,
      candidates: match.candidates,
      incoming,
    });
    opts.counters.reviews++;
    return done({ contactId: null, outcome: "review" });
  }

  // No match at all.
  if (!opts.createMissing || !(patient.name || patient.phoneE164)) {
    await queueSyncReview(admin, {
      orgId,
      source: SOURCE,
      entity: "patient",
      externalId: key,
      reason: "no_match",
      candidates: [],
      incoming,
    });
    opts.counters.reviews++;
    return done({ contactId: null, outcome: "review" });
  }

  const { first, last } = splitName(patient.name);
  const res = await writePreparedContact(admin, {
    orgId,
    existingId: null,
    contact: prepared({
      first,
      last,
      phone: patient.phoneE164,
      pin: patient.pin,
      nationality: patient.nationality,
      email: patient.email,
      dob: patient.dob,
      gender: patient.gender,
    }),
    defaultSource: SOURCE,
    customFields: [],
    tagIds: new Map(),
    actorId: null,
    batch: "unite-sync",
  });
  if (!res.ok) {
    bump(opts.counters, "patient_create_failed");
    return done({ contactId: null, outcome: "failed" });
  }
  if (patient.pin)
    await upsertExternalRef(admin, {
      orgId,
      source: SOURCE,
      entity: "patient",
      externalId: patient.pin,
      localTable: "contacts",
      localId: res.id,
    });
  opts.counters.patientsCreated++;
  await emit(orgId, "contact.created", { contact_id: res.id, source: SOURCE });
  return done({ contactId: res.id, outcome: "created" });
}

// ---------------------------------------------------------------------------
// Appointments
// ---------------------------------------------------------------------------

export type AppointmentSyncDeps = {
  admin: AdminClient;
  orgId: string;
  source: { getAppointments(o: { clinicId: string; from: Date; to?: Date }): Promise<RawRecord[]> };
  config: UniteConfig;
  clinicId: string;
  from: Date;
  to: Date;
  mode: "incremental" | "nightly";
  log: JobLogger;
  now?: Date;
};

type ApptRow = {
  id: string;
  status: string;
  external_status: string | null;
  starts_at: string;
  ends_at: string;
  location_id: string | null;
  specialist_id: string | null;
  contact_id: string | null;
  notes: string | null;
  custom: Json;
};

async function loadStatusMap(admin: AdminClient, orgId: string) {
  const read = () =>
    admin.from("unite_appointment_status_map").select("code, status").eq("org_id", orgId);
  let { data } = await read();
  if (!data?.length) {
    await admin.rpc("seed_unite_appointment_status_map", { p_org: orgId });
    ({ data } = await read());
  }
  return new Map((data ?? []).map((r) => [r.code.toUpperCase(), r.status]));
}

export async function syncAppointments(deps: AppointmentSyncDeps): Promise<SyncCounters> {
  const { admin, orgId, clinicId } = deps;
  const counters = emptyCounters();
  const now = deps.now ?? new Date();
  const scope = clinicId;

  try {
    const { data: location } = await admin
      .from("locations")
      .select("id")
      .eq("org_id", orgId)
      .eq("external_id", clinicId)
      .maybeSingle();

    const raw = await deps.source.getAppointments({
      clinicId,
      from: deps.from,
      to: deps.to,
    });
    counters.fetched = raw.length;

    const mapped = [];
    for (const r of raw) {
      const m = mapAppointment(r, { timezone: deps.config.timezone, clinicId });
      if (m.ok) mapped.push(m.value);
      else {
        counters.skipped++;
        bump(counters, m.reason);
      }
    }

    const statusMap = await loadStatusMap(admin, orgId);

    const doctorIds = [...new Set(mapped.map((m) => m.doctorId).filter((x): x is string => !!x))];
    const doctorNames = [
      ...new Set(mapped.map((m) => m.doctorName).filter((x): x is string => !!x)),
    ];
    const [{ data: byId }, { data: byName }, { data: existing }] = await Promise.all([
      doctorIds.length
        ? admin
            .from("specialists")
            .select("id, external_id, name, department_id")
            .eq("org_id", orgId)
            .in("external_id", doctorIds)
        : Promise.resolve({ data: [] }),
      doctorNames.length
        ? admin
            .from("specialists")
            .select("id, external_id, name, department_id")
            .eq("org_id", orgId)
            .in("name", doctorNames)
        : Promise.resolve({ data: [] }),
      mapped.length
        ? admin
            .from("appointments")
            .select(
              "id, status, external_status, starts_at, ends_at, location_id, specialist_id, contact_id, notes, custom, external_id",
            )
            .eq("org_id", orgId)
            .eq("source", SOURCE)
            .in(
              "external_id",
              mapped.map((m) => m.externalId),
            )
        : Promise.resolve({ data: [] }),
    ]);
    const specialistById = new Map((byId ?? []).map((s) => [s.external_id, s]));
    const specialistByName = new Map((byName ?? []).map((s) => [s.name.trim().toLowerCase(), s]));
    const existingByExt = new Map(
      (existing ?? []).map((a) => [a.external_id as string, a as ApptRow]),
    );
    const cache = new Map<string, Resolution>();

    for (const m of mapped) {
      try {
        const specialist =
          (m.doctorId ? specialistById.get(m.doctorId) : undefined) ??
          (m.doctorName ? specialistByName.get(m.doctorName.trim().toLowerCase()) : undefined);
        const prev = existingByExt.get(m.externalId);

        const res = await resolvePatient(admin, orgId, m.patient, {
          createMissing: deps.config.create_missing_patients,
          cache,
          counters,
        });
        const contactId = res.contactId ?? prev?.contact_id ?? null;
        if (!contactId) counters.unlinked++;

        const mappedStatus = m.statusCode ? statusMap.get(m.statusCode) : null;
        // Unmapped codes (OQ-23) never overwrite what we know; a new row starts as Awaiting.
        const status: AppointmentStatus = isAppointmentStatus(mappedStatus)
          ? mappedStatus
          : isAppointmentStatus(prev?.status)
            ? prev.status
            : "awaiting";

        const prevCustom =
          prev?.custom && typeof prev.custom === "object" && !Array.isArray(prev.custom)
            ? (prev.custom as Record<string, unknown>)
            : {};
        const custom = {
          ...prevCustom,
          unite_patient_pin: m.patient.pin,
          unite_patient_key: patientKey(m.patient),
          unite_doctor_name: m.doctorName,
          unite_created_by: m.createdBy,
          // The name is kept only while there is no contact to hold it.
          ...(contactId
            ? { unite_patient_name: null }
            : { unite_patient_name: m.patient.name || null }),
        } as Record<string, Json>;

        const desired = {
          location_id: location?.id ?? prev?.location_id ?? null,
          specialist_id: specialist?.id ?? null,
          department_id: specialist?.department_id ?? null,
          contact_id: contactId,
          starts_at: m.startsAt.toISOString(),
          ends_at: m.endsAt.toISOString(),
          status,
          external_status: m.statusCode,
          unite_clinic_id: m.clinicId,
          notes: m.notes,
          custom,
        };

        if (!prev) {
          const { data: row, error } = await admin
            .from("appointments")
            .insert({
              org_id: orgId,
              source: SOURCE,
              external_id: m.externalId,
              ...desired,
            })
            .select("id, org_id, contact_id, starts_at, status")
            .single();
          if (error) throw new Error(`insert failed (${error.code})`);
          await upsertExternalRef(admin, {
            orgId,
            source: SOURCE,
            entity: "appointment",
            externalId: m.externalId,
            localTable: "appointments",
            localId: row.id,
          });
          counters.created++;
          await afterWrite(admin, row, null, now, "created");
          continue;
        }

        const changed =
          new Date(prev.starts_at).getTime() !== m.startsAt.getTime() ||
          new Date(prev.ends_at).getTime() !== m.endsAt.getTime() ||
          prev.status !== status ||
          (prev.external_status ?? null) !== m.statusCode ||
          prev.location_id !== desired.location_id ||
          prev.specialist_id !== desired.specialist_id ||
          prev.contact_id !== contactId ||
          (prev.notes ?? null) !== m.notes;
        if (!changed) {
          counters.unchanged++;
          continue;
        }
        const { data: row, error } = await admin
          .from("appointments")
          .update(desired)
          .eq("id", prev.id)
          .select("id, org_id, contact_id, starts_at, status")
          .single();
        if (error) throw new Error(`update failed (${error.code})`);
        counters.updated++;
        await afterWrite(admin, row, prev, now, "updated");
      } catch (e) {
        // Never log the record: it is patient data.
        bump(counters, "record_failed");
        deps.log.warn("unite appointment skipped", {
          reason: e instanceof Error ? e.message : "unknown",
        });
      }
    }

    await touchCursor(admin, orgId, "appointments", scope, {
      ok: true,
      cursor: {
        mode: deps.mode,
        from: deps.from.toISOString(),
        to: deps.to.toISOString(),
        fetched: counters.fetched,
      },
    });
    return counters;
  } catch (e) {
    await touchCursor(admin, orgId, "appointments", scope, {
      ok: false,
      error: e instanceof Error ? e.message.slice(0, 300) : "failed",
    });
    throw e;
  }
}

async function afterWrite(
  admin: AdminClient,
  row: { id: string; org_id: string; contact_id: string | null; starts_at: string; status: string },
  prev: ApptRow | null,
  now: Date,
  kind: "created" | "updated",
) {
  const orgId = row.org_id;
  if (row.contact_id) {
    // Reminders follow the appointment: rescheduled → re-planned, closed → cancelled.
    await syncAppointmentReminders(admin, row, { now });
  }
  if (kind === "created") {
    if (row.contact_id)
      await addTimelineEvent(admin, {
        orgId,
        contactId: row.contact_id,
        type: "appointment.created",
        actorType: "job",
        payload: { appointment_id: row.id, starts_at: row.starts_at, source: SOURCE },
      });
    await emit(orgId, "appointment.created", {
      appointment_id: row.id,
      contact_id: row.contact_id,
      source: SOURCE,
    });
    return;
  }
  if (prev && prev.status !== row.status) {
    if (row.contact_id)
      await addTimelineEvent(admin, {
        orgId,
        contactId: row.contact_id,
        type: "appointment.status_changed",
        actorType: "job",
        payload: { appointment_id: row.id, from: prev.status, to: row.status, via: SOURCE },
      });
    await emit(orgId, "appointment.status_changed", {
      appointment_id: row.id,
      contact_id: row.contact_id,
      from: prev.status,
      to: row.status,
      via: SOURCE,
    });
  }
  if (prev && new Date(prev.starts_at).getTime() !== new Date(row.starts_at).getTime()) {
    if (row.contact_id)
      await addTimelineEvent(admin, {
        orgId,
        contactId: row.contact_id,
        type: "appointment.rescheduled",
        actorType: "job",
        payload: { appointment_id: row.id, from: prev.starts_at, to: row.starts_at, via: SOURCE },
      });
  }
  await emit(orgId, "appointment.updated", {
    appointment_id: row.id,
    contact_id: row.contact_id,
    changed: ["unite"],
  });
}

// ---------------------------------------------------------------------------
// Doctors (configuration-driven; off until the endpoint is known)
// ---------------------------------------------------------------------------

export async function syncDoctors(deps: {
  admin: AdminClient;
  orgId: string;
  source: { listAll(kind: "doctors"): Promise<RawRecord[]> };
  log: JobLogger;
}): Promise<SyncCounters> {
  const { admin, orgId } = deps;
  const counters = emptyCounters();
  try {
    const raw = await deps.source.listAll("doctors");
    counters.fetched = raw.length;
    const doctors = raw.map((r) => mapDoctor(r));
    const [{ data: specialists }, { data: departments }] = await Promise.all([
      admin.from("specialists").select("id, name, external_id, department_id").eq("org_id", orgId),
      admin.from("departments").select("id, name").eq("org_id", orgId),
    ]);
    const byExt = new Map(
      (specialists ?? []).filter((s) => s.external_id).map((s) => [s.external_id, s]),
    );
    const byName = new Map(
      (specialists ?? [])
        .filter((s) => !s.external_id)
        .map((s) => [s.name.trim().toLowerCase(), s]),
    );
    const dept = new Map((departments ?? []).map((d) => [d.name.trim().toLowerCase(), d.id]));

    for (const d of doctors) {
      if (!d) {
        counters.skipped++;
        bump(counters, "unreadable_doctor");
        continue;
      }
      const departmentId = d.department
        ? (dept.get(d.department.trim().toLowerCase()) ?? null)
        : null;
      const known = byExt.get(d.externalId);
      const adoptable = !known ? byName.get(d.name.trim().toLowerCase()) : undefined;
      try {
        if (known) {
          const changed =
            known.name !== d.name || (departmentId && known.department_id !== departmentId);
          if (!changed) {
            counters.unchanged++;
            continue;
          }
          await admin
            .from("specialists")
            .update({ name: d.name, ...(departmentId ? { department_id: departmentId } : {}) })
            .eq("id", known.id)
            .eq("org_id", orgId);
          counters.updated++;
        } else if (adoptable) {
          // A specialist added by hand gets its Unite id instead of a duplicate.
          await admin
            .from("specialists")
            .update({
              external_id: d.externalId,
              ...(departmentId ? { department_id: departmentId } : {}),
            })
            .eq("id", adoptable.id)
            .eq("org_id", orgId);
          counters.updated++;
        } else {
          await admin.from("specialists").insert({
            org_id: orgId,
            name: d.name,
            external_id: d.externalId,
            department_id: departmentId,
          });
          counters.created++;
        }
      } catch {
        bump(counters, "record_failed");
      }
    }
    await touchCursor(admin, orgId, "doctors", "", {
      ok: true,
      cursor: { fetched: counters.fetched },
    });
    return counters;
  } catch (e) {
    await touchCursor(admin, orgId, "doctors", "", {
      ok: false,
      error: e instanceof Error ? e.message.slice(0, 300) : "failed",
    });
    throw e;
  }
}

// ---------------------------------------------------------------------------
// Patients (configuration-driven; off until the endpoint is known)
// ---------------------------------------------------------------------------

/** Fills blank fields only: Unite never overwrites what staff typed in Pulse. */
async function fillBlanks(admin: AdminClient, orgId: string, contactId: string, p: MappedPatient) {
  const { data: c } = await admin
    .from("contacts")
    .select("id, phone_e164, email, dob, gender, nationality, first_name, last_name")
    .eq("id", contactId)
    .eq("org_id", orgId)
    .maybeSingle();
  if (!c) return false;
  const patch: TablesUpdate<"contacts"> = {};
  if (!c.phone_e164 && p.phoneE164) patch.phone_e164 = p.phoneE164;
  if (!c.email && p.email) patch.email = p.email;
  if (!c.dob && p.dob) patch.dob = p.dob;
  if (!c.gender && p.gender) patch.gender = p.gender;
  if (!c.nationality && p.nationality) patch.nationality = p.nationality;
  if (!c.first_name && !c.last_name && p.fullName) {
    patch.first_name = p.firstName;
    patch.last_name = p.lastName;
  }
  if (!Object.keys(patch).length) return false;
  const { error } = await admin
    .from("contacts")
    .update(patch)
    .eq("id", contactId)
    .eq("org_id", orgId);
  return !error;
}

export async function syncPatients(deps: {
  admin: AdminClient;
  orgId: string;
  source: { listAll(kind: "patients", o?: { since?: Date }): Promise<RawRecord[]> };
  config: UniteConfig;
  log: JobLogger;
  now?: Date;
}): Promise<SyncCounters> {
  const { admin, orgId } = deps;
  const counters = emptyCounters();
  const startedAt = deps.now ?? new Date();
  try {
    const cursor = await readCursor(admin, orgId, "patients");
    const since = typeof cursor.since === "string" ? new Date(cursor.since) : undefined;
    const raw = await deps.source.listAll("patients", since ? { since } : undefined);
    counters.fetched = raw.length;
    const cache = new Map<string, Resolution>();

    for (const r of raw) {
      const p = mapPatient(r, { timezone: deps.config.timezone });
      if (!p) {
        counters.skipped++;
        bump(counters, "unreadable_patient");
        continue;
      }
      try {
        const res = await resolvePatient(
          admin,
          orgId,
          {
            pin: p.pin,
            name: p.fullName,
            phoneE164: p.phoneE164,
            nationality: p.nationality,
            email: p.email,
            dob: p.dob,
            gender: p.gender,
          },
          { createMissing: true, cache, counters },
        );
        if (res.contactId && (res.outcome === "linked" || res.outcome === "matched")) {
          if (await fillBlanks(admin, orgId, res.contactId, p)) counters.updated++;
          else counters.unchanged++;
        } else if (res.outcome === "created") counters.created++;
      } catch {
        bump(counters, "record_failed");
      }
    }
    await touchCursor(admin, orgId, "patients", "", {
      ok: true,
      cursor: { since: startedAt.toISOString(), fetched: counters.fetched },
    });
    return counters;
  } catch (e) {
    await touchCursor(admin, orgId, "patients", "", {
      ok: false,
      error: e instanceof Error ? e.message.slice(0, 300) : "failed",
    });
    throw e;
  }
}
