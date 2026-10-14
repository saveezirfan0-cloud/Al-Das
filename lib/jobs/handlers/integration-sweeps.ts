import { sweepCapi } from "@/lib/integrations/capi/server";
import { sweepGcal } from "@/lib/integrations/gcal/server";
import { sweepReviewRequests } from "@/lib/integrations/reviews/server";
import { registerTask } from "@/lib/jobs/tasks";

/**
 * Phase 19b maintenance tasks, each pinged by its own pg_cron schedule (see the 19b migrations). Every one is a no-op for a
 * workspace whose integration is switched off.
 */

// Google review requests: completed visits whose hook was missed (the Unite sync, another process). Never looks back more than a
// day and never before the integration was switched on.
registerTask("review_requests_sweep", {
  name: "reviews.sweep",
  async run(admin, log) {
    const r = await sweepReviewRequests(admin);
    log.info("review requests sweep", r);
    return r;
  },
});

// Meta Conversions API: Lead (enquiries) and Schedule (bookings) for patients who came from an ad, and any Contact event that was never
// queued. Only things created after the integration was switched on, in the last 48 hours.
registerTask("capi_sweep", {
  name: "capi.sweep",
  async run(admin, log) {
    const r = await sweepCapi(admin);
    log.info("capi sweep", r);
    return r;
  },
});

// Phase 20e: Google Calendar busy sync per connected specialist (busy times in, "Busy" events out). A workspace whose integration is
// off makes no Google call and has its mirrored busy times removed.
registerTask("gcal_sync", {
  name: "gcal.sync",
  async run(admin, log) {
    const r = await sweepGcal(admin);
    log.info("google calendar sync", r);
    return r;
  },
});
