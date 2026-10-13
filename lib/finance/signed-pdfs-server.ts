import "server-only";

import type { CloseRecord } from "@/lib/finance/close-server";
import { closePackPdf } from "@/lib/finance/close-pdf";
import { voucherCertificatePdf } from "@/lib/finance/voucher-certificate";
import {
  certificateFrom,
  loadVoucherDetail,
  peopleNames,
  nameOf,
  type VoucherDetail,
} from "@/lib/finance/vouchers-server";
import { redactText } from "@/lib/redact";
import {
  bufferToBytea,
  byteaToBuffer,
  currentSignatures,
  type CurrentStep,
  type SignatureView,
  type StoredSignature,
} from "@/lib/signing/approvals";
import { sealPdf } from "@/lib/signing/pades";
import type { PrintedSignature, SealState, SigningSection } from "@/lib/signing/pdf-text";
import { loadOrgSeal } from "@/lib/signing/seal-server";
import type { StatementDocType, StatementStep } from "@/lib/signing/statement";
import { verifyPdfSignature, VERIFY_FAILURE_TEXT } from "@/lib/signing/verify";
import type { DocumentSigningView, SealStatus } from "@/lib/signing/view-types";
import { isEnabled } from "@/lib/integrations/accounts";
import { loadOwnCertificate } from "@/lib/signing/personal-server";
import type { AdminClient } from "@/lib/supabase/admin";

/**
 * The signed PDFs of Phase 22C: the voucher approval certificate and the month-end close pack.
 *
 * Final documents (a voucher approved in Pulse; a locked month) are sealed with the organisation certificate when the
 * seal is on, and the sealed bytes are STORED (fin_sealed_documents, one row per document and bound hash): every later
 * download returns exactly those bytes, so the signature stays valid and identical even after the seal certificate is
 * renewed or the trail grows (a payment, a Tally export). Without a seal the PDF is rendered on demand (deterministic)
 * with the visible line "Not digitally sealed". Service role; callers have checked the person's permission and scope.
 */

export type SignedPdf = { pdf: Buffer; sealed: boolean; final: boolean };

export type { SealStatus } from "@/lib/signing/view-types";

type Ctx = { orgId: string; orgName: string; timezone: string | null; userId: string };

export type SealedKind = "voucher_certificate" | "close_pack";

async function loadSealed(
  admin: AdminClient,
  orgId: string,
  kind: SealedKind,
  docId: string,
  bound: string,
): Promise<Buffer | null> {
  const { data } = await admin
    .from("fin_sealed_documents")
    .select("pdf")
    .eq("org_id", orgId)
    .eq("doc_kind", kind)
    .eq("doc_id", docId)
    .eq("bound_sha256", bound)
    .maybeSingle();
  return data ? byteaToBuffer(data.pdf) : null;
}

/** Stores a sealed PDF unless one is already stored for the same document and hash; returns the stored bytes (first wins). */
async function storeSealed(
  admin: AdminClient,
  a: {
    orgId: string;
    kind: SealedKind;
    docId: string;
    bound: string;
    pdf: Buffer;
    subject: string;
    fingerprint: string;
    userId: string;
  },
): Promise<Buffer> {
  await admin.from("fin_sealed_documents").upsert(
    {
      org_id: a.orgId,
      doc_kind: a.kind,
      doc_id: a.docId,
      bound_sha256: a.bound,
      pdf: bufferToBytea(a.pdf),
      seal_subject: a.subject.slice(0, 1000),
      seal_fingerprint: a.fingerprint,
      sealed_by: a.userId,
    },
    { onConflict: "org_id,doc_kind,doc_id,bound_sha256", ignoreDuplicates: true },
  );
  return (await loadSealed(admin, a.orgId, a.kind, a.docId, a.bound)) ?? a.pdf;
}

async function loadSignatureRows(
  admin: AdminClient,
  orgId: string,
  kind: StatementDocType,
  docId: string,
): Promise<StoredSignature[]> {
  const { data } = await admin
    .from("fin_approval_signatures")
    .select(
      "id, step, user_id, statement, statement_sha256, bound_sha256, cms, cert_subject, cert_subject_cn, cert_issuer, cert_issuer_cn, cert_serial, cert_fingerprint, cert_valid_from, cert_valid_to, step_at",
    )
    .eq("org_id", orgId)
    .eq("doc_kind", kind)
    .eq("doc_id", docId)
    .order("step_at");
  return (data ?? []).map((r) => ({
    ...r,
    step: r.step as StatementStep,
    cms: byteaToBuffer(r.cms),
  }));
}

export type NamedSignature = SignatureView & { signer: string };

async function named(admin: AdminClient, sigs: SignatureView[]): Promise<NamedSignature[]> {
  const names = await peopleNames(
    admin,
    sigs.map((s) => s.userId),
  );
  return sigs.map((s) => ({ ...s, signer: nameOf(names, s.userId) }));
}

