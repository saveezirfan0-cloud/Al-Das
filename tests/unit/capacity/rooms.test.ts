import { describe, expect, it } from "vitest";

import { PERMISSION_KEYS, SYSTEM_ROLES } from "@/lib/auth/permissions";
import { visibleSettingsPages } from "@/components/shell/settings-pages";
import { financeNavFor } from "@/lib/finance/nav";
import {
  formatTime,
  parseTime,
  roomSchema,
  rotaErrorMessage,
  rotaSchema,
} from "@/lib/capacity/rooms";

const ROOM = "11111111-1111-4111-8111-111111111111";
const DOC = "22222222-2222-4222-8222-222222222222";
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

describe("rota input", () => {
  it("parses times, with an end of 00:00 meaning midnight", () => {
    expect(parseTime("09:30")).toBe(570);
    expect(parseTime("00:00", true)).toBe(1440);
    expect(parseTime("24:00")).toBe(1440);
    expect(parseTime("25:00")).toBeNull();
    expect(parseTime("9.30")).toBeNull();
    expect(formatTime(1440)).toBe("24:00");
  });

  it("refuses an end before the start and a bad day", () => {
    const row = { room_id: ROOM, specialist_id: DOC, weekday: "2", start: "09:00", end: "13:00" };
    expect(rotaSchema.parse(row)).toEqual({
      room_id: ROOM,
      specialist_id: DOC,
      weekday: 2,
      start_min: 540,
      end_min: 780,
    });
    expect(rotaSchema.safeParse({ ...row, end: "08:00" }).success).toBe(false);
    expect(rotaSchema.safeParse({ ...row, weekday: "0" }).success).toBe(false);
    expect(rotaSchema.safeParse({ ...row, weekday: "8" }).success).toBe(false);
  });

  it("turns the database refusals into plain words", () => {
    expect(rotaErrorMessage({ message: "room_double_booked: x" })).toMatch(/already on the rota/);
    expect(rotaErrorMessage({ message: "specialist_not_at_room_location: x" })).toMatch(
      /does not work at this room's branch/,
    );
    expect(rotaErrorMessage(null)).toMatch(/Could not save/);
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
    const cap = (p: string[]) =>
      financeNavFor(member(p)).some((x) => x.href === "/finance/capacity");
    expect(cap(["finance.revenue.view"])).toBe(true);
    expect(cap(["finance.costs.view"])).toBe(false);
  });
});
