/**
 * Phase 22J: how the server reads the connector's answer to an import job (applyResult), with a fake database client
 * that records the calls. Tally's answer is parsed only by lib/accounting/tally/; its error text is redacted before it
 * is stored; a look-up that does not show the voucher, or an unreadable answer, is never taken as success.
 */
import { gzipSync } from "node:zlib";

import { describe, expect, it } from "vitest";

import { applyResult, ResultError } from "@/lib/accounting/tally/bridge-server";

const REMOTE = "pulse-0f3c2b1a111142228333444455556666-pv-a1-1";
const JOB = "00000000-0000-4000-8000-000000000001";
const auth = { deviceId: "device-1", orgId: "org-1" };
const gz = (s: string) => gzipSync(Buffer.from(s)).toString("base64");

function fakeAdmin(job: Record<string, unknown> | null) {
  const calls: Array<{ fn: string; args: Record<string, unknown> }> = [];
  const admin = {
    rpc: async (fn: string, args: Record<string, unknown>) => {
      calls.push({ fn, args });
      if (fn === "acc_tally_bridge_job") return { data: job, error: null };
      return { data: {}, error: null };
    },
  };
  return { admin: admin as never, calls };
}
const importJob = {
  id: JOB,
  kind: "import_voucher",
  params: {},
  push_id: "p1",
  check_first: false,
  remote_id: REMOTE,
  attempts: 1,
};
const outcomeOf = (calls: Array<{ fn: string; args: Record<string, unknown> }>) =>
  calls.find((c) => c.fn === "acc_tally_bridge_import_result")?.args;

describe("the answer to an import", () => {
  it("created, with Tally's MasterID", async () => {
    const { admin, calls } = fakeAdmin(importJob);
    const r = await applyResult(admin, auth, {
      job_id: JOB,
      outcome: "ok",
      parts: [
        gz("<RESPONSE><CREATED>1</CREATED><ERRORS>0</ERRORS><LASTVCHID>31</LASTVCHID></RESPONSE>"),
      ],
    });
    expect(r).toBe("created");
    expect(outcomeOf(calls)).toMatchObject({
      p_outcome: "created",
      p_master_id: 31,
      p_org_id: "org-1",
      p_device_id: "device-1",
    });
  });

  it("refused by Tally: failed with the LINEERROR text, redacted", async () => {
    const { admin, calls } = fakeAdmin(importJob);
    await applyResult(admin, auth, {
      job_id: JOB,
      outcome: "ok",
      parts: [
        gz(
          "<RESPONSE><LINEERROR>Ledger &apos;Card Demo&apos; does not exist! Call +971501234567</LINEERROR><ERRORS>1</ERRORS></RESPONSE>",
        ),
      ],
    });
    const a = outcomeOf(calls)!;
    expect(a).toMatchObject({ p_outcome: "failed", p_code: "tally_error" });
    expect(String(a.p_message)).toContain("Ledger 'Card Demo' does not exist!");
    expect(String(a.p_message)).not.toContain("971501234567");
  });

  it("an unreadable answer, a timeout or a look-up without the voucher is ambiguous, never success", async () => {
    for (const body of [
      { outcome: "ok" as const, parts: [gz("TallyPrime Server is Running")] },
      { outcome: "timeout" as const, code: "timeout" },
      {
        outcome: "exists" as const,
        parts: [gz("<ENVELOPE><BODY><DATA><COLLECTION></COLLECTION></DATA></BODY></ENVELOPE>")],
      },
      { outcome: "ok" as const, parts: ["***"] },
    ]) {
      const { admin, calls } = fakeAdmin(importJob);
      expect(await applyResult(admin, auth, { job_id: JOB, ...body })).toBe("ambiguous");
      expect(outcomeOf(calls)!.p_outcome).toBe("ambiguous");
    }
  });

  it("a look-up that shows the voucher settles it; Tally not running is a plain retry; a refusal by the connector fails it", async () => {
    let f = fakeAdmin(importJob);
    expect(
      await applyResult(f.admin, auth, {
        job_id: JOB,
        outcome: "exists",
        parts: [
          gz(
            `<ENVELOPE><BODY><DATA><COLLECTION><VOUCHER REMOTEID="${REMOTE}"><GUID>${REMOTE}</GUID><MASTERID>8</MASTERID></VOUCHER></COLLECTION></DATA></BODY></ENVELOPE>`,
          ),
        ],
      }),
    ).toBe("exists");
    expect(outcomeOf(f.calls)).toMatchObject({ p_outcome: "exists", p_master_id: 8 });
    f = fakeAdmin(importJob);
    expect(await applyResult(f.admin, auth, { job_id: JOB, outcome: "unreachable" })).toBe("retry");
    f = fakeAdmin(importJob);
    expect(
      await applyResult(f.admin, auth, { job_id: JOB, outcome: "error", code: "refused_job" }),
    ).toBe("failed");
    expect(outcomeOf(f.calls)).toMatchObject({ p_code: "connector_refused" });
    f = fakeAdmin(importJob);
    expect(await applyResult(f.admin, auth, { job_id: JOB, outcome: "absent" })).toBe("absent");
  });

  it("refuses an answer to a job that is not waiting for one", async () => {
    const { admin, calls } = fakeAdmin(null);
    await expect(applyResult(admin, auth, { job_id: JOB, outcome: "ok" })).rejects.toBeInstanceOf(
      ResultError,
    );
    expect(calls.map((c) => c.fn)).toEqual(["acc_tally_bridge_job"]);
  });

  it("an export that failed on the connector is recorded as failed with its code", async () => {
    const { admin, calls } = fakeAdmin({
      ...importJob,
      kind: "export_masters_since",
      push_id: null,
      remote_id: null,
    });
    expect(
      await applyResult(admin, auth, { job_id: JOB, outcome: "error", code: "tally_unreachable" }),
    ).toBe("failed");
    expect(calls.find((c) => c.fn === "acc_tally_bridge_export_result")?.args).toMatchObject({
      p_ok: false,
      p_code: "tally_unreachable",
    });
  });
});
