/**
 * docs/44: the Tally bridge's direct HTTPS connection to a hosted Tally. The envelopes are the connector's to the byte;
 * the address must be public https; the sign-in header per mode; a job runs exactly as the connector runs it; and through
 * the shared client an import is never sent twice (a 5xx or a timeout is ambiguous, the bridge looks it up next time),
 * a refused sign-in sends nothing, exports are retried, Tally's UTF-16 bytes arrive untouched and only the configured host
 * is called. Synthetic data only ("Demo Clinic"); no real Tally or network.
 */
import { randomBytes } from "node:crypto";

import { describe, expect, it } from "vitest";

import * as connector from "@/connector/tally-bridge/lib/envelopes.mjs";
import type { ConnectorJob } from "@/lib/accounting/tally/bridge-server";
import {
  readTallyDirectConfig,
  runDirectJob,
  tallyAuthHeaders,
  tallyDirectConfigProblems,
  TallySendError,
  tallyUrlProblem,
  type TallyPost,
} from "@/lib/accounting/tally/direct";
import { buildTallyDirect, usesDirect } from "@/lib/accounting/tally/direct-server";
import {
  answerHoldsVoucher,
  decodeTally,
  lookupRequest,
  mastersSinceRequests,
  trialBalanceRequest,
  vouchersSinceRequests,
} from "@/lib/accounting/tally/envelopes";
import type { AccountRow } from "@/lib/integrations/accounts";
import { extraValidation } from "@/lib/integrations/extra-validate";
import { readinessProblems } from "@/lib/integrations/readiness";
import { encryptJson } from "@/lib/crypto";
import type { AdminClient } from "@/lib/supabase/admin";

process.env.ENCRYPTION_KEY ||= randomBytes(32).toString("base64");

const COMPANY = "Demo Clinic LLC";
const REMOTE = "pulse-0f3c2b1a111142228333444455556666-pv-11111111222243338444555566667777-1";
const JOB_ID = "11111111-2222-4333-8444-555566667777";
const utf8 = (s: string) => new TextEncoder().encode(s);

describe("envelopes", () => {
  it("are the connector's requests byte for byte", () => {
    expect(mastersSinceRequests(COMPANY, 42)).toEqual(connector.mastersSinceRequests(COMPANY, 42));
    expect(vouchersSinceRequests(COMPANY, 7, "2026-07-01", "2026-07-31")).toEqual(
      connector.vouchersSinceRequests(COMPANY, 7, "2026-07-01", "2026-07-31"),
    );
    expect(trialBalanceRequest(COMPANY, "2026-07-31")).toBe(
      connector.trialBalanceRequest(COMPANY, "2026-07-31"),
    );
    expect(lookupRequest(COMPANY, REMOTE, "2026-07-15")).toBe(
      connector.lookupRequest(COMPANY, REMOTE, "2026-07-15"),
    );
    expect(() => lookupRequest(COMPANY, "not-pulse", "2026-07-15")).toThrow();
    expect(() => mastersSinceRequests(COMPANY, -1)).toThrow();
  });

  it("reads UTF-16 answers and finds a voucher by REMOTEID", () => {
    const text = `<ENVELOPE><VOUCHER REMOTEID="${REMOTE}"/></ENVELOPE>`;
    const le = new Uint8Array([0xff, 0xfe, ...new Uint8Array(Buffer.from(text, "utf16le"))]);
    expect(decodeTally(le)).toBe(text);
    expect(answerHoldsVoucher(decodeTally(le), REMOTE)).toBe(true);
    expect(answerHoldsVoucher(text, "pulse-other-1")).toBe(false);
  });
});

