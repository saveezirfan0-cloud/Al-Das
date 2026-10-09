/**
 * Pipelines created the first time an org opens Enquiries. The clinic runs its operational queues
 * as pipelines (reception, awaiting patient, doctor liaison, escalation, insurance review, medical
 * records, pharmacy, ready to close). Everything is editable in Settings → Enquiries.
 */
import { DEFAULT_CARD_FIELDS, type CardFieldKey } from "@/lib/enquiries/columns";

export type DefaultPipeline = {
  name: string;
  card_fields: CardFieldKey[];
  stages: Array<{ name: string; color: string }>;
};

const LADDER = [
  { name: "New", color: "slate" },
  { name: "In progress", color: "blue" },
  { name: "Follow-up", color: "amber" },
];

export const DEFAULT_PIPELINES: DefaultPipeline[] = [
  "Reception",
  "Awaiting patient",
  "Doctor liaison",
  "Escalation",
  "Insurance review",
  "Medical records",
  "Pharmacy",
  "Ready to close",
].map((name) => ({
  name,
  card_fields: [...DEFAULT_CARD_FIELDS],
  stages: LADDER.map((s) => ({ ...s })),
}));

export const STAGE_COLORS = [
  "slate",
  "blue",
  "green",
  "amber",
  "red",
  "violet",
  "pink",
  "teal",
] as const;
export type StageColor = (typeof STAGE_COLORS)[number];

export function isStageColor(v: unknown): v is StageColor {
  return typeof v === "string" && (STAGE_COLORS as readonly string[]).includes(v);
}
