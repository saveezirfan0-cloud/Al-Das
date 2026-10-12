/**
 * Content sniffing (pure). The browser tells us a file's type; we do not believe it. After upload the server
 * reads the first bytes of the stored object and checks that they look like what was declared. This catches
 * renamed files (an .exe called .pdf) and truncated uploads. It is not a malware scan.
 */
import { normaliseMime } from "@/lib/media/limits";

export type Sniffed =
  | "image/jpeg"
  | "image/png"
  | "image/gif"
  | "image/webp"
  | "image/heic"
  | "application/pdf"
  | "video/mp4"
  | "video/3gpp"
  | "application/zip"
  | "application/x-ole"
  | "text/plain";

const startsWith = (b: Uint8Array, sig: number[], at = 0) =>
  b.length >= at + sig.length && sig.every((v, i) => b[at + i] === v);
const ascii = (b: Uint8Array, from: number, to: number) =>
  String.fromCharCode(...Array.from(b.slice(from, to)));

/** Looks at (at least) the first 32 bytes. Returns null when nothing recognisable is found. */
export function sniffMime(bytes: Uint8Array): Sniffed | null {
  if (startsWith(bytes, [0xff, 0xd8, 0xff])) return "image/jpeg";
  if (startsWith(bytes, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) return "image/png";
  if (ascii(bytes, 0, 4) === "GIF8") return "image/gif";
  if (ascii(bytes, 0, 4) === "RIFF" && ascii(bytes, 8, 12) === "WEBP") return "image/webp";
  if (ascii(bytes, 0, 5) === "%PDF-") return "application/pdf";
  if (ascii(bytes, 4, 8) === "ftyp") {
    const brand = ascii(bytes, 8, 12);
    if (/^(heic|heix|hevc|hevx|mif1|msf1)$/.test(brand)) return "image/heic";
    if (brand.startsWith("3gp")) return "video/3gpp";
    return "video/mp4";
  }
  if (startsWith(bytes, [0x50, 0x4b, 0x03, 0x04])) return "application/zip";
  if (startsWith(bytes, [0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1]))
    return "application/x-ole";
  if (bytes.length > 0 && !bytes.some((v) => v === 0) && isMostlyText(bytes)) return "text/plain";
  return null;
}

function isMostlyText(b: Uint8Array): boolean {
  let odd = 0;
  for (const v of b) if (v < 9 || (v > 13 && v < 32)) odd++;
  return odd === 0;
}

const OFFICE_ZIP = new Set([
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  "application/vnd.openxmlformats-officedocument.presentationml.presentation",
]);
const OFFICE_OLE = new Set([
  "application/msword",
  "application/vnd.ms-excel",
  "application/vnd.ms-powerpoint",
]);

/** Does what the bytes say fit what the browser declared? */
export function sniffMatches(
  declared: string | null | undefined,
  sniffed: Sniffed | null,
): boolean {
  const d = normaliseMime(declared);
  if (!sniffed) return false;
  if (OFFICE_ZIP.has(d)) return sniffed === "application/zip";
  if (OFFICE_OLE.has(d)) return sniffed === "application/x-ole";
  if (d === "image/heif") return sniffed === "image/heic";
  if (d === "video/3gpp") return sniffed === "video/3gpp" || sniffed === "video/mp4";
  if (d === "video/mp4") return sniffed === "video/mp4" || sniffed === "video/3gpp";
  if (d === "text/plain") return sniffed === "text/plain";
  return d === sniffed;
}
