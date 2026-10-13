/**
 * The two hand-filled files that drive the Sanoflow import:
 *
 *  - sanoflow-config.json: pipelines, stages, how Sanoflow statuses and lost reasons map to Pulse,
 *    enquiry custom fields (including the UTM fields) and extra enquiry sources. Filled by hand from
 *    Sanoflow → Settings → Enquiries. Example: docs/audit/sanoflow-config.example.json.
 *  - sanoflow-names.json: Sanoflow location / specialist / service / pipeline names → the Pulse
 *    names they became. Example: docs/audit/sanoflow-names.example.json.
 *
 * Neither file may hold patient data. Both are validated strictly; an unknown key is an error so a
 * typo cannot silently drop a mapping.
 */
import fs from "node:fs";
import { z } from "zod";

import { CUSTOM_FIELD_TYPES } from "@/lib/contacts/custom-values";
import { ENQUIRY_STATUSES } from "@/lib/enquiries/constants";

const name = z.string().trim().min(1).max(120);

const stageSchema = z
  .object({
    name,
    /** The stage's name in Sanoflow when it differs from the Pulse name. */
    sanoflow_name: name.optional(),
    color: z.string().trim().min(1).max(20).optional(),
  })
  .strict();

const pipelineSchema = z
  .object({
    name,
    sanoflow_name: name.optional(),
    is_default: z.boolean().optional(),
    stages: z.array(stageSchema).min(1).max(30),
  })
  .strict();

const customFieldSchema = z
  .object({
    key: z.string().regex(/^[a-z][a-z0-9_]{0,63}$/),
    label: z.string().trim().min(1).max(80),
    type: z.enum(CUSTOM_FIELD_TYPES),
    options: z
      .array(
        z.object({ value: z.string().min(1).max(80), label: z.string().min(1).max(80) }).strict(),
      )
      .max(100)
      .optional(),
  })
  .strict();

export const sanoflowConfigSchema = z
  .object({
    version: z.literal(1),
    pipelines: z.array(pipelineSchema).min(1).max(20),
    /** Sanoflow status text → Pulse status. Matched case-insensitively; built-in words are added. */
    statuses: z.record(name, z.enum(ENQUIRY_STATUSES)).default({}),
    /** Sanoflow disqualify / lost reason → the wording Pulse should store. Unlisted reasons are kept as is. */
    lost_reasons: z.record(name, z.string().trim().min(1).max(200)).default({}),
    /** Stored when a lost / disqualified enquiry has no reason in the export (Pulse requires one). */
    default_lost_reason: z.string().trim().min(1).max(200).default("Not recorded in Sanoflow"),
    enquiry_custom_fields: z.array(customFieldSchema).max(50).default([]),
    /** Added to Settings → Enquiries → sources when missing. */
    sources: z.array(z.string().trim().min(1).max(60)).max(50).default([]),
    /** How to read ambiguous dates like 03/04/2026. UAE exports are day first. */
    date_order: z.enum(["dmy", "mdy"]).default("dmy"),
  })
  .strict();
export type SanoflowConfig = z.infer<typeof sanoflowConfigSchema>;

const nameMap = z.record(name, name).default({});
export const sanoflowNamesSchema = z
  .object({
    version: z.literal(1),
    locations: nameMap,
    specialists: nameMap,
    services: nameMap,
  })
  .strict();
export type SanoflowNames = z.infer<typeof sanoflowNamesSchema>;

export const EMPTY_NAMES: SanoflowNames = {
  version: 1,
  locations: {},
  specialists: {},
  services: {},
};

/** Built-in status words; the config's `statuses` overrides them. */
export const DEFAULT_STATUS_WORDS: Record<string, (typeof ENQUIRY_STATUSES)[number]> = {
  open: "open",
  new: "open",
  "in progress": "open",
  active: "open",
  won: "won",
  converted: "won",
  booked: "won",
  "closed won": "won",
  lost: "lost",
  "closed lost": "lost",
  disqualified: "disqualified",
  junk: "disqualified",
  spam: "disqualified",
};

function readJson(file: string): unknown {
  try {
    return JSON.parse(fs.readFileSync(file, "utf8"));
  } catch (e) {
    throw new Error(`${file}: ${e instanceof Error ? e.message : "unreadable"}`);
  }
}

function explain(file: string, err: z.ZodError): Error {
  const first = err.issues
    .slice(0, 5)
    .map((i) => `${i.path.join(".") || "(root)"}: ${i.message}`)
    .join("; ");
  return new Error(`${file} is not valid: ${first}`);
}

export function parseConfig(raw: unknown, file = "sanoflow-config.json"): SanoflowConfig {
  const p = sanoflowConfigSchema.safeParse(raw);
  if (!p.success) throw explain(file, p.error);
  const seen = new Set<string>();
  for (const pl of p.data.pipelines) {
    const k = (pl.sanoflow_name ?? pl.name).toLowerCase();
    if (seen.has(k)) throw new Error(`${file}: pipeline "${pl.name}" is listed twice`);
    seen.add(k);
    const stages = new Set<string>();
    for (const st of pl.stages) {
      const sk = (st.sanoflow_name ?? st.name).toLowerCase();
      if (stages.has(sk))
        throw new Error(`${file}: stage "${st.name}" is listed twice in "${pl.name}"`);
      stages.add(sk);
    }
  }
  if (p.data.pipelines.filter((pl) => pl.is_default).length > 1)
    throw new Error(`${file}: only one pipeline can be the default`);
  return p.data;
}

export function parseNames(raw: unknown, file = "sanoflow-names.json"): SanoflowNames {
  const p = sanoflowNamesSchema.safeParse(raw);
  if (!p.success) throw explain(file, p.error);
  return p.data;
}

export const loadConfig = (file: string) => parseConfig(readJson(file), file);
export const loadNames = (file: string) => parseNames(readJson(file), file);

/** Case-insensitive lookup in a hand-written name map. */
export function mapName(map: Record<string, string>, raw: string): string {
  const k = raw.trim().toLowerCase();
  for (const [from, to] of Object.entries(map)) if (from.trim().toLowerCase() === k) return to;
  return raw.trim();
}
