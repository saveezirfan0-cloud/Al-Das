import { describe, expect, it } from "vitest";

import { isMediaPathFor, parseMediaPath } from "@/lib/inbox/media-path";

const ORG = "11111111-1111-4111-8111-111111111111";
const OTHER = "22222222-2222-4222-8222-222222222222";
const CONV = "33333333-3333-4333-8333-333333333333";

describe("parseMediaPath", () => {
  it("accepts <org>/<conversation>/<file>", () => {
    expect(parseMediaPath(`${ORG}/${CONV}/44444444-4444-4444-8444-444444444444.jpg`)).toEqual({
      orgId: ORG,
      conversationId: CONV,
      file: "44444444-4444-4444-8444-444444444444.jpg",
    });
  });

  it.each([
    ["traversal in the middle", `${ORG}/${CONV}/../${OTHER}/x.jpg`],
    ["traversal as the file", `${ORG}/${CONV}/..`],
    ["double dots in the file", `${ORG}/${CONV}/a..b.jpg`],
    ["extra segment", `${ORG}/${CONV}/sub/x.jpg`],
    ["missing file", `${ORG}/${CONV}`],
    ["non-uuid org", `acme/${CONV}/x.jpg`],
    ["backslash", `${ORG}/${CONV}/a\\b.jpg`],
    ["leading slash", `/${ORG}/${CONV}/x.jpg`],
    ["encoded slash", `${ORG}/${CONV}/%2e%2e%2fx.jpg`],
    ["empty", ""],
    ["too long", `${ORG}/${CONV}/${"a".repeat(400)}`],
  ])("rejects %s", (_name, p) => {
    expect(parseMediaPath(p)).toBeNull();
  });
});

describe("isMediaPathFor", () => {
  const path = `${ORG}/${CONV}/x.jpg`;
  it("requires the exact org and conversation (case-insensitive)", () => {
    expect(isMediaPathFor(path, ORG, CONV)).toBe(true);
    expect(isMediaPathFor(path, ORG.toUpperCase(), CONV)).toBe(true);
    expect(isMediaPathFor(path, OTHER, CONV)).toBe(false);
    expect(isMediaPathFor(path, ORG, OTHER)).toBe(false);
  });
});
