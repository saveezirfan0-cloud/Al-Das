/** Pure helpers for the Activity log screen. No I/O. */

export const ACTIVITY_PAGE_SIZE = 50;

export const ACTIVITY_PERIODS = [
  { value: "24h", label: "Last 24 hours", hours: 24 },
  { value: "7d", label: "Last 7 days", hours: 24 * 7 },
  { value: "30d", label: "Last 30 days", hours: 24 * 30 },
  { value: "all", label: "All time", hours: null },
] as const;

export type ActivityFilters = {
  period: (typeof ACTIVITY_PERIODS)[number]["value"];
  entity: string | null;
  actor: string | null;
  q: string | null;
  page: number;
};

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const SLUG = /^[a-z0-9_.-]{1,64}$/i;

function first(v: string | string[] | undefined): string | undefined {
  return Array.isArray(v) ? v[0] : v;
}

/** Reads untrusted query-string values into safe filters. Anything odd is dropped, never thrown. */
export function parseActivityFilters(
  params: Record<string, string | string[] | undefined>,
): ActivityFilters {
  const period = ACTIVITY_PERIODS.find((p) => p.value === first(params.period))?.value ?? "7d";
  const entity = first(params.entity)?.trim() ?? "";
  const actor = first(params.actor)?.trim() ?? "";
  // The search box matches action names only; strip LIKE wildcards and cap the length.
  const q = (first(params.q) ?? "")
    .replace(/[%_\\,()]/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 64);
  const page = Number.parseInt(first(params.page) ?? "1", 10);
  return {
    period,
    entity: SLUG.test(entity) ? entity : null,
    actor: UUID.test(actor) ? actor : null,
    q: q || null,
    page: Number.isFinite(page) && page > 0 && page < 10_000 ? page : 1,
  };
}

/** ISO timestamp the period starts at, or null for "all time". */
export function periodStart(period: ActivityFilters["period"], now = new Date()): string | null {
  const hours = ACTIVITY_PERIODS.find((p) => p.value === period)?.hours ?? null;
  return hours === null ? null : new Date(now.getTime() - hours * 3_600_000).toISOString();
}

/** "role.updated" → "Role updated"; keeps unknown shapes readable. */
export function describeAction(action: string): string {
  const text = action.replace(/[._]+/g, " ").trim();
  return text ? text.charAt(0).toUpperCase() + text.slice(1) : action;
}

/** Badge colour: removals and access changes stand out, everything else stays neutral. */
export function actionTone(action: string): "destructive" | "warning" | "secondary" {
  if (/(delete|remove|revoke|suspend|disable|reject|dismiss)/i.test(action)) return "destructive";
  if (/(role|permission|invite|password|api_key|key|export|sign_off|signoff|merge)/i.test(action))
    return "warning";
  return "secondary";
}

/** Compact one-line preview of a diff for the table; the full JSON is in the row's details. */
export function diffPreview(diff: unknown, max = 90): string {
  if (diff === null || diff === undefined) return "";
  let text: string;
  try {
    text = JSON.stringify(diff);
  } catch {
    return "";
  }
  if (!text || text === "{}" || text === "null") return "";
  return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}
