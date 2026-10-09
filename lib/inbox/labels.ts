/** Conversation labels are tags with scope = 'conversation'; colours come from Phase 2's tag palette. */
import { TAG_COLORS, tagClass } from "@/lib/contacts/format";

export const LABEL_COLORS = TAG_COLORS;
export type LabelColor = (typeof TAG_COLORS)[number];

export function labelClass(color: string | null | undefined): string {
  return tagClass(color ?? "gray");
}
