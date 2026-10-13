/**
 * Phase 20B, the finance mailbox (pure part): reading a Postmark inbound message, the sender allow-list, what an attachment
 * really is (by its bytes), the size cap, the basic-auth check and the webhook address. Synthetic messages and files only.
 */
import { describe, expect, it } from "vitest";

import {
  allowListProblem,
  basicAuthMatches,
  checkAttachment,
  classifyAttachment,
  mailboxWebhookUrl,
  MAILBOX_MAX_REQUEST_BYTES,
  parseAllowList,
  parsePostmarkInbound,
  senderAddress,
  senderAllowed,
  type InboundAttachment,
} from "@/lib/finance/mailbox";
import { FINANCE_DOCUMENT_MAX_BYTES } from "@/lib/media/limits";

import { postmarkMessage, SAMPLE } from "./mailbox-fixtures";

const b64 = (bytes: Uint8Array | string) => Buffer.from(bytes).toString("base64");
const att = (
  over: Partial<InboundAttachment> & { bytes?: Uint8Array | string },
): InboundAttachment => ({
  name: over.name ?? "file.bin",
  contentType: over.contentType ?? "application/octet-stream",
  content: over.content ?? b64(over.bytes ?? SAMPLE.pdf),
  contentId: over.contentId ?? "",
});

describe("parsePostmarkInbound", () => {
  it("keeps the MessageID, the sender's address and the attachments; drops body, subject, names and headers", () => {
    const raw = postmarkMessage({
      attachments: [
        {
          Name: "Invoice 0042 Synthetic.pdf",
          Content: b64(SAMPLE.pdf),
          ContentType: "application/pdf",
        },
      ],
    });
    const msg = parsePostmarkInbound(raw);
    expect(msg.messageId).toBe("00000000-0000-4000-8000-0000000000m1");
    expect(msg.senderEmail).toBe("accounts@supplier-one.example");
    expect(msg.attachments).toHaveLength(1);
    const text = JSON.stringify(msg);
    for (const secret of [
      "Synthetic Subject 7",
      "Synthetic body text",
      "<p>Synthetic html",
      "Sam Sender",
      "X-Synthetic-Header",
    ])
      expect(text).not.toContain(secret);
  });

  it("falls back to the From header, lower-cases the address and tolerates a message without attachments", () => {
    const raw = JSON.stringify({
      MessageID: "m-2",
      From: '"Sam Sender" <Accounts@Supplier-One.EXAMPLE>',
    });
    expect(parsePostmarkInbound(raw)).toEqual({
      messageId: "m-2",
      senderEmail: "accounts@supplier-one.example",
      attachments: [],
    });
  });

  it("throws on anything that is not an inbound message (the route answers 400)", () => {
    expect(() => parsePostmarkInbound("not json")).toThrow();
    expect(() => parsePostmarkInbound(JSON.stringify({ From: "a@b.example" }))).toThrow();
    expect(() =>
      parsePostmarkInbound(JSON.stringify({ MessageID: "m", Attachments: [{ Name: "x" }] })),
    ).toThrow();
  });

  it("finds no sender in nonsense", () => {
    expect(senderAddress("", "")).toBeNull();
    expect(senderAddress("", "Sam Sender")).toBeNull();
    expect(senderAddress("not an address", "<also not>")).toBeNull();
    expect(senderAddress("", "a@b.example")).toBe("a@b.example");
  });
});

describe("allow-list", () => {
  const list = parseAllowList(
    "accounts@supplier-one.example, Supplier-Two.example;@supplier-three.example\n",
  );

  it("reads addresses and domains (with or without @), case-insensitively", () => {
    expect(list).toEqual({
      entries: [
        { kind: "address", value: "accounts@supplier-one.example" },
        { kind: "domain", value: "supplier-two.example" },
        { kind: "domain", value: "supplier-three.example" },
      ],
      invalid: [],
    });
  });

  it("an address matches only itself; a domain matches its own addresses but not subdomains or look-alikes", () => {
    const e = list.entries;
    expect(senderAllowed("accounts@supplier-one.example", e)).toBe(true);
    expect(senderAllowed("ACCOUNTS@SUPPLIER-ONE.EXAMPLE", e)).toBe(true);
    expect(senderAllowed("sales@supplier-one.example", e)).toBe(false);
    expect(senderAllowed("anyone@supplier-two.example", e)).toBe(true);
    expect(senderAllowed("anyone@mail.supplier-two.example", e)).toBe(false);
    expect(senderAllowed("anyone@supplier-two.example.evil.example", e)).toBe(false);
    expect(senderAllowed("anyone@notsupplier-two.example", e)).toBe(false);
    expect(senderAllowed(null, e)).toBe(false);
    expect(senderAllowed("accounts@supplier-one.example", [])).toBe(false);
  });

  it("names the first bad entry and refuses an empty list", () => {
    expect(allowListProblem("ok.example, not-a-domain, x@")).toMatch(/not-a-domain/);
    expect(allowListProblem("  ,  ")).toMatch(/at least one/);
    expect(allowListProblem("ok.example")).toBeNull();
    expect(
      allowListProblem(Array.from({ length: 101 }, (_, i) => `s${i}.example`).join(" ")),
    ).toMatch(/100/);
  });
});

