import "server-only";

import type { AdminClient } from "@/lib/supabase/admin";

/**
 * Portal tables are chosen at runtime from the registry, and the portal RPCs are not in the
 * generated Database type until `pnpm gen:types` runs against a migrated database. This is the
 * one place that opts out of the typed client; table names it receives always come from
 * lib/portal/objects (code), never from user input.
 */
export type LooseError = { message: string; code?: string } | null;
export type LooseResult<T = unknown> = { data: T; error: LooseError };

/* eslint-disable @typescript-eslint/no-explicit-any */
export type LooseClient = {
  from(table: string): any;
  rpc(fn: string, args: Record<string, unknown>): PromiseLike<LooseResult<any>>;
  storage: any;
};
/* eslint-enable @typescript-eslint/no-explicit-any */

export function loose(admin: AdminClient): LooseClient {
  return admin as unknown as LooseClient;
}
