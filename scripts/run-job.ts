/**
 * Drain a queue through the running app, exactly like pg_cron does.
 *   pnpm jobs:run scheduler
 *   pnpm jobs:run notifications
 * Uses APP_URL and JOB_SECRET from .env.local.
 */
import "dotenv/config";

async function main() {
  const queue = process.argv[2];
  if (!queue) {
    console.error("usage: pnpm jobs:run <queue>");
    process.exit(1);
  }
  const base = (process.env.APP_URL ?? "http://localhost:3000").replace(/\/$/, "");
  const secret = process.env.JOB_SECRET;
  if (!secret) {
    console.error("JOB_SECRET missing");
    process.exit(1);
  }

  const res = await fetch(`${base}/api/jobs/${queue}`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "X-Job-Secret": secret },
    body: JSON.stringify({ source: "cli" }),
  });
  console.log(res.status, await res.text());
}

main().catch((e) => {
  console.error(e instanceof Error ? e.message : e);
  process.exit(1);
});
