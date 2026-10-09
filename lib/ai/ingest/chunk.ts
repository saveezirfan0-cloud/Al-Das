/**
 * Paragraph-aware chunking for embedding. Deterministic (same text → same chunks), so a re-crawl of
 * unchanged content produces identical chunks and the content hash short-circuits it entirely.
 */

export type ChunkOptions = { size?: number; overlap?: number };

function splitLong(paragraph: string, size: number, overlap: number): string[] {
  const out: string[] = [];
  let start = 0;
  while (start < paragraph.length) {
    let end = Math.min(start + size, paragraph.length);
    if (end < paragraph.length) {
      // Prefer to break at a sentence end, then a space, within the last 30% of the window.
      const window = paragraph.slice(start, end);
      const floor = Math.floor(size * 0.7);
      const sentence = Math.max(window.lastIndexOf(". "), window.lastIndexOf("? "), window.lastIndexOf("! "), window.lastIndexOf("۔ "));
      const space = window.lastIndexOf(" ");
      const cut = sentence >= floor ? sentence + 1 : space >= floor ? space : -1;
      if (cut > 0) end = start + cut;
    }
    const piece = paragraph.slice(start, end).trim();
    if (piece) out.push(piece);
    if (end >= paragraph.length) break;
    start = Math.max(end - overlap, start + 1);
  }
  return out;
}

export function chunkText(text: string, opts: ChunkOptions = {}): string[] {
  const size = opts.size ?? 800;
  const overlap = Math.min(opts.overlap ?? 100, Math.floor(size / 2));
  const paragraphs = text
    .replace(/\r\n?/g, "\n")
    .split(/\n\s*\n/)
    .map((p) => p.replace(/[ \t]+/g, " ").replace(/\n+/g, " ").trim())
    .filter(Boolean);

  const chunks: string[] = [];
  let current = "";
  const flush = () => {
    if (current.trim()) chunks.push(current.trim());
    current = "";
  };
  for (const p of paragraphs) {
    if (p.length > size) {
      flush();
      chunks.push(...splitLong(p, size, overlap));
      continue;
    }
    if (current && current.length + p.length + 2 > size) flush();
    current = current ? `${current}\n\n${p}` : p;
  }
  flush();
  return chunks;
}
