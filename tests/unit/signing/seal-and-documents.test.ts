import { describe, expect, it } from "vitest";

import { buildClosePack, type ClosePackInput } from "@/lib/finance/close-pack";
import { closePackPdf } from "@/lib/finance/close-pdf";
import { voucherCertificatePdf, type VoucherCertificate } from "@/lib/finance/voucher-certificate";
import { allFields, validateFields } from "@/lib/integrations/catalog";
import { readinessProblems } from "@/lib/integrations/readiness";
import { currentSignatures, type StoredSignature } from "@/lib/signing/approvals";
import { signDetached } from "@/lib/signing/cms";
import { openP12 } from "@/lib/signing/p12";
import { sealPdf } from "@/lib/signing/pades";
import { NOT_SEALED_LINE, signingLines, type SigningSection } from "@/lib/signing/pdf-text";
import { checkSealSecrets, sealConfig } from "@/lib/signing/seal";
import { approvalStatement } from "@/lib/signing/statement";
import { verifyPdfSignature } from "@/lib/signing/verify";

import fixture from "../finance/fixtures/phase18-close.synthetic.json";
import { makeTestCert } from "./make-cert";

// Synthetic certificates generated here (node-forge), synthetic names, no real people or documents.

describe("organisation seal settings (catalogue readiness)", () => {
  const good = makeTestCert({ cn: "Seal Test Org" });
  const secrets = { certificate: good.p12.toString("base64"), passphrase: good.pin };

  it("opens the stored certificate with its password and reports what is wrong without echoing secrets", () => {
    const ok = checkSealSecrets(secrets, new Date());
    expect(ok.ok).toBe(true);
    const wrong = checkSealSecrets({ ...secrets, passphrase: "wrong-password" }, new Date());
    expect(wrong).toMatchObject({ ok: false, info: null });
    if (!wrong.ok) {
      expect(wrong.problems[0]).toBe("The certificate password is not correct.");
      expect(wrong.problems.join(" ")).not.toContain("wrong-password");
    }
    const expired = makeTestCert({
      notBefore: new Date(Date.UTC(2020, 0, 1)),
      notAfter: new Date(Date.UTC(2021, 0, 1)),
    });
    const exp = checkSealSecrets(
      { certificate: expired.p12.toString("base64"), passphrase: expired.pin },
      new Date(),
    );
    expect(exp.ok).toBe(false);
    if (!exp.ok) expect(exp.problems).toContain("The certificate has expired.");
    const noSign = makeTestCert({ signing: false });
    const ns = checkSealSecrets(
      { certificate: noSign.p12.toString("base64"), passphrase: noSign.pin },
      new Date(),
    );
    expect(ns.ok).toBe(false);
    expect(checkSealSecrets({}, new Date())).toMatchObject({ ok: false });
  });

  it("feeds readinessProblems: missing fields, unchecked and certificate problems block switching on", () => {
    const base = {
      kind: "document_seal" as const,
      provider: "p12",
      config: { seal_name: "Clinic Test seal" },
    };
    expect(
      readinessProblems({ ...base, secretsStored: { certificate: false, passphrase: false } }),
    ).toEqual(["Certificate file (.p12 / .pfx) is missing.", "Certificate password is missing."]);
    expect(
      readinessProblems({ ...base, secretsStored: { certificate: true, passphrase: true } }),
    ).toEqual(["The stored certificate has not been checked yet."]);
    expect(
      readinessProblems({
        ...base,
        secretsStored: { certificate: true, passphrase: true },
        seal: { problems: ["The certificate has expired."] },
      }),
    ).toEqual(["The certificate has expired."]);
    expect(
      readinessProblems({
        ...base,
        secretsStored: { certificate: true, passphrase: true },
        seal: { problems: [] },
      }),
    ).toEqual([]);
    expect(
      readinessProblems({
        ...base,
        config: {},
        secretsStored: { certificate: true, passphrase: true },
        seal: { problems: [] },
      }),
    ).toEqual(["Name shown with the seal is missing."]);
  });

  it("validates the settings form: the file as base64 is a secret, defaults for reason and location", () => {
    const fields = allFields("document_seal", "p12");
    const r = validateFields(fields, {
      certificate: secrets.certificate,
      passphrase: secrets.passphrase,
      seal_name: "Clinic Test seal",
    });
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(Object.keys(r.secrets).sort()).toEqual(["certificate", "passphrase"]);
      expect(r.config).toMatchObject({ seal_name: "Clinic Test seal" });
      expect(sealConfig(r.config).reason).toBe("Approved and recorded in Pulse");
    }
    expect(
      validateFields(fields, { certificate: "not base64!", passphrase: "x", seal_name: "S" }).ok,
    ).toBe(false);
  });
});

