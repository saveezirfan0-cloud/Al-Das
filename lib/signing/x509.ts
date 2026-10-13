import { createHash, X509Certificate } from "node:crypto";

import {
  bytesOf,
  childrenOf,
  decodeOid,
  DerError,
  expectTag,
  readNode,
  TAG,
  valueOf,
} from "@/lib/signing/der";

/**
 * What Pulse shows and stores about an X.509 certificate (pure; node:crypto parses, the DER reader finds the parts
 * node does not expose). Only public certificate data: subject, issuer, serial, validity, key usage, fingerprint.
 */

export type CertInfo = {
  /** "CN=..., O=..., C=..." */
  subject: string;
  subjectCn: string | null;
  issuer: string;
  issuerCn: string | null;
  /** Upper-case hex, no separators. */
  serialHex: string;
  /** sha256 of the DER certificate, lower-case hex. */
  fingerprint: string;
  validFrom: string;
  validTo: string;
  keyType: string;
  keyBits: number | null;
  /** null when the certificate has no key usage extension (then any use is allowed). */
  keyUsage: { digitalSignature: boolean; nonRepudiation: boolean } | null;
  selfSigned: boolean;
};

const KEY_USAGE_OID = "2.5.29.15";

function dn(s: string): string {
  return s
    .split("\n")
    .map((x) => x.trim())
    .filter(Boolean)
    .join(", ");
}

function cnOf(s: string): string | null {
  for (const part of s.split("\n")) {
    const m = part.trim().match(/^CN=(.*)$/);
    if (m) return m[1].trim() || null;
  }
  return null;
}

/** The pieces of the DER certificate CMS needs: the issuer Name and the serialNumber INTEGER, as encoded. */
export function certParts(der: Uint8Array): { issuer: Buffer; serial: Buffer; tbs: Buffer } {
  const cert = expectTag(readNode(der), TAG.SEQUENCE, "certificate");
  const [tbsNode] = childrenOf(der, cert);
  const tbs = expectTag(tbsNode, TAG.SEQUENCE, "tbsCertificate");
  const parts = childrenOf(der, tbs);
  let i = 0;
  if (parts[0]?.tag === 0xa0) i = 1; // [0] version
  const serial = expectTag(parts[i], TAG.INTEGER, "serial number");
  const issuer = expectTag(parts[i + 2], TAG.SEQUENCE, "issuer");
  return { issuer: bytesOf(der, issuer), serial: bytesOf(der, serial), tbs: bytesOf(der, tbs) };
}

function keyUsageOf(der: Uint8Array): CertInfo["keyUsage"] {
  const cert = readNode(der);
  const tbs = childrenOf(der, cert)[0];
  const ext = childrenOf(der, tbs).find((n) => n.tag === 0xa3);
  if (!ext) return null;
  const list = expectTag(childrenOf(der, ext)[0], TAG.SEQUENCE, "extensions");
  for (const e of childrenOf(der, list)) {
    const fields = childrenOf(der, e);
    if (decodeOid(valueOf(der, expectTag(fields[0], TAG.OID, "extension id"))) !== KEY_USAGE_OID)
      continue;
    const value = expectTag(fields[fields.length - 1], TAG.OCTET_STRING, "extension value");
    const inner = valueOf(der, value);
    const bits = valueOf(inner, expectTag(readNode(inner), TAG.BIT_STRING, "key usage"));
    const first = bits.length > 1 ? bits[1] : 0;
    return { digitalSignature: (first & 0x80) !== 0, nonRepudiation: (first & 0x40) !== 0 };
  }
  return null;
}

export function certInfo(der: Uint8Array): CertInfo {
  let x: X509Certificate;
  try {
    x = new X509Certificate(Buffer.from(der));
  } catch {
    throw new DerError("not an X.509 certificate");
  }
  const details = x.publicKey.asymmetricKeyDetails;
  return {
    subject: dn(x.subject),
    subjectCn: cnOf(x.subject),
    issuer: dn(x.issuer),
    issuerCn: cnOf(x.issuer),
    serialHex: x.serialNumber.toUpperCase().replace(/^0+(?=.)/, ""),
    fingerprint: createHash("sha256").update(der).digest("hex"),
    validFrom: new Date(x.validFrom).toISOString(),
    validTo: new Date(x.validTo).toISOString(),
    keyType: x.publicKey.asymmetricKeyType ?? "unknown",
    keyBits: details?.modulusLength ?? null,
    keyUsage: keyUsageOf(der),
    selfSigned: x.subject === x.issuer,
  };
}

/**
 * Why a certificate cannot be used to sign at `now` (empty = usable). Plain sentences for the settings pages and the
 * signing dialogs; never includes anything secret.
 */
export function certificateProblems(info: CertInfo, now: Date): string[] {
  const out: string[] = [];
  if (info.keyType !== "rsa") out.push("Only RSA certificates are supported.");
  else if (info.keyBits !== null && info.keyBits < 2048)
    out.push("The key is shorter than 2048 bits.");
  if (new Date(info.validFrom) > now) out.push("The certificate is not valid yet.");
  if (new Date(info.validTo) <= now) out.push("The certificate has expired.");
  if (info.keyUsage && !info.keyUsage.digitalSignature && !info.keyUsage.nonRepudiation)
    out.push("The certificate is not allowed to make digital signatures (key usage).");
  return out;
}
