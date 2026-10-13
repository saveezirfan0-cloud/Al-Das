/**
 * Pure helpers for the History tab (record_history). The table list here is the contract between the
 * database triggers (migration 20261011000200) and the UI; tests/db checks the two agree.
 */

export const HISTORY_TABLES = {
  appointments: "Appointment",
  enquiries: "Enquiry",
  tasks: "Task",
  wa_templates: "Template",
  flows: "Flow",
  ref_diagnoses: "Diagnosis",
  ref_condition_groups: "Condition group",
  ref_medications: "Medication",
  ref_items: "Item",
  ref_medication_classes: "Medication class",
  website_entry_points: "Website entry point",
  fin_pre_authorisations: "Pre-authorisation",
  fin_eligibility_checks: "Eligibility check",
  ins_denial_cases: "Denial case",
  fin_period_closes: "Month-end close",
  acc_accounts: "Account",
  acc_journals: "Journal",
  acc_sales_invoices: "Sales invoice",
  acc_receipts: "Receipt",
  acc_bank_transfers: "Bank transfer",
  acc_bank_entries: "Bank entry",
  acc_cheques: "Cheque",
  acc_assets: "Fixed asset",
} as const;

export type HistoryTable = keyof typeof HISTORY_TABLES;

export function isHistoryTable(value: string): value is HistoryTable {
  return Object.prototype.hasOwnProperty.call(HISTORY_TABLES, value);
}

/** The permission needed to read a table's history (mirrors app.can_view_record_history). */
/** Portal tables are not listed: their read key comes from the portal registry (portal_objects.read_perm). */
export const HISTORY_PERMISSION: Partial<Record<HistoryTable, string>> = {
  appointments: "appointments.view",
  enquiries: "enquiries.view",
  tasks: "tasks.view",
  wa_templates: "templates.manage",
  flows: "flows.manage",
  fin_pre_authorisations: "finance.preauth.manage",
  fin_eligibility_checks: "finance.eligibility.manage",
  ins_denial_cases: "finance.denials.manage",
  fin_period_closes: "finance.close.view",
  acc_accounts: "accounting.view",
  acc_journals: "accounting.ledger.view",
  acc_sales_invoices: "accounting.sales.manage",
  acc_receipts: "accounting.receipts.manage",
  acc_bank_transfers: "accounting.banking.manage",
  acc_bank_entries: "accounting.banking.manage",
  acc_cheques: "accounting.banking.manage",
  acc_assets: "accounting.view",
};

export type HistoryChange = { field: string; label: string; from: string; to: string };

export type HistoryEntry = {
  id: number;
  op: "insert" | "update" | "delete";
  at: string;
  actorId: string | null;
  changes: HistoryChange[];
};

/** "starts_at" → "Starts at"; "sla_due_at" → "Sla due at". */
export function fieldLabel(field: string): string {
  const text = field.replace(/_id$/, "").replace(/_/g, " ").trim();
  return text ? text.charAt(0).toUpperCase() + text.slice(1) : field;
}

/** One value as short text for the UI. */
export function formatHistoryValue(value: unknown): string {
  if (value === null || value === undefined) return "empty";
  if (typeof value === "boolean") return value ? "yes" : "no";
  if (typeof value === "string") return value === "" ? "empty" : value;
  if (typeof value === "number") return String(value);
  if (typeof value === "object" && (value as { changed?: unknown }).changed === true)
    return "(changed)";
  try {
    const text = JSON.stringify(value);
    return text.length > 120 ? `${text.slice(0, 119)}…` : text;
  } catch {
    return "(unreadable)";
  }
}

/** Turns the stored {"field": {"from": …, "to": …}} object into rows, ignoring anything malformed. */
export function parseChanges(raw: unknown): HistoryChange[] {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return [];
  return Object.entries(raw as Record<string, unknown>)
    .filter(
      ([, v]) => v && typeof v === "object" && !Array.isArray(v) && ("from" in v || "to" in v),
    )
    .map(([field, v]) => {
      const pair = v as { from?: unknown; to?: unknown };
      return {
        field,
        label: fieldLabel(field),
        from: formatHistoryValue(pair.from),
        to: formatHistoryValue(pair.to),
      };
    })
    .sort((a, b) => a.label.localeCompare(b.label));
}

export function describeOp(op: HistoryEntry["op"]): string {
  return op === "insert" ? "Created" : op === "delete" ? "Deleted" : "Changed";
}
