import { createPrivateKey, createPublicKey, X509Certificate, type KeyObject } from "node:crypto";

import forge from "node-forge";

import { certInfo, type CertInfo } from "@/lib/signing/x509";

/**
 * Opens a PKCS#12 (.p12 / .pfx) soft certificate with its PIN (server only: the result holds a private key and is never
 * logged, stored or returned to a browser). node-forge decrypts the PKCS#12 bags; node:crypto holds the key and signs.
 * Only RSA keys are accepted (see docs/22_PHASE_22C_NOTES.md).
 */

export const P12_MAX_BYTES = 64 * 1024;

export type SigningErrorCode =
  "wrong_pin" | "unreadable" | "too_large" | "no_key" | "no_certificate" | "unsupported_key";

export class SigningError extends Error {
  constructor(
    public readonly code: SigningErrorCode,
    message: string,
  ) {
    super(message);
    this.name = "SigningError";
  }
}

export const SIGNING_ERROR_TEXT: Record<SigningErrorCode, string> = {
  wrong_pin: "The certificate PIN is not correct.",
  unreadable: "The file is not a readable .p12 / .pfx certificate.",
  too_large: "The certificate file is too large (64 KB at most).",
  no_key: "The file holds no private key. Export the certificate together with its private key.",
  no_certificate: "The file holds no certificate for its private key.",
  unsupported_key: "Only RSA certificates are supported.",
};

export type SigningIdentity = {
  key: KeyObject;
  certDer: Buffer;
  /** The other certificates in the file (issuers), DER. */
  chainDer: Buffer[];
  info: CertInfo;
};

const bin = (b: Uint8Array) => Buffer.from(b).toString("binary");
const fromBin = (s: string) => Buffer.from(s, "binary");

export function openP12(p12: Uint8Array, passphrase: string): SigningIdentity {
  if (p12.length > P12_MAX_BYTES) throw new SigningError("too_large", SIGNING_ERROR_TEXT.too_large);
  let asn1: forge.asn1.Asn1;
  try {
    asn1 = forge.asn1.fromDer(forge.util.createBuffer(bin(p12)), false);
  } catch {
    throw new SigningError("unreadable", SIGNING_ERROR_TEXT.unreadable);
  }
  let bags: { key: forge.pkcs12.Bag[]; cert: forge.pkcs12.Bag[] };
  try {
    const p = forge.pkcs12.pkcs12FromAsn1(asn1, false, passphrase);
    bags = {
      key: [
        ...(p.getBags({ bagType: forge.pki.oids.pkcs8ShroudedKeyBag })[
          forge.pki.oids.pkcs8ShroudedKeyBag
        ] ?? []),
        ...(p.getBags({ bagType: forge.pki.oids.keyBag })[forge.pki.oids.keyBag] ?? []),
      ],
      cert: p.getBags({ bagType: forge.pki.oids.certBag })[forge.pki.oids.certBag] ?? [],
    };
  } catch (err) {
    const msg = err instanceof Error ? err.message : "";
    if (/password|mac could not be verified|decrypt|invalid/i.test(msg))
      throw new SigningError("wrong_pin", SIGNING_ERROR_TEXT.wrong_pin);
    throw new SigningError("unreadable", SIGNING_ERROR_TEXT.unreadable);
  }
  const keyBag = bags.key.find((b) => b.key || b.asn1);
  if (!keyBag) throw new SigningError("no_key", SIGNING_ERROR_TEXT.no_key);
  let key: KeyObject;
  try {
    const pkcs8 = keyBag.key
      ? forge.asn1.toDer(
          forge.pki.wrapRsaPrivateKey(
            forge.pki.privateKeyToAsn1(keyBag.key as forge.pki.rsa.PrivateKey),
          ),
        )
      : forge.asn1.toDer(keyBag.asn1 as forge.asn1.Asn1);
    key = createPrivateKey({ key: fromBin(pkcs8.getBytes()), format: "der", type: "pkcs8" });
  } catch {
    throw new SigningError("unreadable", SIGNING_ERROR_TEXT.unreadable);
  }
  if (key.asymmetricKeyType !== "rsa")
    throw new SigningError("unsupported_key", SIGNING_ERROR_TEXT.unsupported_key);

  const certs: Buffer[] = [];
  for (const b of bags.cert) {
    try {
      const asn = b.cert
        ? forge.pki.certificateToAsn1(b.cert)
        : (b as unknown as { asn1?: forge.asn1.Asn1 }).asn1;
      if (asn) certs.push(fromBin(forge.asn1.toDer(asn).getBytes()));
    } catch {
      /* a certificate forge cannot re-encode is skipped */
    }
  }
  const spki = createPublicKey(key).export({ type: "spki", format: "der" });
  const own = certs.find((c) => {
    try {
      return new X509Certificate(c).publicKey.export({ type: "spki", format: "der" }).equals(spki);
    } catch {
      return false;
    }
  });
  if (!own) throw new SigningError("no_certificate", SIGNING_ERROR_TEXT.no_certificate);
  return {
    key,
    certDer: own,
    chainDer: certs.filter((c) => c !== own),
    info: certInfo(own),
  };
}

/** Reads a .p12 given as base64 (the integration settings field). */
export function p12FromBase64(b64: string): Buffer {
  const clean = b64.replace(/\s+/g, "");
  if (!/^[A-Za-z0-9+/]+={0,2}$/.test(clean))
    throw new SigningError("unreadable", SIGNING_ERROR_TEXT.unreadable);
  const buf = Buffer.from(clean, "base64");
  if (buf.length > P12_MAX_BYTES) throw new SigningError("too_large", SIGNING_ERROR_TEXT.too_large);
  return buf;
}
