/**
 * Phase 20B, the Finance inbox actions with the session and the database replaced by fakes: every action refuses a member
 * without finance.inbox.manage before the service role is created (payables and voucher rights do not imply it); a label
 * and a discard touch only documents waiting in the inbox; a discard removes the file first, then the row, is refused for
 * anything linked to an invoice or voucher, and changes nothing when the file cannot be removed; opening a document is
 * limited to inbox documents and logged. Synthetic ids only.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

import { createFakeAdmin, type FakeAdmin } from "../helpers/fake-admin";

const ORG = "00000000-0000-4000-8000-000000000002";
const state = vi.hoisted(() => ({
  permissions: [] as string[],
  adminCalls: 0,
  admin: null as unknown,
  audits: [] as Array<Record<string, unknown>>,
  access: [] as Array<Record<string, unknown>>,
}));

vi.mock("next/cache", () => ({ revalidatePath: () => {} }));
vi.mock("@/lib/auth/session", () => ({
  requireMember: async () => ({
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
  }),
}));
vi.mock("@/lib/supabase/admin", () => ({
  createAdminClient: () => {
    state.adminCalls++;
    if (!state.admin)
      throw new Error("the service role must not be reached by an unauthorised call");
    return state.admin;
  },
}));
vi.mock("@/lib/audit", () => ({
  recordAudit: async (_a: unknown, e: Record<string, unknown>) => {
    state.audits.push(e);
  },
}));
vi.mock("@/lib/security/access-log", () => ({
  recordAccess: async (_a: unknown, _m: unknown, input: Record<string, unknown>) => {
    state.access.push(input);
  },
}));

import * as inbox from "@/app/(app)/finance/inbox/actions";

const ID = "00000000-0000-4000-8000-0000000000d1";
const as = (...p: string[]) => {
  state.permissions = p;
  state.adminCalls = 0;
  state.admin = null;
  state.audits = [];
  state.access = [];
};

const calls: Array<[string, () => Promise<{ ok: boolean; error?: string }>]> = [
  ["prepareInboxUpload", () => inbox.prepareInboxUpload({ mime: "application/pdf", size: 1000 })],
  ["finalizeInboxUpload", () => inbox.finalizeInboxUpload({ id: ID })],
  ["abandonInboxUpload", () => inbox.abandonInboxUpload({ id: ID })],
  ["labelInboxDocument", () => inbox.labelInboxDocument({ id: ID, kind: "bank_statement" })],
  ["discardInboxFile", () => inbox.discardInboxFile({ id: ID })],
  ["openInboxDocument", () => inbox.openInboxDocument({ id: ID })],
];

/** A database with one inbox document (and optionally others) plus a storage that can be told to fail. */
function world(docs: Array<Record<string, unknown>>, o: { removeFails?: boolean } = {}) {
  const removed: string[] = [];
  const admin: FakeAdmin = createFakeAdmin({ fin_documents: docs });
  (admin as unknown as { storage: unknown }).storage = {
    from: () => ({
      remove: async (paths: string[]) => {
        if (o.removeFails) return { data: null, error: { message: "down" } };
        removed.push(...paths);
        return { data: [], error: null };
      },
      createSignedUrl: async (path: string) => ({
        data: { signedUrl: `https://storage.example/signed/${path}` },
        error: null,
      }),
    }),
  };
  state.admin = admin;
  return { admin, removed };
}
const doc = (over: Record<string, unknown> = {}) => ({
  id: ID,
  org_id: ORG,
  kind: "unclassified",
  source: "email",
  storage_path: `${ORG}/${ID}.pdf`,
  status: "ready",
  sha256: "a".repeat(64),
  scan_status: "unscanned",
  inbox_at: "2026-11-03T08:00:00Z",
  routed_at: null,
  ...over,
});