const voucher = (signing?: SigningSection): VoucherCertificate => ({
  org: "Clinic Test",
  voucherNo: "PV-2026-0009",
  voucherDate: "2026-10-05",
  payeeName: "Supplier Test 02",
  supplierName: null,
  amount: 18000,
  currency: "AED",
  category: "Equipment",
  special: "none",
  branchCode: "P",
  costCentre: null,
  payFrom: "BANK-MAIN",
  paymentMethod: "bank_transfer",
  narration: "Test equipment",
  status: "approved",
  route: "pulse",
  tier: "T3",
  needsDept: false,
  needsCeo: true,
  contentHash: "a".repeat(64),
  currentHash: "a".repeat(64),
  invoices: [],
  documents: [{ kind: "supplier_invoice", sha256: "b".repeat(64), sizeBytes: 1000 }],
  events: [
    {
      at: "2026-10-05T08:00:00.000Z",
      action: "ceo_approved",
      actor: "Approver Test",
      fromStatus: "checked",
      toStatus: "approved",
      remarks: null,
      hash: "a".repeat(64),
    },
  ],
  payment: null,
  timezone: "Asia/Dubai",
  signing,
});

describe("signed approval certificate and close pack", () => {
  const sig = {
    stepLabel: "Authorised (CEO)",
    signer: "Approver Test",
    subject: "CN=Approver Test, O=Clinic Test, C=AE",
    issuer: "CN=Test Issuing CA, O=Test CA",
    serial: "0A1B",
    fingerprint: "c".repeat(64),
    validFrom: "2026-01-01T00:00:00.000Z",
    validTo: "2027-01-01T00:00:00.000Z",
    signedAt: "2026-10-05T08:00:00.000Z",
    result: "valid",
  };

  it("prints the signatures and the seal line, or the visible 'not sealed' line", () => {
    const off = signingLines({ signatures: [sig], seal: { state: "off" } }, (s) => s);
    expect(off.map((l) => l.text)).toContain(NOT_SEALED_LINE);
    expect(off.map((l) => l.text).join("\n")).toContain("Approver Test");
    expect(off.map((l) => l.text).join("\n")).toContain(`sha256 ${"c".repeat(64)}`);
    const sealed = signingLines(
      {
        signatures: [],
        seal: {
          state: "sealed",
          name: "Clinic Test seal",
          at: "2026-10-05T08:00:00.000Z",
          subject: "CN=Seal Test Org",
          fingerprint: "d".repeat(64),
        },
      },
      (s) => s,
    );
    expect(sealed.map((l) => l.text).join("\n")).toContain("Sealed by Clinic Test seal");
    expect(sealed.map((l) => l.text).join("\n")).not.toContain(NOT_SEALED_LINE);
  });

  it("renders the certificate with its signatures deterministically, then seals it into a valid PAdES PDF", async () => {
    const section: SigningSection = { signatures: [sig], seal: { state: "off" } };
    const a = await voucherCertificatePdf(voucher(section));
    const b = await voucherCertificatePdf(voucher(section));
    expect(a.equals(b)).toBe(true);
    const id = openP12(makeTestCert({ cn: "Seal Test Org" }).p12, "1234-test");
    // inside the test certificate's validity (it starts a day before now); PDF times have whole seconds
    const at = new Date(Math.floor(Date.now() / 1000) * 1000);
    const sealedPdf = await sealPdf(
      await voucherCertificatePdf(
        voucher({
          signatures: [sig],
          seal: {
            state: "sealed",
            name: "Clinic Test seal",
            at: at.toISOString(),
            subject: id.info.subject,
            fingerprint: id.info.fingerprint,
          },
        }),
      ),
      {
        identity: id,
        name: "Clinic Test seal",
        reason: "Approved",
        location: "Dubai",
        signingTime: at,
      },
    );
    const r = verifyPdfSignature(sealedPdf);
    expect(r).toMatchObject({ status: "valid", pades: true, signedAt: at.toISOString() });
    const tampered = Buffer.from(sealedPdf);
    tampered[400] ^= 0x01;
    expect(verifyPdfSignature(tampered).status).toBe("invalid");
  });

  it("prints the visible 'not sealed' line and the signatures in the voucher certificate and the close pack", async () => {
    const { extractText, getDocumentProxy } = await import("unpdf");
    const textOf = async (b: Buffer) => {
      const { text } = await extractText(await getDocumentProxy(new Uint8Array(b)), {
        mergePages: true,
      });
      return (Array.isArray(text) ? text.join("\n") : text).replace(/\s+/g, " ");
    };
    const v = await textOf(
      await voucherCertificatePdf(voucher({ signatures: [sig], seal: { state: "off" } })),
    );
    expect(v).toContain(NOT_SEALED_LINE);
    expect(v).toContain("Authorised (CEO): Approver Test");
    const pack = buildClosePack(fixture as unknown as ClosePackInput);
    const unsigned = {
      financeBy: null,
      financeAt: null,
      financeNote: null,
      ceoBy: null,
      ceoAt: null,
      ceoNote: null,
      lockedAt: null,
      hash: null,
    };
    const c = await textOf(
      await closePackPdf(pack, unsigned, { signatures: [sig], seal: { state: "off" } }),
    );
    expect(c).toContain("Digital signatures");
    expect(c).toContain(NOT_SEALED_LINE);
    expect(await textOf(await closePackPdf(pack, unsigned))).not.toContain("Digital signatures");
  });
});

