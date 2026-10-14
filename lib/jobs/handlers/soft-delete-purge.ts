import { registerTask } from "@/lib/jobs/tasks";
import type { Json } from "@/lib/supabase/types";

/**
 * /api/jobs/soft_delete_purge (pg_cron daily, 03:50 UTC): ends the restore window of Settings, Recently deleted
 * (docs/35_SOFT_DELETE_NOTES.md). The work is one SQL function (public.purge_deleted_records): each call takes at most
 * BATCH bin rows past their org's window, makes them permanent (tasks, enquiries and website entry points are deleted,
 * a contact keeps its hidden row and loses its restore copy) and writes one audit row per org with counts only. It is
 * idempotent, so a crash or a timeout simply leaves the rest for the next call. Counts only are logged.
 */
const BATCH = 500;
const MAX_ROUNDS = 10;

type Totals = { orgs: number; contacts: number; enquiries: number; tasks: number; website_entry_points: number };

registerTask("soft_delete_purge", {
  name: "soft_delete.purge",
  async run(admin, log) {
    const totals: Totals = { orgs: 0, contacts: 0, enquiries: 0, tasks: 0, website_entry_points: 0 };
    let rounds = 0;
    let more = true;
    while (more && rounds < MAX_ROUNDS) {
      rounds += 1;
      const { data, error } = await admin.rpc("purge_deleted_records", { p_batch: BATCH });
      if (error) throw new Error(`purge_deleted_records failed (${error.code ?? "unknown"})`);
      const r = (data ?? {}) as Partial<Totals> & { more?: boolean };
      for (const k of Object.keys(totals) as Array<keyof Totals>) totals[k] += Number(r[k] ?? 0);
      more = r.more === true;
    }
    log.info("soft delete purge done", { ...totals, rounds, more });
    return { ...totals, rounds, more } as unknown as Json;
  },
});
