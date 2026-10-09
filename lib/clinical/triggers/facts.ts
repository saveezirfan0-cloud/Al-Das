import type { Needs } from "@/lib/clinical/settings";

/** Everything a trigger rule may read about a visit. Text fields are lower-cased by the caller (txt). */
export type VisitFacts = {
  ageAtVisit: number | null;
  tempC: number | null;
  pulse: number | null;
  bpSystolic: number | null;
  bpDiastolic: number | null;
  spo2: number | null;
  /** Primary diagnosis text (coded). */
  dx: string;
  /** Secondary diagnosis codes (coded). */
  dx2: string;
  /** Observation notes AFTER negation scrubbing; empty when scrubbing could not run. */
  obs: string;
  proc: string;
  inv: string;
  plan: string;
  /** null = not known; never read as zero. */
  investigationCount: number | null;
  papResult: "positive" | "negative" | "pending" | "not_available" | null;
  symptomatic: boolean | null;
  hasAntibiotic: boolean;
  hasSteroid: boolean;
};

export type RuleResult = { fired: string[] };

export type RuleCtx = { facts: VisitFacts; need: Needs };

export const hasInv = (f: VisitFacts) => f.investigationCount !== null && f.investigationCount > 0;
