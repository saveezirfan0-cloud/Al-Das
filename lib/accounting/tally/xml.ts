/**
 * Reading a TallyPrime XML file (pure). This is the ONE place Pulse reads Tally XML: the file import (22I) and the live
 * Tally bridge (22J) both come through here.
 *
 * Tally's exports are not always valid XML 1.0: they may be UTF-16 (little or big endian, with or without a byte order
 * mark), and they carry `&#4;` (Tally's "blank" marker, as in `&#4; Not Applicable`) and other control characters that a
 * strict parser rejects. So this is a small, forgiving pull parser: it decodes the bytes, drops characters XML cannot
 * carry, and builds a tree only for each Tally object (GROUP, LEDGER, VOUCHER, ...) at a time, so a large file is never
 * held as one big tree. Anything outside an object is ignored except the report name and the company name.
 */

export const MAX_TALLY_BYTES = 200 * 1024 * 1024;
export const MAX_TALLY_OBJECTS = 400_000;

export type XNode = {
  name: string;
  attrs: Record<string, string>;
  children: XNode[];
  text: string;
};

export class TallyParseError extends Error {
  constructor(
    readonly code: "too_large" | "not_xml" | "too_many_objects" | "empty",
    message: string,
  ) {
    super(message);
    this.name = "TallyParseError";
  }
}

export type TallyEncoding = "utf-8" | "utf-16le" | "utf-16be";

/** The bytes as text: byte order marks first, then the "<\0" / "\0<" pattern of UTF-16 without a mark, else UTF-8. */
export function decodeTallyBytes(bytes: Uint8Array): { text: string; encoding: TallyEncoding } {
  if (bytes.length > MAX_TALLY_BYTES)
    throw new TallyParseError("too_large", "The file is larger than 200 MB.");
  let encoding: TallyEncoding = "utf-8";
  let start = 0;
  if (bytes[0] === 0xff && bytes[1] === 0xfe) {
    encoding = "utf-16le";
    start = 2;
  } else if (bytes[0] === 0xfe && bytes[1] === 0xff) {
    encoding = "utf-16be";
    start = 2;
  } else if (bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf) {
    start = 3;
  } else if (bytes.length >= 2 && bytes[0] !== 0 && bytes[1] === 0) {
    encoding = "utf-16le";
  } else if (bytes.length >= 2 && bytes[0] === 0 && bytes[1] !== 0) {
    encoding = "utf-16be";
  }
  let body = bytes.subarray(start);
  if (encoding === "utf-16be") {
    // swap to little endian (TextDecoder's utf-16be needs full ICU; this does not)
    const swapped = new Uint8Array(body.length - (body.length % 2));
    for (let i = 0; i + 1 < body.length; i += 2) {
      swapped[i] = body[i + 1];
      swapped[i + 1] = body[i];
    }
    body = swapped;
  }
  const text = new TextDecoder(encoding === "utf-8" ? "utf-8" : "utf-16le", {
    fatal: false,
  }).decode(body);
  return { text, encoding };
}

// Characters XML 1.0 cannot carry (C0 controls except tab, newline and return; U+FFFE / U+FFFF), which includes &#4;.
const BAD_CHARS = /[\u0000-\u0008\u000B\u000C\u000E-\u001F￾￿]/g;

const NAMED: Record<string, string> = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'" };

/** Entities decoded; a character reference to a control character (Tally's &#4;) is dropped, not kept. */
export function decodeEntities(raw: string): string {
  const s =
    raw.indexOf("&") < 0
      ? raw
      : raw.replace(/&(#x[0-9a-fA-F]+|#\d+|[a-zA-Z]+);/g, (m, ent: string) => {
          if (ent[0] === "#") {
            const code =
              ent[1] === "x" || ent[1] === "X"
                ? parseInt(ent.slice(2), 16)
                : parseInt(ent.slice(1), 10);
            if (!Number.isFinite(code) || code > 0x10ffff) return "";
            if (code < 0x20 && code !== 9 && code !== 10 && code !== 13) return "";
            if (code === 0xfffe || code === 0xffff || (code >= 0xd800 && code <= 0xdfff)) return "";
            return String.fromCodePoint(code);
          }
          return NAMED[ent] ?? m;
        });
  return s.replace(BAD_CHARS, "");
}

function parseAttrs(src: string): Record<string, string> {
  const attrs: Record<string, string> = {};
  const re = /([^\s=/]+)\s*=\s*("([^"]*)"|'([^']*)')/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(src))) attrs[m[1].toUpperCase()] = decodeEntities(m[3] ?? m[4] ?? "");
  return attrs;
}

/** The index of the '>' that ends the tag starting at `from`, skipping quoted attribute values. */
function tagEnd(s: string, from: number): number {
  let q: string | null = null;
  for (let i = from; i < s.length; i++) {
    const ch = s[i];
    if (q) {
      if (ch === q) q = null;
    } else if (ch === '"' || ch === "'") q = ch;
    else if (ch === ">") return i;
  }
  return -1;
}

export type ScanResult = {
  reportName: string | null;
  company: string | null;
  objects: number;
};

/**
 * Walks the document and calls `onObject` for every complete element whose name is in `objectNames` (outside another
 * object). Unbalanced closing tags are tolerated (closed up to the matching open tag, or ignored).
 */