const printed = (s: NamedSignature): PrintedSignature => ({
  stepLabel: s.stepLabel,
  signer: s.signer,
  subject: s.subject,
  issuer: s.issuer,
  serial: s.serial,
  fingerprint: s.fingerprint,
  validFrom: s.validFrom,
  validTo: s.validTo,
  signedAt: s.signedAt,
  result: s.status === "valid" ? "valid" : `INVALID (${s.reason})`,
});

/** PDF signing times have whole seconds; the printed time must be the same instant. */
const wholeSecond = (d: Date) => new Date(Math.floor(d.getTime() / 1000) * 1000);

// ---------------------------------------------------------------------------------------------------------------------
// Vouchers
// ---------------------------------------------------------------------------------------------------------------------

export function voucherSteps(d: VoucherDetail): CurrentStep[] {
  const v = d.voucher;
  return [
    { step: "check", userId: v.checked_by, at: v.checked_at },
    { step: "approve_dept", userId: v.dept_approved_by, at: v.dept_approved_at },
    { step: "approve_ceo", userId: v.ceo_approved_by, at: v.ceo_approved_at },
  ];
}

/** Approved in Pulse (not a Tally-route voucher) and bound to a content hash. */
export function isFinalVoucher(v: VoucherDetail["voucher"]): boolean {
  return (
    v.route === "pulse" && (v.status === "approved" || v.status === "paid") && !!v.content_sha256
  );
}

export async function voucherSignatures(
  admin: AdminClient,
  orgId: string,
  d: VoucherDetail,
): Promise<NamedSignature[]> {
  if (!d.voucher.content_sha256) return [];
  const rows = await loadSignatureRows(admin, orgId, "payment_voucher", d.voucher.id);
  return named(
    admin,
    currentSignatures({
      docType: "payment_voucher",
      docId: d.voucher.id,
      boundSha256: d.voucher.content_sha256,
      steps: voucherSteps(d),
      rows,
    }),
  );
}

export async function voucherCertificateFile(
  admin: AdminClient,
  ctx: Ctx,
  d: VoucherDetail,
  now = new Date(),
): Promise<SignedPdf> {
  const v = d.voucher;
  const final = isFinalVoucher(v);
  if (final) {
    const stored = await loadSealed(
      admin,
      ctx.orgId,
      "voucher_certificate",
      v.id,
      v.content_sha256!,
    );
    if (stored) return { pdf: stored, sealed: true, final };
  }
  const [sigs, seal] = await Promise.all([
    voucherSignatures(admin, ctx.orgId, d),
    final ? loadOrgSeal(admin, ctx.orgId, now) : Promise.resolve(null),
  ]);
  const at = wholeSecond(now);
  const sealState: SealState = seal
    ? {
        state: "sealed",
        name: seal.name,
        at: at.toISOString(),
        subject: seal.info.subject,
        fingerprint: seal.info.fingerprint,
      }
    : final
      ? { state: "off" }
      : {
          state: "not_final",
          why:
            v.route === "tally"
              ? "this voucher is authorised in Tally, not in Pulse."
              : "the organisation seal is applied once the voucher is fully approved.",
        };
  const signing: SigningSection = { signatures: sigs.map(printed), seal: sealState };
  const pdf = await voucherCertificatePdf({
    ...certificateFrom(d, { name: ctx.orgName, timezone: ctx.timezone }),
    signing,
  });
  if (!seal) return { pdf, sealed: false, final };
  const sealed = await sealPdf(pdf, {
    identity: seal.identity,
    name: seal.name,
    reason: seal.reason,
    location: seal.location,
    signingTime: at,
  });
  const stored = await storeSealed(admin, {
    orgId: ctx.orgId,
    kind: "voucher_certificate",
    docId: v.id,
    bound: v.content_sha256!,
    pdf: sealed,
    subject: seal.info.subject,
    fingerprint: seal.info.fingerprint,
    userId: ctx.userId,
  });
  return { pdf: stored, sealed: true, final };
}

/**
 * Right after the final approval: seal and store the certificate so the sealed copy holds the approval trail as it was
 * when the voucher was approved. Best effort; a failure leaves the voucher approved and the next download tries again.
 */
export async function sealVoucherCertificateNow(
  admin: AdminClient,
  ctx: Ctx,
  voucherId: string,
): Promise<boolean> {
  try {
    const d = await loadVoucherDetail(admin, ctx.orgId, voucherId, { special: true, ids: null });
    if (!d || !isFinalVoucher(d.voucher)) return false;
    return (await voucherCertificateFile(admin, ctx, d)).sealed;
  } catch (err) {
    console.error("[signing] voucher certificate not sealed", {
      voucherId,
      reason: redactText(err, 200),
    });
    return false;
  }
}

