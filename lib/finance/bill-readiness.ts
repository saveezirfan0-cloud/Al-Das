import { addDays } from "@/lib/documents/expiry";

/**
 * "Ready to bill" for an insurance invoice that has not been claimed yet (pure). The same rules live in the SQL view
 * `v_fin_billing_readiness` (migration 20261016000200); tests/db/finance-preauth-eligibility.test.ts runs the shared
 * fixture through both so they cannot drift. Dates are calendar dates (YYYY-MM-DD).
 *
 * Fails closed: an invoice with no PIN, no check, a failed or expired check, a covering check with no card on file, or a
 * service that needs a pre-authorisation nobody holds, is NOT ready. Nothing is evaluated (and nothing is flagged)
 * before `readyStartDate`, which is null until finance switches the check on, nor inside `readyGraceDays`.
 */

export type EligibilityStatus = "pending" | "verified" | "failed" | "expired";

export type EligibilityFact = {
  status: EligibilityStatus;
  validFrom: string | null;
  validTo: string | null;
  checkedOn: string | null;
  createdAt: string;
  hasDocument: boolean;
};

export type PreauthFact = {
  status: string;
  validFrom: string | null;
  expiresOn: string | null;
};

export type ReadinessReason =
  | "no_patient_pin"
  | "no_eligibility"
  | "eligibility_pending"
  | "eligibility_failed"
  | "eligibility_expired"
  | "no_card_on_file"
  | "preauth_missing";

export const REASON_LABELS: Record<ReadinessReason, string> = {
  no_patient_pin: "The invoice has no patient PIN, so cover cannot be checked",
  no_eligibility: "No eligibility check recorded",
  eligibility_pending: "The eligibility check is not finished",
  eligibility_failed: "The eligibility check failed",
  eligibility_expired: "Cover had ended before the service date",
  no_card_on_file: "No insurance card on file for this check",
  preauth_missing: "A service needs a pre-authorisation and none covers the date",
};

/** Short labels for badges; REASON_LABELS has the full sentence. */
export const REASON_SHORT: Record<ReadinessReason, string> = {
  no_patient_pin: "No PIN",
  no_eligibility: "No eligibility check",
  eligibility_pending: "Check not finished",
  eligibility_failed: "Check failed",
  eligibility_expired: "Cover had ended",
  no_card_on_file: "No card on file",
  preauth_missing: "Pre-auth missing",
};

export type ReadinessInput = {
  invoiceDate: string;
  patientPin: string | null;
  today: string;
  readyStartDate: string | null;
  readyGraceDays: number;
  checks: readonly EligibilityFact[];
  needsPreauth: boolean;
  preauths: readonly PreauthFact[];
};

export type ReadinessVerdict = { evaluated: boolean; ready: boolean; reasons: ReadinessReason[] };

const COVERING_PREAUTH = new Set(["approved", "partially_approved", "used"]);

const coversDate = (c: Pick<EligibilityFact, "validFrom" | "validTo">, date: string) =>
  (c.validFrom === null || c.validFrom <= date) && c.validTo !== null && c.validTo >= date;

/** Latest first: checked date (nulls last), then creation time. */
function newestFirst(a: EligibilityFact, b: EligibilityFact): number {
  const ac = a.checkedOn ?? "";
  const bc = b.checkedOn ?? "";
  if (ac !== bc) return ac < bc ? 1 : -1;
  return a.createdAt < b.createdAt ? 1 : a.createdAt > b.createdAt ? -1 : 0;
}

export function billReadiness(input: ReadinessInput): ReadinessVerdict {
  const latestEvaluable = addDays(input.today, -input.readyGraceDays);
  if (
    input.readyStartDate === null ||
    input.invoiceDate < input.readyStartDate ||
    latestEvaluable === null ||
    input.invoiceDate > latestEvaluable
  )
    return { evaluated: false, ready: true, reasons: [] };

  const reasons: ReadinessReason[] = [];
  if (input.patientPin === null || input.patientPin === "") reasons.push("no_patient_pin");
  else {
    const covering = input.checks
      .filter((c) => c.status === "verified" && coversDate(c, input.invoiceDate))
      .sort(newestFirst);
    if (covering.length === 0) {
      const latest = [...input.checks].sort(newestFirst)[0];
      if (!latest) reasons.push("no_eligibility");
      else if (latest.status === "pending") reasons.push("eligibility_pending");
      else if (latest.status === "failed") reasons.push("eligibility_failed");
      else reasons.push("eligibility_expired");
    } else if (!covering[0].hasDocument) reasons.push("no_card_on_file");
  }
  if (input.needsPreauth) {
    const held =
      input.patientPin !== null &&
      input.preauths.some(
        (p) =>
          COVERING_PREAUTH.has(p.status) &&
          p.expiresOn !== null &&
          p.expiresOn >= input.invoiceDate &&
          (p.validFrom === null || p.validFrom <= input.invoiceDate),
      );
    if (!held) reasons.push("preauth_missing");
  }
  return { evaluated: true, ready: reasons.length === 0, reasons };
}
