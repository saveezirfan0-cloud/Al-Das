import { describe, expect, it } from "vitest";

import { signDetached } from "@/lib/signing/cms";
import { readNode } from "@/lib/signing/der";
import { openP12, p12FromBase64, SigningError } from "@/lib/signing/p12";
import { sealPdf } from "@/lib/signing/pades";
import { approvalStatement, parseStatement, remarksHash } from "@/lib/signing/statement";
import {
  pdfDate,
  verifyApprovalSignature,
  verifyDetachedCms,
  verifyPdfSignature,
} from "@/lib/signing/verify";
import { certificateProblems } from "@/lib/signing/x509";

import { makeTestCert } from "./make-cert";

// Every certificate here is generated in the test with node-forge; names are synthetic.

async function samplePdf(text = "Approval certificate test"): Promise<Uint8Array> {
  const { PDFDocument, StandardFonts } = await import("pdf-lib");
  const doc = await PDFDocument.create();
  doc.setCreationDate(new Date(Date.UTC(2026, 9, 1)));
  doc.setModificationDate(new Date(Date.UTC(2026, 9, 1)));
  const page = doc.addPage([595, 842]);
  page.drawText(text, {
    x: 40,
    y: 800,
    size: 12,
    font: await doc.embedFont(StandardFonts.Helvetica),
  });
  doc.addPage([595, 842]);
  return doc.save();
}

describe("PKCS#12 soft certificates", () => {
  it("opens a .p12 with its PIN and reads the certificate details", () => {
    const t = makeTestCert({ cn: "Signer Test 01", withIssuer: true });
    const id = openP12(t.p12, t.pin);
    expect(id.key.asymmetricKeyType).toBe("rsa");
    expect(id.info.subjectCn).toBe("Signer Test 01");
    expect(id.info.issuerCn).toBe("Test Issuing CA");
    expect(id.info.subject).toContain("O=Clinic Test");
    expect(id.info.fingerprint).toMatch(/^[0-9a-f]{64}$/);
    expect(id.info.keyUsage).toEqual({ digitalSignature: true, nonRepudiation: true });
    expect(id.chainDer).toHaveLength(1);
    expect(certificateProblems(id.info, new Date())).toEqual([]);
  });

  it("refuses a wrong PIN with a clean error and never echoes it", () => {
    const t = makeTestCert();
    let err: unknown = null;
    try {
      openP12(t.p12, "not-the-pin");
    } catch (e) {
      err = e;
    }
    expect(err).toBeInstanceOf(SigningError);
    expect((err as SigningError).code).toBe("wrong_pin");
    expect((err as SigningError).message).not.toContain("not-the-pin");
  });

  it("refuses garbage, oversized input and bad base64", () => {
    expect(() => openP12(Buffer.from("not a p12 at all"), "x")).toThrow(SigningError);
    expect(() => openP12(Buffer.alloc(70 * 1024, 1), "x")).toThrow(/too large/);
    expect(() => p12FromBase64("%%%")).toThrow(SigningError);
    const t = makeTestCert();
    expect(p12FromBase64(t.p12.toString("base64")).equals(t.p12)).toBe(true);
  });

  it("flags expired, not-yet-valid and non-signing certificates", () => {
    const now = new Date();
    const expired = openP12(
      makeTestCert({
        notBefore: new Date(Date.UTC(2020, 0, 1)),
        notAfter: new Date(Date.UTC(2021, 0, 1)),
      }).p12,
      "1234-test",
    );
    expect(certificateProblems(expired.info, now)).toContain("The certificate has expired.");
    const future = openP12(
      makeTestCert({ notBefore: new Date(now.getTime() + 86400_000) }).p12,
      "1234-test",
    );
    expect(certificateProblems(future.info, now)).toContain("The certificate is not valid yet.");
    const noSign = openP12(makeTestCert({ signing: false }).p12, "1234-test");
    expect(certificateProblems(noSign.info, now)[0]).toMatch(/key usage/);
    const noExt = openP12(makeTestCert({ signing: null }).p12, "1234-test");
    expect(noExt.info.keyUsage).toBeNull();
    expect(certificateProblems(noExt.info, now)).toEqual([]);
  });
});

