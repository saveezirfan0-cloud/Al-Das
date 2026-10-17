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

/** Counts of one importer run (public.import_runs). Counts only. */
export type RunFact = {
  runAt: string;
  dryRun: boolean;
  counters: {
    read: number;
    created: number;
    updated: number;
    skipped: number;
    invalid: number;
    duplicates: number;
    review: number;
    failed: number;
  };
};

/** The newest real run and the newest dry run of one entity, by `<source>/<entity>`. */
export type RunFacts = { real: RunFact | null; dry: RunFact | null };

/** What the loader reads. Every field is optional evidence; absence is never read as progress. */
export type ScenarioFact = {
  nativeBuilt: boolean;
  parallelStartedOn: string | null;
  diffsExplained: boolean;
  makeOff: boolean;
};

export type MigrationFacts = {
  /** external_refs rows per `<source>/<entity>` key (airtable/..., sanoflow/...), as returned by reconcile_snapshot. */
  refs: Readonly<Record<string, number>>;
  /** The importers' last runs per `<source>/<entity>` key (import_runs). */
  runs: Readonly<Record<string, RunFacts>>;
  /** parallel_run_scenarios rows by scenario_key. */
  scenarios: Readonly<Record<string, ScenarioFact>>;
  /** recall_programmes.status by programme key. */
  programmes: Readonly<Record<string, string>>;
  /** parallel_run_diffs rows not yet explained, by scenario_key. */
  unexplainedDiffs: Readonly<Record<string, number>>;
};

export const NO_FACTS: MigrationFacts = {
  refs: {},
  runs: {},
  scenarios: {},
  programmes: {},
  unexplainedDiffs: {},
};

export type ImportSource = "airtable" | "sanoflow";

export type Evidence =
  /** Records linked in external_refs (`source` defaults to Airtable). */
  | { kind: "refs"; entity: string; source?: ImportSource }
  /** An entity that links no records (settings, lists): imported means a real run wrote something and nothing failed. */
  | { kind: "run"; entity: string; source: ImportSource }
  | { kind: "scenario"; key: string }
  | { kind: "programmes"; keys: readonly string[] }
  | { kind: "none" };

export type MigrationGroup =
  | "Airtable · Unite base"
  | "Airtable · Campaigns base"
  | "Airtable · Acute follow-up base"
  | "Airtable · Older bases"
  | "Sanoflow · Exports"
  | "Make · Active scenarios"
  | "Make · Inactive scenarios";