describe("settings", () => {
  it("accepts a public https address, with or without its own port", () => {
    expect(tallyUrlProblem("https://tally.partner-example.com/")).toBeNull();
    expect(tallyUrlProblem("https://tally.partner-example.com:9443/tally")).toBeNull();
  });

  it.each([
    ["http://tally.partner-example.com:9000/", "https://"],
    ["https://203.0.113.10:9000/", "IP address"],
    ["https://tally-server/", "IP address"],
    ["https://tally.local/", "IP address"],
    ["https://user:pw@tally.partner-example.com/", "own fields"],
    ["https://tally.partner-example.com/?key=1", "query string"],
    ["https://localhost./", "dot"],
    ["not a url", "web address"],
  ])("refuses %s", (url, words) => {
    expect(tallyUrlProblem(url)).toContain(words);
  });

  it("checks the sign-in fields", () => {
    const base = { tally_url: "https://tally.partner-example.com/" };
    expect(
      tallyDirectConfigProblems(readTallyDirectConfig({ ...base, tally_auth: "basic" })),
    ).toEqual(["Basic sign-in needs a user name."]);
    expect(
      tallyDirectConfigProblems(
        readTallyDirectConfig({ ...base, tally_auth: "header", tally_header: "Host" }),
      ),
    ).toHaveLength(1);
    expect(
      tallyDirectConfigProblems(readTallyDirectConfig({ ...base, tally_auth: "header" })),
    ).toEqual([]);
    expect(
      extraValidation("tally_bridge", "https", { tally_url: "http://x.example.com/" }),
    ).toContain("https://");
    expect(extraValidation("tally_bridge", "connector", {})).toBeNull();
  });

  it("is not ready without the address, the secret or a provider", () => {
    expect(
      readinessProblems({ kind: "tally_bridge", provider: null, config: {}, secretsStored: {} }),
    ).toEqual(["Choose a provider."]);
    const missing = readinessProblems({
      kind: "tally_bridge",
      provider: "https",
      config: { company: COMPANY },
      secretsStored: {},
    });
    expect(missing).toEqual(
      expect.arrayContaining([
        "Tally address is missing.",
        "Token, password or API key is missing.",
      ]),
    );
    expect(
      readinessProblems({
        kind: "tally_bridge",
        provider: "https",
        config: { company: COMPANY, tally_url: "https://tally.partner-example.com/" },
        secretsStored: { tally_secret: true },
      }),
    ).toEqual([]);
    expect(
      readinessProblems({
        kind: "tally_bridge",
        provider: "connector",
        config: { company: COMPANY },
        secretsStored: {},
      }),
    ).toEqual([]);
  });

  it("builds the sign-in header for each mode", () => {
    const c = readTallyDirectConfig({
      tally_url: "https://t.example.com/",
      tally_username: "demo",
    });
    expect(tallyAuthHeaders(c, "s3cret")).toEqual({ Authorization: "Bearer s3cret" });
    expect(tallyAuthHeaders({ ...c, auth: "basic" }, "s3cret")).toEqual({
      Authorization: `Basic ${Buffer.from("demo:s3cret").toString("base64")}`,
    });
    expect(tallyAuthHeaders({ ...c, auth: "header", header: "X-Api-Key" }, "s3cret")).toEqual({
      "X-Api-Key": "s3cret",
    });
  });
});

describe("runDirectJob", () => {
  const importJob = (
    over: Partial<Extract<ConnectorJob, { type: "import_voucher" }>> = {},
  ): ConnectorJob => ({
    id: JOB_ID,
    type: "import_voucher",
    company: COMPANY,
    remote_id: REMOTE,
    voucher_date: "2026-07-15",
    check_first: false,
    lookup_only: false,
    xml: "<ENVELOPE>voucher</ENVELOPE>",
    ...over,
  });
  const recorder = (answers: Record<string, string | TallySendError>) => {
    const sent: string[] = [];
    const post: TallyPost = async (_xml, op) => {
      sent.push(op);
      const a = answers[op] ?? "<ENVELOPE/>";
      if (a instanceof TallySendError) throw a;
      return utf8(a);
    };
    return { sent, post };
  };

  it("sends the connector's export requests and returns every answer", async () => {
    const { sent, post } = recorder({});
    const r = await runDirectJob(
      { id: JOB_ID, type: "export_masters_since", company: COMPANY, since_alter_id: 0 },
      post,
    );
    expect(r.outcome).toBe("ok");
    expect(r.answers).toHaveLength(3);
    expect(sent).toEqual(Array(3).fill("tally.export_masters"));
  });

  it("looks a voucher up first and does not import it when Tally holds it", async () => {
    const { sent, post } = recorder({
      "tally.lookup": `<ENVELOPE><VOUCHER REMOTEID="${REMOTE}"></VOUCHER></ENVELOPE>`,
    });
    expect((await runDirectJob(importJob({ check_first: true }), post)).outcome).toBe("exists");
    expect(sent).toEqual(["tally.lookup"]);
  });

  it("imports after a look-up that finds nothing; a look-up-only job never imports", async () => {
    const a = recorder({});
    expect((await runDirectJob(importJob({ check_first: true }), a.post)).outcome).toBe("ok");
    expect(a.sent).toEqual(["tally.lookup", "tally.import_voucher"]);
    const b = recorder({});
    expect((await runDirectJob(importJob({ lookup_only: true }), b.post)).outcome).toBe("absent");
    expect(b.sent).toEqual(["tally.lookup"]);
  });

  it("reports an import that may have reached Tally as a timeout (looked up next time)", async () => {
    const amb = recorder({ "tally.import_voucher": new TallySendError("ambiguous") });
    expect(await runDirectJob(importJob(), amb.post)).toEqual({
      outcome: "timeout",
      code: "timeout",
    });
    const notSent = recorder({ "tally.import_voucher": new TallySendError("not_sent") });
    expect(await runDirectJob(importJob(), notSent.post)).toEqual({
      outcome: "unreachable",
      code: "tally_unreachable",
    });
    const big = recorder({ "tally.export_tb": new TallySendError("too_large") });
    expect(
      await runDirectJob(
        { id: JOB_ID, type: "export_trial_balance", company: COMPANY, as_at: "2026-07-31" },
        big.post,
      ),
    ).toEqual({ outcome: "error", code: "too_large" });
  });
});

