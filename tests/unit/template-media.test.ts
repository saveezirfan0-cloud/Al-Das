import { describe, expect, it } from "vitest";

import { checkSample, isOwnSamplePath, sampleStoragePath } from "@/lib/whatsapp/template-media";

describe("template header samples", () => {
  it("accepts allowed types within size limits", () => {
    expect(checkSample("image/png", 1000, "IMAGE")).toEqual({
      ok: true,
      format: "IMAGE",
      ext: "png",
    });
    expect(checkSample("video/mp4", 1000, ["IMAGE", "VIDEO"])).toMatchObject({
      ok: true,
      format: "VIDEO",
    });
    expect(checkSample("application/pdf", 1000, "DOCUMENT")).toMatchObject({ ok: true });
  });
  it("rejects wrong type, empty and oversized files", () => {
    expect(checkSample("application/pdf", 10, "IMAGE").ok).toBe(false);
    expect(checkSample("image/gif", 10, "IMAGE").ok).toBe(false);
    expect(checkSample("image/png", 0, "IMAGE").ok).toBe(false);
    expect(checkSample("image/jpeg", 6 * 1024 * 1024, "IMAGE").ok).toBe(false);
    expect(checkSample("video/mp4", 17 * 1024 * 1024, "VIDEO").ok).toBe(false);
    expect(checkSample("application/pdf", 16 * 1024 * 1024, "DOCUMENT").ok).toBe(false);
  });
  it("builds org-scoped storage paths", () => {
    expect(sampleStoragePath("org1", "abc", "png")).toBe("org1/templates/abc.png");
  });

  it("accepts only paths inside the org's templates folder", () => {
    expect(isOwnSamplePath("org1", "org1/templates/a.png")).toBe(true);
    expect(isOwnSamplePath("org1", "org2/templates/a.png")).toBe(false);
    expect(isOwnSamplePath("org1", "org1/other/a.png")).toBe(false);
    expect(isOwnSamplePath("org1", "org1/templates/../../org2/templates/a.png")).toBe(false);
    expect(isOwnSamplePath("org1", "org1/templates//a.png")).toBe(false);
    expect(isOwnSamplePath("org1", "org10/templates/a.png")).toBe(false);
  });
});
