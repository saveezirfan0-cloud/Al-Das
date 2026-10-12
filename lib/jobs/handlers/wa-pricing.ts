import { registerTask } from "@/lib/jobs/tasks";
import { clientForChannel } from "@/lib/whatsapp/channel";
import { WhatsAppApiError } from "@/lib/whatsapp/errors";
import { mergePoints, parsePricingAnalytics, PricingShapeError } from "@/lib/whatsapp/pricing";

/** Days re-read on every run: Meta adjusts recent usage, so the tail is re-synced and upserted. */
export const PRICING_WINDOW_DAYS = 8;

/**
 * /api/jobs/wa_pricing_sync (pg_cron nightly): pulls pricing analytics once per WABA and upserts them into
 * wa_pricing_daily. Idempotent (upsert on the bucket key). One failing account is logged and skipped. The
 * response is parsed fail-closed (lib/whatsapp/pricing.ts): an unexpected shape stores nothing.
 */
registerTask("wa_pricing_sync", {
  name: "whatsapp.pricing_sync",
  async run(admin, log) {
    const { data: channels } = await admin
      .from("channels")
      .select("id, org_id, phone_number_id, waba_id")
      .eq("status", "active")
      .order("created_at");

    const endDay = new Date();
    endDay.setUTCHours(0, 0, 0, 0);
    const endSec = Math.floor(endDay.getTime() / 1000) + 86_400; // include today's partial bucket
    const startSec = endSec - (PRICING_WINDOW_DAYS + 1) * 86_400;

    const seen = new Set<string>();
    let rows = 0;
    let failed = 0;
    for (const channel of channels ?? []) {
      const key = `${channel.org_id}:${channel.waba_id}`;
      if (seen.has(key)) continue;
      seen.add(key);
      try {
        const client = await clientForChannel(admin, channel);
        const parsed = parsePricingAnalytics(await client.getPricingAnalytics(channel.waba_id, startSec, endSec));
        const points = mergePoints(parsed.points);
        if (points.length === 0) continue;
        const { error } = await admin.from("wa_pricing_daily").upsert(
          points.map((p) => ({
            org_id: channel.org_id,
            waba_id: channel.waba_id,
            day: p.day,
            category: p.category,
            pricing_type: p.pricingType,
            country: p.country,
            volume: p.volume,
            cost: p.cost,
            currency: parsed.currency,
            synced_at: new Date().toISOString(),
          })),
          { onConflict: "org_id,waba_id,day,category,pricing_type,country" },
        );
        if (error) throw new Error(`upsert failed (${error.code})`);
        rows += points.length;
      } catch (err) {
        failed++;
        log.warn("pricing sync failed", {
          wabaId: channel.waba_id,
          error:
            err instanceof WhatsAppApiError
              ? err.mapped.message
              : err instanceof PricingShapeError
                ? err.message
                : "unexpected error",
        });
      }
    }
    return { accounts: seen.size, rows, failed };
  },
});
