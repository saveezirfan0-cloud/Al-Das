import { describe, expect, it } from "vitest";

import { assertCan, can, canAll, canAny, ForbiddenError, type MemberLike } from "@/lib/auth/can";

const base: MemberLike = {
  userId: "u",
  orgId: "o",
  roleId: "r",
  status: "active",
  permissions: ["inbox.send", "portal.*.read"],
};

describe("can()", () => {
  it("grants listed permissions and wildcards", () => {
    expect(can(base, "inbox.send")).toBe(true);
    expect(can(base, "portal.claims.read")).toBe(true);
    expect(can(base, "portal.claims.write")).toBe(false);
    expect(can({ ...base, permissions: ["*"] }, "settings.manage")).toBe(true);
  });

  it("denies when there is no member, the member is suspended, or permissions are malformed", () => {
    expect(can(null, "inbox.send")).toBe(false);
    expect(can(undefined, "inbox.send")).toBe(false);
    expect(can({ ...base, status: "suspended" }, "inbox.send")).toBe(false);
    expect(can({ ...base, permissions: "inbox.send" as unknown as string[] }, "inbox.send")).toBe(
      false,
    );
    expect(can({ ...base, permissions: [42 as unknown as string] }, "inbox.send")).toBe(false);
  });

  it("canAll / canAny", () => {
    expect(canAll(base, ["inbox.send", "portal.x.read"])).toBe(true);
    expect(canAll(base, ["inbox.send", "reports.view"])).toBe(false);
    expect(canAny(base, ["reports.view", "inbox.send"])).toBe(true);
    expect(canAny(base, ["reports.view"])).toBe(false);
  });

  it("assertCan throws a 403 ForbiddenError", () => {
    expect(() => assertCan(base, "inbox.send")).not.toThrow();
    expect(() => assertCan(base, "settings.manage")).toThrow(ForbiddenError);
    try {
      assertCan(null, "settings.manage");
    } catch (e) {
      expect((e as ForbiddenError).status).toBe(403);
      expect((e as ForbiddenError).permission).toBe("settings.manage");
    }
  });
});
