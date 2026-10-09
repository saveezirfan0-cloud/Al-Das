import { createHash } from "node:crypto";

/** Turns fetched bytes into plain text for chunking. Unsupported types fail with a clear reason. */

export class UnsupportedContentError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "UnsupportedContentError";
  }
}

const ENTITIES: Record<string, string> = {
  amp: "&",
  lt: "<",
  gt: ">",
  quot: '"',
  apos: "'",
  nbsp: " ",
  ndash: "–",
  mdash: "—",
  hellip: "…",
  rsquo: "’",
  lsquo: "‘",
  rdquo: "”",
  ldquo: "“",
};

function decodeEntities(s: string): string {
  return s.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (m, e: string) => {
    if (e[0] === "#") {
      const code = e[1].toLowerCase() === "x" ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10);
      return Number.isFinite(code) && code > 0 && code < 0x110000 ? String.fromCodePoint(code) : m;
    }
    return ENTITIES[e.toLowerCase()] ?? m;
  });
}

export function htmlToText(html: string): { title: string | null; text: string } {
  const title = /<title[^>]*>([\s\S]*?)<\/title>/i.exec(html)?.[1];
  const body = html
    .replace(/<!--[\s\S]*?-->/g, " ")
    .replace(/<(script|style|noscript|svg|template|iframe|head|nav|footer)\b[\s\S]*?<\/\1>/gi, " ")
    .replace(/<\/(p|div|section|article|li|tr|h[1-6]|ul|ol|table|blockquote|br)\s*>/gi, "\n\n")
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<[^>]+>/g, " ");
  const text = decodeEntities(body)
    .replace(/[ \t\f\v]+/g, " ")
    .replace(/ *\n */g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
  return { title: title ? decodeEntities(title).replace(/\s+/g, " ").trim() || null : null, text };
}

export type Extracted = { text: string; title: string | null };

function kindOf(mime: string, filename: string | null | undefined): "html" | "text" | "pdf" | null {
  const m = mime.split(";")[0].trim().toLowerCase();
  const ext = filename?.split(".").pop()?.toLowerCase() ?? "";
  if (m === "application/pdf" || ext === "pdf") return "pdf";
  if (m === "text/html" || m === "application/xhtml+xml" || ext === "html" || ext === "htm") return "html";
  if (m.startsWith("text/") || ["txt", "md", "markdown", "csv"].includes(ext)) return "text";
  return null;
}

export async function extractText(input: {
  bytes: Uint8Array;
  mime: string;
  filename?: string | null;
}): Promise<Extracted> {
  const kind = kindOf(input.mime, input.filename);
  if (!kind) {
    throw new UnsupportedContentError("Unsupported file type. Use HTML, PDF, plain text or Markdown.");
  }
  if (kind === "pdf") {
    const { extractText: pdfText, getDocumentProxy } = await import("unpdf");
    const pdf = await getDocumentProxy(new Uint8Array(input.bytes));
    const { text } = await pdfText(pdf, { mergePages: true });
    return { text: text.trim(), title: null };
  }
  const decoded = new TextDecoder("utf-8", { fatal: false }).decode(input.bytes);
  if (kind === "html") return htmlToText(decoded);
  return { text: decoded.trim(), title: null };
}

export function contentHash(text: string): string {
  return createHash("sha256").update(text).digest("hex");
}
