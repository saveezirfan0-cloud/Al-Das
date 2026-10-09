import "server-only";

import { on } from "@/lib/events/emit";
import { isFlowEvent } from "@/lib/flow-engine/triggers";
import { enqueue } from "@/lib/jobs/enqueue";

/**
 * Domain events → `flow_steps` trigger jobs. The listener only enqueues (listeners run inline in the
 * webhook handler / server actions and must stay short); matching and starting happen in the job.
 * Import this module (side effect) wherever events are emitted from a process other than the jobs route.
 */
let registered = false;

export function registerFlowListeners(): void {
  if (registered) return;
  registered = true;
  on("*", async (event) => {
    if (!isFlowEvent(event.name)) return;
    await enqueue("flow_steps", {
      type: "trigger",
      org_id: event.orgId,
      event: event.name,
      payload: event.payload as never,
    });
  });
}

registerFlowListeners();
