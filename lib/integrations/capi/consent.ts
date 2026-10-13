/**
 * May an ad-attributed patient's event be sent to Meta? (pure)
 *
 * Default basis `contact_opt_in`: only when the person opted in to marketing messages and has not stopped them.
 * Basis `admin_declared`: an administrator typed the confirmation that the clinic has another lawful basis for ad measurement
 * (recorded with who and when). An explicit stop, an erased, deleted or merged record is honoured under either basis.
 */
export const CONSENT_BASES = ["contact_opt_in", "admin_declared"] as const;
export type ConsentBasis = (typeof CONSENT_BASES)[number];

export function isConsentBasis(v: unknown): v is ConsentBasis {
  return typeof v === "string" && (CONSENT_BASES as readonly string[]).includes(v);
}

/** Typed in full to move from contact opt-in to the administrator's own declaration. */
export const CONSENT_BASIS_PHRASE = "I CONFIRM AD MEASUREMENT BASIS";

export type CapiPerson = {
  promotions_opt_in?: boolean | null;
  stop_marketing?: boolean | null;
  deleted_at?: string | null;
  erased_at?: string | null;
  merged_into_id?: string | null;
};

export type ConsentResult =
  { ok: true } | { ok: false; reason: "no_consent" | "stopped" | "unavailable" };

export function capiConsent(basis: ConsentBasis, p: CapiPerson | null): ConsentResult {
  if (!p || p.deleted_at || p.erased_at || p.merged_into_id)
    return { ok: false, reason: "unavailable" };
  if (p.stop_marketing) return { ok: false, reason: "stopped" };
  if (basis === "contact_opt_in" && p.promotions_opt_in !== true)
    return { ok: false, reason: "no_consent" };
  return { ok: true };
}

/** Is the event inside the attribution window that follows the click? */
export function withinAttributionWindow(
  clickedAt: Date,
  eventAt: Date,
  windowDays: number,
): boolean {
  const d = eventAt.getTime() - clickedAt.getTime();
  return d >= 0 && d < windowDays * 86_400_000;
}
