"use server";

import { revalidatePath } from "next/cache";

import { recordAudit } from "@/lib/audit";
import { can } from "@/lib/auth/can";
import { requireMember } from "@/lib/auth/session";
import { DENIED, fail, type ActionResult } from "@/lib/finance/action-support";
import { buildTallyXml, LEDGER_KIND_LABEL, type TallyMissing } from "@/lib/finance/tally-xml";
import { voucherErrorMessage } from "@/lib/finance/vouchers";
import { loadPayablesSettings, loadTallyCandidates } from "@/lib/finance/vouchers-server";
import { recordExport } from "@/lib/security/access-log";
import { createAdminClient } from "@/lib/supabase/admin";

/**
 * Builds the next TallyPrime import file from approved (or paid, or sent-to-Tally) vouchers and supplier invoices that
 * have not been exported, records it (checksum, counts, the XML itself) and marks the items exported in one transaction
 * (fin_tally_record_export). Refuses while any ledger is unmapped. One-way: nothing is read back from Tally. Needs
 * finance.tally.export; audited and written to the access log as an export.
 */

async function gate() {
  const member = await requireMember();
  return can(member, "finance.tally.export") ? member : null;
}

export async function createTallyExport(): Promise<
  ActionResult<{ exportId: string | null; missing: TallyMissing[] }>
> {
  const member = await gate();
  if (!member) return fail(DENIED);
  const admin = createAdminClient(member.userId); // service role AFTER the permission check
  const [cand, settings] = await Promise.all([
    loadTallyCandidates(admin, member.orgId),
    loadPayablesSettings(admin, member.orgId),
  ]);
  if (cand.payments.length === 0 && cand.purchases.length === 0)
    return fail(
      "Nothing new to export: no approved vouchers or supplier invoices since the last file.",
    );
  const built = buildTallyXml({
    company: settings.tallyCompany,
    costCategory: settings.tallyCostCategory,
    ledgers: cand.ledgers,
    purchases: cand.purchases,
    payments: cand.payments,
    supplierNames: cand.supplierNames,
  });
  if (!built.ok)
    return {
      ok: false,
      error: `Map these to Tally ledgers first (Voucher settings, Tally ledgers): ${built.missing
        .slice(0, 8)
        .map((m) => `${LEDGER_KIND_LABEL[m.kind]} "${m.label}"`)
        .join(", ")}${built.missing.length > 8 ? ` and ${built.missing.length - 8} more` : ""}.`,
    };
  const { data, error } = await admin.rpc("fin_tally_record_export", {
    p_org_id: member.orgId,
    p_user_id: member.userId,
    p_voucher_ids: cand.payments.map((p) => p.id),
    p_invoice_ids: cand.purchases.map((p) => p.id),
    p_checksum: built.checksum,
    p_xml: built.xml,
    p_total: built.total,
  });
  if (error || !data)
    return fail(voucherErrorMessage(error?.hint, "The export could not be recorded."));
  const exportId = data as string;
  await recordAudit(admin, {
    orgId: member.orgId,
    userId: member.userId,
    action: "finance.tally.exported",
    entity: "fin_tally_exports",
    entityId: exportId,
    diff: {
      vouchers: built.paymentCount,
      invoices: built.purchaseCount,
      total: built.total,
      checksum: built.checksum,
    },
  });
  await recordExport(admin, member, {
    dataset: "finance:tally-xml",
    rows: built.paymentCount + built.purchaseCount,
    format: "xml",
  });
  revalidatePath("/finance/tally");
  revalidatePath("/finance/vouchers");
  return {
    ok: true,
    data: { exportId, missing: [] },
    message: `Export ready: ${built.paymentCount} payment(s) and ${built.purchaseCount} purchase(s). Download it below.`,
  };
}
