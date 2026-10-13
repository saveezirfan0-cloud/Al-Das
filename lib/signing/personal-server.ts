import "server-only";

import { decryptSecret, encryptSecret } from "@/lib/crypto";
import { signDetached } from "@/lib/signing/cms";
import { openP12, SigningError, SIGNING_ERROR_TEXT } from "@/lib/signing/p12";
import {
  approvalStatement,
  type StatementDocType,
  type StatementStep,
} from "@/lib/signing/statement";
import { verifyApprovalSignature } from "@/lib/signing/verify";
import { certificateProblems } from "@/lib/signing/x509";
import type { AdminClient } from "@/lib/supabase/admin";

/**
 * A person's own signing certificate (Settings, Signing certificate) and signing an approval statement with it. Service
 * role, called only after the action has checked the person's permission. The .p12 is stored AES-256-GCM encrypted
 * (lib/crypto.ts) and is still protected by the person's PIN, which Pulse never stores: it is typed at upload (to read the
 * certificate) and at each signing. Nothing here logs or returns a PIN, a key or the encrypted file.
 */

export { SIGNING_PERMS } from "@/lib/signing/perms";

export const PIN_MIN = 4;

export type OwnCertificate = {
  id: string;
  subject: string;
  subjectCn: string | null;
  issuer: string;
  issuerCn: string | null;
  serial: string;
  fingerprint: string;
  validFrom: string;
  validTo: string;
  createdAt: string;
  /** Why it cannot sign now (expired, ...); empty = usable. */
  problems: string[];
};

type Fail = { ok: false; error: string };

export async function loadOwnCertificate(
  admin: AdminClient,
  orgId: string,
  userId: string,
  now = new Date(),
): Promise<OwnCertificate | null> {
  const { data } = await admin
    .from("fin_signing_certificates")
    .select(
      "id, subject, subject_cn, issuer, issuer_cn, serial_hex, fingerprint_sha256, valid_from, valid_to, created_at",
    )
    .eq("org_id", orgId)
    .eq("user_id", userId)
    .is("revoked_at", null)
    .maybeSingle();
  if (!data) return null;
  const problems: string[] = [];
  if (new Date(data.valid_to) <= now) problems.push("The certificate has expired.");
  if (new Date(data.valid_from) > now) problems.push("The certificate is not valid yet.");
  return {
    id: data.id,
    subject: data.subject,
    subjectCn: data.subject_cn,
    issuer: data.issuer,
    issuerCn: data.issuer_cn,
    serial: data.serial_hex,
    fingerprint: data.fingerprint_sha256,
    validFrom: data.valid_from,
    validTo: data.valid_to,
    createdAt: data.created_at,
    problems,
  };
}

/** Checks the file with its PIN, refuses an unusable certificate, then stores it encrypted (replacing any earlier one). */
export async function storeOwnCertificate(
  admin: AdminClient,
  a: { orgId: string; userId: string; p12: Buffer; pin: string; now?: Date },
): Promise<{ ok: true; certificate: OwnCertificate } | Fail> {
  if (a.pin.length < PIN_MIN)
    return {
      ok: false,
      error: `The certificate must be protected by a PIN of at least ${PIN_MIN} characters.`,
    };
  const now = a.now ?? new Date();
  let info;
  try {
    info = openP12(a.p12, a.pin).info;
  } catch (err) {
    return {
      ok: false,
      error: err instanceof SigningError ? err.message : SIGNING_ERROR_TEXT.unreadable,
    };
  }
  const problems = certificateProblems(info, now);
  if (problems.length > 0) return { ok: false, error: problems[0] };

  const { error: revokeError } = await admin
    .from("fin_signing_certificates")
    .update({ revoked_at: now.toISOString(), p12_enc: null })
    .eq("org_id", a.orgId)
    .eq("user_id", a.userId)
    .is("revoked_at", null);
  if (revokeError) return { ok: false, error: "The earlier certificate could not be replaced." };
  const { error } = await admin.from("fin_signing_certificates").insert({
    org_id: a.orgId,
    user_id: a.userId,
    p12_enc: encryptSecret(a.p12.toString("base64")),
    subject: info.subject.slice(0, 1000),
    subject_cn: info.subjectCn?.slice(0, 300) ?? null,
    issuer: info.issuer.slice(0, 1000),
    issuer_cn: info.issuerCn?.slice(0, 300) ?? null,
    serial_hex: info.serialHex,
    fingerprint_sha256: info.fingerprint,
    valid_from: info.validFrom,
    valid_to: info.validTo,
  });
  if (error) return { ok: false, error: "The certificate could not be saved." };
  const saved = await loadOwnCertificate(admin, a.orgId, a.userId, now);
  return saved
    ? { ok: true, certificate: saved }
    : { ok: false, error: "The certificate could not be saved." };
}

