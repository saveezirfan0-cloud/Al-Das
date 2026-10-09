import type { PortalObjectDef } from "@/lib/portal/types";

import { CLINICAL_SETTINGS } from "./clinical";
import {
  REF_CONDITION_GROUPS,
  REF_DIAGNOSES,
  REF_ITEMS,
  REF_MEDICATION_CLASSES,
  REF_MEDICATIONS,
} from "./reference";
import { WEBSITE_ENTRY_POINTS } from "./website";

/**
 * Every object the portal can expose. Phase 9 registers the objects whose tables exist; the
 * draft-only objects (visits, follow-ups, recall, prescription sequences, clinic calendar)
 * are added here in Phase 6 when supabase/drafts 0102–0105 are promoted.
 */
export const PORTAL_OBJECTS: readonly PortalObjectDef[] = [
  REF_DIAGNOSES,
  REF_CONDITION_GROUPS,
  REF_MEDICATIONS,
  REF_ITEMS,
  REF_MEDICATION_CLASSES,
  CLINICAL_SETTINGS,
  WEBSITE_ENTRY_POINTS,
];

const BY_KEY = new Map(PORTAL_OBJECTS.map((o) => [o.key, o]));

export function getPortalObject(key: string): PortalObjectDef | undefined {
  return BY_KEY.get(key);
}

export function requirePortalObject(key: string): PortalObjectDef {
  const o = BY_KEY.get(key);
  if (!o) throw new Error(`Unknown portal object: ${key}`);
  return o;
}