describe("attachments are judged by their bytes", () => {
  it("accepts PDF, JPEG, PNG and Excel whatever they claim to be", () => {
    const lie = { name: "photo.exe", contentType: "application/x-msdownload" };
    expect(classifyAttachment(SAMPLE.pdf, lie)?.mime).toBe("application/pdf");
    expect(classifyAttachment(SAMPLE.jpeg, lie)?.mime).toBe("image/jpeg");
    expect(classifyAttachment(SAMPLE.png, lie)?.mime).toBe("image/png");
    expect(classifyAttachment(SAMPLE.xlsx, lie)?.extension).toBe("xlsx");
  });

  it("refuses what is not on the list even when it claims to be a PDF: executables, Word, other zips, GIF, HTML", () => {
    const claim = { name: "invoice.pdf", contentType: "application/pdf" };
    expect(classifyAttachment(SAMPLE.exe, claim)).toBeNull();
    expect(classifyAttachment(SAMPLE.docx, claim)).toBeNull();
    expect(classifyAttachment(SAMPLE.zip, claim)).toBeNull();
    expect(classifyAttachment(SAMPLE.gif, claim)).toBeNull();
    expect(
      classifyAttachment(new TextEncoder().encode("<html><script>x</script></html>"), claim),
    ).toBeNull();
  });

  it("takes plain text as CSV only when the sender also called it CSV; binary is never CSV", () => {
    expect(classifyAttachment(SAMPLE.csv, { name: "statement.CSV", contentType: "" })?.mime).toBe(
      "text/csv",
    );
    expect(
      classifyAttachment(SAMPLE.csv, { name: "x", contentType: "text/csv; charset=utf-8" })?.mime,
    ).toBe("text/csv");
    expect(
      classifyAttachment(SAMPLE.csv, { name: "invite.ics", contentType: "text/calendar" }),
    ).toBeNull();
    expect(
      classifyAttachment(SAMPLE.exe, { name: "statement.csv", contentType: "text/csv" }),
    ).toBeNull();
  });

  it("refuses empty and oversized files before looking at them", () => {
    expect(checkAttachment(att({ content: "" }))).toEqual({ ok: false, reason: "refused_size" });
    const big = new Uint8Array(FINANCE_DOCUMENT_MAX_BYTES + 1);
    big.set(SAMPLE.pdf);
    expect(checkAttachment(att({ bytes: big }))).toEqual({ ok: false, reason: "refused_size" });
  });

  it("skips pictures embedded in the message body (signature logos) but keeps an embedded PDF", () => {
    expect(checkAttachment(att({ bytes: SAMPLE.png, contentId: "logo@synthetic" }))).toEqual({
      ok: false,
      reason: "skipped_inline",
    });
    expect(checkAttachment(att({ bytes: SAMPLE.png })).ok).toBe(true);
    expect(checkAttachment(att({ bytes: SAMPLE.pdf, contentId: "doc@synthetic" })).ok).toBe(true);
    expect(checkAttachment(att({ bytes: SAMPLE.exe }))).toEqual({
      ok: false,
      reason: "refused_type",
    });
  });

  it("decodes the base64 exactly", () => {
    const r = checkAttachment(att({ bytes: SAMPLE.pdf }));
    expect(r.ok && Buffer.from(r.bytes).equals(Buffer.from(SAMPLE.pdf))).toBe(true);
  });
});

describe("webhook authentication and address", () => {
  const secret = "S".repeat(30);
  const header = (v: string) => `Basic ${Buffer.from(v).toString("base64")}`;

  it("accepts only user pulse with the stored password", () => {
    expect(basicAuthMatches(header(`pulse:${secret}`), secret)).toBe(true);
    expect(basicAuthMatches(header(`pulse:${secret}x`), secret)).toBe(false);
    expect(basicAuthMatches(header(`other:${secret}`), secret)).toBe(false);
    expect(basicAuthMatches(header(`pulse:`), secret)).toBe(false);
    expect(basicAuthMatches(`Bearer ${secret}`, secret)).toBe(false);
    expect(basicAuthMatches(null, secret)).toBe(false);
    expect(basicAuthMatches(header("pulse:"), "")).toBe(false);
    expect(basicAuthMatches(header("pulse:undefined"), undefined)).toBe(false);
  });

  it("shows the address with a placeholder, never the password, and caps a request below Vercel's body limit", () => {
    expect(mailboxWebhookUrl("https://pulse.example/", "acc-1")).toBe(
      "https://pulse:<webhook password>@pulse.example/api/webhooks/integrations/finance_mailbox/acc-1",
    );
    expect(MAILBOX_MAX_REQUEST_BYTES).toBeLessThanOrEqual(4.5 * 1024 * 1024);
  });
});
