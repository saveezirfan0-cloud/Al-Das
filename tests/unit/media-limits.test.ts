import { describe, expect, it } from "vitest";

import { inspectStoredObject } from "@/lib/media/inspect";
import {
  formatBytes,
  kindForMime,
  MB,
  normaliseMime,
  PATIENT_DOCUMENT_MAX_BYTES,
  validateMedia,
  WHATSAPP_LIMITS,
} from "@/lib/media/limits";
import { sniffMatches, sniffMime } from "@/lib/media/sniff";

const bytes = (...v: number[]) => new Uint8Array([...v, ...new Array(32).fill(0x20)]);
const JPEG = bytes(0xff, 0xd8, 0xff, 0xe0);
const PNG = bytes(0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a);
const PDF = bytes(0x25, 0x50, 0x44, 0x46, 0x2d, 0x31);
const MP4 = new Uint8Array([
  0,
  0,
  0,
  0x18,
  0x66,
  0x74,
  0x79,
  0x70,
  0x69,
  0x73,
  0x6f,
  0x6d,
  ...new Array(20).fill(0),
]);
const ZIP = bytes(0x50, 0x4b, 0x03, 0x04);
const EXE = bytes(0x4d, 0x5a, 0x90, 0x00, 0x03);

describe("WhatsApp limits", () => {
  it("states the documented limits", () => {
    expect(WHATSAPP_LIMITS.image.maxBytes).toBe(5 * MB);
    expect(WHATSAPP_LIMITS.video.maxBytes).toBe(16 * MB);
    expect(WHATSAPP_LIMITS.document.maxBytes).toBe(100 * MB);
  });

  it.each([
    ["image/jpeg", 5 * MB, true],
    ["image/jpeg", 5 * MB + 1, false],
    ["image/png", 1, true],
    ["image/webp", 1000, false], // WhatsApp images are JPEG or PNG only
    ["image/gif", 1000, false],
    ["video/mp4", 16 * MB, true],
    ["video/mp4", 16 * MB + 1, false],
    ["video/quicktime", 1000, false],
    ["application/pdf", 100 * MB, true],
    ["application/pdf", 100 * MB + 1, false],
    ["text/plain", 10, true],
    ["application/x-msdownload", 10, false],
    ["application/zip", 10, false],
  ])("library: %s at %d bytes -> %s", (mime, size, ok) => {
    expect(validateMedia({ mime, size }, "library").ok).toBe(ok);
  });

  it("says why, in plain words, with the limit", () => {
    const r = validateMedia({ mime: "image/jpeg", size: 6 * MB }, "library");
    expect(r).toMatchObject({ ok: false, code: "too_large" });
    expect(!r.ok && r.message).toMatch(/5\.0 MB|5 MB/);
    const t = validateMedia({ mime: "image/webp", size: 5 }, "library");
    expect(!t.ok && t.code).toBe("unsupported_type");
  });

  it("refuses empty files and nonsense sizes", () => {
    expect(validateMedia({ mime: "image/png", size: 0 }, "library")).toMatchObject({
      code: "empty",
    });
    for (const size of [-1, 1.5, NaN, Infinity])
      expect(validateMedia({ mime: "image/png", size }, "library")).toMatchObject({
        code: "bad_size",
      });
  });

  it("normalises the declared type", () => {
    expect(normaliseMime("IMAGE/JPG; charset=binary")).toBe("image/jpeg");
    expect(validateMedia({ mime: "Image/JPEG", size: 10 }, "library")).toMatchObject({
      ok: true,
      kind: "image",
      extension: "jpg",
    });
    expect(kindForMime("video/3gpp")).toBe("video");
    expect(kindForMime(null)).toBeNull();
  });

  it("template headers only take what Meta accepts and the kind the template needs", () => {
    expect(validateMedia({ mime: "image/png", size: 10 }, "template_header", "image").ok).toBe(
      true,
    );
    expect(
      validateMedia({ mime: "application/pdf", size: 10 }, "template_header", "image"),
    ).toMatchObject({ code: "wrong_kind" });
    expect(
      validateMedia({ mime: "video/3gpp", size: 10 }, "template_header", "video"),
    ).toMatchObject({ code: "unsupported_type" });
    expect(
      validateMedia({ mime: "application/msword", size: 10 }, "template_header", "document"),
    ).toMatchObject({ code: "unsupported_type" });
    expect(
      validateMedia({ mime: "video/mp4", size: 17 * MB }, "template_header", "video"),
    ).toMatchObject({ code: "too_large" });
  });

  it("patient documents take PDFs, photos and Word files up to 25 MB, not video or scripts", () => {
    for (const mime of ["application/pdf", "image/jpeg", "image/heic", "image/webp"])
      expect(validateMedia({ mime, size: 1000 }, "patient_document").ok).toBe(true);
    expect(validateMedia({ mime: "video/mp4", size: 1000 }, "patient_document").ok).toBe(false);
    expect(validateMedia({ mime: "text/html", size: 1000 }, "patient_document").ok).toBe(false);
    expect(
      validateMedia(
        { mime: "application/pdf", size: PATIENT_DOCUMENT_MAX_BYTES + 1 },
        "patient_document",
      ),
    ).toMatchObject({ code: "too_large" });
  });

  it("formats sizes", () => {
    expect(formatBytes(512)).toBe("512 B");
    expect(formatBytes(1536)).toBe("1.5 KB");
    expect(formatBytes(5 * MB)).toBe("5.0 MB");
    expect(formatBytes(-4)).toBe("0 B");
  });
});

