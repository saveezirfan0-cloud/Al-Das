/** Patient document categories (pure). Keys are stored in patient_documents.category. */
export const DOCUMENT_CATEGORIES = [
  { key: "referral", label: "Referral" },
  { key: "lab_report", label: "Lab report" },
  { key: "insurance_card", label: "Insurance card" },
  { key: "consent", label: "Consent form" },
  { key: "other", label: "Other" },
] as const;

export type DocumentCategory = (typeof DOCUMENT_CATEGORIES)[number]["key"];

export const CATEGORY_KEYS = DOCUMENT_CATEGORIES.map((c) => c.key) as [
  DocumentCategory,
  ...DocumentCategory[],
];

export function isCategory(v: unknown): v is DocumentCategory {
  return typeof v === "string" && (CATEGORY_KEYS as string[]).includes(v);
}

export function categoryLabel(key: string): string {
  return DOCUMENT_CATEGORIES.find((c) => c.key === key)?.label ?? "Other";
}

/** Categories that raise an "expiring soon" reminder. Other categories may carry an expiry date, quietly. */
export const REMINDER_CATEGORIES: readonly DocumentCategory[] = ["insurance_card"];

/** Categories where the form asks for an expiry date. */
export function suggestsExpiry(category: DocumentCategory): boolean {
  return category === "insurance_card";
}
