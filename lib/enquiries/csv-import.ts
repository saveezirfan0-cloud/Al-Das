/**
 * Enquiries CSV import (Phase F). Pure: column mapping, validation per row (phones to E.164, pipeline / stage / branch
 * names to ids, numbers and dates), the in-file duplicate check and the natural key that makes a re-run idempotent.
 * The server action hashes the key (with the organisation) into external_refs (source 'csv', entity 'enquiry'), writes
 * rows through the enquiry service and audits counts only. Nothing here logs, and errors never repeat a cell's value.
 */
import type { CountryCode } from "libphonenumber-js";

import { normalizePhone } from "@/lib/phone";

export const ENQUIRY_IMPORT_FIELDS = [
  { key: "title", label: "Title" },
  { key: "full_name", label: "Patient name (full)" },
  { key: "first_name", label: "First name" },
  { key: "last_name", label: "Last name" },
  { key: "phone", label: "Phone" },
  { key: "email", label: "E-mail" },
  { key: "pipeline", label: "Pipeline (name)" },
  { key: "stage", label: "Stage (name)" },
  { key: "branch", label: "Branch (name)" },
  { key: "source", label: "Source" },
  { key: "est_value", label: "Estimated value" },
  { key: "appt_date", label: "Appointment date" },
  { key: "external_id", label: "Your own ID (for re-runs)" },
] as const;

export type EnquiryImportField = (typeof ENQUIRY_IMPORT_FIELDS)[number]["key"];

export const MAX_IMPORT_ROWS = 2000;

const FIELD_KEYS = new Set<string>(ENQUIRY_IMPORT_FIELDS.map((f) => f.key));

export function isImportField(v: unknown): v is EnquiryImportField {
  return typeof v === "string" && FIELD_KEYS.has(v);
}

const ALIASES: Record<string, EnquiryImportField> = {
  title: "title",
  subject: "title",
  enquiry: "title",
  name: "full_name",
  "full name": "full_name",
  patient: "full_name",
  "patient name": "full_name",
  "first name": "first_name",
  firstname: "first_name",
  "last name": "last_name",
  lastname: "last_name",
  surname: "last_name",
  phone: "phone",
  mobile: "phone",
  "phone number": "phone",
  whatsapp: "phone",
  email: "email",
  "e-mail": "email",
  pipeline: "pipeline",
  stage: "stage",
  branch: "branch",
  location: "branch",
  source: "source",
  "lead source": "source",
  value: "est_value",
  "estimated value": "est_value",
  "est value": "est_value",
  "appointment date": "appt_date",
  "appt date": "appt_date",
  id: "external_id",
  "external id": "external_id",
  reference: "external_id",
};

/** A first guess at the mapping from the file's headers (each field used once). */
export function guessMapping(
  headers: readonly string[],
): Record<string, EnquiryImportField | null> {
  const used = new Set<EnquiryImportField>();
  const out: Record<string, EnquiryImportField | null> = {};
  for (const h of headers) {
    const key = ALIASES[h.trim().toLowerCase().replace(/[_]+/g, " ")] ?? null;
    out[h] = key && !used.has(key) ? key : null;
    if (key) used.add(key);
  }
  return out;
}

export type ImportPipeline = {
  id: string;
  name: string;
  stages: Array<{ id: string; name: string }>;
};

export type ImportContext = {
  /** header → field, or null to skip the column. Columns not mapped are never read. */
  mapping: Record<string, EnquiryImportField | null>;
  pipelines: readonly ImportPipeline[];
  /** Used for rows without a pipeline column (or an empty cell). */
  defaultPipelineId: string;
  branches: ReadonlyArray<{ id: string; name: string }>;
  defaultCountry?: CountryCode;
};

export type PreparedEnquiry = {
  title: string;
  firstName: string;
  lastName: string;
  phone: string | null;
  email: string | null;
  pipelineId: string;
  stageId: string | null;
  locationId: string | null;
  source: string | null;
  estValue: number | null;
  apptDate: string | null;
  externalId: string | null;
};