describe("which stored signatures count for the current approvals", () => {
  const ids = {
    doc: "11111111-1111-4111-8111-111111111111",
    org: "22222222-2222-4222-8222-222222222222",
    ceo: "33333333-3333-4333-8333-333333333333",
    other: "44444444-4444-4444-8444-444444444444",
  };
  const id = openP12(makeTestCert({ cn: "Approver Test" }).p12, "1234-test");
  const row = (o: {
    user: string;
    hash: string;
    at: string;
    signer?: string;
    tamper?: boolean;
  }): StoredSignature => {
    const s = approvalStatement({
      docType: "payment_voucher",
      docId: ids.doc,
      docRef: "PV-2026-0009",
      orgId: ids.org,
      step: "approve_ceo",
      signerId: o.signer ?? o.user,
      boundSha256: o.hash,
      remarks: null,
      signedAt: new Date(),
    });
    const cms = signDetached({
      content: Buffer.from(s.text),
      identity: id,
      signingTime: new Date(s.statement.signed_at),
    });
    return {
      id: `${o.user}-${o.at}`,
      step: "approve_ceo",
      user_id: o.user,
      statement: o.tamper ? s.text.replace("PV-2026-0009", "PV-2026-0010") : s.text,
      statement_sha256: s.sha256,
      bound_sha256: o.hash,
      cms,
      cert_subject: id.info.subject,
      cert_subject_cn: id.info.subjectCn,
      cert_issuer: id.info.issuer,
      cert_issuer_cn: id.info.issuerCn,
      cert_serial: id.info.serialHex,
      cert_fingerprint: id.info.fingerprint,
      cert_valid_from: id.info.validFrom,
      cert_valid_to: id.info.validTo,
      step_at: o.at,
    };
  };
  const A = "a".repeat(64);
  const B = "b".repeat(64);

  it("keeps only the signature stored with the current step, by its holder, over the current hash", () => {
    const rows = [
      row({ user: ids.ceo, hash: B, at: "2026-10-01T08:00:00.123456+00:00" }), // an earlier approval of other content
      row({ user: ids.ceo, hash: A, at: "2026-10-05T08:00:00.654321+00:00" }),
      row({ user: ids.other, hash: A, at: "2026-10-05T08:00:00.654321+00:00" }),
    ];
    const out = currentSignatures({
      docType: "payment_voucher",
      docId: ids.doc,
      boundSha256: A,
      steps: [{ step: "approve_ceo", userId: ids.ceo, at: "2026-10-05T08:00:00.654321+00:00" }],
      rows,
    });
    expect(out).toHaveLength(1);
    expect(out[0]).toMatchObject({
      userId: ids.ceo,
      status: "valid",
      stepLabel: "Authorised (CEO)",
    });
    expect(
      currentSignatures({
        docType: "payment_voucher",
        docId: ids.doc,
        boundSha256: A,
        steps: [{ step: "approve_ceo", userId: ids.ceo, at: "2026-10-06T00:00:00Z" }],
        rows,
      }),
    ).toEqual([]);
    expect(
      currentSignatures({
        docType: "payment_voucher",
        docId: ids.doc,
        boundSha256: null,
        steps: [],
        rows,
      }),
    ).toEqual([]);
  });

  it("shows a stored signature whose statement was altered as invalid", () => {
    const at = "2026-10-05T08:00:00+00:00";
    const out = currentSignatures({
      docType: "payment_voucher",
      docId: ids.doc,
      boundSha256: A,
      steps: [{ step: "approve_ceo", userId: ids.ceo, at }],
      rows: [row({ user: ids.ceo, hash: A, at, tamper: true })],
    });
    expect(out[0].status).toBe("invalid");
  });
});
