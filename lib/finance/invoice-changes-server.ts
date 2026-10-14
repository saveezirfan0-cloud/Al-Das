import "server-only";

import { parseChanges, type ChangeRegister } from "@/lib/finance/invoice-changes";
import type { AdminClient } from "@/lib/supabase/admin";

/**
 * The invoice-change register for one org and period (fin_invoice_changes, service role only). Callers check
 * finance.changes.view or finance.changes.review with can() BEFORE creating the service-role client, and validate the
 * period with periodProblem(). Throws on a database error so a failed read is never shown as "no changes".
 */
export async function loadChanges(
  admin: AdminClient,
  orgId: string,
  from: string,
  to: string,
): Promise<ChangeRegister> {
  const { data, error } = await admin.rpc("fin_invoice_changes", {
    p_org_id: orgId,
    p_from: from,
    p_to: to,
  });
  if (error) throw new Error("the invoice-change register could not be read");
  return parseChanges(data);
}
