/**
 * The XML remittance advice reader (synthetic XML built here; element names are the public DHA schema, unverified against a
 * real file). It must produce the same lines as the spreadsheet path, ignore member and patient elements, and fail closed.
 */
import { describe, expect, it } from "vitest";

import {
  looksLikeRemittanceXml,
  remittanceXmlToTable,
  RemittanceFileError,
} from "@/lib/finance/parse-remittance-xml";
import { parseRemittanceTable, readRemittanceFile } from "@/lib/finance/parse-remittance";
import { reconcileRemittance, type RemitClaim } from "@/lib/finance/match-remittance";
import { REMITTANCE_XML } from "@/lib/finance/remittance-mapping";

const enc = (s: string) => new TextEncoder().encode(s);
const activity = (
  o: { code?: string; qty?: string; net?: string; paid?: string; denial?: string } = {},
) =>
  `<Activity><ID>9${o.code ?? "1"}</ID><Start>01/09/2026 10:00</Start><Type>3</Type>` +
  (o.code === "" ? "" : `<Code>${o.code ?? "99213"}</Code>`) +
  `<Quantity>${o.qty ?? "1"}</Quantity>` +
  (o.net === undefined ? "<Net>200.00</Net>" : o.net === "-" ? "" : `<Net>${o.net}</Net>`) +
  `<Clinician>SYN-DOC-1</Clinician>` +
  (o.paid === "-" ? "" : `<PaymentAmount>${o.paid ?? "180.00"}</PaymentAmount>`) +
  (o.denial ? `<DenialCode>${o.denial}</DenialCode>` : "") +
  `</Activity>`;
const claim = (acts: string, o: { id?: string; ref?: string } = {}) =>
  `<Claim><ID>${o.id ?? "ADMC/C/70001"}</ID><IDPayer>PAYER-A</IDPayer>` +
  `<MemberID>SYN-MEMBER-777</MemberID><EmiratesIDNumber>SYN-EID-555</EmiratesIDNumber>` +
  `<PatientName>Syn Patient</PatientName>` +
  (o.ref === "" ? "" : `<PaymentReference>${o.ref ?? "RM-77"}</PaymentReference>`) +
  `<DateSettlement>05/10/2026</DateSettlement>${acts}</Claim>`;
const doc = (body: string, root = "Remittance.Advice") =>
  `<?xml version="1.0" encoding="utf-8"?><${root}><Header><SenderID>SYN</SenderID><TransactionDate>05/10/2026</TransactionDate></Header>${body}</${root}>`;

const code = (f: () => unknown) => {
  try {
    f();
  } catch (e) {
    return e instanceof RemittanceFileError ? e.code : `other:${String(e)}`;
  }
  return "no error";
};

