import "server-only";

import type { AdminClient } from "@/lib/supabase/admin";

/**
 * Read helpers for the recall pages and actions. They live here, not in a "use server" actions file, because
 * every export of a "use server" module is callable from the browser.
 */

/** The patient-facing clinical gate (signed-off 'true' only; unsigned defaults never open it). Fails closed. */
export async function clinicalMessagingEnabled(
  admin: AdminClient,
  orgId: string,
): Promise<boolean> {
  const { data, error } = await admin.rpc("recall_clinical_messaging_enabled", { p_org: orgId });
  return !error && data === true;
}

/** A clinical setting's usable value: signed-off, else null (see public.clinical_setting). */
export async function settingValue(
  admin: AdminClient,
  orgId: string,
  key: string,
): Promise<string | null> {
  const { data } = await admin.rpc("clinical_setting", { p_org: orgId, p_key: key });
  return (data as string | null) ?? null;
}
