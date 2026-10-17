/**
 * Migration control centre (Track P, slice P0). Pure: a static registry of every Airtable table and Make scenario in
 * scope with its Pulse equivalent, and `deriveState`, which turns the facts the loader gathered into one of five states.
 *
 * Fails closed: no facts means not_started, and imported / native / parallel_run / retired are claimed only on evidence
 * (rows in `external_refs`, recorded flags on `parallel_run_scenarios`, an active recall programme). No patient data
 * and no real record ids live here; the Airtable ids are schema ids from docs/audit.
 */

export type MigrationState = "not_started" | "imported" | "native" | "parallel_run" | "retired";

export const STATE_LABEL: Record<MigrationState, string> = {
  not_started: "Not started",
  imported: "Imported",
  native: "Native",
  parallel_run: "Parallel run",
  retired: "Retired",
};

export const STATE_ORDER: readonly MigrationState[] = [
  "not_started",
  "imported",
  "native",
  "parallel_run",
  "retired",
];

/** What the loader reads. Every field is optional evidence; absence is never read as progress. */
export type ScenarioFact = {
  nativeBuilt: boolean;
  parallelStartedOn: string | null;
  diffsExplained: boolean;
  makeOff: boolean;
};

export type MigrationFacts = {
  /** external_refs rows per `airtable/<entity>` key, as returned by reconcile_snapshot. */
  refs: Readonly<Record<string, number>>;
  /** parallel_run_scenarios rows by scenario_key. */
  scenarios: Readonly<Record<string, ScenarioFact>>;
  /** recall_programmes.status by programme key. */
  programmes: Readonly<Record<string, string>>;
  /** parallel_run_diffs rows not yet explained, by scenario_key. */
  unexplainedDiffs: Readonly<Record<string, number>>;
};

export const NO_FACTS: MigrationFacts = { refs: {}, scenarios: {}, programmes: {}, unexplainedDiffs: {} };

export type Evidence =
  | { kind: "refs"; entity: string }
  | { kind: "scenario"; key: string }
  | { kind: "programmes"; keys: readonly string[] }
  | { kind: "none" };

export type MigrationGroup =
  | "Airtable · Unite base"
  | "Airtable · Campaigns base"
  | "Airtable · Acute follow-up base"
  | "Airtable · Older bases"
  | "Make · Active scenarios"
  | "Make · Inactive scenarios";

export const GROUP_ORDER: readonly MigrationGroup[] = [
  "Airtable · Unite base",
  "Airtable · Campaigns base",
  "Airtable · Acute follow-up base",
  "Airtable · Older bases",
  "Make · Active scenarios",
  "Make · Inactive scenarios",
];

export type MigrationEntry = {
  id: string;
  group: MigrationGroup;
  /** What it is today. */
  name: string;
  /** Where it lives in Pulse. */
  pulse: string;
  /** Page where the work lives (a real route), if there is one. */
  href?: string;
  evidence: Evidence;
  /** Why nothing is imported or built, when that is by design or waiting. */
  note?: string;
};

const U = "app7QJ2pvhADHQeBP";
const C = "appkOnjPr1SMD83CP";
const A = "appH2jHpsNR1nqEQ2";
const P = "appZbwlQvkuaUsF2l";

const at = (base: string, table: string, suffix?: string): Evidence => ({
  kind: "refs",
  entity: `${base}.${table}${suffix ? `#${suffix}` : ""}`,
});

const SCREENING_PROGRAMMES = [
  "annual_checkup",
  "dental",
  "pap_smear",
  "colonoscopy",
  "skin_check",
  "menopause",
  "pre_menopause",
  "dormant",
] as const;

