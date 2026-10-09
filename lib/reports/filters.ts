import { z } from "zod";

/**
 * Shared report filters. They live in the URL (so a report is linkable and the export matches what
 * is on screen) and are validated the same way on the page and in the export route.
 */

export const PERIODS = ["today", "yesterday", "last_7_days", "last_30_days", "this_month", "last_month", "custom"] as const;
export type Period = (typeof PERIODS)[number];

export const PERIOD_LABELS: Record<Period, string> = {
  today: "Today",
  yesterday: "Yesterday",
  last_7_days: "Last 7 days",
  last_30_days: "Last 30 days",
  this_month: "This month",
  last_month: "Last month",
  custom: "Custom range",
};

const day = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "Use YYYY-MM-DD");
const uuids = z.array(z.string().uuid()).max(50).default([]);

export const MAX_RANGE_DAYS = 366;

export const reportFiltersSchema = z
  .object({
    period: z.enum(PERIODS).default("last_30_days"),
    from: day.optional(),
    to: day.optional(),
    channel_ids: uuids,
    team_ids: uuids,
    user_ids: uuids,
  })
  .superRefine((f, ctx) => {
    if (f.period !== "custom") return;
    if (!f.from || !f.to) {
      ctx.addIssue({ code: "custom", message: "Pick a start and end date.", path: ["from"] });
      return;
    }
    const a = Date.parse(`${f.from}T00:00:00Z`);
    const b = Date.parse(`${f.to}T00:00:00Z`);
    if (Number.isNaN(a) || Number.isNaN(b)) ctx.addIssue({ code: "custom", message: "Invalid date.", path: ["from"] });
    else if (b < a) ctx.addIssue({ code: "custom", message: "The end date is before the start date.", path: ["to"] });
    else if ((b - a) / 86_400_000 + 1 > MAX_RANGE_DAYS) ctx.addIssue({ code: "custom", message: `Choose at most ${MAX_RANGE_DAYS} days.`, path: ["to"] });
  });

export type ReportFilters = z.infer<typeof reportFiltersSchema>;

export const DEFAULT_FILTERS: ReportFilters = reportFiltersSchema.parse({});

type RawParams = Record<string, string | string[] | undefined>;

function list(v: string | string[] | undefined): string[] {
  const raw = Array.isArray(v) ? v : v ? [v] : [];
  return raw.flatMap((s) => s.split(",")).map((s) => s.trim()).filter(Boolean);
}

/** Lenient: an invalid URL falls back to the default filters instead of erroring the page. */
export function filtersFromSearchParams(sp: RawParams): { filters: ReportFilters; error: string | null } {
  const one = (k: string) => (Array.isArray(sp[k]) ? sp[k]![0] : (sp[k] as string | undefined)) || undefined;
  const parsed = reportFiltersSchema.safeParse({
    period: one("period"),
    from: one("from"),
    to: one("to"),
    channel_ids: list(sp.channel),
    team_ids: list(sp.team),
    user_ids: list(sp.user),
  });
  if (parsed.success) return { filters: parsed.data, error: null };
  return { filters: DEFAULT_FILTERS, error: parsed.error.issues[0]?.message ?? "Invalid filters." };
}

export function filtersToSearchParams(f: ReportFilters): URLSearchParams {
  const p = new URLSearchParams();
  if (f.period !== DEFAULT_FILTERS.period) p.set("period", f.period);
  if (f.period === "custom" && f.from && f.to) {
    p.set("from", f.from);
    p.set("to", f.to);
  }
  if (f.channel_ids.length) p.set("channel", f.channel_ids.join(","));
  if (f.team_ids.length) p.set("team", f.team_ids.join(","));
  if (f.user_ids.length) p.set("user", f.user_ids.join(","));
  return p;
}
