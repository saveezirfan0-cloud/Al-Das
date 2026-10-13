/**
 * Phase 22C server actions and routes with the session and the database replaced by fakes. Every entry point refuses a
 * member without its own permission before the service role is created; a wrong PIN, an expired certificate or a missing
 * certificate fail cleanly BEFORE the step is attempted (no step RPC is called, so the approval is not consumed); the
 * right PIN sends the step and its signature to fin_voucher_act_signed / fin_close_sign_signed in one call. No network;
 * certificates generated here; synthetic ids.
 */
import { randomBytes } from "node:crypto";

import { beforeEach, describe, expect, it, vi } from "vitest";

import { encryptSecret } from "@/lib/crypto";
import { parseStatement } from "@/lib/signing/statement";

import { makeTestCert } from "./make-cert";

process.env.ENCRYPTION_KEY ||= randomBytes(32).toString("base64");

const USER = "00000000-0000-4000-8000-000000000001";
const ORG = "00000000-0000-4000-8000-000000000002";
const VOUCHER = "00000000-0000-4000-8000-0000000000aa";
const HASH = "a".repeat(64);

const state = vi.hoisted(() => ({
  permissions: [] as string[],
  signedIn: true,
  adminCreated: 0,
  rpc: [] as Array<{ name: string; args: Record<string, unknown> }>,
  inserts: [] as Array<{ table: string; row: Record<string, unknown> }>,
  updates: [] as Array<{ table: string; patch: Record<string, unknown> }>,
  certRow: null as null | Record<string, unknown>,
}));

