import { registerTask } from "@/lib/jobs/tasks";
import { WhatsAppApiError } from "@/lib/whatsapp/errors";
import { syncTemplatesForChannel } from "@/lib/whatsapp/sync";

/**
 * /api/jobs/templates_sync (pg_cron nightly): mirrors each WABA's templates into wa_templates.
 * One call per WABA (numbers on the same account share their templates). A failing account
 * is logged and skipped so one bad token does not block the others.
 */
registerTask("templates_sync", {
  name: "templates.sync",
  async run(admin, log) {
    const { data: channels } = await admin
      .from("channels")
      .select("id, org_id, phone_number_id, waba_id")
      .eq("status", "active")
      .order("created_at");
    const seen = new Set<string>();
    let synced = 0;
    let failed = 0;
    for (const channel of channels ?? []) {
      const key = `${channel.org_id}:${channel.waba_id}`;
      if (seen.has(key)) continue;
      seen.add(key);
      try {
        const r = await syncTemplatesForChannel(admin, channel);
        synced += r.synced;
      } catch (err) {
        failed++;
        log.warn("template sync failed", {
          wabaId: channel.waba_id,
          error: err instanceof WhatsAppApiError ? err.mapped.message : "unexpected error",
        });
      }
    }
    return { accounts: seen.size, synced, failed };
  },
});