export function scanTallyXml(
  text: string,
  objectNames: ReadonlySet<string>,
  onObject: (node: XNode) => void,
): ScanResult {
  const first = text.search(/\S/);
  if (first < 0) throw new TallyParseError("empty", "The file is empty.");
  if (text[first] !== "<") throw new TallyParseError("not_xml", "This is not an XML file.");
  const path: string[] = [];
  let stack: XNode[] = [];
  let reportName: string | null = null;
  let company: string | null = null;
  let objects = 0;
  let outsideText = "";
  let i = 0;
  const n = text.length;
  while (i < n) {
    const lt = text.indexOf("<", i);
    const chunk = text.slice(i, lt < 0 ? n : lt);
    if (stack.length > 0) {
      if (chunk) stack[stack.length - 1].text += decodeEntities(chunk);
    } else if (chunk.trim()) outsideText += chunk;
    if (lt < 0) break;
    if (text.startsWith("<!--", lt)) {
      const end = text.indexOf("-->", lt + 4);
      i = end < 0 ? n : end + 3;
      continue;
    }
    if (text.startsWith("<![CDATA[", lt)) {
      const end = text.indexOf("]]>", lt + 9);
      const raw = text.slice(lt + 9, end < 0 ? n : end);
      if (stack.length > 0) stack[stack.length - 1].text += raw.replace(BAD_CHARS, "");
      i = end < 0 ? n : end + 3;
      continue;
    }
    if (text[lt + 1] === "?" || text[lt + 1] === "!") {
      const end = tagEnd(text, lt + 1);
      i = end < 0 ? n : end + 1;
      continue;
    }
    const end = tagEnd(text, lt + 1);
    if (end < 0) break; // a truncated tag at the end of the file
    const raw = text.slice(lt + 1, end);
    i = end + 1;
    if (raw[0] === "/") {
      const name = raw.slice(1).trim().toUpperCase();
      const at = path.lastIndexOf(name);
      if (at < 0) continue; // a stray closing tag
      while (path.length > at) {
        const closing = path.pop()!;
        if (stack.length > 0) {
          const node = stack.pop()!;
          if (stack.length === 0) {
            objects++;
            if (objects > MAX_TALLY_OBJECTS)
              throw new TallyParseError(
                "too_many_objects",
                "The file holds too many records. Export it in parts.",
              );
            onObject(node);
          } else stack[stack.length - 1].children.push(node);
        } else if (closing === "REPORTNAME" && outsideText.trim()) {
          reportName = decodeEntities(outsideText).trim().slice(0, 120) || reportName;
        } else if (closing === "SVCURRENTCOMPANY" && outsideText.trim()) {
          company = decodeEntities(outsideText).trim().slice(0, 120) || company;
        }
        outsideText = "";
      }
      continue;
    }
    const selfClosing = raw.endsWith("/");
    const body = selfClosing ? raw.slice(0, -1) : raw;
    const sp = body.search(/\s/);
    const name = (sp < 0 ? body : body.slice(0, sp)).toUpperCase();
    if (!name) continue;
    const attrSrc = sp < 0 ? "" : body.slice(sp);
    outsideText = "";
    if (stack.length > 0 || objectNames.has(name)) {
      const node: XNode = {
        name,
        attrs: attrSrc ? parseAttrs(attrSrc) : {},
        children: [],
        text: "",
      };
      if (selfClosing) {
        if (stack.length > 0) stack[stack.length - 1].children.push(node);
        else {
          objects++;
          onObject(node);
        }
        continue;
      }
      stack.push(node);
    } else if (selfClosing) continue;
    path.push(name);
  }
  stack = [];
  return { reportName, company, objects };
}

// ---- small accessors over an object's tree ----

export function child(node: XNode, name: string): XNode | undefined {
  for (const c of node.children) if (c.name === name) return c;
  return undefined;
}

export function childrenNamed(node: XNode, name: string): XNode[] {
  return node.children.filter((c) => c.name === name);
}

/** The trimmed text of the first child with that name, or null when absent or blank. */
export function textOf(node: XNode, name: string): string | null {
  const c = child(node, name);
  if (!c) return null;
  const t = c.text.trim();
  return t === "" ? null : t;
}

/** Tally booleans are "Yes" / "No"; anything else is unknown (null). */
export function boolOf(node: XNode, name: string): boolean | null {
  const t = textOf(node, name);
  if (t === null) return null;
  if (/^yes$/i.test(t)) return true;
  if (/^no$/i.test(t)) return false;
  return null;
}

/** The object's name: the NAME attribute, else NAME.LIST/NAME, else LANGUAGENAME.LIST/NAME.LIST/NAME, else NAME. */
export function objectName(node: XNode): string | null {
  const attr = node.attrs.NAME?.trim();
  if (attr) return attr;
  const list = child(node, "NAME.LIST");
  if (list) {
    const t = textOf(list, "NAME");
    if (t) return t;
  }
  for (const lang of childrenNamed(node, "LANGUAGENAME.LIST")) {
    const nl = child(lang, "NAME.LIST");
    const t = nl ? textOf(nl, "NAME") : null;
    if (t) return t;
  }
  return textOf(node, "NAME");
}