vi.mock("server-only", () => ({}));
vi.mock("next/cache", () => ({ revalidatePath: () => {} }));
vi.mock("@/lib/audit", () => ({ recordAudit: async () => {} }));
vi.mock("@/lib/security/access-log", () => ({
  recordAccess: async () => {},
  recordExport: async () => {},
}));
vi.mock("@/lib/notify/dispatch-db", () => ({
  notify: async () => {},
  memberIdsWithPermission: async () => [],
}));
vi.mock("@/lib/auth/session", async () => {
  const can = (await import("@/lib/auth/can")) as { assertCan: (m: unknown, p: string) => void };
  const member = () => ({
    userId: "00000000-0000-4000-8000-000000000001",
    orgId: "00000000-0000-4000-8000-000000000002",
    roleId: "r",
    roleName: "Test",
    status: "active" as const,
    permissions: state.permissions,
    org: { name: "Clinic Test", timezone: "Asia/Dubai", settings: {}, is_training: false },
    profile: { first_name: "T", last_name: "U", timezone: null },
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

/** A tiny stand-in for the service-role client: the certificate row, rate limits, the step RPCs. */
function fakeAdmin() {
  const query = (table: string) => {
    const chain: Record<string, unknown> = {};
    let patch: Record<string, unknown> | null = null;
    const result = () => {
      if (table === "fin_signing_certificates")
        return patch
          ? {
              data: state.certRow ? [{ fingerprint_sha256: state.certRow.fingerprint_sha256 }] : [],
              error: null,
            }
          : { data: state.certRow, error: null };
      if (table === "fin_payment_vouchers")
        return { data: { voucher_no: "PV-2026-0001" }, error: null };
      return { data: null, error: null };
    };
    for (const m of ["select", "eq", "is", "order", "limit", "in"]) chain[m] = () => chain;
    chain.update = (p: Record<string, unknown>) => {
      patch = p;
      state.updates.push({ table, patch: p });
      return chain;
    };
    chain.insert = async (row: Record<string, unknown>) => {
      state.inserts.push({ table, row });
      if (table === "fin_signing_certificates")
        state.certRow = { id: "cert-1", ...row, created_at: new Date().toISOString() };
      return { error: null };
    };
    chain.maybeSingle = async () => result();
    chain.then = (resolve: (v: unknown) => unknown) => resolve(result());
    return chain;
  };
  return {
    from: query,
    rpc: async (name: string, args: Record<string, unknown>) => {
      state.rpc.push({ name, args });
      if (name === "rate_limit_hit")
        return { data: [{ allowed: true, hits: 1, retry_after: 0 }], error: null };
      if (name.startsWith("fin_voucher_act"))
        return {
          data: {
            id: VOUCHER,
            voucher_no: "PV-2026-0001",
            from: "submitted",
            to: "checked",
            needs_dept: false,
            needs_ceo: true,
            prepared_by: null,
            submitted_by: null,
          },
          error: null,
        };
      return { data: null, error: null };
    },
  };
}

vi.mock("@/lib/supabase/admin", () => ({
  createAdminClient: () => {
    state.adminCreated++;
    if (state.permissions.length === 0) throw new Error("the service role must not be reached");
    return fakeAdmin();
  },
}));

import * as certActions from "@/app/(app)/settings/signing-certificate/actions";
import * as close from "@/app/(app)/finance/close/actions";
import * as vouchers from "@/app/(app)/finance/vouchers/actions";
import { GET as certificateGet } from "@/app/api/finance/vouchers/[id]/certificate/route";

const as = (...permissions: string[]) => {
  state.permissions = permissions;
  state.signedIn = true;
  state.adminCreated = 0;
  state.rpc = [];
  state.inserts = [];
  state.updates = [];
};

describe("permission gates (before the service role)", () => {
  beforeEach(() => as());

  it("refuses certificate changes to people who never sign approvals", async () => {
    as(
      "finance.payables.view",
      "finance.vouchers.prepare",
      "finance.close.view",
      "settings.manage",
    );
    const f = new FormData();
    f.set("file", new File([Buffer.from("x")], "c.p12"));
    f.set("pin", "1234");
    expect(await certActions.uploadSigningCertificate(f)).toMatchObject({ ok: false });
    expect(await certActions.revokeSigningCertificate()).toMatchObject({ ok: false });
    expect(state.adminCreated).toBe(0);
  });

  it("refuses a signed voucher step or sign-off without the step's own permission", async () => {
    as("finance.vouchers.prepare", "finance.close.signoff.finance");
    expect(
      await vouchers.voucherStep({ id: VOUCHER, action: "check", hash: HASH, pin: "1234" }),
    ).toMatchObject({ ok: false });
    as("finance.vouchers.check", "finance.close.view");
    expect(
      await close.signOffCeo({ id: VOUCHER, month: "2026-08", hash: HASH, pin: "1234" }),
    ).toMatchObject({ ok: false });
    expect(state.adminCreated).toBe(0);
  });

  it("the certificate route answers 401 / 403 without a session or a voucher permission", async () => {
    const ctx = { params: Promise.resolve({ id: VOUCHER }) };
    state.signedIn = false;
    expect((await certificateGet(new Request("http://x"), ctx)).status).toBe(401);
    as("finance.close.view");
    expect((await certificateGet(new Request("http://x"), ctx)).status).toBe(403);
    expect(state.adminCreated).toBe(0);
  });
});

describe("signing at a voucher step", () => {
  const t = makeTestCert({ cn: "Checker Test", pin: "pin-4321" });

  beforeEach(async () => {
    as("finance.vouchers.check");
    const { openP12 } = await import("@/lib/signing/p12");
    state.certRow = {
      id: "cert-1",
      p12_enc: encryptSecret(t.p12.toString("base64")),
      fingerprint_sha256: openP12(t.p12, t.pin).info.fingerprint,
    };
  });

  it("a wrong PIN fails cleanly and the step is never attempted", async () => {
    const r = await vouchers.voucherStep({
      id: VOUCHER,
      action: "check",
      hash: HASH,
      remarks: "ok",
      pin: "wrong-pin",
    });
    expect(r).toMatchObject({ ok: false });
    if (!r.ok) {
      expect(r.error).toContain("PIN is not correct");
      expect(r.error).not.toContain("wrong-pin");
    }
    expect(state.rpc.map((x) => x.name)).toEqual(["rate_limit_hit"]);
  });

  it("no certificate, or a step that cannot be signed, also stops before the step", async () => {
    state.certRow = null;
    expect(
      await vouchers.voucherStep({ id: VOUCHER, action: "check", hash: HASH, pin: "x1234" }),
    ).toMatchObject({ ok: false });
    as("finance.vouchers.check");
    expect(
      await vouchers.voucherStep({
        id: VOUCHER,
        action: "reject",
        hash: HASH,
        remarks: "No quote",
        pin: "x1234",
      }),
    ).toMatchObject({ ok: false });
    expect(state.rpc.filter((x) => x.name.startsWith("fin_voucher_act"))).toEqual([]);
  });

  it("the right PIN sends the step and the signed statement together", async () => {
    const r = await vouchers.voucherStep({
      id: VOUCHER,
      action: "check",
      hash: HASH,
      remarks: "Checked",
      pin: t.pin,
    });
    expect(r).toMatchObject({ ok: true });
    const call = state.rpc.find((x) => x.name.startsWith("fin_voucher_act"))!;
    expect(call.name).toBe("fin_voucher_act_signed");
    const sig = call.args.p_signature as { statement: string; cms: string; certificate_id: string };
    const s = parseStatement(sig.statement)!;
    expect(s).toMatchObject({
      doc_type: "payment_voucher",
      doc_id: VOUCHER,
      doc_ref: "PV-2026-0001",
      org_id: ORG,
      step: "check",
      signer_id: USER,
      bound_sha256: HASH,
    });
    expect(s.remarks_sha256).toMatch(/^[0-9a-f]{64}$/);
    expect(sig.certificate_id).toBe("cert-1");
    expect(JSON.stringify(call.args)).not.toContain(t.pin);
  });

  it("without a PIN the plain step runs as before", async () => {
    expect(await vouchers.voucherStep({ id: VOUCHER, action: "check", hash: HASH })).toMatchObject({
      ok: true,
    });
    expect(state.rpc.map((x) => x.name)).toEqual(["fin_voucher_act"]);
  });
});

describe("signing a close sign-off", () => {
  it("a wrong PIN leaves the month unsigned; the right one calls fin_close_sign_signed", async () => {
    const t = makeTestCert({ cn: "Finance Test", pin: "pin-9999" });
    as("finance.close.signoff.finance");
    const { openP12 } = await import("@/lib/signing/p12");
    state.certRow = {
      id: "cert-2",
      p12_enc: encryptSecret(t.p12.toString("base64")),
      fingerprint_sha256: openP12(t.p12, t.pin).info.fingerprint,
    };
    const input = { id: VOUCHER, month: "2026-08", hash: HASH, note: "Reviewed" };
    expect(await close.signOffFinance({ ...input, pin: "nope-nope" })).toMatchObject({ ok: false });
    expect(state.rpc.some((x) => x.name.startsWith("fin_close_sign"))).toBe(false);
    expect(await close.signOffFinance({ ...input, pin: t.pin })).toMatchObject({ ok: true });
    const call = state.rpc.find((x) => x.name === "fin_close_sign_signed")!;
    expect(call.args).toMatchObject({ p_step: "finance", p_hash: HASH, p_note: "Reviewed" });
    expect(
      parseStatement((call.args.p_signature as { statement: string }).statement),
    ).toMatchObject({
      doc_type: "close_pack",
      doc_ref: "2026-08",
      step: "finance",
    });
  });
});

describe("adding a personal certificate", () => {
  beforeEach(() => {
    as("finance.vouchers.approve_ceo");
    state.certRow = null;
  });
  const form = (p12: Buffer, pin: string) => {
    const f = new FormData();
    f.set("file", new File([new Uint8Array(p12)], "mine.p12"));
    f.set("pin", pin);
    return f;
  };

  it("checks the PIN once, refuses an expired certificate and a short PIN, and stores nothing then", async () => {
    const expired = makeTestCert({
      notBefore: new Date(Date.UTC(2020, 0, 1)),
      notAfter: new Date(Date.UTC(2021, 0, 1)),
      pin: "pin-1234",
    });
    expect(await certActions.uploadSigningCertificate(form(expired.p12, "pin-1234"))).toEqual({
      ok: false,
      error: "The certificate has expired.",
    });
    const good = makeTestCert({ pin: "pin-1234" });
    expect(await certActions.uploadSigningCertificate(form(good.p12, "wrong-pin"))).toMatchObject({
      ok: false,
      error: "The certificate PIN is not correct.",
    });
    const short = makeTestCert({ pin: "123" });
    expect(await certActions.uploadSigningCertificate(form(short.p12, "123"))).toMatchObject({
      ok: false,
    });
    expect(state.inserts).toEqual([]);
  });

  it("stores a good certificate encrypted, with no PIN anywhere", async () => {
    const good = makeTestCert({ cn: "Approver Test", pin: "pin-5678" });
    const r = await certActions.uploadSigningCertificate(form(good.p12, "pin-5678"));
    expect(r).toMatchObject({ ok: true });
    const row = state.inserts.find((i) => i.table === "fin_signing_certificates")!.row;
    expect(String(row.p12_enc)).toMatch(/^v1:/);
    expect(row.subject_cn).toBe("Approver Test");
    expect(JSON.stringify(row)).not.toContain("pin-5678");
    expect(JSON.stringify(row)).not.toContain(good.p12.toString("base64").slice(0, 40));
  });
});
