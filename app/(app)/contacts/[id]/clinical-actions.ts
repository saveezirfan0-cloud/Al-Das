"use server";

import { z } from "zod";

import { can } from "@/lib/auth/can";
import { requirePerm, type CurrentMember } from "@/lib/auth/session";
import { capNote, medicineWindow } from "@/lib/contacts/patient-360";
import { recordAccess } from "@/lib/security/access-log";
import { createAdminClient } from "@/lib/supabase/admin";
import { createClient } from "@/lib/supabase/server";

/**
 * Patient 360, clinical tabs (docs/45 P3). Health data: every action needs contacts.view AND clinical.view (never
 * implied by contacts.* or a portal key), reads through the member's own client (RLS decides, visits follow the branch
 * rule), validates ids, caps the payload and records the open (ids and the tab name only). Nothing here is logged,
 * pushed, e-mailed or put into an AI prompt. Notes are read from the scrubbed column only.
 */

export type ClinicalResult<T> = { ok: true; data: T } | { ok: false; error: string };

const uuid = z.string().uuid();
const pageNumber = z.number().int().min(0).max(500);
const VISITS_PAGE = 15;
const MEDICINES_LIMIT = 40;
const CARE_LIMIT = 30;

function fail(error: string): { ok: false; error: string } {
  return { ok: false, error };
}

async function clinicalMember(): Promise<CurrentMember | null> {
  const member = await requirePerm("contacts.view");
  return can(member, "clinical.view") ? member : null;
}

/** Today's date (YYYY-MM-DD) in the organisation's timezone. */
function orgToday(member: CurrentMember): string {
  try {
    return new Intl.DateTimeFormat("en-CA", { timeZone: member.org.timezone || "UTC" }).format(
      new Date(),
    );
  } catch {
    return new Date().toISOString().slice(0, 10);
  }
}

async function logOpen(member: CurrentMember, contactId: string, tab: string) {
  await recordAccess(createAdminClient(), member, {
    entity: "contact",
    entityId: contactId,
    action: "view",
    detail: { tab },
  });
}

// ---------------------------------------------------------------------------
// Visits and medical record
// ---------------------------------------------------------------------------

export type VisitRow = {
  id: string;
  visit_date: string;
  branch: string | null;
  doctor: string | null;
  department: string | null;
  is_test: boolean;
  vitals: {
    height_cm: number | null;
    weight_kg: number | null;
    temp_c: number | null;
    pulse: number | null;
    bp: string | null;
    spo2: number | null;
  };
  diagnoses: Array<{ code: string; name: string | null; primary: boolean }>;
  prescriptions: Array<{
    name: string | null;
    dosage: string | null;
    duration_days: number | null;
    start_date: string | null;
  }>;
  notes: string | null;
};

export async function listContactVisits(
  contactId: string,
  page = 0,
): Promise<ClinicalResult<{ rows: VisitRow[]; hasMore: boolean }>> {
  const member = await clinicalMember();
  if (!member) return fail("You don't have access to the medical record.");
  if (!uuid.safeParse(contactId).success || !pageNumber.safeParse(page).success)
    return fail("Invalid request.");
  const supabase = await createClient();
  const from = page * VISITS_PAGE;
  const { data: visits, error } = await supabase
    .from("visits")
    .select(
      "id, visit_date, location_id, doctor_name, department_raw, department_mapped, height_cm, weight_kg, temp_c, pulse, bp_systolic, bp_diastolic, spo2, observation_notes_scrubbed, is_test_record",
    )
    .eq("org_id", member.orgId)
    .eq("contact_id", contactId)
    .order("visit_date", { ascending: false })
    .order("id")
    .range(from, from + VISITS_PAGE); // one extra row tells us whether there is a next page
  if (error) return fail("Could not load the visits.");
  const slice = (visits ?? []).slice(0, VISITS_PAGE);
  const ids = slice.map((v) => v.id);
  const locationIds = [...new Set(slice.map((v) => v.location_id).filter((x): x is string => !!x))];

  const [dx, rx, locs] = await Promise.all([
    ids.length
      ? supabase
          .from("visit_diagnoses")
          .select("visit_id, diagnosis_code, is_primary, ref_diagnoses(short_description)")
          .eq("org_id", member.orgId)
          .in("visit_id", ids)
          .limit(500)
      : Promise.resolve({ data: [], error: null }),
    ids.length
      ? supabase
          .from("prescriptions")
          .select(
            "visit_id, position, medication_name, dosage_instruction, duration_days, start_date",
          )
          .eq("org_id", member.orgId)
          .in("visit_id", ids)
          .order("position")
          .limit(500)
      : Promise.resolve({ data: [], error: null }),
    locationIds.length
      ? supabase
          .from("locations")
          .select("id, name")
          .eq("org_id", member.orgId)
          .in("id", locationIds)
      : Promise.resolve({ data: [], error: null }),
  ]);
  if (dx.error || rx.error) return fail("Could not load the visits.");
  const branch = new Map((locs.data ?? []).map((l) => [l.id, l.name]));

  const rows: VisitRow[] = slice.map((v) => ({
    id: v.id,
    visit_date: v.visit_date,
    branch: v.location_id ? (branch.get(v.location_id) ?? null) : null,
    doctor: v.doctor_name,
    department: v.department_mapped ?? v.department_raw,
    is_test: v.is_test_record,
    vitals: {
      height_cm: v.height_cm,
      weight_kg: v.weight_kg,
      temp_c: v.temp_c,
      pulse: v.pulse,
      bp: v.bp_systolic && v.bp_diastolic ? `${v.bp_systolic}/${v.bp_diastolic}` : null,
      spo2: v.spo2,
    },
    diagnoses: (dx.data ?? [])
      .filter((d) => d.visit_id === v.id)
      .sort((a, b) => Number(b.is_primary) - Number(a.is_primary))
      .map((d) => ({
        code: d.diagnosis_code,
        name: d.ref_diagnoses?.short_description ?? null,
        primary: d.is_primary,
      })),
    prescriptions: (rx.data ?? [])
      .filter((p) => p.visit_id === v.id)
      .map((p) => ({
        name: p.medication_name,
        dosage: p.dosage_instruction,
        duration_days: p.duration_days,
        start_date: p.start_date,
      })),
    notes: capNote(v.observation_notes_scrubbed),
  }));
  await logOpen(member, contactId, page === 0 ? "visits" : `visits:${page}`);
  return { ok: true, data: { rows, hasMore: (visits ?? []).length > VISITS_PAGE } };
}

