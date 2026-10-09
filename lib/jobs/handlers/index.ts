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
import "@/lib/jobs/handlers/appointments";
import "@/lib/jobs/handlers/unite-sync";
import "@/lib/jobs/handlers/clinical";
import "@/lib/jobs/handlers/flow-steps";
import "@/lib/jobs/handlers/flow-recurring";
import "@/lib/jobs/handlers/recall-run";
import "@/lib/jobs/handlers/parallel-run";
import "@/lib/recall/listeners";
import "@/lib/flow-engine/listeners";

import { registerKind } from "@/lib/jobs/scheduler";

// Scheduled-job kinds → queues. Kinds use the convention '<domain>.<action>'.
registerKind("notification.*", "notifications");
registerKind("email.send", "notifications");
registerKind("outbound.send", "outbound");
registerKind("media.fetch", "media_fetch");
registerKind("appointment.reminder", "appointments");
registerKind("flow.*", "flow_steps");

export {};
