import type { Tables } from "@/lib/supabase/types";

export type TemplateRow = Pick<
  Tables<"wa_templates">,
  | "id"
  | "name"
  | "language"
  | "category"
  | "status"
  | "type"
  | "channel_id"
  | "waba_id"
  | "meta_template_id"
  | "components"
  | "variable_map"
  | "retry_on_fail"
  | "rejected_reason"
  | "submit_error"
  | "quality"
  | "archived_at"
  | "last_synced_at"
  | "submitted_at"
  | "updated_at"
  | "media_paths"
  | "gallery_key"
  | "parameter_format"
>;

export type ChannelOption = {
  id: string;
  name: string;
  display_phone: string | null;
  waba_id: string;
  status: string;
};

export type TemplatesBootstrap = {
  rows: TemplateRow[];
  channels: ChannelOption[];
  hasMetaAppId: boolean;
  lastSyncedAt: string | null;
};