export const GROUP_ORDER: readonly MigrationGroup[] = [
  "Airtable · Unite base",
  "Airtable · Campaigns base",
  "Airtable · Acute follow-up base",
  "Airtable · Older bases",
  "Sanoflow · Exports",
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

const sf = (entity: string): Evidence => ({ kind: "refs", source: "sanoflow", entity });
const sfRun = (entity: string): Evidence => ({ kind: "run", source: "sanoflow", entity });

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
  {
    id: "unite.patients",
    group: "Airtable · Unite base",
    name: "Unite (patients)",
    pulse: "Contacts (matched by Unite PIN)",
    href: "/contacts",
    evidence: at(U, "tbl9856qJP9S7OEqB"),
  },
  {
    id: "unite.chronic",
    group: "Airtable · Unite base",
    name: "Unite (patients), chronic diagnoses",
    pulse: "Contact chronic conditions",
    href: "/contacts",
    evidence: at(U, "tbl9856qJP9S7OEqB", "chronic_conditions"),
  },
  {
    id: "unite.mrd",
    group: "Airtable · Unite base",
    name: "Medical Records Data",
    pulse: "Visits and prescriptions",
    evidence: at(U, "tblllKPKIY9qvMoEU"),
    note: "No per-patient visit screen yet (Patient 360).",
  },
  {
    id: "unite.mrd_dx",
    group: "Airtable · Unite base",
    name: "Medical Records Data, visit diagnoses",
    pulse: "Visit diagnoses",
    evidence: at(U, "tblllKPKIY9qvMoEU", "visit_diagnoses"),
  },
  {
    id: "unite.diagnosis",
    group: "Airtable · Unite base",
    name: "Diagnosis",
    pulse: "Diagnosis reference list",
    href: "/portal/data-quality",
    evidence: at(U, "tblZqf4Zcw5Kweadh"),
  },
  {
    id: "unite.medication",
    group: "Airtable · Unite base",
    name: "Medication",
    pulse: "Medication reference list",
    href: "/portal/unclassified-medications",
    evidence: at(U, "tblLM2BXjA680GQws"),
  },
  {
    id: "unite.items",
    group: "Airtable · Unite base",
    name: "Items",
    pulse: "Items reference list",
    evidence: at(U, "tblTJtk6aIMbwpoA2"),
  },
  // ---- Campaigns base
  {
    id: "campaigns.appt",
    group: "Airtable · Campaigns base",
    name: "Appointment Messages",
    pulse: "Appointment reminder history",
    href: "/appointments",
    evidence: at(C, "tblhoSfiSjO4zh9cf"),
    note: "Records reminders Make already sent for appointments Pulse has; run it after the Unite appointment sync.",
  },
  {
    id: "campaigns.appt_birthday",
    group: "Airtable · Campaigns base",
    name: "Appointment Messages, early birthday sends",
    pulse: "Recall sends (Birthday)",
    href: "/recall",
    evidence: at(C, "tblhoSfiSjO4zh9cf", "birthday_log"),
  },
  {
    id: "campaigns.birthday",
    group: "Airtable · Campaigns base",
    name: "Birthday Messages",
    pulse: "Recall sends (Birthday)",
    href: "/recall",
    evidence: at(C, "tblHTlF6LXMK5p4mU"),
  },
  {
    id: "campaigns.chronic",
    group: "Airtable · Campaigns base",
    name: "Chronic Recall Messages",
    pulse: "Recall sends and the call list",
    href: "/recall/calls",
    evidence: at(C, "tbldCbNEKeF5NrTCs"),
  },
  {
    id: "campaigns.website",
    group: "Airtable · Campaigns base",
    name: "Website",
    pulse: "Website entry points",
    href: "/settings/channels",
    evidence: at(C, "tblpWst9QqYNuKpwZ"),
  },
  // ---- Acute base
  {
    id: "acute.patients",
    group: "Airtable · Acute follow-up base",
    name: "Patients",
    pulse: "Contacts (merged on Unite PIN)",
    href: "/contacts",
    evidence: at(A, "tblghX1mVYWgXvWbk"),
  },
  {
    id: "acute.settings",
    group: "Airtable · Acute follow-up base",
    name: "Settings",
    pulse: "Clinical settings (signed values)",
    href: "/portal/clinical-settings",
    evidence: at(A, "tbl69r1kelxG4g93L"),
  },
  {
    id: "acute.medref",
    group: "Airtable · Acute follow-up base",
    name: "Medication Reference",
    pulse: "Medication classes",
    href: "/portal/unclassified-medications",
    evidence: at(A, "tblIxa5xUOG3GRwmt"),
  },
  {
    id: "acute.visits",
    group: "Airtable · Acute follow-up base",
    name: "Visits",
    pulse: "Visits",
    evidence: at(A, "tblyOweSP3FfeY9q0"),
  },
  {
    id: "acute.rx",
    group: "Airtable · Acute follow-up base",
    name: "Prescriptions",
    pulse: "Prescriptions and sequences",
    evidence: at(A, "tblQra08AflxuXxQq"),
  },
  {
    id: "acute.queue",
    group: "Airtable · Acute follow-up base",
    name: "Follow-Up Queue",
    pulse: "Clinical follow-ups",
    href: "/portal/follow-ups",
    evidence: at(A, "tblgX6wIqWefpwrBg"),
  },
  {
    id: "acute.feedback",
    group: "Airtable · Acute follow-up base",
    name: "Feedback & Outcomes",
    pulse: "Clinical feedback",
    href: "/portal/clinical-feedback",
    evidence: at(A, "tbluNXftGwkP9rJDV"),
  },
  {
    id: "acute.templates",
    group: "Airtable · Acute follow-up base",
    name: "Message Templates",
    pulse: "Clinical call scripts",
    evidence: at(A, "tblnCsSkyw4Tu9Ak7"),
  },
  {
    id: "acute.log",
    group: "Airtable · Acute follow-up base",
    name: "Message Log",
    pulse: "Clinical message log",
    evidence: at(A, "tblXNWAh1hdaueUbs"),
  },
  {
    id: "acute.tests",
    group: "Airtable · Acute follow-up base",
    name: "Test Plan",
    pulse: "Unit-test fixtures",
    evidence: { kind: "none" },
    note: "Not imported by design; becomes test fixtures.",
  },
  // ---- Older bases
  {
    id: "ptf.doctors",
    group: "Airtable · Older bases",
    name: "Patient Treatment base, Doctors",
    pulse: "Doctors directory",
    href: "/doctors",
    evidence: at(P, "tblhoMqQ1jgiCGHGY"),
  },
  {
    id: "ptf.cpt",
    group: "Airtable · Older bases",
    name: "Patient Treatment base, CPT Master",
    pulse: "Items reference list",
    evidence: at(P, "tblopYbHPAbTi4QeX"),
  },
  {
    id: "ptf.labs",
    group: "Airtable · Older bases",
    name: "Patient Treatment base, Laboratory & Diagnostic Test",
    pulse: "Lab orders (not built)",
    evidence: { kind: "none" },
    note: "Backlog: no lab orders table yet.",
  },
  {
    id: "ptf.other",
    group: "Airtable · Older bases",
    name: "Patient Treatment base, other tables and DRAFT designs",
    pulse: "Redesigned natively where needed",
    evidence: { kind: "none" },
    note: "Prototype data; not imported by design.",
  },
  {
    id: "cfu.queue",
    group: "Airtable · Older bases",
    name: "Clinical Follow-Up & Care base, Follow-Up Queue",
    pulse: "Clinical follow-ups",
    evidence: { kind: "none" },
    note: "Superseded by the Acute base; not imported by design.",
  },
  // ---- Sanoflow exports (docs/22_PHASE_20A_NOTES.md): `pnpm import:sanoflow:all`, entities as the importer reports them
  {
    id: "sf.contacts",
    group: "Sanoflow · Exports",
    name: "Contacts",
    pulse: "Contacts (leads and patients)",
    href: "/contacts",
    evidence: sf("contact"),
  },
  {
    id: "sf.tags",
    group: "Sanoflow · Exports",
    name: "Tags",
    pulse: "Contact tags",
    href: "/settings/tags",
    evidence: sf("tag"),
  },
  {
    id: "sf.labels",
    group: "Sanoflow · Exports",
    name: "Labels",
    pulse: "Contact labels",
    href: "/settings/tags",
    evidence: sf("label"),
  },
  {
    id: "sf.categories",
    group: "Sanoflow · Exports",
    name: "Conversation categories",
    pulse: "Conversation categories",
    href: "/settings/inbox",
    evidence: sf("conv_category"),
  },
  {
    id: "sf.quick_replies",
    group: "Sanoflow · Exports",
    name: "Quick replies",
    pulse: "Quick replies",
    href: "/settings/inbox",
    evidence: sf("quick_reply"),
  },
  {
    id: "sf.segments",
    group: "Sanoflow · Exports",
    name: "Static segments",
    pulse: "Segments",
    href: "/contacts",
    evidence: sf("segment"),
  },
  {
    id: "sf.segment_members",
    group: "Sanoflow · Exports",
    name: "Static segment members",
    pulse: "Segment members",
    href: "/contacts",
    evidence: sf("segment_member"),
  },
  {
    id: "sf.segments_dynamic",
    group: "Sanoflow · Exports",
    name: "Dynamic segments",
    pulse: "Rebuilt by hand as saved filters",
    href: "/contacts",
    evidence: { kind: "none" },
    note: "Report only: a dynamic segment is a filter, and Pulse's filters differ. Rebuild each one by hand.",
  },
  {
    id: "sf.pipelines",
    group: "Sanoflow · Exports",
    name: "Pipelines",
    pulse: "Enquiry pipelines",
    href: "/settings/enquiries",
    evidence: sf("pipeline"),
  },
  {
    id: "sf.stages",
    group: "Sanoflow · Exports",
    name: "Pipeline stages",
    pulse: "Enquiry stages",
    href: "/settings/enquiries",
    evidence: sf("stage"),
  },
  {
    id: "sf.enquiry_fields",
    group: "Sanoflow · Exports",
    name: "Enquiry fields",
    pulse: "Enquiry custom fields",
    href: "/settings/custom-fields",
    evidence: sfRun("enquiry_field"),
  },
  {
    id: "sf.enquiry_sources",
    group: "Sanoflow · Exports",
    name: "Enquiry sources",
    pulse: "Enquiry sources",
    href: "/settings/enquiries",
    evidence: sfRun("enquiry_source"),
  },
  {
    id: "sf.lost_reasons",
    group: "Sanoflow · Exports",
    name: "Lost and disqualified reasons",
    pulse: "Lost reasons pick-list",
    href: "/settings/enquiries",
    evidence: sfRun("lost_reason"),
  },
  {
    id: "sf.enquiries",
    group: "Sanoflow · Exports",
    name: "Enquiries",
    pulse: "Enquiries",
    href: "/enquiries",
    evidence: sf("enquiry"),
  },
  {
    id: "sf.enquiry_activity",
    group: "Sanoflow · Exports",
    name: "Enquiry activity",
    pulse: "Enquiry timeline",
    href: "/enquiries",
    evidence: sf("enquiry_activity"),
  },
  {
    id: "sf.campaigns",
    group: "Sanoflow · Exports",
    name: "Campaign history",
    pulse: "Campaign archive (read only)",
    href: "/campaigns",
    evidence: sf("campaign"),
  },
  {
    id: "sf.campaign_recipients",
    group: "Sanoflow · Exports",
    name: "Campaign history recipients",
    pulse: "Campaign archive recipients (statuses and times only)",
    href: "/campaigns",
    evidence: sf("campaign_recipient"),
  },
  {
    id: "sf.appointments",
    group: "Sanoflow · Exports",
    name: "Appointments",
    pulse: "Appointments (future only; no reminders until switched on)",
    href: "/appointments",
    evidence: sf("appointment"),
    note: "Real writes need --with-appointments, on cut-over day only.",
  },
  // ---- Make, active
  {
    id: "make.token",
    group: "Make · Active scenarios",
    name: "Token",
    pulse: "Unite token refresh on demand",
    href: "/recall/parallel-run",
    evidence: { kind: "scenario", key: "token" },
  },
  {
    id: "make.reminders",
    group: "Make · Active scenarios",
    name: "Appointment Reminders (12:00) and (6 PM)",
    pulse: "Appointment reminders job",
    href: "/recall/parallel-run",
    evidence: { kind: "scenario", key: "appointment_reminders" },
  },
  {
    id: "make.birthday",
    group: "Make · Active scenarios",
    name: "Agewise Birthday Message",
    pulse: "Recall programme: Birthday",
    href: "/recall/parallel-run",
    evidence: { kind: "scenario", key: "birthday" },
  },
  {
    id: "make.chronic",
    group: "Make · Active scenarios",
    name: "Chronic Recall, 90 Day",
    pulse: "Recall programme: Chronic",
    href: "/recall/parallel-run",
    evidence: { kind: "scenario", key: "chronic_recall" },
  },
  {
    id: "make.chronic_update",
    group: "Make · Active scenarios",
    name: "Chronic Update (webhook)",
    pulse: "Reply and booking events on recall sends",
    href: "/recall/parallel-run",
    evidence: { kind: "scenario", key: "chronic_update" },
  },
  {
    id: "make.mrd",
    group: "Make · Active scenarios",
    name: "Acute Follow-Up, MRD Sync",
    pulse: "Visit feed and clinical rules engine",
    href: "/recall/parallel-run",
    evidence: { kind: "scenario", key: "mrd_sync" },
    note: "The Unite visit feed is not built yet.",
  },
  {
    id: "make.airtable_auto",
    group: "Make · Active scenarios",
    name: "Airtable native automations (2, Unite base)",
    pulse: "Documented, then switched off at cut-over",
    href: "/recall/parallel-run",
    evidence: { kind: "scenario", key: "airtable_automations" },
  },
  // ---- Make, inactive
  {
    id: "make.syncs",
    group: "Make · Inactive scenarios",
    name: "Unite data syncs (7 scenarios)",
    pulse: "One incremental Unite sync",
    evidence: { kind: "none" },
    note: "Rebuilt as a single sync, not scenario by scenario.",
  },
  {
    id: "make.finance",
    group: "Make · Inactive scenarios",
    name: "Unite Finance API test",
    pulse: "Finance capture (off, guarded)",
    href: "/finance",
    evidence: { kind: "none" },
    note: "Deliver-once API: never called outside the guarded job.",
  },
  {
    id: "make.screening",
    group: "Make · Inactive scenarios",
    name: "Screening and dormant reminders (9 scenarios)",
    pulse: "Recall programmes",
    href: "/recall",
    evidence: { kind: "programmes", keys: SCREENING_PROGRAMMES },
  },
  {
    id: "make.birthday_legacy",
    group: "Make · Inactive scenarios",
    name: "Birthday legacy (3 scenarios)",
    pulse: "Folded into the Birthday programme",
    evidence: { kind: "none" },
  },
  {
    id: "make.labs",
    group: "Make · Inactive scenarios",
    name: "Lab result and follow-up reminders",
    pulse: "Lab orders (not built)",
    evidence: { kind: "none" },
  },
  {
    id: "make.postvisit",
    group: "Make · Inactive scenarios",
    name: "Post-appointment and no-show (4 scenarios)",
    pulse: "Recall programmes and flows",
    href: "/recall",
    evidence: { kind: "none" },
  },
  {
    id: "make.draft_ops",
    group: "Make · Inactive scenarios",
    name: "Draft clinic operations (6 scenarios)",
    pulse: "Flows, reports, payment links",
    evidence: { kind: "none" },
  },
  {
    id: "make.search",
    group: "Make · Inactive scenarios",
    name: "Search New Contact",
    pulse: "Not needed (single CRM)",
    evidence: { kind: "none" },
    note: "Dropped by design.",
  },
  {
    id: "make.scratch",
    group: "Make · Inactive scenarios",
    name: "Integration scratch scenarios (9)",
    pulse: "Not needed",
    evidence: { kind: "none" },
    note: "Dropped by design.",
  },
];

