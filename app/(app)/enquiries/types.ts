import type { CustomFieldDef } from "@/lib/contacts/custom-values";
import type { EnquiryFilter } from "@/lib/enquiries/filter";
import type { Option } from "@/lib/enquiries/reference";
import type { PipelineView } from "@/lib/enquiries/types";

import type { GridPrefs } from "../contacts/actions";

export type SavedView = {
  id: string;
  name: string;
  pipeline_id: string | null;
  filter: EnquiryFilter;
  columns: string[];
  shared_team_ids: string[];
  shared_with_all: boolean;
  mine: boolean;
};

/** Everything the client needs to render the Enquiries workspace. Serialisable. */
export type EnquiriesBootstrap = {
  orgId: string;
  userId: string;
  timezone: string;
  slaHours: number | null;
  can: { manage: boolean; tasks: boolean; contacts: boolean; settings: boolean };
  pipelines: PipelineView[];
  users: Array<{ id: string; label: string }>;
  teams: Option[];
  channels: Option[];
  locations: Option[];
  departments: Option[];
  specialists: Option[];
  services: Option[];
  customFields: CustomFieldDef[];
  sources: string[];
  views: SavedView[];
  gridPrefs: GridPrefs | null;
};