// ---------------------------------------------------------------------------------------------------------------------
// Close packs
// ---------------------------------------------------------------------------------------------------------------------

export function closeSteps(c: CloseRecord): CurrentStep[] {
  return [
    { step: "finance", userId: c.financeById, at: c.sign.financeAt },
    { step: "ceo", userId: c.ceoById, at: c.sign.ceoAt },
  ];
}

export async function closeSignatures(
  admin: AdminClient,
  orgId: string,
  c: CloseRecord,
): Promise<NamedSignature[]> {
  if (!c.hash) return [];
  const rows = await loadSignatureRows(admin, orgId, "close_pack", c.id);
  return named(
    admin,
    currentSignatures({
      docType: "close_pack",
      docId: c.id,
      boundSha256: c.hash,
      steps: closeSteps(c),
      rows,
    }),
  );
}

export async function closePackPdfFile(
  admin: AdminClient,
  ctx: Ctx,
  c: CloseRecord,
  now = new Date(),
): Promise<SignedPdf> {
  if (!c.pack) throw new Error("no pack");
  const final = c.status === "locked" && !!c.hash;
  if (final) {
    const stored = await loadSealed(admin, ctx.orgId, "close_pack", c.id, c.hash!);
    if (stored) return { pdf: stored, sealed: true, final };
  }
  const [sigs, seal] = await Promise.all([
    closeSignatures(admin, ctx.orgId, c),
    final ? loadOrgSeal(admin, ctx.orgId, now) : Promise.resolve(null),
  ]);
  const at = wholeSecond(now);
  const sealState: SealState = seal
    ? {
        state: "sealed",
        name: seal.name,
        at: at.toISOString(),
        subject: seal.info.subject,
        fingerprint: seal.info.fingerprint,
      }
    : final
      ? { state: "off" }
      : {
          state: "not_final",
          why: "the pack is sealed once the CEO has signed and the month is locked.",
        };
  const pdf = await closePackPdf(c.pack, c.sign, {
    signatures: sigs.map(printed),
    seal: sealState,
  });
  if (!seal) return { pdf, sealed: false, final };
  const sealed = await sealPdf(pdf, {
    identity: seal.identity,
    name: seal.name,
    reason: seal.reason,
    location: seal.location,
    signingTime: at,
  });
  const stored = await storeSealed(admin, {
    orgId: ctx.orgId,
    kind: "close_pack",
    docId: c.id,
    bound: c.hash!,
    pdf: sealed,
    subject: seal.info.subject,
    fingerprint: seal.info.fingerprint,
    userId: ctx.userId,
  });
  return { pdf: stored, sealed: true, final };
}

// ---------------------------------------------------------------------------------------------------------------------
// Verification shown on the pages
// ---------------------------------------------------------------------------------------------------------------------

export async function sealStatus(
  admin: AdminClient,
  orgId: string,
  kind: SealedKind,
  docId: string,
  bound: string | null,
): Promise<SealStatus> {
  if (!bound) return { status: "not_sealed" };
  const pdf = await loadSealed(admin, orgId, kind, docId, bound);
  if (!pdf) return { status: "not_sealed" };
  const r = verifyPdfSignature(pdf);
  if (r.status === "valid")
    return {
      status: "valid",
      signer: r.signer.subjectCn ?? r.signer.subject,
      at: r.signedAt,
      pades: r.pades,
    };
  if (r.status === "invalid") return { status: "invalid", reason: VERIFY_FAILURE_TEXT[r.reason] };
  return { status: "invalid", reason: "The stored file carries no signature." };
}

/** What the voucher drawer / close page shows: the viewer's own certificate, current signatures (verified), the seal. */
export async function signingView(
  admin: AdminClient,
  a: {
    orgId: string;
    userId: string;
    /** Load the viewer's own certificate (they could sign the next step). */
    mayHaveCertificate: boolean;
    signatures: NamedSignature[];
    kind: SealedKind;
    docId: string;
    bound: string | null;
  },
): Promise<DocumentSigningView> {
  const [mine, seal, sealOn] = await Promise.all([
    a.mayHaveCertificate ? loadOwnCertificate(admin, a.orgId, a.userId) : Promise.resolve(null),
    sealStatus(admin, a.orgId, a.kind, a.docId, a.bound),
    isEnabled(admin, a.orgId, "document_seal"),
  ]);
  return {
    myCertificate: mine
      ? { label: mine.subjectCn ?? mine.subject, usable: mine.problems.length === 0 }
      : null,
    signatures: a.signatures.map((s) => ({
      id: s.id,
      stepLabel: s.stepLabel,
      signer: s.signer,
      subjectCn: s.subjectCn,
      issuerCn: s.issuerCn,
      fingerprint: s.fingerprint,
      status: s.status,
      reason: s.reason,
    })),
    seal,
    sealOn,
  };
}
