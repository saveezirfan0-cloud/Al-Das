import { describe, expect, it } from "vitest";

import { PERMISSION_KEYS, SYSTEM_ROLES } from "@/lib/auth/permissions";
import { visibleSettingsPages } from "@/components/shell/settings-pages";
import { financePagesFor } from "@/lib/finance/nav";
import { roomSchema } from "@/lib/capacity/rooms";

const member = (permissions: string[]) => ({
  userId: "u",
  orgId: "o",
  roleId: "r",
  status: "active" as const,
  permissions,
});

describe("room input", () => {
  it("an empty cost is unknown (null); 0 and negatives are refused", () => {
    const ok = roomSchema.parse({ name: " Room 1 ", kind: "dental", monthly_cost: "" });
    expect(ok).toMatchObject({ name: "Room 1", kind: "dental", monthly_cost: null, active: false });
    expect(
      roomSchema.parse({ name: "R", kind: "other", monthly_cost: "1,250.50", active: "on" }),
    ).toMatchObject({ monthly_cost: 1250.5, active: true });
    expect(roomSchema.safeParse({ name: "R", kind: "other", monthly_cost: "0" }).success).toBe(
      false,
    );
    expect(roomSchema.safeParse({ name: "R", kind: "other", monthly_cost: "-5" }).success).toBe(
      false,
    );
    expect(roomSchema.safeParse({ name: "R", kind: "office", monthly_cost: "" }).success).toBe(
      false,
    );
    expect(roomSchema.safeParse({ name: " ", kind: "other" }).success).toBe(false);
  });
});

describe("rooms permission and pages", () => {
  it("rooms.manage is a real key held by Admin (*) and Manager, not by the desk or finance", () => {
    expect(PERMISSION_KEYS).toContain("rooms.manage");
    const has = (name: string) =>
      SYSTEM_ROLES.find((r) => r.name === name)!.permissions.includes("rooms.manage");
    expect(has("Manager")).toBe(true);
    for (const r of ["Agent", "Receptionist", "Finance", "Medical Director"])
      expect(has(r), r).toBe(false);
  });

  it("Settings, Rooms shows for rooms.manage only; Capacity for finance.revenue.view", () => {
    const rooms = (p: string[]) =>
      visibleSettingsPages(member(p)).some((x) => x.href === "/settings/rooms");
    expect(rooms(["rooms.manage"])).toBe(true);
    expect(rooms(["appointments.manage"])).toBe(false);
    // Capacity is a tab of "Doctor and clinic performance" (Phase D tab groups)
    const cap = (p: string[]) => financePagesFor(member(p)).includes("/finance/capacity");
    expect(cap(["finance.revenue.view"])).toBe(true);
    expect(cap(["finance.costs.view"])).toBe(false);
  });
});
