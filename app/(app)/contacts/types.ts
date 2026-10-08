import type { ClientField } from "@/components/filter-builder/filter-builder";
import type { CustomFieldDef } from "@/lib/contacts/custom-values";
import type { SegmentSummary } from "@/lib/contacts/server";

import type { GridPrefs } from "./actions";

export type TagOption = { id: string; name: string; color: string };

/** Everything the client needs to render the Contacts workspace. Serialisable. */
export type ContactsBootstrap = {
  userId: string;
  timezone: string;
  can: { manage: boolean; export: boolean };
  customFields: CustomFieldDef[];
  fields: ClientField[];
  tags: TagOption[];
  segments: SegmentSummary[];
  users: Array<{ id: string; label: string }>;
  gridPrefs: GridPrefs | null;
};
