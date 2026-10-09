import type { PortalObjectDef } from "@/lib/portal/types";

import {
  REF_CONDITION_GROUPS,
  REF_DIAGNOSES,
  REF_ITEMS,
  REF_MEDICATION_CLASSES,
  REF_MEDICATIONS,
} from "./reference";
import { WEBSITE_ENTRY_POINTS } from "./website";

/**
 * Every generic (registry-driven) portal object. Clinical settings, the Follow-Up Queue and Sync
 * Review are dedicated Phase 6 screens (app/(app)/portal/sections.ts) with their own workflows
 * and are deliberately not duplicated here. Recall tables (drafts 0104) join when they are promoted.
 */
export const PORTAL_OBJECTS: readonly PortalObjectDef[] = [
  REF_DIAGNOSES,
  REF_CONDITION_GROUPS,
  REF_MEDICATIONS,
  REF_ITEMS,
  REF_MEDICATION_CLASSES,
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
