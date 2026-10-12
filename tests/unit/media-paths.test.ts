import { describe, expect, it } from "vitest";

import {
  documentObjectPath,
  isDocumentPathFor,
  isDocumentPathInOrg,
  isLibraryPathFor,
  libraryObjectPath,
  mediaSource,
  parseDocumentPath,
  parseLibraryPath,
  parseMediaSource,
} from "@/lib/media/paths";

const ORG = "11111111-1111-4111-8111-111111111111";
const OTHER = "22222222-2222-4222-8222-222222222222";
const A = "33333333-3333-4333-8333-333333333333";
const D = "44444444-4444-4444-8444-444444444444";

describe("library paths", () => {
  it("round-trips original and thumbnail", () => {
    const p = libraryObjectPath(ORG, A, "original", "png");
    expect(p).toBe(`${ORG}/${A}/original.png`);
    expect(parseLibraryPath(p)).toEqual({
      orgId: ORG,
      assetId: A,
      file: "original.png",
      variant: "original",
    });
    expect(parseLibraryPath(libraryObjectPath(ORG, A, "thumb"))).toMatchObject({
      variant: "thumb",
    });
  });

  it.each([
    ["traversal", `${ORG}/${A}/../${OTHER}/original.png`],
    ["a name chosen by a person", `${ORG}/${A}/passport-of-someone.jpg`],
    ["two segments", `${ORG}/original.png`],
    ["four segments", `${ORG}/${A}/x/original.png`],
    ["bad uuid", `acme/${A}/original.png`],
    ["leading slash", `/${ORG}/${A}/original.png`],
    ["backslash", `${ORG}/${A}/original\\.png`],
    ["long extension", `${ORG}/${A}/original.abcdefg`],
    ["encoded slash", `${ORG}/${A}/%2e%2e%2foriginal.png`],
    ["empty", ""],
  ])("rejects %s", (_n, p) => expect(parseLibraryPath(p)).toBeNull());

  it("compares with the caller's org and asset", () => {
    const p = libraryObjectPath(ORG, A, "original", "jpg");
    expect(isLibraryPathFor(p, ORG, A)).toBe(true);
    expect(isLibraryPathFor(p, ORG.toUpperCase(), A)).toBe(true);
    expect(isLibraryPathFor(p, OTHER, A)).toBe(false);
    expect(isLibraryPathFor(p, ORG, D)).toBe(false);
  });

  it("refuses to build a path from bad input", () => {
    expect(() => libraryObjectPath("../x", A, "original", "jpg")).toThrow();
    expect(() => libraryObjectPath(ORG, A, "original", "j/pg")).toThrow();
  });
});

describe("document paths", () => {
  it("round-trips", () => {
    const p = documentObjectPath(ORG, A, D, "pdf");
    expect(p).toBe(`${ORG}/${A}/${D}.pdf`);
    expect(parseDocumentPath(p)).toEqual({
      orgId: ORG,
      contactId: A,
      documentId: D,
      extension: "pdf",
    });
  });

  it.each([
    ["traversal", `${ORG}/${A}/../${D}.pdf`],
    ["no extension", `${ORG}/${A}/${D}`],
    ["non-uuid file", `${ORG}/${A}/lab-result.pdf`],
    ["extra segment", `${ORG}/${A}/x/${D}.pdf`],
    ["wrong depth", `${ORG}/${D}.pdf`],
    ["null byte", `${ORG}/${A}/${D}.pd\0f`],
  ])("rejects %s", (_n, p) => expect(parseDocumentPath(p)).toBeNull());

  it("is tied to org, patient and optionally the document", () => {
    const p = documentObjectPath(ORG, A, D, "jpg");
    expect(isDocumentPathFor(p, ORG, A)).toBe(true);
    expect(isDocumentPathFor(p, ORG, A, D)).toBe(true);
    expect(isDocumentPathFor(p, OTHER, A)).toBe(false);
    expect(isDocumentPathFor(p, ORG, D)).toBe(false);
    expect(isDocumentPathFor(p, ORG, A, A)).toBe(false);
  });
});

describe("documents after a patient merge", () => {
  it("accepts the original patient segment as long as the org and the document match", () => {
    const p = documentObjectPath(ORG, A, D, "pdf");
    expect(isDocumentPathInOrg(p, ORG, D)).toBe(true);
    expect(isDocumentPathInOrg(p, OTHER, D)).toBe(false);
    expect(isDocumentPathInOrg(p, ORG, A)).toBe(false);
    expect(isDocumentPathInOrg(`${ORG}/${A}/../${D}.pdf`, ORG, D)).toBe(false);
  });
});

describe("media sources", () => {
  it("builds and parses media:<uuid>", () => {
    expect(mediaSource(A)).toBe(`media:${A}`);
    expect(parseMediaSource(`media:${A}`)).toBe(A);
  });
  it.each([
    null,
    undefined,
    "",
    "text:https://x.test/a.png",
    "media:",
    "media:not-a-uuid",
    `media:${A}/x`,
    "https://x.test",
  ])("ignores %s", (v) => expect(parseMediaSource(v)).toBeNull());
  it("will not build a source from junk", () => {
    expect(() => mediaSource("nope")).toThrow();
  });
});
