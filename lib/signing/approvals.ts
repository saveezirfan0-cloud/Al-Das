import { STEP_LABEL, type StatementDocType, type StatementStep } from "@/lib/signing/statement";
import { verifyApprovalSignature, type ApprovalSignatureCheck } from "@/lib/signing/verify";

/**
 * Which stored personal signatures belong to the CURRENT approvals of a document, and whether each one verifies (pure).
 *
 * A signature counts for a step only when it was stored in the same transaction as that step (`step_at` equals the
 * step's own timestamp: checked_at, ceo_approved_at, finance_signed_at, ...), by the person who holds the step now, and
 * is bound to the document's current hash. A rejected-and-resubmitted voucher or a withdrawn finance sign-off therefore
 * never shows an old signature as current; the old rows stay in the table (append-only) as history.
 */

export type StoredSignature = {
  id: string;
  step: StatementStep;
  user_id: string | null;
  statement: string;
  statement_sha256: string;
  bound_sha256: string;
  cms: Buffer;
  cert_subject: string;
  cert_subject_cn: string | null;
  cert_issuer: string;
  cert_issuer_cn: string | null;
  cert_serial: string;
  cert_fingerprint: string;
  cert_valid_from: string;
  cert_valid_to: string;
  step_at: string;
};

export type CurrentStep = { step: StatementStep; userId: string | null; at: string | null };

export type SignatureView = {
  id: string;
  step: StatementStep;
  stepLabel: string;
  userId: string;
  subject: string;
  subjectCn: string | null;
  issuer: string;
  issuerCn: string | null;
  serial: string;
  fingerprint: string;
  validFrom: string;
  validTo: string;
  signedAt: string;
  status: "valid" | "invalid";
  reason: string | null;
};

const sameInstant = (a: string, b: string) => Date.parse(a) === Date.parse(b);

export function currentSignatures(input: {
  docType: StatementDocType;
  docId: string;
  boundSha256: string | null;
  steps: readonly CurrentStep[];
  rows: readonly StoredSignature[];
}): SignatureView[] {
  if (!input.boundSha256) return [];
  const out: SignatureView[] = [];
  for (const s of input.steps) {
    if (!s.userId || !s.at) continue;
    const row = [...input.rows]
      .reverse()
      .find(
        (r) =>
          r.step === s.step &&
          r.user_id === s.userId &&
          r.bound_sha256 === input.boundSha256 &&
          sameInstant(r.step_at, s.at!),
      );
    if (!row) continue;
    const check: ApprovalSignatureCheck = verifyApprovalSignature({
      cms: row.cms,
      statement: row.statement,
      statementSha256: row.statement_sha256,
      fingerprint: row.cert_fingerprint,
      expect: {
        docType: input.docType,
        docId: input.docId,
        step: s.step,
        signerId: s.userId,
        boundSha256: input.boundSha256,
      },
    });
    out.push({
      id: row.id,
      step: s.step,
      stepLabel: STEP_LABEL[s.step],
      userId: s.userId,
      subject: row.cert_subject,
      subjectCn: row.cert_subject_cn,
      issuer: row.cert_issuer,
      issuerCn: row.cert_issuer_cn,
      serial: row.cert_serial,
      fingerprint: row.cert_fingerprint,
      validFrom: row.cert_valid_from,
      validTo: row.cert_valid_to,
      signedAt: check.status === "valid" ? check.statement.signed_at : row.step_at,
      status: check.status,
      reason: check.status === "valid" ? null : check.reason,
    });
  }
  return out;
}

/** bytea as PostgREST returns it ("\x3082...") -> bytes. */
export function byteaToBuffer(v: unknown): Buffer {
  if (typeof v === "string" && v.startsWith("\\x")) return Buffer.from(v.slice(2), "hex");
  if (v instanceof Uint8Array) return Buffer.from(v);
  return Buffer.alloc(0);
}

/** bytes -> the bytea text form PostgREST accepts. */
export function bufferToBytea(b: Uint8Array): string {
  return `\\x${Buffer.from(b).toString("hex")}`;
}
