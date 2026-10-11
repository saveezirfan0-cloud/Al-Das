import {
  dropHeaderArtefact,
  splitList,
  toBool,
  toDate,
  toNumber,
  toText,
  slug,
  upperSnake,
} from "../convert";
import { BASE } from "./bases";
import type { TableMapper } from "./types";

/** Unite.Diagnosis → ref_diagnoses. The condition group is a select, resolved by name. */
export const diagnosisMapper: TableMapper = {
  key: "unite.diagnosis",
  name: "Unite · Diagnosis",
  baseId: BASE.unite,
  tableId: "tblZqf4Zcw5Kweadh",
  target: "ref_diagnoses",
  status: "ready",
  naturalKey: ["code"],
  fields: [
    { id: "fldld9DKnsoLK9ADK", column: "code", required: true },
    { id: "fldlgGXBFovQBgr7N", column: "short_description" },
    { id: "fldXgTWsfTbPrlreE", column: "long_description" },
    { id: "fldIGBzWtu2QFP0Yk", column: "chronic", convert: (v) => toBool(v) },
    { id: "fldFVPiTP5g4AGaV2", column: "top30", convert: (v) => toBool(v) },
    { id: "fldgC3rVdSM5ehgtQ", column: "not_found_in_unite", convert: (v) => toBool(v) },
  ],
  links: [
    {
      kind: "lookup",
      fieldId: "fldyz11Dj5wK2y2S8",
      label: "Mapped condition group",
      column: "condition_group_id",
      table: "ref_condition_groups",
      matchColumn: "name",
    },
  ],
};

/** Unite.Medication → ref_medications. Header-artefact values ("SOURCE", "IS_EBP") are dropped. */
export const medicationMapper: TableMapper = {
  key: "unite.medication",
  name: "Unite · Medication",
  baseId: BASE.unite,
  tableId: "tblLM2BXjA680GQws",
  target: "ref_medications",
  status: "ready",
  naturalKey: ["ddc_code"],
  fields: [
    { id: "fld7kgxlA3c0kjFdW", column: "ddc_code", required: true },
    { id: "fldvBHlyQEFGX1UFS", column: "trade_name" },
    { id: "fldDwPzpHS7bHGZbj", column: "status" },
    { id: "fld6erxHG8rlNl7Zr", column: "scientific_code" },
    { id: "fldIea5PEr6Tk50tY", column: "scientific_name" },
    { id: "fldsXKIf7k6HF3jhW", column: "strength" },
    { id: "fld7ovnGh11wewXqw", column: "dosage_form" },
    { id: "flduJNhd0tBaFqDoT", column: "route" },
    { id: "fldQPwna6WcQkIsrb", column: "package_price", convert: (v) => toNumber(v) },
    { id: "fldGFRp4X68CfAO6k", column: "granular_unit" },
    {
      id: "fldlWj6a725a6l54H",
      column: "registered_owner",
      convert: (v) => dropHeaderArtefact(v, "REGISTERED_OWNER"),
    },
    { id: "fldGvn9X6b6sNY9Xi", column: "source_updated_on", convert: (v) => toDate(v) },
    { id: "fldkhVVFyNnSz5T4n", column: "source", convert: (v) => dropHeaderArtefact(v, "SOURCE") },
    {
      id: "fldQQsGZMJDEmcIkL",
      column: "is_ebp",
      convert: (v) => {
        const s = dropHeaderArtefact(v, "IS_EBP");
        return s === null ? null : toBool(s, true);
      },
    },
    { id: "fldOr4Wf4rSrjTDwV", column: "medicine_type" },
    { id: "fld15ltyTEfiugYam", column: "all_medicine_types", convert: (v) => splitList(v) },
    { id: "fldma2rcVXZDIDsuY", column: "icd_codes" },
  ],
};

/** "ItemType" is a header artefact; case variants collapse to one UPPER_SNAKE value. */
function itemType(v: unknown, warn: (c: string) => void): string | null {
  const t = upperSnake(v);
  if (t === "ITEMTYPE" || t === "ITEM_TYPE") {
    warn("item_type_header_artefact");
    return null;
  }
  return t;
}

export const itemsMapper: TableMapper = {
  key: "unite.items",
  name: "Unite · Items",
  baseId: BASE.unite,
  tableId: "tblTJtk6aIMbwpoA2",
  target: "ref_items",
  status: "ready",
  naturalKey: ["code"],
  fields: [
    { id: "fld0i0BQItTWZpTm5", column: "code", required: true },
    { id: "fldB4i14uDiaFt0Qv", column: "description" },
    { id: "fldDUW6cM6saCg5m8", column: "item_type", convert: itemType },
  ],
};