export type PreparedEnquiryRow = {
  /** 1-based line in the file, not counting the header. */
  line: number;
  status: "ok" | "invalid" | "duplicate";
  errors: string[];
  duplicateOf?: number;
  /** Natural key for idempotency (hashed with the organisation before it is stored). */
  key: string | null;
  enquiry: PreparedEnquiry | null;
};

export type ImportSummary = { total: number; ok: number; invalid: number; duplicates: number };

/** Mapping problems that stop the whole import (before any row is looked at). */
export function mappingProblem(mapping: Record<string, EnquiryImportField | null>): string | null {
  const targets = Object.values(mapping).filter((v): v is EnquiryImportField => !!v);
  const dup = targets.find((t, i) => targets.indexOf(t) !== i);
  if (dup) return `Two columns are mapped to the same field (${dup.replace(/_/g, " ")}).`;
  if (!targets.includes("phone") && !targets.includes("external_id"))
    return "Map a Phone column (or Your own ID) so a re-run does not create the enquiries twice.";
  if (
    !targets.includes("title") &&
    !targets.includes("full_name") &&
    !targets.includes("first_name")
  )
    return "Map a Title or a patient name column.";
  return null;
}

const norm = (s: string) => s.trim().toLowerCase().replace(/\s+/g, " ");

function parseAmount(raw: string): number | null | "bad" {
  if (!raw) return null;
  const cleaned = raw.replace(/[,\s]/g, "").replace(/^(AED|aed|د\.إ)/, "");
  if (!/^\d+(\.\d{1,2})?$/.test(cleaned)) return "bad";
  const n = Number(cleaned);
  return n > 100_000_000 ? "bad" : n;
}

/** ISO (2026-10-14) or day-first (14/10/2026, 14-10-2026, 14.10.2026), checked to be a real date. */
export function parseImportDate(raw: string): string | null | "bad" {
  if (!raw) return null;
  const s = raw.trim();
  let y: number, m: number, d: number;
  const iso = /^(\d{4})-(\d{1,2})-(\d{1,2})(?:[T ].*)?$/.exec(s);
  const dmy = /^(\d{1,2})[/.-](\d{1,2})[/.-](\d{4})$/.exec(s);
  if (iso) [y, m, d] = [Number(iso[1]), Number(iso[2]), Number(iso[3])];
  else if (dmy) [y, m, d] = [Number(dmy[3]), Number(dmy[2]), Number(dmy[1])];
  else return "bad";
  const date = new Date(Date.UTC(y, m - 1, d));
  if (date.getUTCFullYear() !== y || date.getUTCMonth() !== m - 1 || date.getUTCDate() !== d)
    return "bad";
  if (y < 2000 || y > 2100) return "bad";
  return `${y}-${String(m).padStart(2, "0")}-${String(d).padStart(2, "0")}`;
}

