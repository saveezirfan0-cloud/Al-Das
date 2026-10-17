import "server-only";

import { can } from "@/lib/auth/can";
import type { CurrentMember } from "@/lib/auth/session";
import {
  rowFromShares,
  summarizeBilling,
  type BillingRow,
  type BillingSummary,
} from "@/lib/contacts/patient-billing";
import { invoiceShares } from "@/lib/finance/invoice-shares";
import { createClient } from "@/lib/supabase/server";

/**
 * One patient's invoices for Patient 360 (header balance and Billing tab). Reads go through the member's own client:
 * RLS and the finance access window decide, and the caller has checked `finance.invoices.view`. Linked by the Unite PIN
 * only; amounts, dates and ids, no names. The invoice view's rule decides who owes what: an insurance invoice needs the
 * claims permission to be worked out (without it the claims would read as "none" and the split would be wrong), so
 * those invoices are left out of the totals and counted as skipped.
 */

export type PatientBilling = {
  linked: boolean;
  rows: BillingRow[];
  summary: BillingSummary;
  capped: boolean;
};

const LIMIT = 50;

export async function loadPatientBilling(
  member: CurrentMember,
  contactId: string,
): Promise<PatientBilling | null> {
  if (!can(member, "finance.invoices.view")) return null;
  const canClaims = can(member, "finance.claims.view");
  const supabase = await createClient();
  const { data: contact } = await supabase
    .from("contacts")
    .select("id, external_id")
    .eq("org_id", member.orgId)
    .eq("id", contactId)
    .maybeSingle();
  if (!contact) return null;
  const pin = contact.external_id?.trim();
  if (!pin) return { linked: false, rows: [], summary: summarizeBilling([]), capped: false };

  const { data: invoices, error } = await supabase
    .from("fin_invoices")
    .select(
      "id, inv_display_number, transaction_date, inv_type, total, net, write_off, credit_note, is_deleted",
    )
    .eq("org_id", member.orgId)
    .eq("patient_pin", pin)
    .order("transaction_date", { ascending: false })
    .limit(LIMIT);
  if (error) return null;
  const list = invoices ?? [];
  const ids = list.map((i) => i.id);

  const [payments, claims] = await Promise.all([
    ids.length
      ? supabase
          .from("fin_payments")
          .select("invoice_id, paid, refund, is_current")
          .in("invoice_id", ids)
      : Promise.resolve({ data: [] }),
    ids.length && canClaims
      ? supabase
          .from("ins_claim_activities")
          .select("matched_invoice_id, payer_id, net, initial_net, remitted, rejected")
          .eq("match_status", "matched")
          .in("matched_invoice_id", ids)
      : Promise.resolve({ data: [] }),
  ]);

  const rows: BillingRow[] = list.map((inv) => {
    const insurance = /INSUR/i.test(inv.inv_type ?? "");
    const base = {
      id: inv.id,
      number: inv.inv_display_number,
      date: inv.transaction_date,
      void: inv.is_deleted,
      net: inv.net === null ? null : Number(inv.net),
      claimed: null as number | null,
      paid: null as number | null,
    };
    const pays = (payments.data ?? []).filter((p) => p.invoice_id === inv.id);
    base.paid = pays.length
      ? pays
          .filter((p) => p.is_current)
          .reduce((a, p) => a + Number(p.paid ?? 0) - Number(p.refund ?? 0), 0)
      : null;
    if (insurance && !canClaims) return rowFromShares(base, null, null);
    const mine = (claims.data ?? []).filter((c) => c.matched_invoice_id === inv.id);
    base.claimed = insurance
      ? mine.reduce((a, c) => a + Number(c.initial_net ?? c.net ?? 0), 0)
      : null;
    const shares = invoiceShares({
      invType: inv.inv_type,
      total: inv.total,
      writeOff: inv.write_off,
      creditNote: inv.credit_note,
      claims: mine.map((c) => ({
        payerId: c.payer_id,
        amount: c.initial_net ?? c.net,
        remitted: c.remitted,
        rejected: c.rejected,
      })),
      payments: pays.map((p) => ({ paid: p.paid, refund: p.refund, isCurrent: p.is_current })),
    });
    return rowFromShares(
      base,
      shares,
      mine.map((c) => ({
        net: c.initial_net ?? c.net,
        remitted: c.remitted,
        rejected: c.rejected,
      })),
    );
  });

  return { linked: true, rows, summary: summarizeBilling(rows), capped: list.length >= LIMIT };
}
