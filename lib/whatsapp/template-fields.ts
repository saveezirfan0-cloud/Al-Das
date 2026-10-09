/** Contact fields a template variable can be mapped to ("body.1" → "contact.first_name"). */
export const MAPPABLE_FIELDS = [
  { key: "contact.first_name", label: "Contact first name" },
  { key: "contact.last_name", label: "Contact last name" },
  { key: "contact.name", label: "Contact full name" },
  { key: "contact.phone", label: "Contact phone" },
] as const;

export type MappableField = (typeof MAPPABLE_FIELDS)[number]["key"];

export function isMappableField(v: string): v is MappableField {
  return MAPPABLE_FIELDS.some((f) => f.key === v);
}

/** Meta's template statuses, with a label and a tone for badges. */
export const TEMPLATE_STATUSES = [
  { value: "DRAFT", label: "Draft", tone: "neutral" },
  { value: "PENDING", label: "Pending review", tone: "warning" },
  { value: "IN_APPEAL", label: "In appeal", tone: "warning" },
  { value: "APPROVED", label: "Approved", tone: "success" },
  { value: "REJECTED", label: "Rejected", tone: "danger" },
  { value: "PAUSED", label: "Paused", tone: "warning" },
  { value: "FLAGGED", label: "Flagged", tone: "warning" },
  { value: "LIMIT_EXCEEDED", label: "Limit exceeded", tone: "danger" },
  { value: "DISABLED", label: "Disabled", tone: "danger" },
  { value: "PENDING_DELETION", label: "Pending deletion", tone: "neutral" },
  { value: "DELETED", label: "Deleted", tone: "neutral" },
] as const;

export type StatusTone = (typeof TEMPLATE_STATUSES)[number]["tone"];

export function statusInfo(status: string): { label: string; tone: StatusTone } {
  const s = TEMPLATE_STATUSES.find((x) => x.value === status.toUpperCase());
  return s ? { label: s.label, tone: s.tone } : { label: status, tone: "neutral" };
}

/** Which Meta statuses allow editing the template through Meta's edit API. */
export function isMetaEditable(status: string): boolean {
  return ["APPROVED", "REJECTED", "PAUSED"].includes(status.toUpperCase());
}
