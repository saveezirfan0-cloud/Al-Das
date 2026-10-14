import type { ClientField } from "@/components/filter-builder/filter-builder";
import type { CustomFieldDef } from "@/lib/contacts/custom-values";
import type { SegmentSummary } from "@/lib/contacts/server";

import type { GridPrefs } from "./actions";

export type TagOption = { id: string; name: string; color: string };

/** Everything the client needs to render the Contacts workspace. Serialisable. */
export type ContactsBootstrap = {
  userId: string;
  timezone: string;
  can: {
    manage: boolean;
    export: boolean;
    enquiriesView: boolean;
    enquiriesManage: boolean;
    /** documents.view: the Documents tab (not inherited from contacts.view). */
    documentsView: boolean;
    /** flows.manage as well as contacts.manage: may choose a segment's drip flow (Phase 20b). */
    drip: boolean;
    /** Phase F Patient 360 tabs: tasks.view (Tasks) and finance.invoices.view (Invoices). */
    tasksView: boolean;
    invoicesView: boolean;
  };
  /** Flows with the "Contact added to a segment (drip)" trigger, for the segment dialog. Empty without `can.drip`. */
  dripFlows: Array<{ id: string; name: string; active: boolean }>;
  customFields: CustomFieldDef[];
  fields: ClientField[];
  tags: TagOption[];
  segments: SegmentSummary[];
  users: Array<{ id: string; label: string }>;
  /** Phase B: every active branch (names for the column and filter) and the ones this member may pick as home branch. */
  branches: Array<{ id: string; name: string; allowed: boolean }>;
  gridPrefs: GridPrefs | null;
};