/** The key reconcile_snapshot and import_runs use for an entity: `<source>/<entity>`. */
export const refKey = (entity: string, source: ImportSource = "airtable"): string =>
  `${source}/${entity}`;

const count = (n: number | undefined): number =>
  typeof n === "number" && Number.isFinite(n) && n > 0 ? n : 0;

export function deriveState(
  entry: Pick<MigrationEntry, "evidence">,
  facts: MigrationFacts = NO_FACTS,
): MigrationState {
  const ev = entry.evidence;
  switch (ev.kind) {
    case "refs":
      return count(facts.refs[refKey(ev.entity, ev.source)]) > 0 ? "imported" : "not_started";
    case "run": {
      // A real run that wrote something and failed nothing. A dry run is never progress.
      const r = facts.runs[refKey(ev.entity, ev.source)]?.real;
      return r &&
        r.counters.failed === 0 &&
        count(r.counters.created) + count(r.counters.updated) > 0
        ? "imported"
        : "not_started";
    }
    case "scenario": {
      const s = facts.scenarios[ev.key];
      if (!s || !s.nativeBuilt) return "not_started";
      const unexplained = count(facts.unexplainedDiffs[ev.key]);
      if (s.makeOff && s.diffsExplained && unexplained === 0) return "retired";
      if (s.parallelStartedOn) return "parallel_run";
      return "native";
    }
    case "programmes":
      return ev.keys.length > 0 && ev.keys.every((k) => facts.programmes[k] === "active")
        ? "native"
        : "not_started";
    case "none":
      return "not_started";
  }
}

