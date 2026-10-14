import forge from "node-forge";

/**
 * Throwaway certificates for the signing tests, generated on the fly with node-forge. Synthetic names only; nothing here
 * is a real certificate or key, and nothing is written to disk or committed.
 */

export type TestCert = {
  p12: Buffer;
  pin: string;
  certPem: string;
};

const keyCache = new Map<number, forge.pki.rsa.KeyPair>();

function keys(bits: number, fresh: boolean): forge.pki.rsa.KeyPair {
  if (!fresh && keyCache.has(bits)) return keyCache.get(bits)!;
  const k = forge.pki.rsa.generateKeyPair({ bits, e: 0x10001 });
  if (!fresh) keyCache.set(bits, k);
  return k;
}

export function makeTestCert(
  o: {
    cn?: string;
    pin?: string;
    notBefore?: Date;
    notAfter?: Date;
    /** false = a key usage extension WITHOUT digitalSignature / nonRepudiation; undefined = both; null = no extension. */
    signing?: boolean | null;
    bits?: number;
    /** Include a separate (synthetic) issuer certificate in the file. */
    withIssuer?: boolean;
    fresh?: boolean;
    serial?: string;
  } = {},
): TestCert {
  const pin = o.pin ?? "1234-test";
  const kp = keys(o.bits ?? 2048, o.fresh ?? false);
  const now = Date.now();
  const issuerKp = o.withIssuer ? keys(2048, true) : kp;
  const subject = [
    { name: "commonName", value: o.cn ?? "Seal Test Org" },
    { name: "organizationName", value: "Clinic Test" },
    { name: "countryName", value: "AE" },
  ];
  const issuerAttrs = o.withIssuer
    ? [
        { name: "commonName", value: "Test Issuing CA" },
        { name: "organizationName", value: "Test CA" },
      ]
    : subject;

  const cert = forge.pki.createCertificate();
  cert.publicKey = kp.publicKey;
  cert.serialNumber = o.serial ?? "0" + Math.floor(Math.random() * 1e12).toString(16);
  // A fixed past start, so tests that sign at a fixed date stay inside the validity window whatever day they run on.
  cert.validity.notBefore = o.notBefore ?? new Date(Date.UTC(2020, 0, 1));
  cert.validity.notAfter = o.notAfter ?? new Date(now + 365 * 24 * 3600_000);
  cert.setSubject(subject);
  cert.setIssuer(issuerAttrs);
  const exts: object[] = [{ name: "basicConstraints", cA: false }];
  if (o.signing !== null)
    exts.push(
      o.signing === false
        ? {
            name: "keyUsage",
            keyEncipherment: true,
            digitalSignature: false,
            nonRepudiation: false,
          }
        : { name: "keyUsage", digitalSignature: true, nonRepudiation: true },
    );
  cert.setExtensions(exts);
  cert.sign(issuerKp.privateKey, forge.md.sha256.create());

  const chain = [cert];
  if (o.withIssuer) {
    const ca = forge.pki.createCertificate();
    ca.publicKey = issuerKp.publicKey;
    ca.serialNumber = "0a";
    ca.validity.notBefore = new Date(now - 48 * 3600_000);
    ca.validity.notAfter = new Date(now + 2 * 365 * 24 * 3600_000);
    ca.setSubject(issuerAttrs);
    ca.setIssuer(issuerAttrs);
    ca.setExtensions([{ name: "basicConstraints", cA: true }]);
    ca.sign(issuerKp.privateKey, forge.md.sha256.create());
    chain.push(ca);
  }
  const asn1 = forge.pkcs12.toPkcs12Asn1(kp.privateKey, chain, pin, { algorithm: "aes256" });
  return {
    p12: Buffer.from(forge.asn1.toDer(asn1).getBytes(), "binary"),
    pin,
    certPem: forge.pki.certificateToPem(cert),
  };
}
