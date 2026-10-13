import { createHash } from "node:crypto";

/** Signer details (pure). The e-mail goes to the provider and is not stored: only a masked hint is kept for the staff list. */
export function normalizeSignerEmail(raw: unknown): string | null {
  const v = typeof raw === "string" ? raw.trim() : "";
  if (v.length > 200 || /[\s,;<>()]/.test(v)) return null;
  return /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(v) ? v : null;
}

export function normalizeSignerName(raw: unknown): string | null {
  const v = typeof raw === "string" ? raw.trim().replace(/\s+/g, " ") : "";
  if (v.length < 1 || v.length > 100 || /[\u0000-\u001f<>]/.test(v)) return null;
  return v;
}

/** "sara.ahmed@example.com" -> "s***@example.com" */
export function maskEmail(email: string): string {
  const [local, domain] = email.split("@");
  if (!domain) return "***";
  return `${local.slice(0, 1)}***@${domain}`.slice(0, 80);
}

/** A UUID derived from a seed (the same seed always gives the same id), so a retried job cannot create a second document. */
export function deterministicUuid(seed: string): string {
  const h = createHash("sha256").update(seed).digest();
  h[6] = (h[6] & 0x0f) | 0x50; // version 5-style
  h[8] = (h[8] & 0x3f) | 0x80;
  const x = h.subarray(0, 16).toString("hex");
  return `${x.slice(0, 8)}-${x.slice(8, 12)}-${x.slice(12, 16)}-${x.slice(16, 20)}-${x.slice(20, 32)}`;
}

/** Fixed wording sent to the provider: nothing about the patient or the clinic's services. */
export const ESIGN_TITLE = "Consent form";
export const ESIGN_MESSAGE = "Please review and sign this document.";