/** Revokes the person's active certificate and drops the encrypted file. False when there was none. */
export async function revokeOwnCertificate(
  admin: AdminClient,
  a: { orgId: string; userId: string; now?: Date },
): Promise<{ ok: true; fingerprint: string } | Fail> {
  const { data, error } = await admin
    .from("fin_signing_certificates")
    .update({ revoked_at: (a.now ?? new Date()).toISOString(), p12_enc: null })
    .eq("org_id", a.orgId)
    .eq("user_id", a.userId)
    .is("revoked_at", null)
    .select("fingerprint_sha256");
  if (error) return { ok: false, error: "The certificate could not be revoked." };
  if (!data || data.length === 0) return { ok: false, error: "You have no active certificate." };
  return { ok: true, fingerprint: data[0].fingerprint_sha256 };
}

/** What the SQL step function stores with the step (app.fin_store_approval_signature). */
export type SignedStatement = {
  certificate_id: string;
  fingerprint: string;
  statement: string;
  cms: string;
};

/**
 * Signs the approval statement of one step with the person's own certificate and PIN. A wrong PIN, a missing, revoked or
 * expired certificate all fail here, before the step is attempted, so the approval is never consumed by a failed signature.
 */
export async function signApprovalStatement(
  admin: AdminClient,
  a: {
    orgId: string;
    userId: string;
    pin: string;
    docType: StatementDocType;
    docId: string;
    docRef: string;
    step: StatementStep;
    boundSha256: string;
    remarks: string | null;
    now?: Date;
  },
): Promise<{ ok: true; signature: SignedStatement } | Fail> {
  const now = a.now ?? new Date();
  const { data: row } = await admin
    .from("fin_signing_certificates")
    .select("id, p12_enc, fingerprint_sha256")
    .eq("org_id", a.orgId)
    .eq("user_id", a.userId)
    .is("revoked_at", null)
    .maybeSingle();
  if (!row?.p12_enc)
    return {
      ok: false,
      error: "You have no signing certificate. Add one under Settings, Signing certificate.",
    };
  let identity;
  try {
    identity = openP12(Buffer.from(decryptSecret(row.p12_enc), "base64"), a.pin);
  } catch (err) {
    return {
      ok: false,
      error: err instanceof SigningError ? err.message : "Your certificate cannot be opened.",
    };
  }
  if (identity.info.fingerprint !== row.fingerprint_sha256)
    return { ok: false, error: "Your stored certificate does not match its record." };
  const problems = certificateProblems(identity.info, now);
  if (problems.length > 0) return { ok: false, error: problems[0] };

  const s = approvalStatement({
    docType: a.docType,
    docId: a.docId,
    docRef: a.docRef,
    orgId: a.orgId,
    step: a.step,
    signerId: a.userId,
    boundSha256: a.boundSha256,
    remarks: a.remarks,
    signedAt: now,
  });
  const cms = signDetached({
    content: Buffer.from(s.text, "utf8"),
    identity,
    signingTime: new Date(s.statement.signed_at),
  });
  // Check our own output before it is stored with the approval.
  const check = verifyApprovalSignature({
    cms,
    statement: s.text,
    statementSha256: s.sha256,
    fingerprint: row.fingerprint_sha256,
    expect: {
      docType: a.docType,
      docId: a.docId,
      step: a.step,
      signerId: a.userId,
      boundSha256: a.boundSha256,
    },
  });
  if (check.status !== "valid") return { ok: false, error: "The signature could not be made." };
  return {
    ok: true,
    signature: {
      certificate_id: row.id,
      fingerprint: row.fingerprint_sha256,
      statement: s.text,
      cms: cms.toString("base64"),
    },
  };
}
