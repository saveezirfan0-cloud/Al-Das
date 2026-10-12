/**
 * Bundle budgets: parse the route table that `next build` prints and compare each route's "First Load JS"
 * with a budget. Pure (text in, verdict out) so it is unit-tested; scripts/check-bundle-budget.ts wires it to
 * the build log and CI.
 */

export type RouteSize = { route: string; firstLoadKb: number };
export type ParsedBuild = { shared: number | null; routes: RouteSize[] };

const UNIT: Record<string, number> = { B: 1 / 1000, kB: 1, KB: 1, MB: 1000 };
const toKb = (n: string, unit: string) => Number(n) * (UNIT[unit] ?? NaN);

/** Strips the ANSI colour codes Next adds when it thinks it is on a terminal. */
const plain = (s: string) => s.replace(/\u001b\[[0-9;]*m/g, "");

export function parseBuildOutput(output: string): ParsedBuild {
  const routes: RouteSize[] = [];
  let shared: number | null = null;
  for (const raw of plain(output).split(/\r?\n/)) {
    const line = raw.trimEnd();
    // "+ First Load JS shared by all    102 kB"
    const sh = /First Load JS shared by all\s+([\d.]+)\s*(B|kB|KB|MB)\b/.exec(line);
    if (sh) {
      shared = toKb(sh[1], sh[2]);
      continue;
    }
    // "├ ƒ /appointments        97 kB   309 kB"   (symbols: ○ static, ƒ dynamic, ● SSG)
    const m =
      /^[\s│├└┌]*[○●◐λƒ]?\s*(\/[^\s]*)\s+([\d.]+)\s*(B|kB|KB|MB)\s+([\d.]+)\s*(B|kB|KB|MB)\s*$/.exec(
        line,
      );
    if (m) routes.push({ route: m[1], firstLoadKb: toKb(m[4], m[5]) });
  }
  return { shared, routes };
}

export type BudgetConfig = {
  /** Budget for "First Load JS shared by all", in kB. */
  sharedKb: number;
  /** Budget for any route not listed in `routes`. */
  defaultKb: number;
  /** Per-route budgets in kB (First Load JS). */
  routes: Record<string, number>;
};

export type BudgetResult = {
  ok: boolean;
  violations: string[];
  /** One line per budgeted route, for the log. */
  report: string[];
  unknownBudgetRoutes: string[];
};

export function checkBudgets(build: ParsedBuild, config: BudgetConfig): BudgetResult {
  const violations: string[] = [];
  const report: string[] = [];

  if (build.routes.length === 0) {
    violations.push("No routes found in the build output (is this a `next build` log?).");
  }
  if (build.shared === null)
    violations.push('Could not find "First Load JS shared by all" in the build output.');
  else {
    const over = build.shared > config.sharedKb;
    report.push(
      `shared by all: ${build.shared.toFixed(1)} kB (budget ${config.sharedKb} kB)${over ? "  OVER" : ""}`,
    );
    if (over)
      violations.push(`shared JS is ${build.shared.toFixed(1)} kB, budget ${config.sharedKb} kB`);
  }

  const seen = new Set<string>();
  for (const r of build.routes) {
    seen.add(r.route);
    const budget = config.routes[r.route] ?? config.defaultKb;
    const over = r.firstLoadKb > budget;
    if (over)
      violations.push(
        `${r.route} first load is ${r.firstLoadKb.toFixed(1)} kB, budget ${budget} kB`,
      );
    if (r.route in config.routes)
      report.push(
        `${r.route}: ${r.firstLoadKb.toFixed(1)} kB (budget ${budget} kB)${over ? "  OVER" : ""}`,
      );
  }
  const unknownBudgetRoutes = Object.keys(config.routes).filter((r) => !seen.has(r));
  for (const r of unknownBudgetRoutes)
    violations.push(
      `${r} has a budget but is not in the build output (renamed or removed? update scripts/bundle-budget.json)`,
    );
  return { ok: violations.length === 0, violations, report, unknownBudgetRoutes };
}
