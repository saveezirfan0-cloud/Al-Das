import type { QueueName } from "@/lib/jobs/queues";
import type { QueueHandlerDef } from "@/lib/jobs/types";
import type { Json } from "@/lib/supabase/types";

const registry = new Map<QueueName, QueueHandlerDef<Json>>();

/** Register the handler for a queue. One handler per queue; re-registering replaces it. */
export function registerHandler<P extends Json>(def: QueueHandlerDef<P>): void {
  registry.set(def.queue, def as unknown as QueueHandlerDef<Json>);
}

export function getHandler(queue: QueueName): QueueHandlerDef<Json> | undefined {
  return registry.get(queue);
}

export function listHandlers(): QueueHandlerDef<Json>[] {
  return [...registry.values()];
}

/** Test helper. */
export function clearHandlers(): void {
  registry.clear();
}