export const MIGRATION_REGISTRY: readonly MigrationEntry[] = [
  // ---- Unite base
  { id: "unite.patients", group: "Airtable · Unite base", name: "Unite (patients)", pulse: "Contacts (matched by Unite PIN)", href: "/contacts", evidence: at(U, "tbl9856qJP9S7OEqB") },
  { id: "unite.chronic", group: "Airtable · Unite base", name: "Unite (patients), chronic diagnoses", pulse: "Contact chronic conditions", href: "/contacts", evidence: at(U, "tbl9856qJP9S7OEqB", "chronic_conditions") },
  { id: "unite.mrd", group: "Airtable · Unite base", name: "Medical Records Data", pulse: "Visits and prescriptions", evidence: at(U, "tblllKPKIY9qvMoEU"), note: "No per-patient visit screen yet (Patient 360)." },
  { id: "unite.mrd_dx", group: "Airtable · Unite base", name: "Medical Records Data, visit diagnoses", pulse: "Visit diagnoses", evidence: at(U, "tblllKPKIY9qvMoEU", "visit_diagnoses") },
  { id: "unite.diagnosis", group: "Airtable · Unite base", name: "Diagnosis", pulse: "Diagnosis reference list", href: "/portal/data-quality", evidence: at(U, "tblZqf4Zcw5Kweadh") },
  { id: "unite.medication", group: "Airtable · Unite base", name: "Medication", pulse: "Medication reference list", href: "/portal/unclassified-medications", evidence: at(U, "tblLM2BXjA680GQws") },
  { id: "unite.items", group: "Airtable · Unite base", name: "Items", pulse: "Items reference list", evidence: at(U, "tblTJtk6aIMbwpoA2") },
  // ---- Campaigns base
  { id: "campaigns.appt", group: "Airtable · Campaigns base", name: "Appointment Messages", pulse: "Appointment reminders log", href: "/appointments", evidence: at(C, "tblhoSfiSjO4zh9cf"), note: "Importer is written but waits for confirmed column names." },
  { id: "campaigns.birthday", group: "Airtable · Campaigns base", name: "Birthday Messages", pulse: "Recall sends (Birthday)", href: "/recall", evidence: at(C, "tblHTlF6LXMK5p4mU"), note: "Importer is written but waits for confirmed column names." },
  { id: "campaigns.chronic", group: "Airtable · Campaigns base", name: "Chronic Recall Messages", pulse: "Recall sends and the call list", href: "/recall/calls", evidence: at(C, "tbldCbNEKeF5NrTCs"), note: "Importer is written but waits for confirmed column names." },
  { id: "campaigns.website", group: "Airtable · Campaigns base", name: "Website", pulse: "Website entry points", href: "/settings/channels", evidence: at(C, "tblpWst9QqYNuKpwZ") },
  // ---- Acute base
  { id: "acute.patients", group: "Airtable · Acute follow-up base", name: "Patients", pulse: "Contacts (merged on Unite PIN)", href: "/contacts", evidence: at(A, "tblghX1mVYWgXvWbk") },
  { id: "acute.settings", group: "Airtable · Acute follow-up base", name: "Settings", pulse: "Clinical settings (signed values)", href: "/portal/clinical-settings", evidence: at(A, "tbl69r1kelxG4g93L") },
  { id: "acute.medref", group: "Airtable · Acute follow-up base", name: "Medication Reference", pulse: "Medication classes", href: "/portal/unclassified-medications", evidence: at(A, "tblIxa5xUOG3GRwmt") },
  { id: "acute.visits", group: "Airtable · Acute follow-up base", name: "Visits", pulse: "Visits", evidence: at(A, "tblyOweSP3FfeY9q0") },
  { id: "acute.rx", group: "Airtable · Acute follow-up base", name: "Prescriptions", pulse: "Prescriptions and sequences", evidence: at(A, "tblQra08AflxuXxQq") },
  { id: "acute.queue", group: "Airtable · Acute follow-up base", name: "Follow-Up Queue", pulse: "Clinical follow-ups", href: "/portal/follow-ups", evidence: at(A, "tblgX6wIqWefpwrBg") },
  { id: "acute.feedback", group: "Airtable · Acute follow-up base", name: "Feedback & Outcomes", pulse: "Clinical feedback", href: "/portal/clinical-feedback", evidence: at(A, "tbluNXftGwkP9rJDV") },
  { id: "acute.templates", group: "Airtable · Acute follow-up base", name: "Message Templates", pulse: "Clinical call scripts", evidence: at(A, "tblnCsSkyw4Tu9Ak7") },
  { id: "acute.log", group: "Airtable · Acute follow-up base", name: "Message Log", pulse: "Clinical message log", evidence: at(A, "tblXNWAh1hdaueUbs") },
  { id: "acute.tests", group: "Airtable · Acute follow-up base", name: "Test Plan", pulse: "Unit-test fixtures", evidence: { kind: "none" }, note: "Not imported by design; becomes test fixtures." },
  // ---- Older bases
  { id: "ptf.doctors", group: "Airtable · Older bases", name: "Patient Treatment base, Doctors", pulse: "Doctors directory", href: "/doctors", evidence: at(P, "tblhoMqQ1jgiCGHGY") },
  { id: "ptf.cpt", group: "Airtable · Older bases", name: "Patient Treatment base, CPT Master", pulse: "Items reference list", evidence: at(P, "tblopYbHPAbTi4QeX") },
  { id: "ptf.labs", group: "Airtable · Older bases", name: "Patient Treatment base, Laboratory & Diagnostic Test", pulse: "Lab orders (not built)", evidence: { kind: "none" }, note: "Backlog: no lab orders table yet." },
  { id: "ptf.other", group: "Airtable · Older bases", name: "Patient Treatment base, other tables and DRAFT designs", pulse: "Redesigned natively where needed", evidence: { kind: "none" }, note: "Prototype data; not imported by design." },
  { id: "cfu.queue", group: "Airtable · Older bases", name: "Clinical Follow-Up & Care base, Follow-Up Queue", pulse: "Clinical follow-ups", evidence: { kind: "none" }, note: "Superseded by the Acute base; not imported by design." },
  // ---- Make, active
  { id: "make.token", group: "Make · Active scenarios", name: "Token", pulse: "Unite token refresh on demand", href: "/recall/parallel-run", evidence: { kind: "scenario", key: "token" } },
  { id: "make.reminders", group: "Make · Active scenarios", name: "Appointment Reminders (12:00) and (6 PM)", pulse: "Appointment reminders job", href: "/recall/parallel-run", evidence: { kind: "scenario", key: "appointment_reminders" } },
  { id: "make.birthday", group: "Make · Active scenarios", name: "Agewise Birthday Message", pulse: "Recall programme: Birthday", href: "/recall/parallel-run", evidence: { kind: "scenario", key: "birthday" } },
  { id: "make.chronic", group: "Make · Active scenarios", name: "Chronic Recall, 90 Day", pulse: "Recall programme: Chronic", href: "/recall/parallel-run", evidence: { kind: "scenario", key: "chronic_recall" } },
  { id: "make.chronic_update", group: "Make · Active scenarios", name: "Chronic Update (webhook)", pulse: "Reply and booking events on recall sends", href: "/recall/parallel-run", evidence: { kind: "scenario", key: "chronic_update" } },
  { id: "make.mrd", group: "Make · Active scenarios", name: "Acute Follow-Up, MRD Sync", pulse: "Visit feed and clinical rules engine", href: "/recall/parallel-run", evidence: { kind: "scenario", key: "mrd_sync" }, note: "The Unite visit feed is not built yet." },
  { id: "make.airtable_auto", group: "Make · Active scenarios", name: "Airtable native automations (2, Unite base)", pulse: "Documented, then switched off at cut-over", href: "/recall/parallel-run", evidence: { kind: "scenario", key: "airtable_automations" } },
  // ---- Make, inactive
  { id: "make.syncs", group: "Make · Inactive scenarios", name: "Unite data syncs (7 scenarios)", pulse: "One incremental Unite sync", evidence: { kind: "none" }, note: "Rebuilt as a single sync, not scenario by scenario." },
  { id: "make.finance", group: "Make · Inactive scenarios", name: "Unite Finance API test", pulse: "Finance capture (off, guarded)", href: "/finance", evidence: { kind: "none" }, note: "Deliver-once API: never called outside the guarded job." },
  { id: "make.screening", group: "Make · Inactive scenarios", name: "Screening and dormant reminders (9 scenarios)", pulse: "Recall programmes", href: "/recall", evidence: { kind: "programmes", keys: SCREENING_PROGRAMMES } },
  { id: "make.birthday_legacy", group: "Make · Inactive scenarios", name: "Birthday legacy (3 scenarios)", pulse: "Folded into the Birthday programme", evidence: { kind: "none" } },
  { id: "make.labs", group: "Make · Inactive scenarios", name: "Lab result and follow-up reminders", pulse: "Lab orders (not built)", evidence: { kind: "none" } },
  { id: "make.postvisit", group: "Make · Inactive scenarios", name: "Post-appointment and no-show (4 scenarios)", pulse: "Recall programmes and flows", href: "/recall", evidence: { kind: "none" } },
  { id: "make.draft_ops", group: "Make · Inactive scenarios", name: "Draft clinic operations (6 scenarios)", pulse: "Flows, reports, payment links", evidence: { kind: "none" } },
  { id: "make.search", group: "Make · Inactive scenarios", name: "Search New Contact", pulse: "Not needed (single CRM)", evidence: { kind: "none" }, note: "Dropped by design." },
  { id: "make.scratch", group: "Make · Inactive scenarios", name: "Integration scratch scenarios (9)", pulse: "Not needed", evidence: { kind: "none" }, note: "Dropped by design." },
];

