import { describe, expect, it } from "vitest";

import {
  cropRect,
  firstFitting,
  fitWithin,
  NO_INSETS,
  normaliseRotation,
  planCompression,
  rotatedSize,
} from "@/lib/media/image-ops";

describe("rotation", () => {
  it("normalises any multiple of 90", () => {
    expect([0, 90, 180, 270, 360, -90, 450].map(normaliseRotation)).toEqual([
      0, 90, 180, 270, 0, 270, 90,
    ]);
  });
  it("swaps the sides on a quarter turn only", () => {
    expect(rotatedSize(400, 300, 90)).toEqual({ width: 300, height: 400 });
    expect(rotatedSize(400, 300, 270)).toEqual({ width: 300, height: 400 });
    expect(rotatedSize(400, 300, 180)).toEqual({ width: 400, height: 300 });
  });
});

describe("fitWithin", () => {
  it("never scales up and keeps the ratio", () => {
    expect(fitWithin(800, 600, 2048)).toEqual({ width: 800, height: 600, scale: 1 });
    expect(fitWithin(4000, 3000, 2000)).toEqual({ width: 2000, height: 1500, scale: 0.5 });
    expect(fitWithin(3000, 4000, 2000)).toMatchObject({ width: 1500, height: 2000 });
  });
  it("copes with nonsense", () => {
    expect(fitWithin(0, 0, 100).scale).toBe(1);
    expect(fitWithin(10, 10, 0).scale).toBe(1);
  });
});

describe("cropRect", () => {
  it("keeps everything with no trim", () => {
    expect(cropRect(1000, 500, NO_INSETS)).toEqual({ x: 0, y: 0, width: 1000, height: 500 });
  });
  it("trims by fractions", () => {
    expect(cropRect(1000, 500, { top: 0.1, right: 0.2, bottom: 0, left: 0.1 })).toEqual({
      x: 100,
      y: 50,
      width: 700,
      height: 450,
    });
  });
  it("can never produce an empty or out-of-bounds rectangle", () => {
    for (const insets of [
      { top: 5, right: 5, bottom: 5, left: 5 },
      { top: -3, right: NaN, bottom: Infinity, left: 0.9 },
      { top: 0.6, right: 0.6, bottom: 0.6, left: 0.6 },
    ]) {
      const r = cropRect(200, 100, insets);
      expect(r.width).toBeGreaterThanOrEqual(16);
      expect(r.height).toBeGreaterThanOrEqual(16);
      expect(r.x).toBeGreaterThanOrEqual(0);
      expect(r.y).toBeGreaterThanOrEqual(0);
      expect(r.x + r.width).toBeLessThanOrEqual(200);
      expect(r.y + r.height).toBeLessThanOrEqual(100);
    }
  });
});

describe("planCompression", () => {
  const opts = { maxBytes: 5 * 1024 * 1024, maxEdge: 2048 };
  it("leaves a small JPEG alone", () => {
    expect(
      planCompression({ width: 1200, height: 800, bytes: 300_000, mime: "image/jpeg" }, opts)
        .needed,
    ).toBe(false);
  });
  it("re-encodes a large phone photo", () => {
    const p = planCompression(
      { width: 4032, height: 3024, bytes: 4_000_000, mime: "image/jpeg" },
      opts,
    );
    expect(p).toMatchObject({ needed: true, width: 2048, height: 1536 });
    expect(p.attempts[0].mime).toBe("image/jpeg");
    expect(p.attempts.map((a) => a.quality)).toEqual(
      [...p.attempts.map((a) => a.quality)].sort((a, b) => b - a),
    );
  });
  it("always re-encodes what WhatsApp cannot send (WebP, HEIC)", () => {
    for (const mime of ["image/webp", "image/heic"])
      expect(planCompression({ width: 100, height: 100, bytes: 1000, mime }, opts).needed).toBe(
        true,
      );
  });
  it("lets a PNG stay PNG first and falls back to JPEG", () => {
    const p = planCompression({ width: 3000, height: 3000, bytes: 1000, mime: "image/png" }, opts);
    expect(p.attempts[0].mime).toBe("image/png");
    expect(p.attempts.slice(1).every((a) => a.mime === "image/jpeg")).toBe(true);
  });
  it("can be forced (after a rotate or crop)", () => {
    expect(
      planCompression(
        { width: 100, height: 100, bytes: 1000, mime: "image/jpeg" },
        { ...opts, force: true },
      ).needed,
    ).toBe(true);
  });
  it("picks the first encoding that fits", () => {
    expect(firstFitting([9, 7, 4, 2], 5)).toBe(2);
    expect(firstFitting([9, 7], 5)).toBe(-1);
    expect(firstFitting([0, 3], 5)).toBe(1);
  });
});

describe("encodeWithin (compression retry loop)", () => {
  type Blobish = { size: number; tag: string };
  const plan = {
    width: 1000,
    height: 800,
    attempts: [
      { mime: "image/png" as const, quality: 1 },
      { mime: "image/jpeg" as const, quality: 0.8 },
      { mime: "image/jpeg" as const, quality: 0.5 },
    ],
  };

  it("returns the first encoding that fits", async () => {
    const { encodeWithin } = await import("@/lib/media/encode");
    const calls: string[] = [];
    const r = await encodeWithin<Blobish>(plan, 500, async (mime, q, w, h) => {
      calls.push(`${mime}:${q}:${w}x${h}`);
      return { size: mime === "image/png" ? 900 : q === 0.8 ? 400 : 200, tag: `${mime}:${q}` };
    });
    expect(r).toMatchObject({ ok: true, mime: "image/jpeg", width: 1000, height: 800, shrinks: 0 });
    expect(calls).toEqual(["image/png:1:1000x800", "image/jpeg:0.8:1000x800"]);
  });

  it("shrinks the picture by a fifth and retries when nothing fits, then gives up", async () => {
    const { encodeWithin } = await import("@/lib/media/encode");
    // size is proportional to area, so one shrink (0.64 of the area) is enough for 700 vs a 1000 baseline
    const area = async (_m: string, _q: number, w: number, h: number): Promise<Blobish> => ({
      size: Math.round((w * h) / 800),
      tag: "x",
    });
    const r = await encodeWithin<Blobish>(plan, 700, area);
    expect(r).toMatchObject({ ok: true, shrinks: 1, width: 800, height: 640 });
    const never = await encodeWithin<Blobish>(plan, 1, area);
    expect(never).toEqual({ ok: false });
  });

  it("treats a failed or empty encode as a miss", async () => {
    const { encodeWithin } = await import("@/lib/media/encode");
    const r = await encodeWithin<Blobish>(plan, 500, async () => null);
    expect(r).toEqual({ ok: false });
    const empty = await encodeWithin<Blobish>(plan, 500, async () => ({ size: 0, tag: "e" }));
    expect(empty).toEqual({ ok: false });
  });
});
