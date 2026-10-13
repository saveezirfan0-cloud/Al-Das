/**
 * Shared bookkeeping for the Sanoflow importers. A run records counts, reason codes and line numbers;
 * never a name, phone, e-mail or message text (CLAUDE.md rule 10). The only free text it keeps is
 * reference data the operator has to fix by hand: unmatched pipeline, stage, location, specialist
 * and service names, and unknown CSV header names.
 */
import { normalizePhone } from "@/lib/phone";

import { runCounters, type RunCounters } from "../results";
import type { SanoflowConfig, SanoflowNames } from "./config";
import type { ContactMatch, SanoflowPorts } from "./ports";

export type EntityRun = {
  /** external_refs.entity (source 'sanoflow'). */
  entity: string;
  label: string;
  /** Export file name (basename), null for the config file. */
  file: string | null;
  counters: RunCounters;
  /** Reason code → rows. */
  warnings: Record<string, number>;
  /** [line, reason code] for rows that were not imported; line 1 is the first data row. */
  problems: Array<[number, string]>;
  unknownHeaders: string[];
  /** Reference names that matched nothing (kind → distinct names). */
  unmatchedNames: Record<string, string[]>;
  /** Skipped rows are skipped on purpose (past appointments, cancelled ones). */
  skippedByDesign: boolean;
  notes: string[];
  /** This step only simulated its writes even if the overall run is real. */
  dryRun?: boolean;
  /** Run aborted before reading rows (e.g. a required column is missing). */
  fatal?: string;
};

export function newRun(entity: string, label: string, file: string | null): EntityRun {
  return {
    entity,
    label,
    file,
    counters: runCounters(),
    warnings: {},
    problems: [],
    unknownHeaders: [],
    unmatchedNames: {},
    skippedByDesign: false,
    notes: [],
  };
}

export const warn = (r: EntityRun, code: string) => {
  r.warnings[code] = (r.warnings[code] ?? 0) + 1;
};

const MAX_PROBLEMS = 1000;
export const problem = (r: EntityRun, line: number, code: string) => {
  if (r.problems.length < MAX_PROBLEMS) r.problems.push([line, code]);
};

export function unmatchedName(r: EntityRun, kind: string, name: string) {
  const list = (r.unmatchedNames[kind] ??= []);
  if (name && !list.includes(name) && list.length < 200) list.push(name);
}

export type RunContext = {
  ports: SanoflowPorts;
  config: SanoflowConfig;
  names: SanoflowNames;
  /** IANA zone the export's dates and times are written in (the org's). */
  timezone: string;
  now: Date;
  /** "skip" never changes a row an earlier run created. */
  mode: "update" | "skip";
};

/** Finds the patient a Sanoflow row belongs to: Sanoflow contact id (via external_refs), then phone. */
export async function resolveContact(
  ports: SanoflowPorts,
  sanoflowContactId: string,
  phoneRaw: string,
): Promise<ContactMatch> {
  if (sanoflowContactId) {
    const ref = await ports.findRef("contact", sanoflowContactId);
    if (ref) {
      const live = await ports.liveContact(ref.localId);
      if (live) return { kind: "match", id: live };
    }
  }
  const phone = normalizePhone(phoneRaw);
  if (phone) return ports.matchContactByPhone(phone.e164);
  return { kind: "none" };
}

/** Outcome total; equals counters.read when every row is accounted for. */
export function outcomes(c: RunCounters): number {
  return (
    c.created +
    c.updated +
    c.unchanged +
    c.adopted +
    c.skipped +
    c.invalid +
    c.duplicates +
    c.review +
    c.failed
  );
}
