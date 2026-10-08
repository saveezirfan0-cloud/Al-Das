/**
 * Importing this module registers every queue handler and scheduled-job route.
 * The jobs API route imports it once per process. Phase 3+ add their handlers here.
 */
import "@/lib/jobs/handlers/notifications";

import { registerKind } from "@/lib/jobs/scheduler";

// Scheduled-job kinds → queues. Kinds use the convention '<domain>.<action>'.
registerKind("notification.*", "notifications");
registerKind("email.send", "notifications");

export {};
