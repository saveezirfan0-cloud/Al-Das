/**
 * Image geometry and compression planning (pure; unit-tested). The canvas work itself lives in
 * client-image.ts and only follows the plan made here, so the decisions can be tested without a browser.
 */

export type Rotation = 0 | 90 | 180 | 270;

export function normaliseRotation(deg: number): Rotation {
  const r = (((Math.round(deg / 90) * 90) % 360) + 360) % 360;
  return r as Rotation;
}

/** Size of an image after turning it by `deg` (a quarter turn swaps width and height). */
export function rotatedSize(
  width: number,
  height: number,
  deg: number,
): { width: number; height: number } {
  const r = normaliseRotation(deg);
  return r === 90 || r === 270 ? { width: height, height: width } : { width, height };
}

/** Scales (never up) so the longest edge is at most `maxEdge`. */
export function fitWithin(
  width: number,
  height: number,
  maxEdge: number,
): { width: number; height: number; scale: number } {
  const longest = Math.max(width, height);
  if (!(longest > 0) || !(maxEdge > 0) || longest <= maxEdge) return { width, height, scale: 1 };
  const scale = maxEdge / longest;
  return {
    width: Math.max(1, Math.round(width * scale)),
    height: Math.max(1, Math.round(height * scale)),
    scale,
  };
}

/** Fractions of each edge to trim, 0 to 0.8. */
export type Insets = { top: number; right: number; bottom: number; left: number };

export const NO_INSETS: Insets = { top: 0, right: 0, bottom: 0, left: 0 };

const clamp = (v: number, lo: number, hi: number) =>
  Math.min(hi, Math.max(lo, Number.isFinite(v) ? v : 0));

/**
 * The rectangle that remains after trimming. Insets are clamped so at least 10% of each side survives
 * and the rectangle is never smaller than 16 px, so a stray slider can never produce an empty image.
 */
export function cropRect(
  width: number,
  height: number,
  insets: Insets,
): { x: number; y: number; width: number; height: number } {
  const maxTrim = 0.45;
  let left = clamp(insets.left, 0, maxTrim);
  let right = clamp(insets.right, 0, maxTrim);
  let top = clamp(insets.top, 0, maxTrim);
  let bottom = clamp(insets.bottom, 0, maxTrim);
  if (left + right > 0.9) {
    const k = 0.9 / (left + right);
    left *= k;
    right *= k;
  }
  if (top + bottom > 0.9) {
    const k = 0.9 / (top + bottom);
    top *= k;
    bottom *= k;
  }
  const x = Math.round(width * left);
  const y = Math.round(height * top);
  const w = Math.max(Math.min(16, width), Math.round(width * (1 - left - right)));
  const h = Math.max(Math.min(16, height), Math.round(height * (1 - top - bottom)));
  return {
    x: Math.min(x, Math.max(0, width - w)),
    y: Math.min(y, Math.max(0, height - h)),
    width: Math.min(w, width),
    height: Math.min(h, height),
  };
}

export type CompressionInput = { width: number; height: number; bytes: number; mime: string };

export type CompressionPlan = {
  /** False when the file already fits: it is uploaded untouched. */
  needed: boolean;
  width: number;
  height: number;
  /** Encodings to try in order; the first whose result fits `maxBytes` wins. */
  attempts: Array<{ mime: "image/jpeg" | "image/png"; quality: number }>;
};

export const JPEG_LADDER = [0.86, 0.76, 0.66, 0.54, 0.42] as const;

/**
 * Decides whether an image needs re-encoding and how. A PNG stays a PNG when only its dimensions are
 * trimmed (screenshots, logos with transparency) and falls back to JPEG when that is still too big.
 * Anything that is not JPEG or PNG (WebP, HEIC from a phone) is always re-encoded, because WhatsApp
 * cannot send it.
 */
export function planCompression(
  input: CompressionInput,
  opts: { maxBytes: number; maxEdge: number; force?: boolean },
): CompressionPlan {
  const fit = fitWithin(input.width, input.height, opts.maxEdge);
  const mime = input.mime.toLowerCase();
  const supported = mime === "image/jpeg" || mime === "image/png";
  const needed = !!opts.force || !supported || input.bytes > opts.maxBytes || fit.scale < 1;
  const jpeg = JPEG_LADDER.map((quality) => ({ mime: "image/jpeg" as const, quality }));
  const attempts =
    mime === "image/png" ? [{ mime: "image/png" as const, quality: 1 }, ...jpeg] : jpeg;
  return { needed, width: fit.width, height: fit.height, attempts };
}

/** First attempt index whose size fits, or -1 when none does (the caller then refuses the file). */
export function firstFitting(sizes: readonly number[], maxBytes: number): number {
  return sizes.findIndex((s) => s > 0 && s <= maxBytes);
}

/** Edge of the grid thumbnail the library stores next to every image. */
export const THUMB_EDGE = 320;
