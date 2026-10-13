import { createHash } from "node:crypto";

/**
 * The canonical "approval statement" a person signs with their own certificate at an approval step (pure). It names
 * the document, the step, the signer and the sha256 the approval is bound to, plus the sha256 of the remarks (never the
 * remarks themselves), so the signature proves which content this person approved without carrying free text. The SQL
 * function app.fin_store_approval_signature checks the same fields again before the signature is stored.
 */

export const STATEMENT_TYPE = "pulse.approval-statement";

export type StatementDocType = "payment_voucher" | "close_pack";
export type StatementStep = "check" | "approve_dept" | "approve_ceo" | "finance" | "ceo";

export const STEP_LABEL: Record<StatementStep, string> = {
  check: "Verified (Finance Manager)",
  approve_dept: "Approved (department head)",
  approve_ceo: "Authorised (CEO)",
  finance: "Signed for Finance",
  ceo: "Signed as CEO",
};

export type ApprovalStatement = {
  type: typeof STATEMENT_TYPE;
  v: 1;
  doc_type: StatementDocType;
  doc_id: string;
  /** The human reference: voucher number or close month (YYYY-MM). */
  doc_ref: string;
  org_id: string;
  step: StatementStep;
  signer_id: string;
  bound_sha256: string;
  remarks_sha256: string | null;
  signed_at: string;
};

const sha256Hex = (s: string) => createHash("sha256").update(s, "utf8").digest("hex");

/** Remarks are trimmed first; blank remarks have no hash. Mirrors nullif(btrim(..), '') in SQL for already-trimmed text. */
export function remarksHash(remarks: string | null | undefined): string | null {
  const t = (remarks ?? "").trim();
  return t === "" ? null : sha256Hex(t);
}

export function approvalStatement(i: {
  docType: StatementDocType;
  docId: string;
  docRef: string;
  orgId: string;
  step: StatementStep;
  signerId: string;
  boundSha256: string;
  remarks: string | null;
  signedAt: Date;
}): { statement: ApprovalStatement; text: string; sha256: string } {
  const statement: ApprovalStatement = {
    type: STATEMENT_TYPE,
    v: 1,
    doc_type: i.docType,
    doc_id: i.docId,
    doc_ref: i.docRef,
    org_id: i.orgId,
    step: i.step,
    signer_id: i.signerId,
    bound_sha256: i.boundSha256,
    remarks_sha256: remarksHash(i.remarks),
    signed_at: new Date(Math.floor(i.signedAt.getTime() / 1000) * 1000).toISOString(),
  };
  const text = canonicalStatement(statement);
  return { statement, text, sha256: sha256Hex(text) };
}

/** The canonical text: JSON with the keys in the fixed order above, no spaces. */
export function canonicalStatement(s: ApprovalStatement): string {
  return JSON.stringify({
    type: s.type,
    v: s.v,
    doc_type: s.doc_type,
    doc_id: s.doc_id,
    doc_ref: s.doc_ref,
    org_id: s.org_id,
    step: s.step,
    signer_id: s.signer_id,
    bound_sha256: s.bound_sha256,
    remarks_sha256: s.remarks_sha256,
    signed_at: s.signed_at,
  });
}

const HEX64 = /^[0-9a-f]{64}$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

/** Parses a stored statement and checks it is in canonical form (null when it is not). */
export function parseStatement(text: string): ApprovalStatement | null {
  if (text.length > 4000) return null;
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    return null;
  }
  if (!raw || typeof raw !== "object") return null;
  const s = raw as ApprovalStatement;
  if (
    s.type !== STATEMENT_TYPE ||
    s.v !== 1 ||
    (s.doc_type !== "payment_voucher" && s.doc_type !== "close_pack") ||
    !UUID.test(String(s.doc_id)) ||
    !UUID.test(String(s.org_id)) ||
    !UUID.test(String(s.signer_id)) ||
    !(s.step in STEP_LABEL) ||
    !HEX64.test(String(s.bound_sha256)) ||
    (s.remarks_sha256 !== null && !HEX64.test(String(s.remarks_sha256))) ||
    typeof s.doc_ref !== "string" ||
    Number.isNaN(Date.parse(String(s.signed_at)))
  )
    return null;
  return canonicalStatement(s) === text ? s : null;
}

export function statementSha256(text: string): string {
  return sha256Hex(text);
}
