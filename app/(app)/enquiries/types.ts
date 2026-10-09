import type { ClientField } from "@/components/filter-builder/filter-builder";
import type { CustomFieldDef } from "@/lib/contacts/custom-values";
import type {
  EnquiryViewSummary,
  Lookups,
  OrgUser,
  PipelineInfo,
  TeamInfo,
} from "@/lib/enquiries/server";

import type { GridPrefs } from "@/app/(app)/contacts/actions";

/** Everything the client needs to render the Enquiries workspace. Serialisable. */
export type EnquiriesBootstrap = {
  orgId: string;
  userId: string;
  timezone: string;
  can: {
    manage: boolean;
    export: boolean;
    delete: boolean;
    settings: boolean;
    contacts: boolean;
    tasks: boolean;
  };
  customFields: CustomFieldDef[];
  fields: ClientField[];
  pipelines: PipelineInfo[];
  lookups: Lookups;
  users: OrgUser[];
  teams: TeamInfo[];
  sources: string[];
  views: EnquiryViewSummary[];
  gridPrefs: GridPrefs | null;
};