describe("content sniffing", () => {
  it("recognises the formats we accept", () => {
    expect(sniffMime(JPEG)).toBe("image/jpeg");
    expect(sniffMime(PNG)).toBe("image/png");
    expect(sniffMime(PDF)).toBe("application/pdf");
    expect(sniffMime(MP4)).toBe("video/mp4");
    expect(sniffMime(ZIP)).toBe("application/zip");
    expect(sniffMime(new TextEncoder().encode("hello clinic\n"))).toBe("text/plain");
    expect(sniffMime(new Uint8Array([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1, 0]))).toBe(
      "application/x-ole",
    );
  });

  it("does not recognise an executable or an empty file", () => {
    expect(sniffMime(EXE)).toBeNull();
    expect(sniffMime(new Uint8Array(0))).toBeNull();
  });

  it("matches declared types to content, including Office files", () => {
    expect(sniffMatches("image/jpeg", sniffMime(JPEG))).toBe(true);
    expect(sniffMatches("image/png", sniffMime(JPEG))).toBe(false);
    expect(sniffMatches("application/pdf", sniffMime(EXE))).toBe(false);
    expect(
      sniffMatches(
        "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
        sniffMime(ZIP),
      ),
    ).toBe(true);
    expect(sniffMatches("application/pdf", sniffMime(ZIP))).toBe(false);
    expect(sniffMatches("image/jpeg", null)).toBe(false);
  });
});

describe("inspectStoredObject", () => {
  const stored = (size: number, head: Uint8Array) => ({ size, contentType: null, head });

  it("accepts an honest file and reports the real size", () => {
    const r = inspectStoredObject(
      { declaredMime: "image/jpeg", purpose: "library" },
      stored(1234, JPEG),
    );
    expect(r).toEqual({ ok: true, size: 1234, mime: "image/jpeg", extension: "jpg" });
  });

  it("rejects a file that is bigger than declared (the declared size is not trusted)", () => {
    const r = inspectStoredObject(
      { declaredMime: "image/jpeg", purpose: "library" },
      stored(9 * MB, JPEG),
    );
    expect(r).toMatchObject({ ok: false, reason: "validation" });
  });

  it("rejects an executable renamed to .pdf", () => {
    const r = inspectStoredObject(
      { declaredMime: "application/pdf", purpose: "patient_document" },
      stored(100, EXE),
    );
    expect(r).toMatchObject({ ok: false, reason: "content_mismatch" });
  });

  it("applies the expected header kind", () => {
    const r = inspectStoredObject(
      { declaredMime: "application/pdf", purpose: "template_header", expect: "image" },
      stored(100, PDF),
    );
    expect(r).toMatchObject({ ok: false, reason: "validation" });
  });
});
