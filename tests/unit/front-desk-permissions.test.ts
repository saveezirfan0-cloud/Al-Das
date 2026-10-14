/**
 * Permission gating for the Phase 14 server actions. The session and the database are replaced with fakes so the
 * test proves what each action does before it reaches data: a member without the permission is refused and the
 * service-role client is never even created.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

import { assertCan, ForbiddenError, type MemberLike } from "@/lib/auth/can";
import { PERMISSIONS, SYSTEM_ROLES, permissionMatches } from "@/lib/auth/permissions";

const state = vi.hoisted(() => ({ permissions: [] as string[], adminCalls: 0 }));

vi.mock("server-only", () => ({}));
vi.mock("next/cache", () => ({ revalidatePath: () => {} }));
vi.mock("@/lib/auth/session", async () => {
  const can = (await import("@/lib/auth/can")) as { assertCan: (m: unknown, p: string) => void };
  const member = () => ({
    userId: "00000000-0000-4000-8000-000000000001",
    orgId: "00000000-0000-4000-8000-000000000002",
    roleId: "r",
    roleName: "Test",
    status: "active" as const,
    permissions: state.permissions,
    org: { name: "Test", timezone: "Asia/Dubai", settings: {}, is_training: false },
    profile: { first_name: "T", last_name: "U" },
    user: { email: "t@example.test" },
    orgs: [],
  });
  return {
    requirePerm: async (p: string) => {
      const m = member();
      can.assertCan(m, p);
      return m;
    },
    requireMember: async () => member(),
  };
});
vi.mock("@/lib/supabase/admin", () => ({
  createAdminClient: () => {
    state.adminCalls++;
    throw new Error("the service role must not be reached by an unauthorised call");
  },
}));

import * as desk from "@/app/(app)/front-desk/actions";
import * as deskSettings from "@/app/(app)/settings/front-desk/actions";
import * as training from "@/app/(app)/settings/training/actions";

const ID = "00000000-0000-4000-8000-0000000000aa";
const as = (...permissions: string[]) => {
  state.permissions = permissions;
  state.adminCalls = 0;
};

/** Every desk action with arguments that pass validation, so refusal can only come from permissions. */
const deskCalls: Array<[string, () => Promise<unknown>, string[]]> = [
  [
    "setCheckin",
    () => desk.setCheckin({ appointmentId: ID, to: "arrived" }),
    ["appointments.manage"],
  ],
  ["markNoShow", () => desk.markNoShow(ID), ["appointments.manage"]],
  ["cancelFromDesk", () => desk.cancelFromDesk({ appointmentId: ID }), ["appointments.manage"]],
  ["getPatientCard", () => desk.getPatientCard(ID), ["contacts.view", "appointments.view"]],
  ["logCall", () => desk.logCall(ID), ["tasks.manage"]],
  [
    "sendDeskMessageAction",
    () => desk.sendDeskMessageAction({ contactId: ID, kind: "location" }),
    ["inbox.send"],
  ],
  [
    "registerWalkIn",
    () =>
      desk.registerWalkIn({
        phone: "0500000123",
        name: "Test Person",
        language: "en",
        consent_contact: true,
      }),
    ["contacts.manage"],
  ],
  [
    "addToWaitlist",
    () => desk.addToWaitlist({ contactId: ID, specialistId: ID }),
    ["appointments.manage"],
  ],
  ["removeFromWaitlist", () => desk.removeFromWaitlist(ID), ["appointments.manage"]],
  [
    "linkDependant",
    () => desk.linkDependant({ guardianId: ID, dependantId: ID }),
    ["contacts.manage"],
  ],
  ["unlinkDependant", () => desk.unlinkDependant(ID), ["contacts.manage"]],
  [
    "createDependant",
    () => desk.createDependant({ guardianId: ID, name: "Test Child" }),
    ["contacts.manage"],
  ],
  ["addHandoverNote", () => desk.addHandoverNote({ body: "x" }), []],
  ["resolveHandoverNote", () => desk.resolveHandoverNote(ID, true), []],
  // Phase E
  ["recordWhatsAppAgreement", () => desk.recordWhatsAppAgreement(ID), ["contacts.manage"]],
  [
    "getDeskDaySlots",
    () => desk.getDeskDaySlots({ locationId: ID, serviceId: ID, date: "2026-10-14" }),
    ["appointments.view"],
  ],
  ["getArrivalChecks", () => desk.getArrivalChecks([ID]), ["appointments.view"]],
];