// ---------------------------------------------------------------------------
// Conditions and medicines
// ---------------------------------------------------------------------------

export type ConditionRow = {
  id: string;
  code: string | null;
  name: string | null;
  first_seen: string | null;
  last_seen: string | null;
  evidence_visits: number | null;
  source: string;
};

export type MedicineRow = {
  id: string;
  name: string | null;
  dosage: string | null;
  duration_days: number | null;
  start_date: string | null;
  ends_on: string | null;
  /** null = not enough data to say. */
  current: boolean | null;
};

export async function getContactConditions(
  contactId: string,
): Promise<
  ClinicalResult<{ conditions: ConditionRow[]; medicines: MedicineRow[]; allergies: null }>
> {
  const member = await clinicalMember();
  if (!member) return fail("You don't have access to the medical record.");
  if (!uuid.safeParse(contactId).success) return fail("Invalid request.");
  const today = orgToday(member);
  const supabase = await createClient();
  const [cc, rx] = await Promise.all([
    supabase
      .from("contact_chronic_conditions")
      .select(
        "id, source, noted_at, last_seen_on, evidence_visits, ref_diagnoses(code, short_description)",
      )
      .eq("org_id", member.orgId)
      .eq("contact_id", contactId)
      .order("last_seen_on", { ascending: false, nullsFirst: false })
      .limit(50),
    supabase
      .from("prescriptions")
      .select("id, medication_name, dosage_instruction, duration_days, start_date")
      .eq("org_id", member.orgId)
      .eq("contact_id", contactId)
      .order("start_date", { ascending: false, nullsFirst: false })
      .limit(MEDICINES_LIMIT),
  ]);
  if (cc.error || rx.error) return fail("Could not load the conditions.");
  await logOpen(member, contactId, "conditions");
  const medicines: MedicineRow[] = (rx.data ?? []).map((p) => {
    const w = medicineWindow(p.start_date, p.duration_days, today);
    return {
      id: p.id,
      name: p.medication_name,
      dosage: p.dosage_instruction,
      duration_days: p.duration_days,
      start_date: p.start_date,
      ends_on: w.endsOn,
      current: w.current,
    };
  });
  return {
    ok: true,
    data: {
      conditions: (cc.data ?? []).map((r) => ({
        id: r.id,
        code: r.ref_diagnoses?.code ?? null,
        name: r.ref_diagnoses?.short_description ?? null,
        first_seen: r.noted_at,
        last_seen: r.last_seen_on,
        evidence_visits: r.evidence_visits,
        source: r.source,
      })),
      medicines,
      allergies: null, // no source table yet (docs/45_PHASE_P3_NOTES.md)
    },
  };
}

// ---------------------------------------------------------------------------
// Care and follow-ups (status, dates and counts only; no message text, no notes)
// ---------------------------------------------------------------------------

export type CareData = {
  followups: Array<{
    id: string;
    category: string | null;
    priority: string;
    due_date: string | null;
    status: string;
    outcome: string | null;
    closed: boolean;
  }>;
  recalls: Array<{
    id: string;
    programme: string | null;
    status: string;
    sent_at: string | null;
    replied: boolean;
    booked: boolean;
    follow_up_status: string | null;
  }>;
  feedback: Array<{
    id: string;
    stage: string;
    score: number | null;
    needs_review: boolean;
    at: string;
  }>;
};

