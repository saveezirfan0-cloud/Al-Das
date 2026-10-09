import { describe, expect, it } from "vitest";

import nextConfig from "../../next.config";

describe("security headers", () => {
  it("applies the baseline set to every route", async () => {
    const rules = await nextConfig.headers!();
    const all = rules.find((r) => r.source === "/:path*")!;
    const map = new Map(all.headers.map((h) => [h.key, h.value]));
    expect(map.get("Strict-Transport-Security")).toMatch(/max-age=\d{8,}/);
    expect(map.get("X-Content-Type-Options")).toBe("nosniff");
    expect(map.get("X-Frame-Options")).toBe("DENY");
    expect(map.get("Referrer-Policy")).toBeTruthy();
    expect(map.get("Permissions-Policy")).toContain("camera=()");
    expect(map.get("Content-Security-Policy-Report-Only")).toContain("frame-ancestors 'none'");
    expect(nextConfig.poweredByHeader).toBe(false);
  });
});