/** PTF.CPT Master merges into ref_items: upsert on code; description / item_type only fill blanks. */
export const cptMasterMapper: TableMapper = {
  key: "ptf.cpt_master",
  name: "PTF · CPT Master",
  baseId: BASE.ptf,
  tableId: "tblopYbHPAbTi4QeX",
  target: "ref_items",
  status: "ready",
  naturalKey: ["code"],
  dependsOn: ["unite.items"],
  fillBlankOnly: ["description", "item_type"],
  fields: [
    { id: "fldjaLpahs9NgSFAF", column: "code", required: true },
    { id: "fldX4POEMd2VY8FKc", column: "description" },
    { id: "fldYCtqy5kYgQrwlr", column: "item_type", convert: itemType },
    { id: "fldqsVvaiGRe59o9w", column: "test_category" },
    { id: "fldyLyowekQPhpFnr", column: "patient_message_group" },
    { id: "fldi4vFfiPdSU7ZxC", column: "doctor_verified", convert: (v) => toBool(v) },
  ],
};

const MED_CLASSES = [
  "antibiotic",
  "steroid",
  "probiotic",
  "supplement",
  "enzyme",
  "other",
  "unclassified",
];

/** Acute.Medication Reference → ref_medication_classes. Unknown classes fail closed to unclassified. */
export const medicationReferenceMapper: TableMapper = {
  key: "acute.medication_reference",
  name: "Acute · Medication Reference",
  baseId: BASE.acute,
  tableId: "tblIxa5xUOG3GRwmt",
  target: "ref_medication_classes",
  status: "ready",
  naturalKey: ["unite_local_code"],
  fields: [
    { id: "fld8IyFkiQC3VrDpH", column: "unite_local_code", required: true },
    { id: "fldBmjJIDVEFm6gbW", column: "medication_name" },
    {
      id: "fldHUcvmoD8Sy8Yia",
      column: "class",
      convert: (v, warn) => {
        const s = slug(v);
        if (!s) return "unclassified";
        if (MED_CLASSES.includes(s)) return s;
        warn("unknown_medication_class");
        return "unclassified";
      },
    },
    { id: "fldUVPyOsylLribKr", column: "requires_probiotics_default", convert: (v) => toBool(v) },
    { id: "fldDSObi3AgyZAX3U", column: "classified_by" },
    { id: "fldSuHUA4YgNPovVI", column: "notes" },
  ],
  // A heuristic suggestion is never an effective classification (DB check constraint).
  finalize(values, _raw, warn) {
    if (
      toText(values.classified_by).toLowerCase() === "heuristic" &&
      values.class !== "unclassified"
    ) {
      values.class = "unclassified";
      warn("heuristic_forced_unclassified");
    }
  },
};

export const websiteMapper: TableMapper = {
  key: "campaigns.website",
  name: "Campaigns · Website",
  baseId: BASE.campaigns,
  tableId: "tblpWst9QqYNuKpwZ",
  target: "website_entry_points",
  status: "ready",
  naturalKey: ["section", "source_key"],
  fields: [
    { id: "fld44pzWF1WiW96XW", column: "section", required: true },
    { id: "fld87i81Uv5xEbCjh", column: "source_key", required: true },
    { id: "fldeVUgOhIlFt0fPu", column: "channel_phone" },
    { id: "fldMXt1bD5N6aTNbR", column: "prefill_message" },
    { id: "fldySS9CEPFLYnWVP", column: "route_to" },
    { id: "fld4cpDJ3LsB3Fq7k", column: "priority_key" },
    { id: "fld6BmbGE4MDFZENr", column: "is_dynamic", convert: (v) => toBool(v) },
  ],
};

export const settingsMapper: TableMapper = {
  key: "acute.settings",
  name: "Acute · Settings",
  baseId: BASE.acute,
  tableId: "tbl69r1kelxG4g93L",
  target: "clinical_settings",
  status: "ready",
  naturalKey: ["label"],
  writer: "clinical_settings",
  fields: [
    { id: "fldpn14HNQN3BFEfc", column: "label", required: true },
    { id: "fld7M5zm094N0rlcm", column: "category", convert: (v) => slug(v) || null },
    { id: "fldg7eo4b6905Vouh", column: "proposed_value" },
    { id: "fld5xepAeK9pdB6mE", column: "approved_value" },
    { id: "fldezo13piyceP6Ex", column: "sign_off_status", convert: (v) => slug(v) || null },
    { id: "fldD5bnejIIX8YMqO", column: "owner" },
    { id: "fldOGCNJX09G2Rlms", column: "notes" },
    { id: "fldU8lQx3G30drRGi", column: "signed_by" },
    { id: "fld51DuMTqkow2Qic", column: "signed_at", convert: (v) => toDate(v) },
  ],
};
