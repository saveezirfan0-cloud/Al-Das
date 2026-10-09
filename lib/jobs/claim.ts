import type { AdminClient } from "@/lib/supabase/admin";

type ClaimTarget =
  | { table: "flows"; column: "last_triggered_at" }
  | { table: "recall_programmes"; column: "last_run_at" };

/**
 * Atomically claim "this minute" for a cron-driven row: succeeds only if the row has not fired in the last
 * `windowSeconds`. pg_cron pings may overlap; exactly one caller wins. Two conditional UPDATEs (NULL, then stale)
 * instead of one `or=` filter, which PostgREST rejects on UPDATE.
 */
export async function claimCronSlot(
  admin: AdminClient,
  target: ClaimTarget,
  id: string,
  now: Date,
  windowSeconds = 55,
): Promise<boolean> {
  const stamp = now.toISOString();
  const cutoff = new Date(now.getTime() - windowSeconds * 1000).toISOString();
  const base = () =>
    admin
      .from(target.table)
      .update({ [target.column]: stamp } as never)
      .eq("id", id);
  const first = await base().is(target.column, null).select("id");
  if (first.data?.length) return true;
  const second = await base().lt(target.column, cutoff).select("id");
  return Boolean(second.data?.length);
}