const joinDetail = (...parts: Array<string | null>): string | null => {
  const used = parts.filter((p): p is string => !!p);
  return used.length ? used.join(" · ") : null;
};

const RUN_DATE = new Intl.DateTimeFormat("en-GB", {
  day: "numeric",
  month: "short",
  year: "numeric",
  timeZone: "UTC",
});
const runDay = (iso: string): string => {
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? "unknown date" : RUN_DATE.format(d);
};

/**
 * Counts of the importer's last run: the newest real run, else "dry run only" (a dry run proves the mapping, not that
 * anything arrived). Counts only; null when no run was recorded.
 */
export function runLine(facts: RunFacts | undefined): string | null {
  if (!facts) return null;
  const run = facts.real ?? facts.dry;
  if (!run) return null;
  const c = run.counters;
  const bits = [`${count(c.read).toLocaleString("en-GB")} read`];
  if (count(c.created)) bits.push(`${count(c.created).toLocaleString("en-GB")} created`);
  if (count(c.skipped)) bits.push(`${count(c.skipped).toLocaleString("en-GB")} skipped`);
  if (count(c.review)) bits.push(`${count(c.review).toLocaleString("en-GB")} for review`);
  if (count(c.invalid)) bits.push(`${count(c.invalid).toLocaleString("en-GB")} invalid`);
  if (count(c.failed)) bits.push(`${count(c.failed).toLocaleString("en-GB")} failed`);
  return facts.real
    ? `last import ${runDay(run.runAt)}: ${bits.join(", ")}`
    : `dry run only (${runDay(run.runAt)}): ${bits.join(", ")}`;
}

