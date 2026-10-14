/**
 * The client-safe half of soft delete (docs/35_SOFT_DELETE_NOTES.md): record kinds and the realtime signal. No
 * imports, so browser components (the shell, Tasks, Enquiries) can use it without pulling Zod or the permission
 * catalogue into their bundles. Server rules live in rules.ts, which re-exports this.
 */

export const SOFT_DELETE_ENTITIES = ["contact", "enquiry", "task", "website_entry_point"] as const;
export type SoftDeleteEntity = (typeof SOFT_DELETE_ENTITIES)[number];

export function isSoftDeleteEntity(v: unknown): v is SoftDeleteEntity {
  return typeof v === "string" && (SOFT_DELETE_ENTITIES as readonly string[]).includes(v);
}

/**
 * Realtime after a soft delete (docs/35). Other members' lists listen with postgres_changes, but the UPDATE that hides a
 * row is filtered out for them by RLS, so the server also sends one broadcast on this org channel with ids only, never
 * titles. The channel is PRIVATE (Realtime Authorization): the policy soft_delete_broadcast_receive on realtime.messages
 * lets only active members of the org receive it, and browsers have no policy to send. The shell
 * (components/shell/shell-data.tsx) listens and re-dispatches it as a window event.
 */
export const SOFT_DELETE_CHANNEL_CONFIG = { config: { private: true } } as const;
export const SOFT_DELETE_BROADCAST_EVENT = "deleted";
export const SOFT_DELETE_WINDOW_EVENT = "pulse:soft-deleted";
export function softDeleteChannelName(orgId: string): string {
  return `soft-delete:${orgId}`;
}
export type SoftDeleteSignal = { entity: SoftDeleteEntity; ids: string[] };
/** Parses a broadcast payload (untrusted: anyone on the channel could send one); null when it is not a valid signal. */
export function parseSoftDeleteSignal(payload: unknown): SoftDeleteSignal | null {
  if (!payload || typeof payload !== "object") return null;
  const p = payload as Record<string, unknown>;
  if (!isSoftDeleteEntity(p.entity) || !Array.isArray(p.ids)) return null;
  const ids = p.ids.filter((x): x is string => typeof x === "string" && /^[0-9a-f-]{36}$/i.test(x)).slice(0, 500);
  return ids.length ? { entity: p.entity, ids } : null;
}
