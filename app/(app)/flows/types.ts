import type { TriggerType } from "@/lib/flow-engine/types";

export type FlowListItem = {
  id: string;
  name: string;
  description: string | null;
  status: "draft" | "active" | "paused";
  trigger_type: TriggerType;
  channel_id: string | null;
  version: number;
  updated_at: string;
  published_at: string | null;
  completed: number;
  failed: number;
  live: number;
  last_run_at: string | null;
  /** The draft differs from what is live. */
  unpublished: boolean;
};

export type VariableItem = {
  id: string;
  key: string;
  label: string | null;
  value_type: "text" | "number" | "boolean";
  default_value: string | null;
  description: string | null;
};

export type ChannelOption = { id: string; name: string };