/** One short, count-only line for the "Last known" column; null when there is nothing to say. */
export function detailFor(
  entry: Pick<MigrationEntry, "evidence">,
  facts: MigrationFacts = NO_FACTS,
): string | null {
  const ev = entry.evidence;
  switch (ev.kind) {
    case "refs": {
      const key = refKey(ev.entity, ev.source);
      const n = count(facts.refs[key]);
      return joinDetail(
        n > 0 ? `${n.toLocaleString("en-GB")} records linked` : null,
        runLine(facts.runs[key]),
      );
    }
    case "run":
      return runLine(facts.runs[refKey(ev.entity, ev.source)]);
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
  return MIGRATION_REGISTRY.map((e) => ({
    ...e,
    state: deriveState(e, facts),
    detail: detailFor(e, facts),
  }));
}

export function summarise(rows: readonly MigrationRow[]): Record<MigrationState, number> {
  const out: Record<MigrationState, number> = {
    not_started: 0,
    imported: 0,
    native: 0,
    parallel_run: 0,
    retired: 0,
  };
  for (const r of rows) out[r.state] += 1;
  return out;
}

const COUNTER_KEYS = [
  "read",
  "created",
  "updated",
  "skipped",
  "invalid",
  "duplicates",
  "review",
  "failed",
] as const;

/** A recorded run → the facts the page shows. Anything unreadable is dropped (counts only, nothing guessed). */
export function toRunFact(runAt: string, dryRun: boolean, counters: unknown): RunFact | null {
  if (!counters || typeof counters !== "object" || Array.isArray(counters)) return null;
  const o = counters as Record<string, unknown>;
  const out = {} as RunFact["counters"];
  for (const k of COUNTER_KEYS) {
    const n = Number(o[k]);
    out[k] = Number.isFinite(n) && n > 0 ? Math.floor(n) : 0;
  }
  return { runAt, dryRun, counters: out };
}
