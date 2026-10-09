import type { MetaTemplateComponent } from "@/lib/whatsapp/types";

export type ChannelOption = {
  id: string;
  name: string;
  phone_number_id: string;
  display_phone: string | null;
  waba_id: string;
  status: string;
};

/** What the list and the builder need about one template. */
export type TemplateView = {
  id: string;
  channel_id: string | null;
  name: string;
  language: string;
  category: string;
  status: string;
  type: string;
  quality: string | null;
  components: MetaTemplateComponent[];
  variable_map: Record<string, string>;
  rejected_reason: string | null;
  last_error: string | null;
  needs_review: boolean;
  source: string;
  meta_template_id: string | null;
  archived_at: string | null;
  last_edited_at: string | null;
  submitted_at: string | null;
  last_synced_at: string | null;
  header_sample_path: string | null;
  card_sample_paths: Array<string | null>;
  internal_key: string | null;
  clinical_approval: string;
  updated_at: string;
};

export type TemplatesBootstrap = {
  templates: TemplateView[];
  channels: ChannelOption[];
  canManage: boolean;
  /** META_APP_ID is configured, so header samples can be uploaded to Meta. */
  uploadsEnabled: boolean;
};
