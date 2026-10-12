/**
 * Server-action gating for Phase 18 with the session and the database replaced by fakes: every action refuses a member who
 * lacks ITS OWN permission (a different finance.* key, or all of finance.view / invoices / claims, is not enough) before the
 * service role is even created, and the routes answer 401 / 403. No network. Synthetic ids only.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

import { ForbiddenError } from "@/lib/auth/can";

const state = vi.hoisted(() => ({
  permissions: [] as string[],
  adminCalls: 0,
  signedIn: true,
}));

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
    getCurrentMember: async () => (state.signedIn ? member() : null),
  };
});
vi.mock("@/lib/supabase/admin", () => ({
  createAdminClient: () => {
    state.adminCalls++;
    throw new Error("the service role must not be reached by an unauthorised call");
  },
}));
vi.mock("@/lib/supabase/server", () => ({
  createClient: async () => {
    state.adminCalls++;
    throw new Error("the data layer must not be reached by an unauthorised call");
  },
}));
vi.mock("@/lib/audit", () => ({ recordAudit: async () => {} }));
vi.mock("@/lib/security/access-log", () => ({
  recordAccess: async () => {},
  recordExport: async () => {},
}));

import * as cashup from "@/app/(app)/finance/cashup/actions";
import * as close from "@/app/(app)/finance/close/actions";
import * as denials from "@/app/(app)/finance/denials/actions";
import * as eligibility from "@/app/(app)/finance/eligibility/actions";
import * as exportActions from "@/app/(app)/finance/export/actions";
import * as preauth from "@/app/(app)/finance/preauth/actions";
import * as recovery from "@/app/(app)/finance/recovery/actions";
import * as remittance from "@/app/(app)/finance/remittance/actions";
import * as workflow from "@/app/(app)/finance/workflow-settings/actions";
import { GET as revenueGet } from "@/app/api/finance/revenue/route";
import { GET as packGet } from "@/app/api/finance/close/[month]/pack/route";
import { GET as exportGet } from "@/app/api/finance/export/accounting/route";

const ID = "00000000-0000-4000-8000-0000000000aa";
const HASH = "a".repeat(64);
const as = (...permissions: string[]) => {
  state.permissions = permissions;
  state.adminCalls = 0;
  state.signedIn = true;
};

/** Everything a member could hold in finance EXCEPT the one key an action needs. */
const ALL_OTHERS = (needed: string) =>
  [
    "finance.view",
    "finance.invoices.view",
    "finance.claims.view",
    "finance.claims.import",
    "finance.exceptions.manage",
    "finance.capture.manage",
    "finance.preauth.manage",
    "finance.eligibility.manage",
    "finance.denials.manage",
    "finance.remittance.manage",
    "finance.scorecards.view",
    "finance.forecast.view",
    "finance.recovery.manage",
    "finance.recovery.approve",
    "finance.close.view",
    "finance.close.manage",
    "finance.close.signoff.finance",
    "finance.close.signoff.ceo",
    "finance.cashup.manage",
    "finance.revenue.view",
    "finance.export.run",
    "documents.view",
    "documents.manage",
    "ai.use",
    "contacts.view",
    "contacts.manage",
    "settings.manage",
  ].filter((p) => p !== needed);