export function prepareEnquiryImport(
  headers: readonly string[],
  rows: readonly (readonly string[])[],
  ctx: ImportContext,
): { rows: PreparedEnquiryRow[]; summary: ImportSummary } {
  const pipelineByName = new Map(ctx.pipelines.map((p) => [norm(p.name), p]));
  const pipelineById = new Map(ctx.pipelines.map((p) => [p.id, p]));
  const branchByName = new Map(ctx.branches.map((b) => [norm(b.name), b.id]));
  const seen = new Map<string, number>();
  const out: PreparedEnquiryRow[] = [];

  rows.forEach((cells, idx) => {
    const line = idx + 1;
    const errors: string[] = [];
    const get = (field: EnquiryImportField): string => {
      const i = headers.findIndex((h) => ctx.mapping[h] === field);
      return i >= 0 ? String(cells[i] ?? "").trim() : "";
    };

    if (cells.every((c) => !String(c ?? "").trim())) {
      out.push({
        line,
        status: "invalid",
        errors: ["The row is empty."],
        key: null,
        enquiry: null,
      });
      return;
    }

    let firstName = get("first_name");
    let lastName = get("last_name");
    const full = get("full_name");
    if (!firstName && !lastName && full) {
      const parts = full.split(/\s+/);
      firstName = parts.shift() ?? "";
      lastName = parts.join(" ");
    }
    const name = `${firstName} ${lastName}`.trim();
    const title = (get("title") || (name ? `Enquiry from ${name}` : "")).slice(0, 200);
    if (!title) errors.push("Missing title or patient name.");

    const rawPhone = get("phone");
    let phone: string | null = null;
    if (rawPhone) {
      const p = normalizePhone(rawPhone, ctx.defaultCountry);
      if (p) phone = p.e164;
      else errors.push("The phone number is not valid.");
    }
    const externalId = get("external_id").slice(0, 100) || null;
    if (!rawPhone && !externalId) errors.push("Missing phone number.");

    const rawEmail = get("email").toLowerCase();
    let email: string | null = null;
    if (rawEmail) {
      if (/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(rawEmail) && rawEmail.length <= 254) email = rawEmail;
      else errors.push("The e-mail address is not valid.");
    }

    const pipelineName = get("pipeline");
    const pipeline = pipelineName
      ? pipelineByName.get(norm(pipelineName))
      : pipelineById.get(ctx.defaultPipelineId);
    if (!pipeline) errors.push(pipelineName ? "Unknown pipeline." : "Choose a pipeline.");

    const stageName = get("stage");
    let stageId: string | null = null;
    if (stageName && pipeline) {
      const stage = pipeline.stages.find((s) => norm(s.name) === norm(stageName));
      if (stage) stageId = stage.id;
      else errors.push("Unknown stage for this pipeline.");
    }

    const branchName = get("branch");
    let locationId: string | null = null;
    if (branchName) {
      locationId = branchByName.get(norm(branchName)) ?? null;
      if (!locationId) errors.push("Unknown branch.");
    }

    const value = parseAmount(get("est_value"));
    if (value === "bad") errors.push("The estimated value is not a number.");
    const apptDate = parseImportDate(get("appt_date"));
    if (apptDate === "bad")
      errors.push("The appointment date is not a date (use 2026-10-14 or 14/10/2026).");

    const source = get("source").slice(0, 60) || null;

    const enquiry: PreparedEnquiry | null =
      errors.length === 0 && pipeline
        ? {
            title,
            firstName: firstName.slice(0, 60),
            lastName: lastName.slice(0, 60),
            phone,
            email,
            pipelineId: pipeline.id,
            stageId,
            locationId,
            source,
            estValue: value === "bad" ? null : value,
            apptDate: apptDate === "bad" ? null : apptDate,
            externalId,
          }
        : null;
    const key = enquiry ? naturalKey(enquiry) : null;

    if (!enquiry || !key) {
      out.push({ line, status: "invalid", errors, key: null, enquiry: null });
      return;
    }
    const first = seen.get(key);
    if (first !== undefined) {
      out.push({ line, status: "duplicate", errors: [], duplicateOf: first, key, enquiry });
      return;
    }
    seen.set(key, line);
    out.push({ line, status: "ok", errors: [], key, enquiry });
  });

  return {
    rows: out,
    summary: {
      total: out.length,
      ok: out.filter((r) => r.status === "ok").length,
      invalid: out.filter((r) => r.status === "invalid").length,
      duplicates: out.filter((r) => r.status === "duplicate").length,
    },
  };
}

/**
 * The same enquiry imported twice gets the same key: your own ID when the file has one, otherwise the patient's
 * phone, the title (case and spacing ignored) and the pipeline.
 */
export function naturalKey(
  e: Pick<PreparedEnquiry, "externalId" | "phone" | "title" | "pipelineId">,
): string | null {
  if (e.externalId) return `ext:${e.externalId}`;
  if (!e.phone) return null;
  return `nat:${e.phone}|${norm(e.title)}|${e.pipelineId}`;
}
