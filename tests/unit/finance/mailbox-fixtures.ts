/**
 * Synthetic files and Postmark-style inbound messages for the finance mailbox tests. No real e-mail, invoice or person:
 * the "files" are a few bytes with the right signatures, the addresses use the reserved .example domain.
 */

const enc = (s: string) => new TextEncoder().encode(s);
const join = (...parts: Array<Uint8Array | number[]>) => {
  const all = parts.map((p) => (p instanceof Uint8Array ? p : new Uint8Array(p)));
  const out = new Uint8Array(all.reduce((n, p) => n + p.length, 0));
  let at = 0;
  for (const p of all) {
    out.set(p, at);
    at += p.length;
  }
  return out;
};

export const SAMPLE = {
  pdf: enc("%PDF-1.7\n% synthetic supplier invoice 0001\n1 0 obj << >> endobj\n%%EOF\n"),
  jpeg: join([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10], enc("JFIF synthetic photo of a paper invoice")),
  png: join([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a], enc("synthetic png")),
  gif: enc("GIF89a synthetic"),
  csv: enc("date,reference,amount\n2026-10-01,SYN-0001,100.00\n"),
  xlsx: join(
    [0x50, 0x4b, 0x03, 0x04, 0x14, 0x00],
    enc("[Content_Types].xml ... xl/workbook.xml ... xl/worksheets/sheet1.xml"),
  ),
  docx: join(
    [0x50, 0x4b, 0x03, 0x04, 0x14, 0x00],
    enc("[Content_Types].xml ... word/document.xml"),
  ),
  zip: join([0x50, 0x4b, 0x03, 0x04, 0x14, 0x00], enc("payload.exe")),
  exe: join(enc("MZ"), [0x90, 0x00, 0x03, 0x00, 0x00, 0x00]),
};

export type PostmarkAttachment = {
  Name?: string;
  Content: string;
  ContentType?: string;
  ContentLength?: number;
  ContentID?: string;
};

/** A Postmark inbound message with everything Pulse must NOT keep filled with recognisable synthetic text. */
export function postmarkMessage(
  o: { id?: string; from?: string; attachments?: PostmarkAttachment[] } = {},
): string {
  const from = o.from ?? "accounts@supplier-one.example";
  return JSON.stringify({
    MessageID: o.id ?? "00000000-0000-4000-8000-0000000000m1",
    From: `"Sam Sender" <${from}>`,
    FromName: "Sam Sender",
    FromFull: { Email: from, Name: "Sam Sender", MailboxHash: "" },
    To: "accounts@clinic.example",
    Subject: "Synthetic Subject 7",
    TextBody: "Synthetic body text for invoice 0042",
    HtmlBody: "<p>Synthetic html body</p>",
    StrippedTextReply: "Synthetic body text",
    Headers: [{ Name: "X-Synthetic-Header", Value: "Sam Sender" }],
    Attachments: (o.attachments ?? []).map((a) => ({ ContentLength: 0, ContentID: "", ...a })),
  });
}