describe("buildTallyDirect through the shared client", () => {
  const account = (config: Record<string, string>, secret = "s3cret") =>
    ({
      org_id: "00000000-0000-4000-8000-000000000001",
      enabled: true,
      config: { provider: "https", company: COMPANY, ...config },
      config_enc: encryptJson({ tally_secret: secret }),
    }) as unknown as AccountRow;
  const calls: { url: string; method: string; headers: Record<string, string> }[] = [];
  const fake = (statuses: number[], body: Uint8Array = utf8("<ENVELOPE/>")) => {
    calls.length = 0;
    let i = 0;
    return (async (url: string, init: RequestInit) => {
      calls.push({
        url,
        method: String(init.method),
        headers: init.headers as Record<string, string>,
      });
      const status = statuses[Math.min(i++, statuses.length - 1)];
      return new Response(status >= 200 && status < 300 ? (body as BodyInit) : "no", { status });
    }) as unknown as typeof fetch;
  };
  const build = (
    fetchFn: typeof fetch,
    config = { tally_url: "https://tally.partner-example.com:9443/" },
  ) =>
    buildTallyDirect({} as AdminClient, account(config), {
      fetchFn,
      sleep: async () => {},
      sink: { record: () => {} },
      breaker: undefined,
    });

  it("is only built for the hosted provider with usable settings", () => {
    expect(usesDirect(account({ tally_url: "https://t.example.com/" }))).toBe(true);
    expect(
      buildTallyDirect(
        {} as AdminClient,
        {
          ...account({ tally_url: "https://t.example.com/" }),
          config: { provider: "connector", company: COMPANY },
        } as unknown as AccountRow,
      ),
    ).toBeNull();
    expect(build(fake([200]), { tally_url: "http://t.example.com/" })).toBeNull();
  });

  it("posts to the one configured address with the sign-in and keeps Tally's bytes", async () => {
    const utf16 = new Uint8Array([
      0xff,
      0xfe,
      ...new Uint8Array(Buffer.from("<ENVELOPE/>", "utf16le")),
    ]);
    const d = build(fake([200], utf16))!;
    const answer = await d.post("<ENVELOPE>x</ENVELOPE>", "tally.export_tb");
    expect(answer).toEqual(utf16);
    expect(calls).toHaveLength(1);
    expect(calls[0].url).toBe("https://tally.partner-example.com:9443/");
    expect(calls[0].headers.Authorization).toBe("Bearer s3cret");
  });

  it("never sends an import twice after a 5xx, and retries a read", async () => {
    const d = build(fake([502, 200]))!;
    await expect(d.post("<ENVELOPE>v</ENVELOPE>", "tally.import_voucher")).rejects.toMatchObject({
      failure: "ambiguous",
    });
    expect(calls).toHaveLength(1);
    const e = build(fake([502, 200]))!;
    await expect(e.post("<ENVELOPE>r</ENVELOPE>", "tally.export_masters")).resolves.toBeInstanceOf(
      Uint8Array,
    );
    expect(calls).toHaveLength(2);
  });

  it("treats a refused sign-in as not sent and reports it on the status check", async () => {
    const d = build(fake([401]))!;
    await expect(d.post("<ENVELOPE>v</ENVELOPE>", "tally.import_voucher")).rejects.toMatchObject({
      failure: "not_sent",
    });
    expect(await build(fake([403]))!.state()).toBe("auth");
    expect(await build(fake([200]))!.state()).toBe("ok");
    const down = build((async () => {
      throw new TypeError("fetch failed");
    }) as unknown as typeof fetch)!;
    expect(await down.state()).toBe("unreachable");
  });
});
