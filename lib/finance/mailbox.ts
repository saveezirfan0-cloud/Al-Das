import { z } from "zod";

import { safeEqual } from "@/lib/integrations/webhook";
import { FINANCE_DOCUMENT_MAX_BYTES, MB } from "@/lib/media/limits";
import { sniffMime } from "@/lib/media/sniff";

/**
 * The finance mailbox (Phase 20B), pure part: reading a Postmark inbound message, the sender allow-list and what an
 * attachment really is. The server part (lib/finance/mailbox-server.ts) stores what passes.
 *
 * Only four things of a message are ever read: its MessageID (the idempotency key), the sender's address (to check the
 * allow-list; only its domain is kept), the receiving server's SPF and DKIM verdicts (to know the address is not forged;
 * reduced to one yes/no at once) and the attachments. The schema below drops everything else (body, subject, names, other
 * headers) before any code sees it, and no header is ever stored or logged. An attachment's declared type is ignored: its
 * bytes decide.
 */

export const MAILBOX_KIND = "finance_mailbox" as const;

/**
 * The largest request Pulse reads from the mail service. Vercel refuses a function request body over 4.5 MB before Pulse
 * sees it, and attachments travel base64-encoded (a third larger), so about 3 MB of attachments fit in one message.
 */
export const MAILBOX_MAX_REQUEST_BYTES = 4.5 * MB;

const attachmentSchema = z.object({
  Name: z.string().max(1000).optional().default(""),
  Content: z.string(),
  ContentType: z.string().max(200).optional().default(""),
  ContentID: z.string().max(1000).optional().default(""),
});

/** The two authentication headers read from Postmark's `Headers` list (every other header is dropped by the schema). */
const AUTH_HEADERS = ["received-spf", "x-spam-tests"] as const;

const headerSchema = z.object({ Name: z.string().max(200), Value: z.string().max(4000) });

/** Postmark's inbound JSON, cut down to the fields Pulse uses. Unknown keys (TextBody, HtmlBody, Subject...) are dropped. */
const inboundSchema = z.object({
  MessageID: z.string().trim().min(1).max(200),
  From: z.string().max(2000).optional().default(""),
  FromFull: z.object({ Email: z.string().max(400).optional() }).optional(),
  // only the authentication headers survive, and only until senderAuthenticated() has read them
  Headers: z
    .array(z.unknown())
    .max(500)
    .optional()
    .default([])
    .transform((list) =>
      list.flatMap((h) => {
        const p = headerSchema.safeParse(h);
        return p.success &&
          (AUTH_HEADERS as readonly string[]).includes(p.data.Name.trim().toLowerCase())
          ? [p.data]
          : [];
      }),
    ),
  Attachments: z.array(attachmentSchema).max(100).optional().default([]),
});

export type InboundAttachment = {
  /** Read only to recognise a CSV file; never stored or logged. */
  name: string;
  contentType: string;
  /** Base64, as the mail service sends it. */
  content: string;
  /** Set for images embedded in the message body (signature logos). */
  contentId: string;
};

export type InboundMessage = {
  messageId: string;
  /** Lower-case sender address, or null when there is none that looks like an address. */
  senderEmail: string | null;
  /** Whether the receiving server vouched for the sender's domain (SPF or DKIM, aligned); see senderAuthenticated(). */
  senderAuthenticated: boolean;
  attachments: InboundAttachment[];
};

