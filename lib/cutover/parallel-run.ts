/**
 * Parallel run of the native replacements next to Make (docs/audit/make-replacement-design.md §10).
 * Pure: parsing what Make handled, and deciding whether a scenario may be signed off. A scenario is
 * only ever turned off in Make by a person, after this says the evidence is there.
 */

const ISO = /^(\d{4})-(\d{2})-(\d{2})$/;
const DMY = /^(\d{1,2})[/.-](\d{1,2})[/.-](\d{4})$/;

/** YYYY-MM-DD for an ISO date or a day-first date (Airtable logs write 12/10/2026 as 12 October). */
export function normaliseDate(raw: string): string | null {
  const t = raw.trim().replace(/^"|"$/g, "");
  let y: number, m: number, d: number;
  let mt = ISO.exec(t);
  if (mt) [y, m, d] = [Number(mt[1]), Number(mt[2]), Number(mt[3])];
  else if ((mt = DMY.exec(t))) [d, m, y] = [Number(mt[1]), Number(mt[2]), Number(mt[3])];
  else return null;
  const probe = new Date(Date.UTC(y, m - 1, d));
  if (probe.getUTCFullYear() !== y || probe.getUTCMonth() !== m - 1 || probe.getUTCDate() !== d)
    return null;
  return `${y}-${String(m).padStart(2, "0")}-${String(d).padStart(2, "0")}`;
}

export const MAX_MAKE_KEYS_PER_UPLOAD = 5000;

export type ParsedKeys = {
  rows: Array<{ date: string; key: string }>;
  rejected: number;
  truncated: boolean;
};

/**
 * One identifier per line, optionally "key,date" (a header row is skipped). Lines without a date
 * use `defaultDate`. Only the identifier is kept: if a line carries more columns (names, phones)
 * they are dropped, never stored.
 */
export function parseMakeKeys(text: string, defaultDate: string | null): ParsedKeys {
  const seen = new Set<string>();
  const rows: ParsedKeys["rows"] = [];
  let rejected = 0;
  let truncated = false;
  let first = true;
  for (const line of text.split(/\r?\n/)) {
    const raw = line.trim();
    if (!raw) continue;
    const cols = raw.split(/[,;\t]/).map((c) => c.trim().replace(/^"|"$/g, ""));
    const key = cols[0];
    const date = cols.length > 1 ? normaliseDate(cols[1]) : defaultDate;
    if (first) {
      first = false;
      // A header such as "appointment_id,date" or "PIN": skip it rather than store it as an id.
      if (
        /^(key|pin|id|patient|appointment[ _]?id|unite[ _]?id)\b/i.test(key) &&
        (cols.length === 1 || !date)
      )
        continue;
    }
    if (!key || key.length > 80 || /\s/.test(key) || !date) {
      rejected++;
      continue;
    }
    const k = `${date}|${key}`;
    if (seen.has(k)) continue;
    if (rows.length >= MAX_MAKE_KEYS_PER_UPLOAD) {
      truncated = true;
      break;
    }
    seen.add(k);
    rows.push({ date, key });
  }
  return { rows, rejected, truncated };
}

export type DayDiff = {
  runDate: string;
  makeCount: number;
  nativeCount: number;
  onlyInMake: number;
  onlyInNative: number;
  noted: boolean;
};

export type ScenarioFacts = {
  compareKind: "ids" | "health" | "none";
  nativeReady: boolean;
  parallelStartedOn: string | null;
  /** Today in the workspace time zone, YYYY-MM-DD. */
  today: string;
  diffs: readonly DayDiff[];
  health?: { total: number; ok: number } | null;
};

export const MIN_PARALLEL_DAYS = 7;
export const MIN_ACTIVE_DAYS = 5;
export const MIN_HEALTH_CALLS = 50;
export const MIN_HEALTH_RATE = 0.99;

const dayNumber = (d: string) =>
  Math.floor(Date.UTC(+d.slice(0, 4), +d.slice(5, 7) - 1, +d.slice(8, 10)) / 86_400_000);

/** What still stands between this scenario and a sign-off. Empty = ready. */
export function signOffBlockers(f: ScenarioFacts): string[] {
  const out: string[] = [];
  if (f.compareKind === "none") return ["There is no native replacement to compare yet."];
  if (!f.nativeReady) out.push("The native version is not marked as built.");
  if (!f.parallelStartedOn) out.push("Record the day the parallel run started.");
  else if (dayNumber(f.today) - dayNumber(f.parallelStartedOn) < MIN_PARALLEL_DAYS)
    out.push(
      `The parallel run needs ${MIN_PARALLEL_DAYS} days; it started ${dayNumber(f.today) - dayNumber(f.parallelStartedOn)} day(s) ago.`,
    );

  if (f.compareKind === "health") {
    const h = f.health;
    if (!h || h.total < MIN_HEALTH_CALLS)
      out.push(`Not enough Unite calls yet to judge (${h?.total ?? 0} of ${MIN_HEALTH_CALLS}).`);
    else if (h.ok / h.total < MIN_HEALTH_RATE)
      out.push(
        `Only ${((h.ok / h.total) * 100).toFixed(1)}% of Unite calls succeeded; ${MIN_HEALTH_RATE * 100}% is needed.`,
      );
    return out;
  }

  const start = f.parallelStartedOn;
  const window = f.diffs.filter((d) => !start || d.runDate >= start);
  const days = new Set(window.map((d) => d.runDate));
  if (days.size < MIN_PARALLEL_DAYS)
    out.push(`Only ${days.size} day(s) compared; ${MIN_PARALLEL_DAYS} are needed.`);
  const active = window.filter((d) => d.makeCount > 0 || d.nativeCount > 0).length;
  if (days.size >= MIN_PARALLEL_DAYS && active < MIN_ACTIVE_DAYS)
    out.push(
      `Only ${active} day(s) had any activity; at least ${MIN_ACTIVE_DAYS} are needed to prove anything.`,
    );
  const unexplained = window.filter((d) => (d.onlyInMake > 0 || d.onlyInNative > 0) && !d.noted);
  if (unexplained.length)
    out.push(
      `${unexplained.length} day(s) have differences nobody has explained (add a note per day).`,
    );
  return out;
}
