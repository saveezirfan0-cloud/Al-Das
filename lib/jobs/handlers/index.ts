/**
 * Importing this module registers every queue handler, maintenance task and
 * scheduled-job route. The jobs API route imports it once per process.
 */
import "@/lib/jobs/handlers/notifications";
import "@/lib/jobs/handlers/finance-capture";
import "@/lib/jobs/handlers/meta-events";
import "@/lib/jobs/handlers/media-fetch";
import "@/lib/jobs/handlers/outbound";
import "@/lib/jobs/handlers/sms-outbound";
import "@/lib/jobs/handlers/capi-events";
import "@/lib/jobs/handlers/integration-sweeps";
import "@/lib/jobs/handlers/inbox-housekeeping";
import "@/lib/jobs/handlers/campaign-fanout";
import "@/lib/jobs/handlers/campaign-tick";
import "@/lib/jobs/handlers/templates-sync";
import "@/lib/jobs/handlers/wa-pricing";
import "@/lib/jobs/handlers/kb-ingest";
import "@/lib/jobs/handlers/ai-insights";
import "@/lib/jobs/handlers/ai-quality-weekly";
import "@/lib/jobs/handlers/metrics-refresh";
import "@/lib/jobs/handlers/security-maintenance";
import "@/lib/jobs/handlers/documents-maintenance";
import "@/lib/jobs/handlers/finance-workflows";
import "@/lib/jobs/handlers/notification-digests";
import "@/lib/jobs/handlers/webhooks-out";
import "@/lib/jobs/handlers/appointments";
import "@/lib/jobs/handlers/unite-sync";
import "@/lib/jobs/handlers/clinical";
import "@/lib/jobs/handlers/flow-steps";
import "@/lib/jobs/handlers/flow-recurring";
import "@/lib/jobs/handlers/recall-run";
import "@/lib/jobs/handlers/parallel-run";
import "@/lib/jobs/handlers/accounting-post";
import "@/lib/recall/listeners";
import "@/lib/flow-engine/listeners";

import { registerKind } from "@/lib/jobs/scheduler";

// Scheduled-job kinds → queues. Kinds use the convention '<domain>.<action>'.
registerKind("notification.*", "notifications");
registerKind("email.send", "notifications");
registerKind("outbound.send", "outbound");
registerKind("media.fetch", "media_fetch");
registerKind("task.due", "notifications");
registerKind("enquiry.sla", "notifications");
registerKind("inbox.escalate", "notifications");
registerKind("campaign.*", "campaign_fanout");
registerKind("webhook.retry", "webhooks_out");
registerKind("appointment.reminder", "appointments");
registerKind("waitlist.*", "appointments");
registerKind("review.*", "appointments");
registerKind("telehealth.*", "appointments");
registerKind("flow.*", "flow_steps");
registerKind("clinical.*", "clinical");

export {};