describe("Finance inbox actions", () => {
  beforeEach(() => as());

  it.each(calls)(
    "%s refuses a member without finance.inbox.manage before the service role is created",
    async (_n, call) => {
      as(
        "finance.payables.view",
        "finance.payables.manage",
        "finance.vouchers.prepare",
        "finance.vouchers.check",
        "finance.view",
      );
      const res = await call();
      expect(res.ok).toBe(false);
      expect(state.adminCalls).toBe(0);
    },
  );

  it("labels a document waiting in the inbox, audited with the label only", async () => {
    as("finance.inbox.manage");
    const { admin } = world([doc()]);
    expect(await inbox.labelInboxDocument({ id: ID, kind: "bank_statement" })).toMatchObject({
      ok: true,
    });
    expect(admin._rows("fin_documents")[0].kind).toBe("bank_statement");
    expect(state.audits).toEqual([
      expect.objectContaining({
        action: "finance.inbox.labelled",
        entityId: ID,
        diff: { kind: "bank_statement" },
      }),
    ]);
  });

  it("refuses to label an unknown kind, a routed document or one that never came through the inbox", async () => {
    as("finance.inbox.manage");
    world([doc({ routed_at: "2026-11-03T09:00:00Z" })]);
    expect((await inbox.labelInboxDocument({ id: ID, kind: "bank_statement" })).ok).toBe(false);
    world([doc({ inbox_at: null })]);
    expect((await inbox.labelInboxDocument({ id: ID, kind: "bank_statement" })).ok).toBe(false);
    expect((await inbox.labelInboxDocument({ id: ID, kind: "voucher_backup" as "other" })).ok).toBe(
      false,
    );
    expect(state.audits).toEqual([]);
  });

  it("discards: the file first, then the row, audited", async () => {
    as("finance.inbox.manage");
    const { admin, removed } = world([doc()]);
    expect(await inbox.discardInboxFile({ id: ID })).toMatchObject({ ok: true });
    expect(removed).toEqual([`${ORG}/${ID}.pdf`]);
    expect(admin._rows("fin_documents")).toEqual([]);
    expect(state.audits).toEqual([
      expect.objectContaining({ action: "finance.inbox.discarded", entityId: ID }),
    ]);
  });

  it("refuses to discard a document on an invoice or voucher, one not from the inbox, another org's, or one not ready", async () => {
    as("finance.inbox.manage");
    for (const over of [
      { routed_at: "2026-11-03T09:00:00Z" },
      { inbox_at: null },
      { org_id: "00000000-0000-4000-8000-0000000000ff" },
      { status: "pending" },
    ]) {
      const { admin, removed } = world([doc(over)]);
      const res = await inbox.discardInboxFile({ id: ID });
      expect(res.ok, JSON.stringify(over)).toBe(false);
      expect(removed).toEqual([]);
      expect(admin._rows("fin_documents")).toHaveLength(1);
    }
    expect(state.audits).toEqual([]);
  });

  it("changes nothing when the file cannot be removed", async () => {
    as("finance.inbox.manage");
    const { admin } = world([doc()], { removeFails: true });
    const res = await inbox.discardInboxFile({ id: ID });
    expect(res.ok).toBe(false);
    expect(admin._rows("fin_documents")[0]).toMatchObject({
      status: "ready",
      sha256: "a".repeat(64),
    });
    expect(state.audits).toEqual([]);
  });

  it("opens only inbox documents, through a short link, and logs the open", async () => {
    as("finance.inbox.manage");
    world([doc()]);
    const res = await inbox.openInboxDocument({ id: ID });
    expect(res).toMatchObject({ ok: true });
    expect(state.access).toEqual([
      expect.objectContaining({ entity: "finance_document", entityId: ID, action: "view" }),
    ]);
    world([doc({ inbox_at: null, kind: "voucher_backup" })]);
    expect((await inbox.openInboxDocument({ id: ID })).ok).toBe(false);
    world([doc({ scan_status: "infected" })]);
    expect((await inbox.openInboxDocument({ id: ID })).ok).toBe(false);
  });
});