/** The key reconcile_snapshot uses for an Airtable entity. */
export const refKey = (entity: string): string => `airtable/${entity}`;

const count = (n: number | undefined): number => (typeof n === "number" && Number.isFinite(n) && n > 0 ? n : 0);

export function deriveState(entry: Pick<MigrationEntry, "evidence">, facts: MigrationFacts = NO_FACTS): MigrationState {
  const ev = entry.evidence;
  switch (ev.kind) {
    case "refs":
      return count(facts.refs[refKey(ev.entity)]) > 0 ? "imported" : "not_started";
    case "scenario": {
      const s = facts.scenarios[ev.key];
      if (!s || !s.nativeBuilt) return "not_started";
      const unexplained = count(facts.unexplainedDiffs[ev.key]);
      if (s.makeOff && s.diffsExplained && unexplained === 0) return "retired";
      if (s.parallelStartedOn) return "parallel_run";
      return "native";
    }
    case "programmes":
      return ev.keys.length > 0 && ev.keys.every((k) => facts.programmes[k] === "active") ? "native" : "not_started";
    case "none":
      return "not_started";
  }
}

/** One short, count-only line for the "Last known" column; null when there is nothing to say. */
export function detailFor(entry: Pick<MigrationEntry, "evidence">, facts: MigrationFacts = NO_FACTS): string | null {
  const ev = entry.evidence;
  switch (ev.kind) {
    case "refs": {
      const n = count(facts.refs[refKey(ev.entity)]);
      return n > 0 ? `${n.toLocaleString("en-GB")} records linked` : null;
    }
    case "scenario": {
      const s = facts.scenarios[ev.key];
      if (!s) return null;
      const u = count(facts.unexplainedDiffs[ev.key]);
      const parts: string[] = [];
      if (s.parallelStartedOn) parts.push(`parallel run since ${s.parallelStartedOn}`);
      if (u > 0) parts.push(`${u} unexplained ${u === 1 ? "difference" : "differences"}`);
      return parts.length ? parts.join(", ") : null;
    }
    case "programmes": {
      const active = ev.keys.filter((k) => facts.programmes[k] === "active").length;
      const present = ev.keys.filter((k) => facts.programmes[k] !== undefined).length;
      return present > 0 ? `${active} of ${ev.keys.length} programmes active` : null;
    }
    case "none":
      return null;
  }
}

export type MigrationRow = MigrationEntry & { state: MigrationState; detail: string | null };

export function buildRows(facts: MigrationFacts = NO_FACTS): MigrationRow[] {
  return MIGRATION_REGISTRY.map((e) => ({ ...e, state: deriveState(e, facts), detail: detailFor(e, facts) }));
}

export function summarise(rows: readonly MigrationRow[]): Record<MigrationState, number> {
  const out: Record<MigrationState, number> = { not_started: 0, imported: 0, native: 0, parallel_run: 0, retired: 0 };
  for (const r of rows) out[r.state] += 1;
  return out;
}
