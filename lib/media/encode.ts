/**
 * The retry loop behind image compression (pure, so it is tested with a fake encoder; the real encoder is the
 * browser canvas in client-image.ts). It walks the plan's encodings from best to smallest, and if even the
 * smallest is too big it shrinks the picture and tries again, at most three times.
 */
import type { CompressionPlan } from "@/lib/media/image-ops";

export type Encoder<B extends { size: number }> = (
  mime: "image/jpeg" | "image/png",
  quality: number,
  width: number,
  height: number,
) => Promise<B | null>;

export type EncodeOutcome<B extends { size: number }> =
  | {
      ok: true;
      blob: B;
      mime: "image/jpeg" | "image/png";
      width: number;
      height: number;
      shrinks: number;
    }
  | { ok: false };

export async function encodeWithin<B extends { size: number }>(
  plan: Pick<CompressionPlan, "width" | "height" | "attempts">,
  maxBytes: number,
  encode: Encoder<B>,
  maxShrinks = 3,
): Promise<EncodeOutcome<B>> {
  let width = plan.width;
  let height = plan.height;
  for (let shrinks = 0; shrinks <= maxShrinks; shrinks++) {
    for (const attempt of plan.attempts) {
      const blob = await encode(attempt.mime, attempt.quality, width, height);
      if (blob && blob.size > 0 && blob.size <= maxBytes)
        return { ok: true, blob, mime: attempt.mime, width, height, shrinks };
    }
    width = Math.max(1, Math.round(width * 0.8));
    height = Math.max(1, Math.round(height * 0.8));
  }
  return { ok: false };
}
