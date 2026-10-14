import { createHash, verify as cryptoVerify, X509Certificate } from "node:crypto";

import {
  bytesOf,
  childrenOf,
  decodeOid,
  decodeTime,
  DerError,
  expectTag,
  readNode,
  TAG,
  valueOf,
  type DerNode,
} from "@/lib/signing/der";
import { OID } from "@/lib/signing/cms";
import { parseStatement, statementSha256, type ApprovalStatement } from "@/lib/signing/statement";
import { certInfo, certParts, type CertInfo } from "@/lib/signing/x509";

/**
 * Verifies what Pulse signs (pure: no network, no database). A detached CMS against its content, an approval statement
 * signature, and a PDF signature (ByteRange, digest, signer). It answers "is this signature mathematically valid over
 * these bytes, and who made it"; it does not check revocation or build a chain to a trusted root (that needs the
 * issuer's CRL / OCSP, a network call), so a self-signed seal is reported as valid with `selfSigned: true`.
 */

export type VerifyFailure =
  | "malformed"
  | "unsupported"
  | "no_signer_certificate"
  | "digest_mismatch"
  | "bad_signature"
  | "certificate_mismatch"
  | "outside_validity"
  | "content_type"
  | "not_covering_whole_file";

export const VERIFY_FAILURE_TEXT: Record<VerifyFailure, string> = {
  malformed: "The signature cannot be read.",
  unsupported: "The signature uses an algorithm Pulse does not check.",
  no_signer_certificate: "The signer's certificate is missing from the signature.",
  digest_mismatch: "The signed content was changed after signing.",
  bad_signature: "The signature does not match the signer's key.",
  certificate_mismatch: "The signature names a different certificate.",
  outside_validity: "The certificate was not valid at the time of signing.",
  content_type: "The signature is not over plain data.",
  not_covering_whole_file: "Data was added to the file after it was signed.",
};

export type CmsResult =
  | {
      ok: true;
      signer: CertInfo;
      signingTime: string | null;
      /** The ESS signing-certificate-v2 attribute is present and matches (PAdES / CAdES baseline). */
      hasSigningCertificateV2: boolean;
    }
  | { ok: false; reason: VerifyFailure; signer: CertInfo | null };

type Parsed = {
  certs: Buffer[];
  sid: { issuer: Buffer; serial: Buffer };
  digestAlg: string;
  signedAttrs: {
    implicit: Buffer;
    values: Map<string, { tag: number; value: Buffer; raw: Buffer }>;
  };
  sigAlg: string;
  signature: Buffer;
};

function attrValue(buf: Buffer, n: DerNode) {
  const [typeNode, setNode] = childrenOf(buf, n);
  const type = decodeOid(valueOf(buf, expectTag(typeNode, TAG.OID, "attribute type")));
  const values = childrenOf(buf, expectTag(setNode, TAG.SET, "attribute values"));
  if (values.length !== 1) throw new DerError("one attribute value expected");
  return { type, tag: values[0].tag, value: valueOf(buf, values[0]), raw: bytesOf(buf, values[0]) };
}