describe("remittanceXmlToTable", () => {
  it("turns claims and activities into lines the table parser accepts", () => {
    const xml = doc(
      claim(
        activity() + activity({ code: "99214", net: "300.00", paid: "240.00", denial: "AUTH-001" }),
      ),
    );
    const res = parseRemittanceTable(remittanceXmlToTable(enc(xml)));
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.rows).toHaveLength(2);
    expect(res.rows[0]).toMatchObject({
      remittance_ref: "RM-77",
      paid_on: "2026-10-05",
      payer_id: "PAYER-A",
      invoice_no: "ADMC/C/70001",
      cpt_code: "99213",
      quantity: 1,
      claimed_amount: 200,
      paid_amount: 180,
      denied_amount: 0, // no denial code: an unexplained shortfall stays a short payment
      denial_code: null,
    });
    expect(res.rows[1]).toMatchObject({
      paid_amount: 240,
      denied_amount: 60,
      denial_code: "AUTH-001",
    });
    expect(res.rows[0].claim_activity_number).toBeNull(); // matched by invoice + code, not the sequence id
  });

  it("never outputs member, patient or card elements", () => {
    const table = remittanceXmlToTable(enc(doc(claim(activity()))));
    const json = JSON.stringify(table);
    for (const secret of ["SYN-MEMBER-777", "SYN-EID-555", "Syn Patient", "SYN-DOC-1"])
      expect(json).not.toContain(secret);
    expect(REMITTANCE_XML.ignored).toContain("MemberID");
  });

  it("feeds the real matcher: invoice number + CPT code finds the claim", () => {
    const res = parseRemittanceTable(remittanceXmlToTable(enc(doc(claim(activity())))));
    if (!res.ok) throw new Error("expected ok");
    const claims: RemitClaim[] = [
      {
        id: "c1",
        claim_activity_number: "CA-1",
        invoice_no: "ADMC/C/70001",
        cpt_code: "99213",
        payer_id: "PAYER-A",
        quantity: 1,
        net: 200,
        transaction_date: "2026-09-01",
        activity_start_date: "2026-09-01",
      },
    ];
    const [r] = reconcileRemittance(res.rows, claims, [], {
      toleranceAmount: 1,
      tolerancePct: 0.01,
    });
    expect(r.match_status).toBe("matched");
    expect(r.flags).toContain("short_paid"); // 200 expected, 180 paid, no denial
  });

  it("reads UTF-16 and a byte order mark, case-insensitive element names, and a negative payment", () => {
    const xml = doc(claim(activity({ paid: "-25.00" }))).replace(/<(\/?)Claim>/g, "<$1CLAIM>");
    const utf16 = new Uint8Array([
      0xff,
      0xfe,
      ...Array.from(xml).flatMap((c) => [c.charCodeAt(0), 0]),
    ]);
    expect(looksLikeRemittanceXml(utf16)).toBe(true);
    const res = parseRemittanceTable(remittanceXmlToTable(utf16));
    expect(res.ok).toBe(true);
    if (res.ok) expect(res.rows[0].paid_amount).toBe(-25);
    expect(remittanceXmlToTable(enc("﻿" + doc(claim(activity()))))).toHaveLength(2);
  });

  it("is chosen by content, not file name", async () => {
    const xml = Buffer.from(doc(claim(activity())));
    expect((await readRemittanceFile(xml)).length).toBe(2);
    expect(looksLikeRemittanceXml(enc("a,b\n1,2"))).toBe(false);
    expect(looksLikeRemittanceXml(new Uint8Array([0x50, 0x4b, 0x03, 0x04]))).toBe(false);
  });

  it("fails closed on anything unexpected, with a code and no values", () => {
    const ok = claim(activity());
    expect(code(() => remittanceXmlToTable(enc(doc(ok, "Claim.Submission"))))).toBe(
      "xml_unexpected_root",
    );
    expect(code(() => remittanceXmlToTable(enc("<html></html>")))).toBe("xml_unexpected_root");
    expect(code(() => remittanceXmlToTable(enc(doc("").replace("</Header>", "</Header>"))))).toBe(
      "xml_no_claims",
    );
    expect(code(() => remittanceXmlToTable(enc(doc(ok).replace("</Remittance.Advice>", ""))))).toBe(
      "xml_truncated",
    );
    expect(code(() => remittanceXmlToTable(enc(doc(ok).replace("</Claim>", ""))))).toBe(
      "xml_malformed",
    );
    expect(code(() => remittanceXmlToTable(enc(doc(claim(activity(), { ref: "" })))))).toBe(
      "xml_claim_incomplete",
    );
    expect(code(() => remittanceXmlToTable(enc(doc(claim("")))))).toBe("xml_claim_incomplete");
    expect(code(() => remittanceXmlToTable(enc(doc(claim(activity({ paid: "-" }))))))).toBe(
      "xml_activity_incomplete",
    );
    expect(code(() => remittanceXmlToTable(enc(doc(claim(activity({ code: "" }))))))).toBe(
      "xml_activity_incomplete",
    );
    expect(code(() => remittanceXmlToTable(enc('<!DOCTYPE x [<!ENTITY a "b">]>' + doc(ok))))).toBe(
      "xml_not_allowed",
    );
    expect(code(() => remittanceXmlToTable(new Uint8Array(26 * 1024 * 1024).fill(0x20)))).toBe(
      "file_too_large",
    );
  });

  it("non-numeric amounts are rejected by the table parser, without echoing the value", () => {
    const res = parseRemittanceTable(
      remittanceXmlToTable(enc(doc(claim(activity({ paid: "12abc" }))))),
    );
    expect(res.ok).toBe(false);
    if (!res.ok) {
      expect(res.errors.map((e) => e.code)).toContain("invalid_number");
      expect(JSON.stringify(res.errors)).not.toContain("12abc");
    }
  });

  it("caps the number of lines", () => {
    const many = Array.from({ length: 30_001 }, () => activity()).join("");
    expect(code(() => remittanceXmlToTable(enc(doc(claim(many)))))).toBe("too_many_rows");
  });
});