const EMAIL = /^[^\s@<>()",;:]+@([a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z0-9-]{2,63}$/;
const DOMAIN = /^([a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z0-9-]{2,63}$/;

/** Parses the provider's JSON. Throws on anything that is not a Postmark inbound message (the route answers 400). */
export function parsePostmarkInbound(raw: string): InboundMessage {
  const parsed = inboundSchema.parse(JSON.parse(raw));
  const senderEmail = senderAddress(parsed.FromFull?.Email ?? "", parsed.From);
  return {
    messageId: parsed.MessageID,
    senderEmail,
    senderAuthenticated: senderAuthenticated(senderEmail, parsed.Headers),
    attachments: parsed.Attachments.map((a) => ({
      name: a.Name,
      contentType: a.ContentType,
      content: a.Content,
      contentId: a.ContentID,
    })),
  };
}

/** The sender's address from FromFull.Email, else from the From header ("Name <a@b>" or "a@b"). */
export function senderAddress(fullEmail: string, fromHeader: string): string | null {
  for (const candidate of [fullEmail, /<([^<>]+)>/.exec(fromHeader)?.[1] ?? fromHeader]) {
    const email = candidate.trim().toLowerCase();
    if (EMAIL.test(email)) return email;
  }
  return null;
}

export function domainOf(email: string): string {
  return email.slice(email.lastIndexOf("@") + 1);
}

/**
 * Relaxed alignment without a public-suffix list: the same domain, or one is a subdomain of the other, and the shorter one
 * has at least two labels (so "example" alone never aligns with everything under it).
 */
function aligned(a: string, b: string): boolean {
  const [x, y] = [a.toLowerCase().replace(/\.$/, ""), b.toLowerCase().replace(/\.$/, "")];
  if (!DOMAIN.test(x) || !DOMAIN.test(y)) return false;
  if (x === y) return true;
  const [short, long] = x.length <= y.length ? [x, y] : [y, x];
  return short.includes(".") && long.endsWith(`.${short}`);
}

/** The first header of that name: the one the receiving server added on top. The sender can only add lower ones. */
function topHeader(
  headers: readonly { Name: string; Value: string }[],
  name: string,
): string | null {
  return headers.find((h) => h.Name.trim().toLowerCase() === name)?.Value ?? null;
}

/**
 * Whether the From address is vouched for by the receiving mail service (Postmark inbound), so a forged From is not
 * enough to get a file into the inbox. True when either:
 *   - SPF: the topmost `Received-SPF` header says Pass for identity=mailfrom and its envelope-from domain is aligned with
 *     the From domain (same domain or a subdomain either way, e.g. a bounce domain), or
 *   - DKIM: the topmost `X-Spam-Tests` (Postmark's SpamAssassin result; SpamAssassin replaces any such header the sender
 *     wrote) lists DKIM_VALID_AU, a valid signature whose d= is the author's (From) domain. DKIM_VALID alone is a
 *     signature by some other domain: not enough.
 * A header the sender wrote (lower in the list) is never read, and neither is Authentication-Results, which Postmark's
 * documentation does not show it adding (a sender could write one). Header names follow Postmark's inbound documentation;
 * not yet verified against a live Postmark message.
 */
export function senderAuthenticated(
  senderEmail: string | null,
  headers: readonly { Name: string; Value: string }[] | undefined,
): boolean {
  if (!senderEmail || !headers?.length) return false;
  const fromDomain = domainOf(senderEmail.toLowerCase());

  const spf = topHeader(headers, "received-spf");
  if (spf) {
    const result = /^\s*([a-z]+)/i.exec(spf)?.[1]?.toLowerCase();
    const identity = /\bidentity=([a-z_]+)/i.exec(spf)?.[1]?.toLowerCase();
    const envelope = /\benvelope-from=<?([^\s;<>]+)>?/i.exec(spf)?.[1]?.toLowerCase() ?? "";
    if (
      result === "pass" &&
      (identity === undefined || identity === "mailfrom") &&
      envelope.includes("@") &&
      aligned(domainOf(envelope), fromDomain)
    )
      return true;
  }

  const tests = topHeader(headers, "x-spam-tests");
  if (tests && tests.split(",").some((t) => t.trim().toUpperCase() === "DKIM_VALID_AU"))
    return true;
  return false;
}

export type AllowEntry = { kind: "address" | "domain"; value: string };

/** "a@x.example, y.example @z.example" -> entries; anything that is neither an address nor a domain is listed as invalid. */
export function parseAllowList(text: unknown): { entries: AllowEntry[]; invalid: string[] } {
  const entries: AllowEntry[] = [];
  const invalid: string[] = [];
  for (const token of String(text ?? "").split(/[\s,;]+/)) {
    const t = token.trim().toLowerCase();
    if (!t) continue;
    if (t.includes("@") && !t.startsWith("@")) {
      if (EMAIL.test(t)) entries.push({ kind: "address", value: t });
      else invalid.push(token);
    } else {
      const d = t.replace(/^@/, "");
      if (DOMAIN.test(d)) entries.push({ kind: "domain", value: d });
      else invalid.push(token);
    }
  }
  return { entries, invalid };
}

/** A problem with the allow-list as typed in Settings, or null. */
export function allowListProblem(text: unknown): string | null {
  const { entries, invalid } = parseAllowList(text);
  if (invalid.length > 0)
    return `Allowed senders: "${invalid[0].slice(0, 60)}" is neither an e-mail address nor a domain.`;
  if (entries.length === 0) return "Allowed senders: add at least one address or domain.";
  if (entries.length > 100) return "Allowed senders: at most 100 entries.";
  return null;
}

/** An address matches itself; a domain matches every address at exactly that domain (not its subdomains). */
export function senderAllowed(email: string | null, entries: readonly AllowEntry[]): boolean {
  if (!email) return false;
  const e = email.toLowerCase();
  const domain = domainOf(e);
  return entries.some((x) => (x.kind === "address" ? x.value === e : x.value === domain));
}

/** What the inbox accepts from e-mail, by content. */
export const MAILBOX_TYPES = {
  pdf: { mime: "application/pdf", extension: "pdf" },
  jpeg: { mime: "image/jpeg", extension: "jpg" },
  png: { mime: "image/png", extension: "png" },
  csv: { mime: "text/csv", extension: "csv" },
  xlsx: {
    mime: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    extension: "xlsx",
  },
} as const;
export type MailboxType = (typeof MAILBOX_TYPES)[keyof typeof MAILBOX_TYPES];

/** Every Excel workbook (an Office Open XML zip) has this part; zip entry names are stored as plain text. */
const XLSX_MARKER = new TextEncoder().encode("xl/workbook.xml");

function contains(haystack: Uint8Array, needle: Uint8Array): boolean {
  outer: for (let i = 0; i + needle.length <= haystack.length; i++) {
    for (let j = 0; j < needle.length; j++) if (haystack[i + j] !== needle[j]) continue outer;
    return true;
  }
  return false;
}

/**
 * What an attachment really is, from its bytes; null when it is not one of the accepted types. The declared type cannot
 * make a file acceptable. Plain text is only taken as CSV when the sender also called it CSV (name or type): text alone
 * could be anything (a calendar invitation, a note).
 */
export function classifyAttachment(
  bytes: Uint8Array,
  declared: { name: string; contentType: string },
): MailboxType | null {
  const sniffed = sniffMime(bytes.subarray(0, 512));
  if (sniffed === "application/pdf") return MAILBOX_TYPES.pdf;
  if (sniffed === "image/jpeg") return MAILBOX_TYPES.jpeg;
  if (sniffed === "image/png") return MAILBOX_TYPES.png;
  if (sniffed === "application/zip" && contains(bytes, XLSX_MARKER)) return MAILBOX_TYPES.xlsx;
  if (
    sniffed === "text/plain" &&
    (/\.csv$/i.test(declared.name.trim()) ||
      declared.contentType.split(";")[0].trim().toLowerCase() === "text/csv")
  )
    return MAILBOX_TYPES.csv;
  return null;
}

export type AttachmentVerdict =
  | { ok: true; bytes: Uint8Array; type: MailboxType }
  | { ok: false; reason: "refused_size" | "refused_type" | "skipped_inline" };

/** Decodes and checks one attachment: size first, then content, then whether it is a picture embedded in the body. */
export function checkAttachment(a: InboundAttachment): AttachmentVerdict {
  const bytes = new Uint8Array(Buffer.from(a.content, "base64"));
  if (bytes.byteLength === 0 || bytes.byteLength > FINANCE_DOCUMENT_MAX_BYTES)
    return { ok: false, reason: "refused_size" };
  const type = classifyAttachment(bytes, a);
  if (!type) return { ok: false, reason: "refused_type" };
  // Logos and pictures in a signature come as images with a content id; a real attachment (even an image) has none.
  if (a.contentId.trim() && type.mime.startsWith("image/"))
    return { ok: false, reason: "skipped_inline" };
  return { ok: true, bytes, type };
}

/** The address to give Postmark as the inbound webhook (basic-auth user "pulse", the stored password). */
export function mailboxWebhookUrl(appUrl: string, accountId: string): string {
  const u = new URL(appUrl);
  return `${u.protocol}//${MAILBOX_WEBHOOK_USER}:<webhook password>@${u.host}${u.pathname.replace(/\/+$/, "")}/api/webhooks/integrations/finance_mailbox/${accountId}`;
}

/** The user name in the webhook address; the password is the stored secret. */
export const MAILBOX_WEBHOOK_USER = "pulse";

/** Checks the HTTP basic-auth header the mail service sends (constant-time, the length is not leaked either). */
export function basicAuthMatches(header: string | null, secret: string | undefined): boolean {
  if (!secret || !header) return false;
  const m = /^Basic\s+([A-Za-z0-9+/=]{4,1024})\s*$/i.exec(header);
  if (!m) return false;
  const decoded = Buffer.from(m[1], "base64").toString("utf8");
  return safeEqual(decoded, `${MAILBOX_WEBHOOK_USER}:${secret}`);
}
