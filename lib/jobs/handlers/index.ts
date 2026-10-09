/**
 * Importing this module registers every queue handler, maintenance task and
 * scheduled-job route. The jobs API route imports it once per process.
 */
import "@/lib/jobs/handlers/notifications";
import "@/lib/jobs/handlers/finance-capture";
import "@/lib/jobs/handlers/meta-events";
import "@/lib/jobs/handlers/media-fetch";
import "@/lib/jobs/handlers/outbound";
import "@/lib/jobs/handlers/inbox-housekeeping";
import "@/lib/jobs/handlers/campaign-fanout";
import "@/lib/jobs/handlers/campaign-tick";
import "@/lib/jobs/handlers/appointments";
import "@/lib/jobs/handlers/unite-sync";
import "@/lib/jobs/handlers/clinical";

import { registerKind } from "@/lib/jobs/scheduler";

// Scheduled-job kinds → queues. Kinds use the convention '<domain>.<action>'.
registerKind("notification.*", "notifications");
registerKind("email.send", "notifications");
registerKind("outbound.send", "outbound");
registerKind("media.fetch", "media_fetch");
registerKind("campaign.*", "campaign_fanout");
registerKind("appointment.reminder", "appointments");

export {};