function parseCms(cms: Buffer): Parsed {
  const ci = expectTag(readNode(cms), TAG.SEQUENCE, "ContentInfo");
  if (ci.end !== cms.length) throw new DerError("trailing data");
  const [ctNode, wrap] = childrenOf(cms, ci);
  if (decodeOid(valueOf(cms, expectTag(ctNode, TAG.OID, "content type"))) !== OID.signedData)
    throw new DerError("not SignedData");
  const sd = expectTag(
    childrenOf(cms, expectTag(wrap, 0xa0, "[0]"))[0],
    TAG.SEQUENCE,
    "SignedData",
  );
  const parts = childrenOf(cms, sd);
  // version, digestAlgorithms, encapContentInfo, [0] certificates, [1] crls?, signerInfos
  const encap = childrenOf(cms, expectTag(parts[2], TAG.SEQUENCE, "encapContentInfo"));
  if (decodeOid(valueOf(cms, expectTag(encap[0], TAG.OID, "eContentType"))) !== OID.data)
    throw new DerError("content type");
  if (encap.length > 1) throw new DerError("not detached");
  const certNode = parts.find((p) => p.tag === 0xa0);
  const certs = certNode ? childrenOf(cms, certNode).map((c) => bytesOf(cms, c)) : [];
  const signerInfos = childrenOf(cms, expectTag(parts[parts.length - 1], TAG.SET, "signerInfos"));
  if (signerInfos.length !== 1) throw new DerError("exactly one signer expected");
  const si = childrenOf(cms, expectTag(signerInfos[0], TAG.SEQUENCE, "SignerInfo"));
  const sidParts = childrenOf(cms, expectTag(si[1], TAG.SEQUENCE, "IssuerAndSerialNumber"));
  const digestAlg = decodeOid(valueOf(cms, childrenOf(cms, si[2])[0]));
  const attrsNode = expectTag(si[3], 0xa0, "signed attributes");
  const values = new Map<string, { tag: number; value: Buffer; raw: Buffer }>();
  for (const a of childrenOf(cms, attrsNode)) {
    const v = attrValue(cms, a);
    if (values.has(v.type)) throw new DerError("duplicate attribute");
    values.set(v.type, v);
  }
  const sigAlg = decodeOid(valueOf(cms, childrenOf(cms, si[4])[0]));
  return {
    certs,
    sid: { issuer: bytesOf(cms, sidParts[0]), serial: bytesOf(cms, sidParts[1]) },
    digestAlg,
    signedAttrs: { implicit: bytesOf(cms, attrsNode), values },
    sigAlg,
    signature: valueOf(cms, expectTag(si[5], TAG.OCTET_STRING, "signature")),
  };
}

/** Checks a detached CMS signature over `content`. `at` (default: the signing time, else now) must be inside the signer certificate's validity. */
export function verifyDetachedCms(
  cms: Uint8Array,
  content: Uint8Array,
  opts: { at?: Date } = {},
): CmsResult {
  let p: Parsed;
  try {
    p = parseCms(Buffer.from(cms));
  } catch (err) {
    return {
      ok: false,
      reason:
        err instanceof DerError && err.message === "content type" ? "content_type" : "malformed",
      signer: null,
    };
  }
  const signerDer = p.certs.find((c) => {
    try {
      const parts = certParts(c);
      return parts.issuer.equals(p.sid.issuer) && parts.serial.equals(p.sid.serial);
    } catch {
      return false;
    }
  });
  if (!signerDer) return { ok: false, reason: "no_signer_certificate", signer: null };
  let signer: CertInfo;
  try {
    signer = certInfo(signerDer);
  } catch {
    return { ok: false, reason: "malformed", signer: null };
  }
  if (
    p.digestAlg !== OID.sha256 ||
    ![OID.rsaEncryption, OID.sha256WithRsa].includes(p.sigAlg as never)
  )
    return { ok: false, reason: "unsupported", signer };

  const ct = p.signedAttrs.values.get(OID.contentType);
  if (!ct || ct.tag !== TAG.OID || decodeOid(ct.value) !== OID.data)
    return { ok: false, reason: "content_type", signer };
  const md = p.signedAttrs.values.get(OID.messageDigest);
  const digest = createHash("sha256").update(content).digest();
  if (!md || md.tag !== TAG.OCTET_STRING || !md.value.equals(digest))
    return { ok: false, reason: "digest_mismatch", signer };

  let hasSigningCertificateV2 = false;
  const scv2 = p.signedAttrs.values.get(OID.signingCertificateV2);
  if (scv2) {
    try {
      // SigningCertificateV2 ::= SEQUENCE { certs SEQUENCE OF ESSCertIDv2, ... }; first ESSCertIDv2 names the signer
      const raw = scv2.raw;
      const certsSeq = childrenOf(raw, readNode(raw))[0];
      const first = childrenOf(raw, certsSeq)[0];
      const fields = childrenOf(raw, first);
      let i = 0;
      let hashAlg = OID.sha256 as string;
      if (fields[0].tag === TAG.SEQUENCE) {
        hashAlg = decodeOid(valueOf(raw, childrenOf(raw, fields[0])[0]));
        i = 1;
      }
      if (hashAlg !== OID.sha256) return { ok: false, reason: "unsupported", signer };
      const certHash = valueOf(raw, expectTag(fields[i], TAG.OCTET_STRING, "certHash"));
      if (!certHash.equals(createHash("sha256").update(signerDer).digest()))
        return { ok: false, reason: "certificate_mismatch", signer };
      hasSigningCertificateV2 = true;
    } catch {
      return { ok: false, reason: "malformed", signer };
    }
  }

  const signedSet = Buffer.concat([Buffer.from([TAG.SET]), p.signedAttrs.implicit.subarray(1)]);
  let good = false;
  try {
    good = cryptoVerify("sha256", signedSet, new X509Certificate(signerDer).publicKey, p.signature);
  } catch {
    good = false;
  }
  if (!good) return { ok: false, reason: "bad_signature", signer };

  const st = p.signedAttrs.values.get(OID.signingTime);
  let signingTime: string | null = null;
  if (st) {
    try {
      signingTime = decodeTime(st.tag, st.value).toISOString();
    } catch {
      return { ok: false, reason: "malformed", signer };
    }
  }
  const at = opts.at ?? (signingTime ? new Date(signingTime) : new Date());
  if (at < new Date(signer.validFrom) || at > new Date(signer.validTo))
    return { ok: false, reason: "outside_validity", signer };
  return { ok: true, signer, signingTime, hasSigningCertificateV2 };
}

