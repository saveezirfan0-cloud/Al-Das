/**
 * Retention policy per document category (pure; unit-tested).
 *
 * A policy says how many days a category is kept. The clock starts at the upload, or at the expiry date when
 * there is one and it is later (a card is kept for N days after it stops being valid). A policy never deletes
 * on its own: `auto_delete` must be switched on for the nightly job to remove files, otherwise documents past
 * retention are only listed for a person to review. No policy means "keep".
 */
import { dayNumber } from "@/lib/documents/expiry";

export type RetentionPolicy = {
  category: string;
  retain_days: number | null;
  auto_delete: boolean;
};

export const MIN_RETAIN_DAYS = 30;
export const MAX_RETAIN_DAYS = 36_500;

export function validRetainDays(days: unknown): days is number {
  return (
    typeof days === "number" &&
    Number.isInteger(days) &&
    days >= MIN_RETAIN_DAYS &&
    days <= MAX_RETAIN_DAYS
  );
}

const toDay = (d: string | Date): string =>
  typeof d === "string" ? d.slice(0, 10) : d.toISOString().slice(0, 10);

/** The first day the document may be removed (YYYY-MM-DD), or null when it is kept indefinitely. */
export function retentionDueOn(
  policy: Pick<RetentionPolicy, "retain_days"> | null | undefined,
  doc: { created_at: string | Date; expires_on: string | null },
): string | null {
  if (!policy || !validRetainDays(policy.retain_days)) return null;
  const start = dayNumber(toDay(doc.created_at));
  if (start === null) return null;
  const exp = dayNumber(doc.expires_on);
  const base = exp !== null && exp > start ? exp : start;
  return new Date((base + policy.retain_days) * 86_400_000).toISOString().slice(0, 10);
}

export function pastRetention(
  policy: Pick<RetentionPolicy, "retain_days"> | null | undefined,
  doc: { created_at: string | Date; expires_on: string | null },
  today: string,
): boolean {
  const due = retentionDueOn(policy, doc);
  const d = dayNumber(due);
  const t = dayNumber(today);
  return d !== null && t !== null && t >= d;
}

/** Splits documents past retention into those the job may delete and those a person must review. */
export function classifyRetention<
  T extends { category: string; created_at: string | Date; expires_on: string | null },
>(
  docs: readonly T[],
  policies: readonly RetentionPolicy[],
  today: string,
): { autoDelete: T[]; review: T[] } {
  const byCat = new Map(policies.map((p) => [p.category, p]));
  const autoDelete: T[] = [];
  const review: T[] = [];
  for (const d of docs) {
    const p = byCat.get(d.category);
    if (!p || !pastRetention(p, d, today)) continue;
    (p.auto_delete ? autoDelete : review).push(d);
  }
  return { autoDelete, review };
}