describe("front desk actions: permission gating", () => {
  beforeEach(() => as());

  it.each(deskCalls)(
    "%s refuses a member without frontdesk.use, before touching data",
    async (_n, call, domain) => {
      as(...domain, "contacts.view", "appointments.view"); // plenty of other rights, but not frontdesk.use
      await expect(call()).rejects.toBeInstanceOf(ForbiddenError);
      expect(state.adminCalls).toBe(0);
    },
  );

  it.each(deskCalls.filter(([, , domain]) => domain.length > 0))(
    "%s refuses a desk member who lacks the domain permission it acts under",
    async (_n, call, domain) => {
      as("frontdesk.use"); // the workspace, but none of the rights to act in it
      const res = (await call()) as { ok: boolean; error?: string };
      expect(res.ok).toBe(false);
      expect(res.error).toMatch(/permission/);
      expect(domain.length).toBeGreaterThan(0);
      expect(state.adminCalls).toBe(0);
    },
  );

  it("lets a member holding the permissions through to the data layer", async () => {
    as("frontdesk.use", "appointments.manage");
    await expect(desk.markNoShow(ID)).rejects.toThrow(/service role must not be reached/);
    expect(state.adminCalls).toBe(1);
  });

  it("refuses an invalid walk-in before anything else, even for a permitted member", async () => {
    as("frontdesk.use", "contacts.manage");
    // Phase E: the WhatsApp tick is a real choice now; a UAE landline is still refused before any data.
    const res = await desk.registerWalkIn({
      phone: "04 000 0000",
      name: "Test Person",
      language: "en",
      consent_contact: false,
    });
    expect(res).toMatchObject({ ok: false, error: expect.stringMatching(/not a UAE mobile/) });
    const short = await desk.registerWalkIn({ phone: "", name: "T", language: "en" });
    expect(short).toMatchObject({ ok: false, error: expect.stringMatching(/name/) });
    expect(state.adminCalls).toBe(0);
  });

  it("Phase E: checks a branch and the day before reading slots", async () => {
    as("frontdesk.use", "appointments.view");
    const past = await desk.getDeskDaySlots({ locationId: ID, serviceId: ID, date: "2020-01-01" });
    expect(past).toMatchObject({ ok: false });
    expect(state.adminCalls).toBe(0);
  });

  it("covers every exported desk action (a new action must be added to this table)", () => {
    const exported = Object.keys(desk).sort();
    expect(deskCalls.map(([name]) => name).sort()).toEqual(exported);
  });
});

describe("settings actions need settings.manage", () => {
  beforeEach(() => as());
  it("refuses the front desk settings, training mode and video links without it", async () => {
    as("frontdesk.use", "appointments.manage", "contacts.manage");
    await expect(deskSettings.saveFrontDeskSettings({})).rejects.toBeInstanceOf(ForbiddenError);
    await expect(
      training.setTrainingMode({ enabled: true, confirm: "TRAINING" }),
    ).rejects.toBeInstanceOf(ForbiddenError);
    await expect(
      training.saveVideoLinks({ welcome: "https://v.example.test/x" }),
    ).rejects.toBeInstanceOf(ForbiddenError);
    expect(state.adminCalls).toBe(0);
  });

  it("makes the administrator type the confirmation word before training mode changes", async () => {
    as("settings.manage");
    expect(await training.setTrainingMode({ enabled: true, confirm: "yes" })).toMatchObject({
      ok: false,
      error: "Type TRAINING to confirm.",
    });
    expect(await training.setTrainingMode({ enabled: false, confirm: "TRAINING" })).toMatchObject({
      ok: false,
      error: "Type GO LIVE to confirm.",
    });
    expect(state.adminCalls).toBe(0);
  });

  it("rejects video links that are not https", async () => {
    as("settings.manage");
    expect(
      await training.saveVideoLinks({ welcome: "http://insecure.example.test" }),
    ).toMatchObject({ ok: false });
    expect(await training.saveVideoLinks({ welcome: "javascript:alert(1)" })).toMatchObject({
      ok: false,
    });
    expect(state.adminCalls).toBe(0);
  });
});

describe("the permission itself", () => {
  const holders = (perm: string) =>
    SYSTEM_ROLES.filter((r) => r.permissions.some((g) => permissionMatches(g, perm))).map(
      (r) => r.name,
    );

  it("is catalogued under Front desk", () => {
    const entry = PERMISSIONS.find((p) => p.key === "frontdesk.use");
    expect(entry?.group).toBe("Front desk");
  });

  it("goes to Admin, Manager and Receptionist only; the Receptionist can do everything the desk needs", () => {
    expect(holders("frontdesk.use")).toEqual(["Admin", "Manager", "Receptionist"]);
    const reception = SYSTEM_ROLES.find((r) => r.name === "Receptionist")!;
    const member: MemberLike = {
      userId: "u",
      orgId: "o",
      roleId: "r",
      status: "active",
      permissions: reception.permissions,
    };
    for (const perm of [
      "frontdesk.use",
      "appointments.manage",
      "contacts.manage",
      "tasks.manage",
      "inbox.send",
      "contacts.view",
      "appointments.view",
    ])
      expect(() => assertCan(member, perm), perm).not.toThrow();
    // ...but is not an administrator
    expect(() => assertCan(member, "settings.manage")).toThrow(ForbiddenError);
    expect(() => assertCan(member, "privacy.manage")).toThrow(ForbiddenError);
  });

  it("is not granted to Agent, Care coordinator, Marketing or the finance roles", () => {
    for (const name of [
      "Agent",
      "Care coordinator",
      "Marketing",
      "Finance",
      "Billing",
      "Insurance",
      "CEO",
      "Medical Director",
    ])
      expect(holders("frontdesk.use"), name).not.toContain(name);
  });
});