// ---------------------------------------------------------------------------------------------------------------------
// PDF (PAdES) signatures
// ---------------------------------------------------------------------------------------------------------------------

export type PdfSignatureResult =
  | { status: "not_signed" }
  | {
      status: "valid";
      signer: CertInfo;
      /** The /M entry of the signature dictionary (PAdES keeps the claimed signing time there). */
      signedAt: string | null;
      subFilter: string | null;
      /** ETSI.CAdES.detached with the signing-certificate-v2 attribute and no CMS signing time. */
      pades: boolean;
    }
  | { status: "invalid"; reason: VerifyFailure; signer: CertInfo | null };

/** "D:20261013190000Z" or "D:20261013190000+04'00'" -> ISO. */
export function pdfDate(s: string): string | null {
  const m = s.match(
    /^D:(\d{4})(\d{2})(\d{2})(\d{2})(\d{2})(\d{2})(?:([Zz])|([+-])(\d{2})'?(\d{2})'?)?/,
  );
  if (!m) return null;
  let t = Date.UTC(+m[1], +m[2] - 1, +m[3], +m[4], +m[5], +m[6]);
  if (m[8]) t -= (m[8] === "+" ? 1 : -1) * (+m[9] * 60 + +m[10]) * 60_000;
  return new Date(t).toISOString();
}

/**
 * Verifies the (last) signature of a PDF: the ByteRange must start at 0 and end at the end of the file (nothing appended
 * after signing), the excluded gap must be exactly the /Contents hex string, and the CMS inside must be valid over the
 * two covered ranges.
 */
