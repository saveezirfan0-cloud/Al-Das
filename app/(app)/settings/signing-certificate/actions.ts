"use server";

import { revalidatePath } from "next/cache";

import { recordAudit } from "@/lib/audit";
import { canAny } from "@/lib/auth/can";
import { requireMember } from "@/lib/auth/session";
import { checkRateLimit, RATE_RULES, waitText } from "@/lib/rate-limit";
import { P12_MAX_BYTES } from "@/lib/signing/p12";
import {
  revokeOwnCertificate,
  SIGNING_PERMS,
  storeOwnCertificate,
} from "@/lib/signing/personal-server";
import { createAdminClient } from "@/lib/supabase/admin";

/**
 * Phase 22C: a person adds or revokes their OWN signing certificate (.p12 / .pfx). Only people who verify or approve
 * vouchers or sign the month-end close may hold one. The PIN is used once to read the certificate and is never stored;
 * the file is stored AES-256-GCM encrypted. Audited with the certificate fingerprint only.
 */

export type CertResult = { ok: true; message: string } | { ok: false; error: string };

async function gate() {
  const member = await requireMember();
  return canAny(member, SIGNING_PERMS) ? member : null;
}

export async function uploadSigningCertificate(form: FormData): Promise<CertResult> {
  const member = await gate();
  if (!member) return { ok: false, error: "You do not have permission for that." };
  const file = form.get("file");
  const pin = form.get("pin");
  if (!(file instanceof File) || file.size === 0)
    return { ok: false, error: "Choose your certificate file (.p12 or .pfx)." };
  if (file.size > P12_MAX_BYTES)
    return { ok: false, error: "The certificate file is too large (64 KB at most)." };
  if (typeof pin !== "string" || pin.length > 200)
    return { ok: false, error: "Type the certificate PIN." };
  const admin = createAdminClient(member.userId);
  const limit = await checkRateLimit(
    admin,
    "signing-cert-upload",
    member.userId,
    RATE_RULES.signingCertUploadPerUser,
  );
  if (!limit.allowed)
    return { ok: false, error: `Too many attempts. Try again in ${waitText(limit.retryAfter)}.` };
  const stored = await storeOwnCertificate(admin, {
    orgId: member.orgId,
    userId: member.userId,
    p12: Buffer.from(await file.arrayBuffer()),
    pin,
  });
  if (!stored.ok) return stored;
  await recordAudit(admin, {
    orgId: member.orgId,
    userId: member.userId,
    action: "signing.certificate_added",
    entity: "fin_signing_certificates",
    entityId: stored.certificate.id,
    diff: {
      fingerprint: stored.certificate.fingerprint,
      valid_to: stored.certificate.validTo,
    },
  });
  revalidatePath("/settings/signing-certificate");
  return {
    ok: true,
    message: "Certificate saved. You can now sign approvals with it by typing its PIN.",
  };
}

export async function revokeSigningCertificate(): Promise<CertResult> {
  const member = await gate();
  if (!member) return { ok: false, error: "You do not have permission for that." };
  const admin = createAdminClient(member.userId);
  const done = await revokeOwnCertificate(admin, { orgId: member.orgId, userId: member.userId });
  if (!done.ok) return done;
  await recordAudit(admin, {
    orgId: member.orgId,
    userId: member.userId,
    action: "signing.certificate_revoked",
    entity: "fin_signing_certificates",
    entityId: null,
    diff: { fingerprint: done.fingerprint },
  });
  revalidatePath("/settings/signing-certificate");
  return {
    ok: true,
    message: "Certificate revoked. Signatures you already made stay on record.",
  };
}
