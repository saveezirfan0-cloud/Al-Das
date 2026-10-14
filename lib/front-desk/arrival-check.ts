/**
 * The check panel shown when a patient is marked Arrived (Phase E, pure).
 *
 * Three questions, each answered only from data the desk member may see, and each FAILS CLOSED: when the feature is off,
 * the member lacks the permission, or the data is missing or unreadable, the answer is "Not checked", never a green tick.
 *
 *  - Insurance card: patient documents, category insurance_card (needs patient documents switched on and documents.view).
 *    Only the expiry date and status are read, never the title.
 *  - Eligibility: the finance eligibility checks (fin_eligibility_checks), read-only, only with finance.eligibility.manage.
 *  - Consent forms: e-signature requests (needs the e-signature integration on, patient documents on and documents.view).
 */
import { daysUntil } from "@/lib/documents/expiry";
import { isEsignStatus } from "@/lib/integrations/esign/state";

export type CheckTone = "ok" | "warn" | "alert" | "unknown";
export type CheckLine = {
  key: "insurance" | "eligibility" | "consent";
  tone: CheckTone;
  label: string;
};

const NOT_CHECKED = (key: CheckLine["key"], why: string): CheckLine => ({
  key,
  tone: "unknown",
  label: `Not checked (${why})`,
});

export type CardDoc = { expires_on: string | null; status: string; scan_status: string };

/**
 * Insurance card on file. `cards` null = could not be read. Only ready, non-infected files count. The card that runs
 * longest decides; a card without an expiry date is "on file, no expiry date" (amber: the desk should look at it).
 */
export function insuranceCheck(input: {
  available: boolean;
  why?: string;
  cards: readonly CardDoc[] | null;
  today: string;
  leadDays: number;
}): CheckLine {
  if (!input.available) return NOT_CHECKED("insurance", input.why ?? "no access");
  if (input.cards === null) return NOT_CHECKED("insurance", "could not read");
  const usable = input.cards.filter((c) => c.status === "ready" && c.scan_status !== "infected");
  if (usable.length === 0)
    return { key: "insurance", tone: "warn", label: "No insurance card on file" };
  const dated = usable
    .map((c) => ({ c, days: daysUntil(c.expires_on, input.today) }))
    .filter((x): x is { c: CardDoc; days: number } => x.days !== null)
    .sort((a, b) => b.days - a.days);
  if (dated.length === 0)
    return { key: "insurance", tone: "warn", label: "Insurance card on file, no expiry date" };
  const best = dated[0];
  if (best.days < 0) return { key: "insurance", tone: "alert", label: "Insurance card expired" };
  if (best.days <= input.leadDays)
    return {
      key: "insurance",
      tone: "warn",
      label:
        best.days === 0
          ? "Insurance card expires today"
          : `Insurance card expires in ${best.days} d`,
    };
  return { key: "insurance", tone: "ok", label: "Insurance card valid" };
}

export type EligibilityRow = { status: string; valid_to: string | null; checked_on: string | null };

/** The newest eligibility check decides. A verified check whose cover has ended counts as expired. */
export function eligibilityCheck(input: {
  available: boolean;
  why?: string;
  checks: readonly EligibilityRow[] | null;
  today: string;
}): CheckLine {
  if (!input.available) return NOT_CHECKED("eligibility", input.why ?? "no access");
  if (input.checks === null) return NOT_CHECKED("eligibility", "could not read");
  const newest = [...input.checks].sort((a, b) =>
    (b.checked_on ?? "").localeCompare(a.checked_on ?? ""),
  )[0];
  if (!newest) return { key: "eligibility", tone: "warn", label: "No eligibility check" };
  switch (newest.status) {
    case "verified": {
      const days = daysUntil(newest.valid_to, input.today);
      if (days === null) return NOT_CHECKED("eligibility", "no cover date");
      if (days < 0) return { key: "eligibility", tone: "alert", label: "Cover ended" };
      return { key: "eligibility", tone: "ok", label: `Cover verified to ${newest.valid_to}` };
    }
    case "pending":
      return { key: "eligibility", tone: "warn", label: "Eligibility pending" };
    case "failed":
      return { key: "eligibility", tone: "alert", label: "Eligibility check failed" };
    case "expired":
      return { key: "eligibility", tone: "alert", label: "Eligibility expired" };
    default:
      return NOT_CHECKED("eligibility", "unknown status");
  }
}

export type EsignRow = { status: string; created_at: string };

/** Consent forms sent for e-signature: any signed one is enough; otherwise the newest request's state. */
export function consentCheck(input: {
  available: boolean;
  why?: string;
  requests: readonly EsignRow[] | null;
}): CheckLine {
  if (!input.available) return NOT_CHECKED("consent", input.why ?? "no access");
  if (input.requests === null) return NOT_CHECKED("consent", "could not read");
  const known = input.requests.filter((r) => isEsignStatus(r.status));
  if (known.length !== input.requests.length) return NOT_CHECKED("consent", "unknown status");
  if (known.some((r) => r.status === "signed"))
    return { key: "consent", tone: "ok", label: "Consent form signed" };
  const newest = [...known].sort((a, b) => b.created_at.localeCompare(a.created_at))[0];
  if (!newest) return { key: "consent", tone: "warn", label: "No consent form sent" };
  if (newest.status === "pending" || newest.status === "creating")
    return { key: "consent", tone: "warn", label: "Consent form waiting for signature" };
  return { key: "consent", tone: "alert", label: "Consent form not signed" };
}

/** Why a section could not be checked, in the desk's words (the first reason that applies). */
export function unavailableReason(flags: {
  featureOn: boolean;
  featureName: string;
  permitted: boolean;
}): string | undefined {
  if (!flags.featureOn) return `${flags.featureName} off`;
  if (!flags.permitted) return "no access";
  return undefined;
}
