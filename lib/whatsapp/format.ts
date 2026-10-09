/**
 * Parses WhatsApp message formatting (*bold*, _italic_, ~strike~, ```mono```) into a
 * small tree so previews render it safely without dangerouslySetInnerHTML. Pure.
 */
export type FormatNode =
  | { type: "text"; text: string }
  | { type: "bold" | "italic" | "strike"; children: FormatNode[] }
  | { type: "mono"; text: string };

const PATTERN =
  /```([\s\S]+?)```|\*([^\s*](?:[^*\n]*[^\s*])?)\*|_([^\s_](?:[^_\n]*[^\s_])?)_|~([^\s~](?:[^~\n]*[^\s~])?)~/g;

export function parseWhatsAppFormat(input: string, depth = 0): FormatNode[] {
  const out: FormatNode[] = [];
  let last = 0;
  for (const m of input.matchAll(PATTERN)) {
    const start = m.index ?? 0;
    // Markers must sit at a word boundary: not glued to a letter or digit on the outside.
    const before = start > 0 ? input[start - 1] : "";
    const after = input[start + m[0].length] ?? "";
    const glued =
      (m[2] || m[3] || m[4]) && (/[\p{L}\p{N}]/u.test(before) || /[\p{L}\p{N}]/u.test(after));
    if (glued) continue;
    if (start > last) out.push({ type: "text", text: input.slice(last, start) });
    if (m[1] !== undefined) out.push({ type: "mono", text: m[1] });
    else {
      const type = m[2] !== undefined ? "bold" : m[3] !== undefined ? "italic" : "strike";
      const inner = m[2] ?? m[3] ?? m[4] ?? "";
      out.push({
        type,
        children:
          depth < 3 ? parseWhatsAppFormat(inner, depth + 1) : [{ type: "text", text: inner }],
      });
    }
    last = start + m[0].length;
  }
  if (last < input.length) out.push({ type: "text", text: input.slice(last) });
  return out;
}
