/**
 * Browser-only image work: decode, rotate, trim, compress and make a thumbnail with the canvas API.
 * The decisions (sizes, qualities, retries) come from image-ops.ts and encode.ts, which are unit-tested;
 * this file is the thin canvas layer around them and is verified by hand in a browser (see the Phase 16 notes).
 */
import { encodeWithin, type Encoder } from "@/lib/media/encode";
import {
  cropRect,
  fitWithin,
  NO_INSETS,
  normaliseRotation,
  planCompression,
  rotatedSize,
  THUMB_EDGE,
  type Insets,
} from "@/lib/media/image-ops";

export type Decoded = {
  source: CanvasImageSource;
  width: number;
  height: number;
  close: () => void;
};

/** Decodes a picture, honouring the camera's orientation tag. HEIC works where the browser can show it. */
export async function decodeImage(file: Blob): Promise<Decoded> {
  if (typeof createImageBitmap === "function") {
    try {
      const bmp = await createImageBitmap(file, { imageOrientation: "from-image" });
      return { source: bmp, width: bmp.width, height: bmp.height, close: () => bmp.close() };
    } catch {
      // fall through to the <img> route
    }
  }
  const url = URL.createObjectURL(file);
  try {
    const img = new Image();
    img.decoding = "async";
    img.src = url;
    await img.decode();
    return {
      source: img,
      width: img.naturalWidth,
      height: img.naturalHeight,
      close: () => URL.revokeObjectURL(url),
    };
  } catch (err) {
    URL.revokeObjectURL(url);
    throw err;
  }
}

function canvasOf(width: number, height: number): HTMLCanvasElement {
  const c = document.createElement("canvas");
  c.width = Math.max(1, Math.round(width));
  c.height = Math.max(1, Math.round(height));
  return c;
}

/** The picture turned by `rotation` degrees, as a canvas. */
function rotated(src: Decoded, rotation: number): HTMLCanvasElement {
  const r = normaliseRotation(rotation);
  const size = rotatedSize(src.width, src.height, r);
  const c = canvasOf(size.width, size.height);
  const ctx = c.getContext("2d")!;
  ctx.translate(c.width / 2, c.height / 2);
  ctx.rotate((r * Math.PI) / 180);
  ctx.drawImage(src.source, -src.width / 2, -src.height / 2);
  return c;
}

export type EditOptions = {
  rotation?: number;
  insets?: Insets;
  maxBytes: number;
  maxEdge: number;
  /** Re-encode even when the file already fits (after a rotate or trim). */
  force?: boolean;
};

export type PreparedImage = {
  blob: Blob;
  mime: string;
  width: number;
  height: number;
  originalBytes: number;
  /** False when the original file was kept as it was. */
  changed: boolean;
};

/** Rotate, trim and compress to fit `maxBytes`. Returns null when the picture cannot be made small enough. */
export async function prepareImage(file: File, opts: EditOptions): Promise<PreparedImage | null> {
  const src = await decodeImage(file);
  try {
    const rotation = normaliseRotation(opts.rotation ?? 0);
    const insets = opts.insets ?? NO_INSETS;
    const edited = rotation !== 0 || JSON.stringify(insets) !== JSON.stringify(NO_INSETS);
    const rect = cropRect(
      rotatedSize(src.width, src.height, rotation).width,
      rotatedSize(src.width, src.height, rotation).height,
      insets,
    );
    const plan = planCompression(
      { width: rect.width, height: rect.height, bytes: file.size, mime: file.type },
      { maxBytes: opts.maxBytes, maxEdge: opts.maxEdge, force: opts.force || edited },
    );
    if (!plan.needed) {
      return {
        blob: file,
        mime: file.type,
        width: src.width,
        height: src.height,
        originalBytes: file.size,
        changed: false,
      };
    }
    const turned = rotated(src, rotation);
    const encode: Encoder<Blob> = (mime, quality, width, height) =>
      new Promise((resolve) => {
        const out = canvasOf(width, height);
        const ctx = out.getContext("2d")!;
        if (mime === "image/jpeg") {
          ctx.fillStyle = "#ffffff"; // JPEG has no transparency
          ctx.fillRect(0, 0, out.width, out.height);
        }
        ctx.imageSmoothingQuality = "high";
        ctx.drawImage(turned, rect.x, rect.y, rect.width, rect.height, 0, 0, out.width, out.height);
        out.toBlob((b) => resolve(b), mime, quality);
      });
    const result = await encodeWithin(plan, opts.maxBytes, encode);
    if (!result.ok) return null;
    return {
      blob: result.blob,
      mime: result.mime,
      width: result.width,
      height: result.height,
      originalBytes: file.size,
      changed: true,
    };
  } finally {
    src.close();
  }
}

/** A small JPEG preview for the library grid. */
export async function makeThumbnail(file: Blob): Promise<Blob | null> {
  const src = await decodeImage(file);
  try {
    const fit = fitWithin(src.width, src.height, THUMB_EDGE);
    const c = canvasOf(fit.width, fit.height);
    const ctx = c.getContext("2d")!;
    ctx.fillStyle = "#ffffff";
    ctx.fillRect(0, 0, c.width, c.height);
    ctx.drawImage(src.source, 0, 0, c.width, c.height);
    return await new Promise<Blob | null>((resolve) => c.toBlob(resolve, "image/jpeg", 0.7));
  } finally {
    src.close();
  }
}

/** Draws the rotated and trimmed picture into a preview canvas, scaled to fit `box` px. */
export function renderPreview(
  src: Decoded,
  canvas: HTMLCanvasElement,
  rotation: number,
  insets: Insets,
  box = 320,
): void {
  const r = normaliseRotation(rotation);
  const full = rotatedSize(src.width, src.height, r);
  const scale = Math.min(1, box / Math.max(full.width, full.height));
  const turned = canvasOf(full.width * scale, full.height * scale);
  const tctx = turned.getContext("2d")!;
  tctx.translate(turned.width / 2, turned.height / 2);
  tctx.rotate((r * Math.PI) / 180);
  tctx.drawImage(
    src.source,
    (-src.width * scale) / 2,
    (-src.height * scale) / 2,
    src.width * scale,
    src.height * scale,
  );
  const rect = cropRect(turned.width, turned.height, insets);
  canvas.width = rect.width;
  canvas.height = rect.height;
  const ctx = canvas.getContext("2d")!;
  ctx.drawImage(turned, rect.x, rect.y, rect.width, rect.height, 0, 0, rect.width, rect.height);
}
