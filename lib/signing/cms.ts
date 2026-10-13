import { createHash, sign as rsaSign } from "node:crypto";

import { ctx, int, nul, octets, oid, seq, setOf, tlv, time } from "@/lib/signing/der";
import type { SigningIdentity } from "@/lib/signing/p12";
import { certParts } from "@/lib/signing/x509";

/**
 * Detached CMS SignedData (RFC 5652), the signature format of both a PAdES PDF signature (ETSI.CAdES.detached) and a
 * personal approval statement. SHA-256 with RSA (PKCS#1 v1.5). Signed attributes: content type, message digest and the
 * ESS signing-certificate-v2 (RFC 5035, required by PAdES and CAdES baseline); signing time only when asked for (PAdES
 * forbids it: the time is the PDF's /M entry). No timestamp token (that needs a TSA, i.e. a network call).
 */

export const OID = {
  data: "1.2.840.113549.1.7.1",
  signedData: "1.2.840.113549.1.7.2",
  contentType: "1.2.840.113549.1.9.3",
  messageDigest: "1.2.840.113549.1.9.4",
  signingTime: "1.2.840.113549.1.9.5",
  signingCertificateV2: "1.2.840.113549.1.9.16.2.47",
  sha256: "2.16.840.1.101.3.4.2.1",
  rsaEncryption: "1.2.840.113549.1.1.1",
  sha256WithRsa: "1.2.840.113549.1.1.11",
} as const;

const attribute = (type: string, value: Buffer) => seq(oid(type), setOf([value]));

export type DetachedSignInput = {
  content: Uint8Array;
  identity: Pick<SigningIdentity, "key" | "certDer" | "chainDer">;
  /** Adds the CMS signing-time attribute (statements). Leave out for PAdES. */
  signingTime?: Date;
};

export function signDetached(input: DetachedSignInput): Buffer {
  const { key, certDer, chainDer } = input.identity;
  const { issuer, serial } = certParts(certDer);
  const digest = createHash("sha256").update(input.content).digest();
  const certHash = createHash("sha256").update(certDer).digest();
  // IssuerSerial ::= SEQUENCE { issuer GeneralNames (directoryName [4] EXPLICIT Name), serialNumber }
  const issuerSerial = seq(seq(ctx(4, issuer)), serial);
  // ESSCertIDv2 with the default hash algorithm (sha256) left out, as DER requires
  const signingCertV2 = seq(seq(seq(octets(certHash), issuerSerial)));

  const attrs = [
    attribute(OID.contentType, oid(OID.data)),
    attribute(OID.messageDigest, octets(digest)),
    attribute(OID.signingCertificateV2, signingCertV2),
  ];
  if (input.signingTime) attrs.push(attribute(OID.signingTime, time(input.signingTime)));

  // The signature covers the attributes encoded as a SET OF (tag 0x31); they travel as [0] IMPLICIT (tag 0xa0).
  const signedSet = setOf(attrs);
  const signedImplicit = Buffer.concat([Buffer.from([0xa0]), signedSet.subarray(1)]);
  const signature = rsaSign("sha256", signedSet, key);

  const digestAlg = seq(oid(OID.sha256));
  const signerInfo = seq(
    int(1),
    seq(issuer, serial),
    digestAlg,
    signedImplicit,
    seq(oid(OID.rsaEncryption), nul()),
    octets(signature),
  );
  const signedData = seq(
    int(1),
    setOf([digestAlg]),
    seq(oid(OID.data)),
    setOf([certDer, ...chainDer], 0xa0),
    setOf([signerInfo]),
  );
  return seq(oid(OID.signedData), tlv(0xa0, signedData));
}