const calls: Array<[string, string, () => Promise<unknown>]> = [
  [
    "createPreauth",
    "finance.preauth.manage",
    () => preauth.createPreauth({ pin: "P1", payer_id: "PA", status: "requested" }),
  ],
  [
    "updatePreauth",
    "finance.preauth.manage",
    () => preauth.updatePreauth({ id: ID, payer_id: "PA" }),
  ],
  [
    "recordPreauthDecision",
    "finance.preauth.manage",
    () => preauth.recordPreauthDecision({ id: ID, decision: "denied" }),
  ],
  [
    "changePreauthStatus",
    "finance.preauth.manage",
    () => preauth.changePreauthStatus({ id: ID, to: "cancelled" }),
  ],
  [
    "createEligibilityCheck",
    "finance.eligibility.manage",
    () => eligibility.createEligibilityCheck({ pin: "P1", payer_id: "PA", status: "pending" }),
  ],
  [
    "updateEligibilityCheck",
    "finance.eligibility.manage",
    () => eligibility.updateEligibilityCheck({ id: ID, status: "pending" }),
  ],
  ["listCardDocuments", "finance.eligibility.manage", () => eligibility.listCardDocuments("P1")],
  ["syncDenialCases", "finance.denials.manage", () => denials.syncDenialCases()],
  [
    "assignDenialCase",
    "finance.denials.manage",
    () => denials.assignDenialCase({ id: ID, owner: "" }),
  ],
  [
    "setDenialStatus",
    "finance.denials.manage",
    () => denials.setDenialStatus({ id: ID, to: "in_progress" }),
  ],
  ["addDenialNote", "finance.denials.manage", () => denials.addDenialNote({ id: ID, note: "x" })],
  [
    "createAppealDraft",
    "finance.denials.manage",
    () => denials.createAppealDraft({ id: ID, mode: "template" }),
  ],
  ["discardAppealDraft", "finance.denials.manage", () => denials.discardAppealDraft(ID)],
  ["markAppealSent", "finance.denials.manage", () => denials.markAppealSent(ID)],
  [
    "createRemittanceUpload",
    "finance.remittance.manage",
    () => remittance.createRemittanceUpload({ filename: "a.xlsx", size: 100 }),
  ],
  [
    "processRemittanceUpload",
    "finance.remittance.manage",
    () =>
      remittance.processRemittanceUpload({
        path: "00000000-0000-4000-8000-000000000002/remittance/x.xlsx",
        filename: "a.xlsx",
      }),
  ],
  ["commitRemittanceFile", "finance.remittance.manage", () => remittance.commitRemittanceFile(ID)],
  [
    "discardRemittanceFile",
    "finance.remittance.manage",
    () => remittance.discardRemittanceFile(ID),
  ],
  [
    "reviewRemittanceLine",
    "finance.remittance.manage",
    () => remittance.reviewRemittanceLine({ id: ID }),
  ],
  [
    "saveRecoverySettings",
    "finance.recovery.manage",
    () =>
      recovery.saveRecoverySettings({
        template_id: "",
        min_balance: "50",
        min_days_overdue: "14",
        gap_days: "14",
        max_reminders: "3",
        batch_size: "50",
      }),
  ],
  ["approveRecoveryTone", "finance.recovery.approve", () => recovery.approveRecoveryTone()],
  [
    "setRecoveryEnabled",
    "finance.recovery.manage",
    () => recovery.setRecoveryEnabled({ enabled: false }),
  ],
  ["previewRecovery", "finance.recovery.manage", () => recovery.previewRecovery()],
  ["runRecoveryNow", "finance.recovery.manage", () => recovery.runRecoveryNow()],
  [
    "buildClosePackAction",
    "finance.close.manage",
    () => close.buildClosePackAction({ month: "2026-08" }),
  ],
  [
    "signOffFinance",
    "finance.close.signoff.finance",
    () => close.signOffFinance({ id: ID, month: "2026-08", hash: HASH }),
  ],
  [
    "signOffCeo",
    "finance.close.signoff.ceo",
    () => close.signOffCeo({ id: ID, month: "2026-08", hash: HASH }),
  ],
  [
    "withdrawFinanceSignoff",
    "finance.close.manage",
    () => close.withdrawFinanceSignoff({ id: ID, month: "2026-08" }),
  ],
  [
    "openCashup",
    "finance.cashup.manage",
    () => cashup.openCashup({ branch: "P", date: "2026-10-01" }),
  ],
  [
    "saveCashupCounts",
    "finance.cashup.manage",
    () => cashup.saveCashupCounts({ id: ID, lines: [] }),
  ],
  ["submitCashup", "finance.cashup.manage", () => cashup.submitCashup(ID)],
  ["reopenCashup", "finance.cashup.manage", () => cashup.reopenCashup(ID)],
  [
    "previewAccountingExport",
    "finance.export.run",
    () => exportActions.previewAccountingExport({ from: "2026-09-01", to: "2026-09-30" }),
  ],
  [
    "saveAccountMapping",
    "finance.export.run",
    () => exportActions.saveAccountMapping({ kind: "vat_output", key: "*", account_code: "2200" }),
  ],
  [
    "deleteAccountMapping",
    "finance.export.run",
    () => exportActions.deleteAccountMapping({ kind: "vat_output", key: "*" }),
  ],
];

