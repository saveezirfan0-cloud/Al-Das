/**
 * pnpm bundle:check [build.log]   (or pipe the build:  pnpm build 2>&1 | tee build.log; pnpm bundle:check build.log)
 *
 * Reads the route table `next build` prints, compares every route's "First Load JS" with
 * scripts/bundle-budget.json and exits 1 when any route (or the shared bundle) is over budget. CI runs this
 * after the production build, so a dependency that quietly adds 50 kB to the inbox fails the pull request.
 * Update the budget file in the same commit when a size increase is intended.
 */
import { readFileSync } from "node:fs";

import { checkBudgets, parseBuildOutput, type BudgetConfig } from "../lib/build/bundle-budget";

const config = JSON.parse(
  readFileSync(new URL("./bundle-budget.json", import.meta.url), "utf8"),
) as BudgetConfig & { _comment?: string };
const source = process.argv[2] ? readFileSync(process.argv[2], "utf8") : readFileSync(0, "utf8");

const result = checkBudgets(parseBuildOutput(source), config);
for (const line of result.report) console.log(line);
if (!result.ok) {
  console.error("\nBundle budget exceeded:");
  for (const v of result.violations) console.error(`  - ${v}`);
  process.exit(1);
}
console.log("\nBundle budgets OK.");