describe("detached CMS", () => {
  it("signs and verifies, and any change to the content or signature is caught", () => {
    const id = openP12(makeTestCert({ cn: "Signer Test 02" }).p12, "1234-test");
    const content = Buffer.from("hello, approval");
    const cms = signDetached({ content, identity: id, signingTime: new Date() });
    const ok = verifyDetachedCms(cms, content);
    expect(ok.ok).toBe(true);
    if (ok.ok) {
      expect(ok.signer.subjectCn).toBe("Signer Test 02");
      expect(ok.hasSigningCertificateV2).toBe(true);
      expect(ok.signingTime).not.toBeNull();
    }
    const changed = verifyDetachedCms(cms, Buffer.from("hello, approval!"));
    expect(changed).toMatchObject({ ok: false, reason: "digest_mismatch" });
    const bad = Buffer.from(cms);
    bad[bad.length - 5] ^= 0xff; // inside the RSA signature value
    expect(verifyDetachedCms(bad, content)).toMatchObject({ ok: false, reason: "bad_signature" });
    expect(verifyDetachedCms(Buffer.from([0x30, 0x03, 0x02, 0x01]), content)).toMatchObject({
      ok: false,
      reason: "malformed",
    });
  });

  it("encodes its signed attributes as sorted DER and is deterministic for the same input", () => {
    const id = openP12(makeTestCert().p12, "1234-test");
    const at = new Date(Date.UTC(2026, 9, 13, 10, 0, 0));
    const a = signDetached({ content: Buffer.from("x"), identity: id, signingTime: at });
    const b = signDetached({ content: Buffer.from("x"), identity: id, signingTime: at });
    expect(a.equals(b)).toBe(true);
    expect(readNode(a).end).toBe(a.length);
  });
});

describe("approval statements", () => {
  const base = {
    docType: "payment_voucher" as const,
    docId: "11111111-1111-4111-8111-111111111111",
    docRef: "PV-2026-0001",
    orgId: "22222222-2222-4222-8222-222222222222",
    step: "approve_ceo" as const,
    signerId: "33333333-3333-4333-8333-333333333333",
    boundSha256: "a".repeat(64),
    remarks: "  Looks right  ",
    signedAt: new Date(Date.UTC(2026, 9, 13, 9, 30, 15, 789)),
  };

  it("is canonical, carries the remarks hash only and parses back", () => {
    const s = approvalStatement(base);
    expect(s.text).not.toContain("Looks right");
    expect(s.statement.remarks_sha256).toBe(remarksHash("Looks right"));
    expect(s.statement.signed_at).toBe("2026-10-13T09:30:15.000Z");
    expect(parseStatement(s.text)).toEqual(s.statement);
    expect(parseStatement(s.text.replace('"v":1', '"v":1 '))).toBeNull();
    expect(approvalStatement({ ...base, remarks: "   " }).statement.remarks_sha256).toBeNull();
  });

  it("verifies the signed statement and rejects any other document, step, person or hash", () => {
    const id = openP12(makeTestCert({ cn: "Approver Test" }).p12, "1234-test");
    const s = approvalStatement({ ...base, signedAt: new Date() });
    const cms = signDetached({
      content: Buffer.from(s.text, "utf8"),
      identity: id,
      signingTime: new Date(s.statement.signed_at),
    });
    const expect0 = {
      docType: base.docType,
      docId: base.docId,
      step: base.step,
      signerId: base.signerId,
      boundSha256: base.boundSha256,
    };
    const ok = verifyApprovalSignature({
      cms,
      statement: s.text,
      statementSha256: s.sha256,
      fingerprint: id.info.fingerprint,
      expect: expect0,
    });
    expect(ok.status).toBe("valid");
    for (const wrong of [
      { boundSha256: "b".repeat(64) },
      { step: "check" as const },
      { signerId: "44444444-4444-4444-8444-444444444444" },
      { docId: "55555555-5555-4555-8555-555555555555" },
    ])
      expect(
        verifyApprovalSignature({
          cms,
          statement: s.text,
          statementSha256: s.sha256,
          fingerprint: id.info.fingerprint,
          expect: { ...expect0, ...wrong },
        }).status,
      ).toBe("invalid");
    expect(
      verifyApprovalSignature({
        cms,
        statement: s.text,
        statementSha256: s.sha256,
        fingerprint: "0".repeat(64),
        expect: expect0,
      }).status,
    ).toBe("invalid");
    const tampered = s.text.replace(base.boundSha256, "c".repeat(64));
    expect(
      verifyApprovalSignature({
        cms,
        statement: tampered,
        statementSha256: s.sha256,
        fingerprint: id.info.fingerprint,
        expect: expect0,
      }).status,
    ).toBe("invalid");
  });
});

