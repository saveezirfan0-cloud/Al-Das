import { registerTask } from "@/lib/jobs/tasks";
import { redactText } from "@/lib/redact";
import { syncTemplatesForChannel } from "@/lib/whatsapp/sync";

/**
 * /api/jobs/templates_sync (pg_cron nightly): mirror every active channel's templates from Meta.
 * One channel failing (expired token, Meta outage) never stops the others; failures are reported in
 * the job_runs meta, not thrown, so one bad number does not hide the rest.
 */
registerTask("templates_sync", {
  name: "templates.nightly_sync",
  async run(admin, log) {
    const { data: channels } = await admin
      .from("channels")
      .select("id, org_id, phone_number_id, waba_id")
      .eq("status", "active");
    let synced = 0;
    let removed = 0;
    const failures: Array<{ channel: string; error: string }> = [];
    for (const ch of channels ?? []) {
      try {
        const r = await syncTemplatesForChannel(admin, ch);
        synced += r.synced;
        removed += r.removed;
      } catch (err) {
        const error = redactText(err, 200);
        failures.push({ channel: ch.id, error });
        log.warn("template sync failed", { channel: ch.id, error });
      }
    }
    return {
      channels: channels?.length ?? 0,
      synced,
      removed,
      failed: failures.length,
      failures: failures.slice(0, 10),
    };
  },
});
