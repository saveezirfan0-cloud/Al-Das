import "server-only";

import { fetchAll } from "@/lib/supabase/fetch-all";
import type { AdminClient } from "@/lib/supabase/admin";
import { invoiceShares, type InvoiceShares } from "@/lib/finance/invoice-shares";

/**
 * Server reads for one Unite invoice (Phase G): its ledger posting status and the data of the internal PDF. Service
 * role; callers have run can() (finance.invoices.view, plus an accounting read key for the posting status and
 * finance.claims.view for the claims). Finance tables carry the Unite PIN only, never a name.
 */

export type PostingStatusView = {
  state: "posted" | "waiting" | "preview" | "nothing" | "withdrawn" | "not_seen";
  reason: string | null;
  detail: string | null;
  journal: { id: string; number: string | null; status: string; journal_date: string } | null;
};

export async function loadPostingStatus(
  admin: AdminClient,
  orgId: string,
  invoiceNumber: string,
): Promise<PostingStatusView> {
  const { data: st } = await admin
    .from("acc_posting_status")
    .select("state, reason, detail, journal_id")
    .eq("org_id", orgId)
    .eq("source_kind", "unite_invoice")
    .eq("source_id", invoiceNumber)
    .maybeSingle();
  if (!st) return { state: "not_seen", reason: null, detail: null, journal: null };
  const { data: j } = st.journal_id
    ? await admin
        .from("acc_journals")
        .select("id, number, status, journal_date")
        .eq("org_id", orgId)
        .eq("id", st.journal_id)
        .maybeSingle()
    : { data: null };
  return {
    state: st.state as PostingStatusView["state"],
    reason: st.reason,
    detail: st.detail,
    journal: j ?? null,
  };
}

export type InvoicePdfData = {
  number: string;
  date: string | null;
  invType: string | null;
  branch: string | null;
  department: string | null;
  doctor: string | null;
  patientPin: string | null;
  version: number;
  deleted: boolean;
  amounts: Array<[string, number | null]>;
  lines: Array<{
    position: number | null;
    code: string | null;
    description: string | null;
    cpt: string | null;
    qty: number | null;
    net: number | null;
    removed: boolean;
  }>;
  payments: Array<{
    date: string | null;
    mode: string | null;
    receipt: string | null;
    paid: number | null;
    refund: number | null;
  }>;
  /** null when the reader may not see the claims of an insurance invoice. */
  shares: InvoiceShares | null;
  payerNames: Map<string, string>;
};

export async function loadInvoicePdfData(
  admin: AdminClient,
  orgId: string,
  id: string,
  opts: { claims: boolean },
): Promise<InvoicePdfData | null> {
  const { data: inv } = await admin
    .from("fin_invoices")
    .select(
      "id, inv_display_number, transaction_date, inv_type, branch_code, department, doctor_name, doctor_dha_id, patient_pin, version, is_deleted, gross, discount, net, vat, total, write_off, credit_note",
    )
    .eq("org_id", orgId)
    .eq("id", id)
    .maybeSingle();
  if (!inv) return null;
  const isInsurance = /INSUR/i.test(inv.inv_type ?? "");
  const [lines, payments, claims] = await Promise.all([
    fetchAll((from, to) =>
      admin
        .from("fin_invoice_lines")
        .select("id, position, item_code, item_short_desc, cpt_code, qty, line_net, is_current")
        .eq("org_id", orgId)
        .eq("invoice_id", id)
        .order("position")
        .order("id")
        .range(from, to),
    ),
    fetchAll((from, to) =>
      admin
        .from("fin_payments")
        .select("id, paid_date, payment_mode, receipt_number, paid, refund, is_current")
        .eq("org_id", orgId)
        .eq("invoice_id", id)
        .order("paid_date")
        .order("id")
        .range(from, to),
    ),
    opts.claims
      ? fetchAll((from, to) =>
          admin
            .from("ins_claim_activities")
            .select("id, payer_id, net, initial_net, remitted, rejected")
            .eq("org_id", orgId)
            .eq("matched_invoice_id", id)
            .eq("match_status", "matched")
            .order("id")
            .range(from, to),
        )
      : Promise.resolve({ data: [], error: null, truncated: false }),
  ]);
  if (lines.error || payments.error || claims.error) throw new Error("invoice read failed");
  const shares =
    opts.claims || !isInsurance
      ? invoiceShares({
          invType: inv.inv_type,
          total: inv.total,
          writeOff: inv.write_off,
          creditNote: inv.credit_note,
          claims: claims.data.map((c) => ({
            payerId: c.payer_id,
            amount: c.initial_net ?? c.net,
            remitted: c.remitted,
            rejected: c.rejected,
          })),
          payments: payments.data.map((p) => ({
            paid: p.paid,
            refund: p.refund,
            isCurrent: p.is_current,
          })),
        })
      : null;
  const payerIds = [...new Set(claims.data.map((c) => c.payer_id).filter((x): x is string => !!x))];
  const { data: refs } = payerIds.length
    ? await admin
        .from("fin_ref_payers")
        .select("payer_id, payer_name")
        .eq("org_id", orgId)
        .in("payer_id", payerIds)
    : { data: [] };
  return {
    number: inv.inv_display_number,
    date: inv.transaction_date,
    invType: inv.inv_type,
    branch: inv.branch_code,
    department: inv.department,
    doctor: inv.doctor_name ?? inv.doctor_dha_id,
    patientPin: inv.patient_pin,
    version: inv.version,
    deleted: inv.is_deleted,
    amounts: [
      ["Gross", inv.gross],
      ["Discount", inv.discount],
      ["Net", inv.net],
      ["VAT", inv.vat],
      ["Total", inv.total],
      ["Write-off", inv.write_off],
      ["Credit note", inv.credit_note],
    ],
    lines: lines.data.map((l) => ({
      position: l.position,
      code: l.item_code,
      description: l.item_short_desc,
      cpt: l.cpt_code,
      qty: l.qty,
      net: l.line_net,
      removed: !l.is_current,
    })),
    payments: payments.data
      .filter((p) => p.is_current)
      .map((p) => ({
        date: p.paid_date,
        mode: p.payment_mode,
        receipt: p.receipt_number,
        paid: p.paid,
        refund: p.refund,
      })),
    shares,
    payerNames: new Map((refs ?? []).map((r) => [r.payer_id, r.payer_name ?? r.payer_id])),
  };
}
