import type { ClientField } from "@/components/filter-builder/filter-builder";
import type { PortalObjectDef } from "@/lib/portal/types";
import type { SavedViewDto } from "@/lib/portal/server";

export type PortalGridPrefs = {
  columns: Array<{ id: string; width?: number; hidden?: boolean }>;
  pageSize?: number;
};

/** Everything the client needs to render one portal object's workspace. Serialisable. */
export type PortalBootstrap = {
  object: PortalObjectDef;
  userId: string;
  timezone: string;
  can: { write: boolean; create: boolean; delete: boolean; export: boolean };
  fields: ClientField[];
  views: SavedViewDto[];
  users: Array<{ id: string; label: string }>;
  linkOptions: Record<string, Array<{ value: string; label: string }>>;
  gridPrefs: PortalGridPrefs | null;
};