describe("Phase 18 server actions: permission gating", () => {
  beforeEach(() => as());

  it.each(calls)(
    "%s refuses a member with every other finance permission",
    async (_name, needed, call) => {
      as(...ALL_OTHERS(needed));
      const res = (await call()) as { ok: boolean; error?: string };
      expect(res.ok).toBe(false);
      expect(res.error).toMatch(/permission/);
      expect(state.adminCalls).toBe(0);
    },
  );

  it.each(calls)("%s refuses a member with no permissions at all", async (_name, _needed, call) => {
    as();
    expect(((await call()) as { ok: boolean }).ok).toBe(false);
    expect(state.adminCalls).toBe(0);
  });

  it.each(calls)(
    "%s reaches the data layer for the member who holds the permission",
    async (_name, needed, call) => {
      as(needed, "documents.view");
      let outcome: unknown;
      try {
        outcome = await call();
      } catch (e) {
        outcome = e;
      }
      // either validation said no (still no data touched) or it went on to the fake service role and stopped there
      if (state.adminCalls === 0) expect((outcome as { ok?: boolean }).ok).toBe(false);
      else expect(String(outcome)).toMatch(/must not be reached/);
    },
  );

  it("the CEO and finance sign-offs are separate keys: one cannot sign for the other", async () => {
    as("finance.close.signoff.ceo", "finance.close.manage", "finance.close.view");
    expect(await close.signOffFinance({ id: ID, month: "2026-08", hash: HASH })).toMatchObject({
      ok: false,
    });
    as("finance.close.signoff.finance", "finance.close.manage", "finance.close.view");
    expect(await close.signOffCeo({ id: ID, month: "2026-08", hash: HASH })).toMatchObject({
      ok: false,
    });
    expect(state.adminCalls).toBe(0);
  });

  it("approving the tone of the reminders is a separate key from running them", async () => {
    as("finance.recovery.manage");
    expect(await recovery.approveRecoveryTone()).toMatchObject({ ok: false });
    as("finance.recovery.approve");
    expect(await recovery.previewRecovery()).toMatchObject({ ok: false });
    expect(await recovery.runRecoveryNow()).toMatchObject({ ok: false });
    expect(state.adminCalls).toBe(0);
  });

  it("listing a patient's cards also needs documents.view (finance rights never imply documents.*)", async () => {
    as("finance.eligibility.manage");
    expect(await eligibility.listCardDocuments("P1")).toMatchObject({ ok: false });
    expect(state.adminCalls).toBe(0);
  });

  it("validates before touching data: malformed ids, months and amounts", async () => {
    as(
      "finance.close.manage",
      "finance.close.signoff.finance",
      "finance.denials.manage",
      "finance.remittance.manage",
      "finance.cashup.manage",
    );
    expect(await close.buildClosePackAction({ month: "September" })).toMatchObject({ ok: false });
    expect(await close.buildClosePackAction({ month: "2099-01" })).toMatchObject({
      ok: false,
      error: "A month can only be closed after it has ended.",
    });
    expect(await close.signOffFinance({ id: "nope", month: "2026-08", hash: HASH })).toMatchObject({
      ok: false,
    });
    expect(await close.signOffFinance({ id: ID, month: "2026-08", hash: "short" })).toMatchObject({
      ok: false,
    });
    expect(await denials.setDenialStatus({ id: ID, to: "recovered" })).toMatchObject({ ok: false });
    expect(await denials.discardAppealDraft("../etc")).toMatchObject({ ok: false });
    expect(
      await remittance.processRemittanceUpload({
        path: "00000000-0000-4000-8000-0000000000ff/remittance/x.xlsx",
        filename: "a.xlsx",
      }),
    ).toMatchObject({ ok: false, error: "Invalid upload path." });
    expect(
      await remittance.processRemittanceUpload({
        path: "00000000-0000-4000-8000-000000000002/remittance/../x.xlsx",
        filename: "a.xlsx",
      }),
    ).toMatchObject({ ok: false });
    expect(
      await remittance.createRemittanceUpload({ filename: "advice.pdf", size: 10 }),
    ).toMatchObject({ ok: false });
    expect(
      await remittance.createRemittanceUpload({ filename: "a.xlsx", size: 30 * 1024 * 1024 }),
    ).toMatchObject({ ok: false });
    expect(await cashup.openCashup({ branch: "P", date: "2999-01-01" })).toMatchObject({
      ok: false,
    });
    expect(await cashup.openCashup({ branch: "too long", date: "2026-10-01" })).toMatchObject({
      ok: false,
    });
    expect(state.adminCalls).toBe(0);
  });
});

