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

/** Pages are untrusted input. Beyond this size the rest is ignored rather than risk a stalled worker. */
export const MAX_HTML_CHARS = 2_000_000;

const BLOCK_TAGS = ["script", "style", "noscript", "svg", "template", "iframe", "head", "nav", "footer"] as const;

/**
 * Removes <script>…</script>, <nav>…</nav> etc. in ONE linear pass. A regex like /<(script)[\s\S]*?<\/\1>/
 * is quadratic on input such as "<script " repeated (each unclosed opener rescans to the end), which a
 * hostile page can use to stall the worker. Here every tag's next position is cached and an opener with
 * no closer after it is simply skipped.
 */
function stripBlocks(html: string): string {
  const lower = html.toLowerCase();
  const lastClose = new Map<string, number>(BLOCK_TAGS.map((t) => [t, lower.lastIndexOf(`</${t}`)]));
  // Cache of each tag's next valid opener: a position, -2 = not searched yet, -1 = none left.
  const cache = new Map<string, number>(BLOCK_TAGS.map((t) => [t, -2]));

  function findOpen(tag: string, from: number): number {
    const cached = cache.get(tag)!;
    if (cached === -1) return -1;
    if (cached >= from) return cached; // still ahead of us, and nothing valid lies between
    let searchFrom = from;
    for (;;) {
      const p = lower.indexOf(`<${tag}`, searchFrom);
      if (p === -1) {
        cache.set(tag, -1);
        return -1;
      }
      // the tag name must end here (so <navigation> is not <nav>)
      if (!/[a-z0-9-]/.test(lower[p + 1 + tag.length] ?? "")) {
        cache.set(tag, p);
        return p;
      }
      searchFrom = p + 1;
    }
  }

  // Next ">" at or after a position, cached so repeated lookups stay linear overall.
  let gtCache = -2;
  function nextGt(from: number): number {
    if (gtCache === -1) return -1;
    if (gtCache < from) gtCache = lower.indexOf(">", from);
    return gtCache;
  }

  let out = "";
  let i = 0;
  while (i < html.length) {
    let tag = "";
    let start = -1;
    for (const t of BLOCK_TAGS) {
      const p = findOpen(t, i);
      if (p !== -1 && (start === -1 || p < start)) {
        start = p;
        tag = t;
      }
    }
    if (start === -1) break;
    out += html.slice(i, start);
    const closeAt = (lastClose.get(tag) ?? -1) >= start ? lower.indexOf(`</${tag}`, start) : -1;
    if (closeAt === -1) {
      // unclosed: drop just the opener itself (through its ">") so the remaining text still reads
      const gt = nextGt(start);
      out += " ";
      i = gt === -1 ? start + 1 + tag.length : gt + 1;
      continue;
    }
    const end = lower.indexOf(">", closeAt);
    i = end === -1 ? html.length : end + 1;
    out += " ";
  }
  return out + html.slice(i);
}

function findTitle(html: string): string | undefined {
  const lower = html.toLowerCase();
  const open = lower.indexOf("<title");
  if (open === -1) return undefined;
  const gt = lower.indexOf(">", open);
  const close = gt === -1 ? -1 : lower.indexOf("</title", gt);
  return gt === -1 || close === -1 ? undefined : html.slice(gt + 1, close);
}

/** Drops <!-- … --> comments in one pass; an unclosed comment ends the scan and the rest stays as text. */
function stripComments(html: string): string {
  let out = "";
  let i = 0;
  for (;;) {
    const open = html.indexOf("<!--", i);
    if (open === -1) break;
    const close = html.indexOf("-->", open + 4);
    if (close === -1) break;
    out += html.slice(i, open) + " ";
    i = close + 3;
  }
  return out + html.slice(i);
}

/**
 * Replaces every <…> with a space in one pass. (/<[^>]+>/g is quadratic on many "<" with no ">": each
 * "<" rescans to the end.) A "<" after the last ">" cannot start a tag, so the rest is kept as text.
 */
function stripTags(html: string): string {
  const lastGt = html.lastIndexOf(">");
  let out = "";
  let i = 0;
  while (i < html.length) {
    const lt = html.indexOf("<", i);
    if (lt === -1) break;
    out += html.slice(i, lt);
    if (lt > lastGt) {
      i = lt; // no ">" anywhere after: not a tag
      break;
    }
    const gt = html.indexOf(">", lt);
    out += " ";
    i = gt + 1;
  }
  return out + html.slice(i);
}

export function htmlToText(rawHtml: string): { title: string | null; text: string } {
  const html = rawHtml.length > MAX_HTML_CHARS ? rawHtml.slice(0, MAX_HTML_CHARS) : rawHtml;
  const title = findTitle(html);
  const withBreaks = stripBlocks(stripComments(html))
    .replace(/<\/(p|div|section|article|li|tr|h[1-6]|ul|ol|table|blockquote|br)\s*>/gi, "\n\n")
    .replace(/<br\s*\/?>/gi, "\n");
  const text = decodeEntities(stripTags(withBreaks))
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