describe("PAdES organisation seal", () => {
  it("seals a pdf-lib PDF: ByteRange covers the whole file, the digest and signer check out", async () => {
    const id = openP12(makeTestCert({ cn: "Seal Test Org", withIssuer: true }).p12, "1234-test");
    const at = new Date(Date.UTC(2026, 9, 13, 8, 0, 0));
    const sealed = await sealPdf(await samplePdf(), {
      identity: id,
      name: "Clinic Test seal",
      reason: "Approved in Pulse",
      location: "Dubai",
      signingTime: at,
    });
    const text = sealed.toString("latin1");
    expect(text.startsWith("%PDF-")).toBe(true);
    expect(text).toContain("/SubFilter /ETSI.CAdES.detached");
    const r = verifyPdfSignature(sealed);
    expect(r.status).toBe("valid");
    if (r.status === "valid") {
      expect(r.signer.subjectCn).toBe("Seal Test Org");
      expect(r.pades).toBe(true);
      expect(r.signedAt).toBe(at.toISOString());
    }
    const [a, b, c, d] = text
      .match(/\/ByteRange \[(\d+) (\d+) (\d+) (\d+)/)!
      .slice(1)
      .map(Number);
    expect(a).toBe(0);
    expect(c + d).toBe(sealed.length);
    expect(b).toBeGreaterThan(0);
  });

  it("reports one changed byte anywhere in the signed ranges as invalid", async () => {
    const id = openP12(makeTestCert().p12, "1234-test");
    const sealed = await sealPdf(await samplePdf("Amount AED 1,000.00"), {
      identity: id,
      name: "Seal",
      reason: "Approved",
      location: "Dubai",
      signingTime: new Date(),
    });
    const at = sealed.indexOf(Buffer.from("Amount AED 1,000.00"));
    const pos = at >= 0 ? at + 11 : 200; // the text may sit in a compressed stream; then flip a byte early in the file
    const tampered = Buffer.from(sealed);
    tampered[pos] = tampered[pos] === 0x31 ? 0x39 : 0x31;
    expect(verifyPdfSignature(tampered)).toMatchObject({ status: "invalid" });
    const appended = Buffer.concat([sealed, Buffer.from("\n% added later\n")]);
    expect(verifyPdfSignature(appended)).toMatchObject({
      status: "invalid",
      reason: "not_covering_whole_file",
    });
    expect(verifyPdfSignature(await samplePdf())).toEqual({ status: "not_signed" });
  });

  it("reads PDF dates", () => {
    expect(pdfDate("D:20261013080000Z")).toBe("2026-10-13T08:00:00.000Z");
    expect(pdfDate("D:20261013120000+04'00'")).toBe("2026-10-13T08:00:00.000Z");
    expect(pdfDate("garbage")).toBeNull();
  });
});