describe("Phase 18 workflow settings (requirePerm)", () => {
  beforeEach(() => as());
  it.each([
    ["saveThresholds", () => workflow.saveThresholds({})],
    ["saveDenialCode", () => workflow.saveDenialCode({})],
    ["deleteDenialCode", () => workflow.deleteDenialCode("AUTH")],
    ["importPayerPrices", () => workflow.importPayerPrices({ payer_id: "P", text: "1,2" })],
    ["deletePayerPrice", () => workflow.deletePayerPrice(ID)],
  ])("%s throws Forbidden without finance.reference.manage", async (_n, call) => {
    as(...ALL_OTHERS("finance.reference.manage"));
    await expect(call()).rejects.toBeInstanceOf(ForbiddenError);
    expect(state.adminCalls).toBe(0);
  });
});

describe("Phase 18 download routes", () => {
  const req = (path: string) => new Request(`http://localhost${path}`);
  beforeEach(() => as());

  it("answer 401 when signed out and 403 without the permission", async () => {
    state.signedIn = false;
    expect((await revenueGet(req("/api/finance/revenue"))).status).toBe(401);
    expect(
      (await exportGet(req("/api/finance/export/accounting?from=2026-09-01&to=2026-09-30"))).status,
    ).toBe(401);
    expect(
      (
        await packGet(req("/api/finance/close/2026-08/pack"), {
          params: Promise.resolve({ month: "2026-08" }),
        })
      ).status,
    ).toBe(401);

    as(...ALL_OTHERS("finance.revenue.view"));
    expect((await revenueGet(req("/api/finance/revenue"))).status).toBe(403);
    as(...ALL_OTHERS("finance.export.run"));
    expect(
      (await exportGet(req("/api/finance/export/accounting?from=2026-09-01&to=2026-09-30"))).status,
    ).toBe(403);
    as("finance.view", "finance.revenue.view", "finance.export.run");
    expect(
      (
        await packGet(req("/api/finance/close/2026-08/pack"), {
          params: Promise.resolve({ month: "2026-08" }),
        })
      ).status,
    ).toBe(403);
    expect(state.adminCalls).toBe(0);
  });

  it("validate the request before touching data", async () => {
    as("finance.export.run", "finance.close.view");
    expect(
      (await exportGet(req("/api/finance/export/accounting?from=bad&to=2026-09-30"))).status,
    ).toBe(400);
    expect(
      (await exportGet(req("/api/finance/export/accounting?from=2024-01-01&to=2026-09-30"))).status,
    ).toBe(400); // longer than 13 months
    expect(
      (
        await packGet(req("/api/finance/close/not-a-month/pack"), {
          params: Promise.resolve({ month: "not-a-month" }),
        })
      ).status,
    ).toBe(400);
    expect(state.adminCalls).toBe(0);
  });
});
