import type { CrmPort } from "@/lib/flow-engine/deps";

/**
 * Phases 5–7 (enquiries, tasks, portal, appointments) register their adapters here at import time:
 *   registerCrmAdapter({ createEnquiry: async (run, input) => ({ id }) })
 * Until then the matching flow nodes fail closed with "not available yet".
 */
const adapter: CrmPort = {};

export function registerCrmAdapter(partial: CrmPort): void {
  Object.assign(adapter, partial);
}

export function crmPort(): CrmPort {
  return adapter;
}

export function clearCrmAdapters(): void {
  for (const k of Object.keys(adapter)) delete (adapter as Record<string, unknown>)[k];
}