export function verifyPdfSignature(pdf: Uint8Array): PdfSignatureResult {
  const buf = Buffer.from(pdf);
  const text = buf.toString("latin1");
  const ranges = [...text.matchAll(/\/ByteRange\s*\[\s*(\d+)\s+(\d+)\s+(\d+)\s+(\d+)\s*\]/g)];
  if (ranges.length === 0) return { status: "not_signed" };
  const m = ranges[ranges.length - 1];
  const [a, b, c, d] = [m[1], m[2], m[3], m[4]].map(Number);
  if (a !== 0 || b <= 0 || c <= b || c + d > buf.length || buf[b] !== 0x3c || buf[c - 1] !== 0x3e)
    return { status: "invalid", reason: "malformed", signer: null };
  if (c + d !== buf.length)
    return { status: "invalid", reason: "not_covering_whole_file", signer: null };
  const hex = text.slice(b + 1, c - 1);
  if (!/^[0-9a-fA-F]*$/.test(hex) || hex.length % 2 !== 0)
    return { status: "invalid", reason: "malformed", signer: null };
  const raw = Buffer.from(hex, "hex");
  let cms: Buffer;
  try {
    cms = raw.subarray(0, readNode(raw).end); // the placeholder is padded with zeros after the DER
  } catch {
    return { status: "invalid", reason: "malformed", signer: null };
  }
  const signed = Buffer.concat([buf.subarray(a, a + b), buf.subarray(c, c + d)]);

  // The signature dictionary around this ByteRange: /SubFilter and /M.
  const dictStart = text.lastIndexOf("<<", m.index);
  const dict = text.slice(Math.max(0, dictStart), Math.min(text.length, c + 2000));
  const subFilter = dict.match(/\/SubFilter\s*\/([A-Za-z0-9.#_-]+)/)?.[1] ?? null;
  const mEntry = dict.match(/\/M\s*\((D:[^)]*)\)/)?.[1] ?? null;
  const signedAt = mEntry ? pdfDate(mEntry) : null;

  const r = verifyDetachedCms(cms, signed, { at: signedAt ? new Date(signedAt) : undefined });
  if (!r.ok) return { status: "invalid", reason: r.reason, signer: r.signer };
  return {
    status: "valid",
    signer: r.signer,
    signedAt,
    subFilter,
    pades:
      subFilter === "ETSI.CAdES.detached" && r.hasSigningCertificateV2 && r.signingTime === null,
  };
}

// ---------------------------------------------------------------------------------------------------------------------
// Personal approval signatures
// ---------------------------------------------------------------------------------------------------------------------

export type ApprovalSignatureCheck =
  | { status: "valid"; signer: CertInfo; statement: ApprovalStatement }
  | { status: "invalid"; reason: string; signer: CertInfo | null };

/**
 * Checks a stored personal signature: the statement is canonical and names the expected document, step, signer and
 * bound hash; its sha256 is the stored one; the CMS is valid over exactly that statement; and the certificate is the
 * one recorded at signing (fingerprint).
 */
export function verifyApprovalSignature(input: {
  cms: Uint8Array;
  statement: string;
  statementSha256: string;
  fingerprint: string;
  expect: {
    docType: ApprovalStatement["doc_type"];
    docId: string;
    step: ApprovalStatement["step"];
    signerId: string;
    boundSha256: string;
  };
}): ApprovalSignatureCheck {
  const s = parseStatement(input.statement);
  if (!s)
    return {
      status: "invalid",
      reason: "The signed statement is not in the expected form.",
      signer: null,
    };
  if (statementSha256(input.statement) !== input.statementSha256)
    return { status: "invalid", reason: "The stored statement was changed.", signer: null };
  const e = input.expect;
  if (
    s.doc_type !== e.docType ||
    s.doc_id !== e.docId ||
    s.step !== e.step ||
    s.signer_id !== e.signerId ||
    s.bound_sha256 !== e.boundSha256
  )
    return {
      status: "invalid",
      reason: "The signature is for a different document, step, person or content.",
      signer: null,
    };
  const r = verifyDetachedCms(input.cms, Buffer.from(input.statement, "utf8"), {
    at: new Date(s.signed_at),
  });
  if (!r.ok) return { status: "invalid", reason: VERIFY_FAILURE_TEXT[r.reason], signer: r.signer };
  if (r.signer.fingerprint !== input.fingerprint)
    return {
      status: "invalid",
      reason: VERIFY_FAILURE_TEXT.certificate_mismatch,
      signer: r.signer,
    };
  return { status: "valid", signer: r.signer, statement: s };
}
