import type { ChannelOption } from "../types";

export type BuilderLookups = {
  templates: Array<{ id: string; name: string; language: string; status: string }>;
  people: Array<{ id: string; name: string }>;
  teams: Array<{ id: string; name: string }>;
  pipelines: Array<{ id: string; name: string; stages: Array<{ id: string; name: string }> }>;
  channels: ChannelOption[];
  flows: Array<{ id: string; name: string }>;
  portalObjects: Array<{ key: string; label: string; fields: string[] }>;
  specialists: Array<{ id: string; name: string }>;
  locations: Array<{ id: string; name: string }>;
  services: Array<{ id: string; name: string }>;
  permissions: string[];
};
