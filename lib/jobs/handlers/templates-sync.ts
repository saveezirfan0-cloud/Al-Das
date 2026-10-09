import { registerTask } from "@/lib/jobs/tasks";
import { WhatsAppApiError } from "@/lib/whatsapp/errors";
import { channelsToSync, syncTemplatesForChannel } from "@/lib/whatsapp/sync";

/**
 * /api/jobs/templates_sync (pg_cron nightly): mirrors every WABA's templates into
 * wa_templates. One sync per (org, WABA); one failing WABA never stops the others.
 * Logs counts and ids only, never template text.
 */
registerTask("templates_sync", {
  name: "templates.sync",
  async run(admin, log) {
    const { data: channels, error } = await admin
      .from("channels")
      .select("id, org_id, phone_number_id, waba_id, status, created_at");
    if (error) throw new Error(`templates_sync: ${error.message}`);

    const totals = { wabas: 0, synced: 0, removed: 0, revived: 0, failed: 0 };
    for (const channel of channelsToSync(channels ?? [])) {
      totals.wabas++;
      try {
        const r = await syncTemplatesForChannel(admin, channel);
        totals.synced += r.synced;
        totals.removed += r.removed;
        totals.revived += r.revived;
      } catch (err) {
        totals.failed++;
        log.error("template sync failed", {
          channel_id: channel.id,
          waba_id: channel.waba_id,
          error:
            err instanceof WhatsAppApiError
              ? err.mapped.message
              : err instanceof Error
                ? err.message
                : "unknown",
        });
      }
    }
    log.info("templates sync done", totals);
    return totals;
  },
});
