/**
 * Campaign A/B tests (Phase 20g, G9; docs/29_PHASE_20G_SHOWBUSY_AB_NOTES.md). Pure; unit-tested.
 *
 * Who gets B is decided in SQL when the recipient row is inserted (app.campaign_ab_bucket: a hash of campaign id and
 * contact id below `split_pct`), stored in campaign_recipients.variant and never changed, so a retry round or a
 * resumed fanout sends each person the same version. This file only picks the version's settings at dispatch, checks
 * a variant before it is saved, and shapes the A vs B report.
 */
import { pct, type Funnel } from "@/lib/campaigns/funnel";

export const AB_SPLIT_MIN = 1;
export const AB_SPLIT_MAX = 99;
export const AB_SPLIT_DEFAULT = 50;

export type Variant = "a" | "b";

/** One version's send settings, as the fanout needs them. */
export type VariantSettings<T> = {
  template: T;
  map: Record<string, string>;
  fallbacks: Record<string, string>;
};

/**
 * The settings for a recipient's version. A recipient marked 'b' whose campaign has no variant B (cannot happen
 * through the app: the row is never deleted on its own) gets null, so the caller skips it rather than sending A.
 */
export function settingsForVariant<T>(
  variant: string | null | undefined,
  a: VariantSettings<T>,
  b: VariantSettings<T> | null,
): VariantSettings<T> | null {
  if (variant === "b") return b;
  return a;
}

const sameMap = (x: Record<string, string>, y: Record<string, string>) => {
  const kx = Object.keys(x).filter((k) => x[k] !== "");
  const ky = Object.keys(y).filter((k) => y[k] !== "");
  return kx.length === ky.length && kx.every((k) => x[k] === y[k]);
};

/**
 * Why variant B cannot be saved, or null. B must have the same category as A (the audience, its consent check and
 * the send-time opt-out guard are decided by A's category), and must differ from A in template or mapping.
 */
export function variantProblem(input: {
  a: { templateId: string; category: string };
  b: { templateId: string; category: string };
  aMap: Record<string, string>;
  bMap: Record<string, string>;
  aFallbacks: Record<string, string>;
  bFallbacks: Record<string, string>;
  splitPct: number;
}): string | null {
  const { a, b } = input;
  if (
    !Number.isInteger(input.splitPct) ||
    input.splitPct < AB_SPLIT_MIN ||
    input.splitPct > AB_SPLIT_MAX
  )
    return `Send version B to between ${AB_SPLIT_MIN}% and ${AB_SPLIT_MAX}% of the audience.`;
  if (a.category.toUpperCase() !== b.category.toUpperCase())
    return "Version B must use a template of the same category as version A.";
  if (
    a.templateId === b.templateId &&
    sameMap(input.aMap, input.bMap) &&
    sameMap(input.aFallbacks, input.bFallbacks)
  )
    return "Version B is the same as version A. Choose another template or change its variables.";
  return null;
}

/** One version's numbers: the campaign funnel plus quick-reply clicks. */
export type AbCounts = Funnel & { clicked: number };
export type AbFunnel = { a: AbCounts; b: AbCounts };

const COUNT_KEYS: Array<keyof AbCounts> = [
  "total",
  "eligible",
  "pending",
  "queued",
  "sent",
  "delivered",
  "read",
  "replied",
  "clicked",
  "failed",
  "skipped",
];

function counts(raw: unknown): AbCounts {
  const o =
    raw && typeof raw === "object" && !Array.isArray(raw) ? (raw as Record<string, unknown>) : {};
  const out = {} as AbCounts;
  for (const k of COUNT_KEYS) {
    const v = Number(o[k]);
    out[k] = Number.isFinite(v) && v > 0 ? Math.floor(v) : 0;
  }
  return out;
}

/** campaign_ab_funnel() → both versions (a missing side is all zeros). */
export function parseAbFunnel(raw: unknown): AbFunnel {
  const o =
    raw && typeof raw === "object" && !Array.isArray(raw) ? (raw as Record<string, unknown>) : {};
  return { a: counts(o.a), b: counts(o.b) };
}

export type AbRow = {
  key: "sent" | "delivered" | "read" | "replied" | "clicked" | "failed";
  label: string;
  a: { count: number; pct: number };
  b: { count: number; pct: number };
};

const ROWS: Array<[AbRow["key"], string]> = [
  ["sent", "Sent"],
  ["delivered", "Delivered"],
  ["read", "Read"],
  ["replied", "Replied"],
  ["clicked", "Clicked"],
  ["failed", "Failed"],
];

/** Side-by-side rows, each as a share of that version's eligible recipients (skipped excluded, like the funnel). */
export function abRows(f: AbFunnel): AbRow[] {
  return ROWS.map(([key, label]) => ({
    key,
    label,
    a: { count: f.a[key], pct: pct(f.a[key], f.a.eligible) },
    b: { count: f.b[key], pct: pct(f.b[key], f.b.eligible) },
  }));
}
