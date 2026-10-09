import { permissionMatches } from "@/lib/auth/permissions";

/** Labels and helpers for the exception rules. Mirrors the owner mapping in app.fin_owner_perm (SQL). */

export type RuleInfo = { title: string; meaning: string; action: string };

export const RULE_INFO: Record<string, RuleInfo> = {
  E01: {
    title: "Insurance invoice with no claim",
    meaning:
      "An insurance invoice is older than the threshold and no claim activity for it has been uploaded from Diligence.",
    action:
      "Check whether the claim was submitted. If it was, make sure the next Diligence upload includes it. If not, submit it.",
  },
  E02: {
    title: "Claim with no matching invoice",
    meaning:
      "A claim activity refers to an invoice number that Unite has not delivered (or that was deleted).",
    action:
      "Check the invoice number on the claim. If the invoice exists in Unite, ask Billing; it may have a different number.",
  },
  E03: {
    title: "Claim and invoice do not agree",
    meaning:
      "The claim amount differs from the invoiced line, or several lines fit and the system cannot tell which.",
    action:
      "Billing: compare the claim and the invoice lines; correct the invoice in Unite or the claim in Diligence.",
  },
  E04: {
    title: "Rejected claim not resubmitted",
    meaning:
      "The payer rejected (part of) the claim and it has not been resubmitted within the threshold.",
    action: "Resubmit with the missing information, or write the amount off and record why.",
  },
  E05: {
    title: "Outstanding balance is old",
    meaning: "Money claimed on this invoice is still unpaid after the threshold.",
    action: "Chase the payer, or record the reason it is still open.",
  },
  E06: {
    title: "Claim missing from the latest file",
    meaning: "The claim was in the previous Diligence upload but is not in the latest one.",
    action: "Check whether the export was filtered or the claim was removed in Diligence.",
  },
  E07: {
    title: "Unknown clinic",
    meaning: "The invoice comes from a clinic name that is not mapped to a branch.",
    action:
      "Finance → Reference data → Branches: enter the clinic name exactly as shown, then Re-derive branches.",
  },
  E08: {
    title: "Appointment not found",
    meaning: "The invoice has an AppointmentId that is not in the synced Unite appointments.",
    action:
      "Usually the appointment sync has not caught up. If it stays open, check the appointment in Unite.",
  },
  E09: {
    title: "Capture problem",
    meaning:
      "A Unite batch failed, a response could not be stored, the count did not match, or invoice numbers are missing in a series.",
    action:
      "Finance → Data health: reprocess failed batches. For lost responses or gaps, ask Unite to re-queue those records.",
  },
  E10: {
    title: "Diligence file failed validation",
    meaning: "An uploaded claims file was rejected.",
    action: "Open Insurance upload, read the reasons, fix the export and upload it again.",
  },
};

export const RULE_CODES = Object.keys(RULE_INFO);

/** Which permission lets a member see exceptions owned by a role. Keep in step with app.fin_owner_perm. */
export function ownerPermission(ownerRole: string): string {
  switch (ownerRole) {
    case "insurance":
      return "finance.claims.view";
    case "billing":
      return "finance.invoices.view";
    case "finance":
      return "finance.view";
    default:
      return "finance.capture.manage";
  }
}

export function holds(permissions: readonly string[], requested: string): boolean {
  return permissions.some((g) => permissionMatches(g, requested));
}

/** Due date (yyyy-mm-dd) strictly before today, and still open. */
export function isOverdue(dueDate: string | null, status: string, today = new Date()): boolean {
  if (!dueDate || (status !== "open" && status !== "in_progress")) return false;
  return dueDate < today.toISOString().slice(0, 10);
}

export const STATUS_LABEL: Record<string, string> = {
  open: "Open",
  in_progress: "In progress",
  closed: "Closed",
  auto_closed: "Cleared",
};
