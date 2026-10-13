import "server-only";

import {
  loadArSettings,
  loadSalesOptions,
  type SalesDetail,
} from "@/lib/accounting/receivables-server";
import type { AdminClient } from "@/lib/supabase/admin";

import type { SalesFormLine, SalesFormOptions } from "./sales-form";

/** Everything the sales form offers, as plain props for the client component. */
export async function salesFormOptions(admin: AdminClient, orgId: string): Promise<SalesFormOptions> {
  const [o, s] = await Promise.all([loadSalesOptions(admin, orgId), loadArSettings(admin, orgId)]);
  return {
    customers: o.customers.map((c) => ({ id: c.id, name: c.name, trn: c.trn, terms: c.terms })),
    incomeAccounts: o.incomeAccounts,
    taxCodes: o.taxCodes,
    branches: o.branches,
    costCentres: o.costCentres,
    today: new Date().toISOString().slice(0, 10),
    simplifiedLimit: s.simplified_invoice_limit,
    approvalThreshold: s.issue_approval_threshold,
    creditNoteDays: s.credit_note_days,
  };
}

/** A stored document's lines as form lines (edit a draft, or start a credit note from its invoice). */
export function formLines(d: SalesDetail): SalesFormLine[] {
  return d.lines.map((l) => ({
    description: l.description,
    quantity: String(l.quantity),
    unit_price: l.unit_price.toFixed(2),
    discount: l.discount ? l.discount.toFixed(2) : "",
    income_account_id: l.income_account_id,
    tax_code_id: l.tax_code_id,
    branch_code: l.branch_code ?? "",
    department: l.department ?? "",
    cost_centre_id: l.cost_centre_id ?? "",
  }));
}