export async function getContactCare(contactId: string): Promise<ClinicalResult<CareData>> {
  const member = await clinicalMember();
  if (!member) return fail("You don't have access to the medical record.");
  if (!uuid.safeParse(contactId).success) return fail("Invalid request.");
  const supabase = await createClient();
  const [f, r, fb] = await Promise.all([
    supabase
      .from("clinical_followups")
      .select("id, trigger_category, priority, due_date, call_status, outcome, closed_at")
      .eq("org_id", member.orgId)
      .eq("contact_id", contactId)
      .order("due_date", { ascending: false, nullsFirst: false })
      .limit(CARE_LIMIT),
    supabase
      .from("recall_sends")
      .select(
        "id, status, sent_at, replied_at, booked_at, follow_up_status, created_at, recall_programmes(name)",
      )
      .eq("org_id", member.orgId)
      .eq("contact_id", contactId)
      .order("created_at", { ascending: false })
      .limit(CARE_LIMIT),
    supabase
      .from("clinical_feedback")
      .select("id, stage, score, needs_doctor_review, created_at")
      .eq("org_id", member.orgId)
      .eq("contact_id", contactId)
      .order("created_at", { ascending: false })
      .limit(CARE_LIMIT),
  ]);
  if (f.error || r.error || fb.error) return fail("Could not load the care history.");
  await logOpen(member, contactId, "care");
  return {
    ok: true,
    data: {
      followups: (f.data ?? []).map((x) => ({
        id: x.id,
        category: x.trigger_category,
        priority: x.priority,
        due_date: x.due_date,
        status: x.call_status,
        outcome: x.outcome,
        closed: !!x.closed_at,
      })),
      recalls: (r.data ?? []).map((x) => ({
        id: x.id,
        programme: x.recall_programmes?.name ?? null,
        status: x.status,
        sent_at: x.sent_at,
        replied: !!x.replied_at,
        booked: !!x.booked_at,
        follow_up_status: x.follow_up_status,
      })),
      feedback: (fb.data ?? []).map((x) => ({
        id: x.id,
        stage: x.stage,
        score: x.score,
        needs_review: x.needs_doctor_review,
        at: x.created_at,
      })),
    },
  };
}

// ---------------------------------------------------------------------------
// Overview card (last visit summary, counts)
// ---------------------------------------------------------------------------

export type ClinicalOverview = {
  lastVisit: {
    date: string;
    branch: string | null;
    department: string | null;
    diagnoses: number;
  } | null;
  chronicCount: number;
  currentMedicines: number | null;
};

export async function getClinicalOverview(
  contactId: string,
): Promise<ClinicalResult<ClinicalOverview>> {
  const member = await clinicalMember();
  if (!member) return fail("You don't have access to the medical record.");
  if (!uuid.safeParse(contactId).success) return fail("Invalid request.");
  const today = orgToday(member);
  const supabase = await createClient();
  const [v, cc, rx] = await Promise.all([
    supabase
      .from("visits")
      .select("id, visit_date, location_id, department_mapped, department_raw")
      .eq("org_id", member.orgId)
      .eq("contact_id", contactId)
      .order("visit_date", { ascending: false })
      .limit(1),
    supabase
      .from("contact_chronic_conditions")
      .select("id", { count: "exact", head: true })
      .eq("org_id", member.orgId)
      .eq("contact_id", contactId),
    supabase
      .from("prescriptions")
      .select("start_date, duration_days")
      .eq("org_id", member.orgId)
      .eq("contact_id", contactId)
      .order("start_date", { ascending: false, nullsFirst: false })
      .limit(MEDICINES_LIMIT),
  ]);
  if (v.error || cc.error || rx.error) return fail("Could not load the summary.");
  const last = v.data?.[0] ?? null;
  let branch: string | null = null;
  let diagnoses = 0;
  if (last) {
    const [loc, dx] = await Promise.all([
      last.location_id
        ? supabase
            .from("locations")
            .select("name")
            .eq("org_id", member.orgId)
            .eq("id", last.location_id)
            .maybeSingle()
        : Promise.resolve({ data: null }),
      supabase
        .from("visit_diagnoses")
        .select("id", { count: "exact", head: true })
        .eq("org_id", member.orgId)
        .eq("visit_id", last.id),
    ]);
    branch = loc.data?.name ?? null;
    diagnoses = dx.count ?? 0;
  }
  const windows = (rx.data ?? []).map(
    (p) => medicineWindow(p.start_date, p.duration_days, today).current,
  );
  await logOpen(member, contactId, "overview");
  return {
    ok: true,
    data: {
      lastVisit: last
        ? {
            date: last.visit_date,
            branch,
            department: last.department_mapped ?? last.department_raw,
            diagnoses,
          }
        : null,
      chronicCount: cc.count ?? 0,
      currentMedicines:
        windows.length === 0
          ? 0
          : windows.every((w) => w === null)
            ? null
            : windows.filter((w) => w === true).length,
    },
  };
}
