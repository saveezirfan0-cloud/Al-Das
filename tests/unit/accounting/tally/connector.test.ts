/**
 * Phase 22J: the Tally bridge connector (connector/tally-bridge), run against a fake Tally XML server and a fake Pulse
 * API, both started here on 127.0.0.1 (no real Tally, no network). Pairing; the export jobs build their own requests;
 * an import is forwarded byte for byte only when it is one Pulse voucher; look-ups before a resend; refusals (unknown job
 * type, a delete, a voucher that is not Pulse's, masters inside an import); Tally not running; HTTPS only; the logs
 * carry no amounts, names or XML. Synthetic data only ("Demo Clinic").
 */
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { gunzipSync } from "node:zlib";

import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { createBridge } from "@/connector/tally-bridge/lib/core.mjs";
import {
  lookupRequest,
  mastersSinceRequests,
  trialBalanceRequest,
  vouchersSinceRequests,
} from "@/connector/tally-bridge/lib/envelopes.mjs";
import { checkImportXml, checkJob } from "@/connector/tally-bridge/lib/validate.mjs";
import { importVerdict, parseImportResponse } from "@/lib/accounting/tally/response";
import { parseTallyXml } from "@/lib/accounting/tally/parse";
import { buildBridgeVoucherXml } from "@/lib/finance/tally-xml";

const TOKEN = "ptb_" + "t".repeat(43);
const REMOTE = "pulse-0f3c2b1a111142228333444455556666-pv-11111111222243338444555566667777-1";
const voucherXml = (remoteId = REMOTE) =>
  buildBridgeVoucherXml({
    company: "Demo Clinic LLC",
    costCategory: "Primary Cost Category",
    remoteId,
    number: "PB-0000000001",
    date: "2026-07-15",
    tallyType: "Pulse Payment",
    narration: "Pulse: Payment voucher PV-DEMO-1",
    entries: [
      { ledger: "Supplier Demo B", side: "debit", cents: 250_000 },
      { ledger: "Bank - Demo Main", side: "credit", cents: 250_000 },
    ],
  });
const uuid = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;

type Seen = { method: string; url: string; headers: IncomingMessage["headers"]; body: string };

function listen(handler: (req: IncomingMessage, body: string, res: ServerResponse) => void) {
  const seen: Seen[] = [];
  const server = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (c: Buffer) => chunks.push(c));
    req.on("end", () => {
      const body = Buffer.concat(chunks).toString("utf8");
      seen.push({ method: req.method ?? "", url: req.url ?? "", headers: req.headers, body });
      handler(req, body, res);
    });
  });
  return new Promise<{ server: Server; port: number; seen: Seen[] }>((resolve) =>
    server.listen(0, "127.0.0.1", () =>
      resolve({ server, port: (server.address() as AddressInfo).port, seen }),
    ),
  );
}

describe("the connector against a fake Tally and a fake Pulse", () => {
  let tally: Awaited<ReturnType<typeof listen>>;
  let pulse: Awaited<ReturnType<typeof listen>>;
  let jobs: unknown[] = [];
  let lookupFinds = false;
  const results: Array<Record<string, unknown>> = [];
  const logs: Array<Record<string, unknown>> = [];

  beforeAll(async () => {
    tally = await listen((req, body, res) => {
      res.setHeader("Content-Type", "text/xml");
      if (req.method === "GET") return res.end("<RESPONSE>TallyPrime Server is Running</RESPONSE>");
      if (body.includes("<ID>PulseBridgeLookup</ID>"))
        return res.end(
          lookupFinds
            ? `<ENVELOPE><BODY><DATA><COLLECTION><VOUCHER REMOTEID="${REMOTE}" VCHTYPE="Pulse Payment"><GUID>${REMOTE}</GUID><MASTERID>31</MASTERID><DATE>20260715</DATE></VOUCHER></COLLECTION></DATA></BODY></ENVELOPE>`
            : "<ENVELOPE><BODY><DATA><COLLECTION></COLLECTION></DATA></BODY></ENVELOPE>",
        );
      if (body.includes("<TALLYREQUEST>Import Data</TALLYREQUEST>"))
        return res.end(
          "<RESPONSE><CREATED>1</CREATED><ALTERED>0</ALTERED><LASTVCHID>31</LASTVCHID><ERRORS>0</ERRORS><EXCEPTIONS>0</EXCEPTIONS></RESPONSE>",
        );
      if (body.includes("<TYPE>Ledger</TYPE>"))
        return res.end(
          '<ENVELOPE><BODY><DATA><COLLECTION><LEDGER NAME="Bank - Demo Main"><GUID>demo-guid-led-bank</GUID><ALTERID>41</ALTERID><PARENT>Bank Accounts</PARENT><CLOSINGBALANCE>-2500.00</CLOSINGBALANCE></LEDGER></COLLECTION></DATA></BODY></ENVELOPE>',
        );
      return res.end("<ENVELOPE><BODY><DATA><COLLECTION></COLLECTION></DATA></BODY></ENVELOPE>");
    });
    pulse = await listen((req, body, res) => {
      res.setHeader("Content-Type", "application/json");
      if (req.url === "/api/tally-bridge/pair") {
        const code = JSON.parse(body).code;
        if (code !== "ABCD-EFGH-JKMN-PQRS") {
          res.statusCode = 401;
          return res.end('{"error":"invalid_code"}');
        }
        return res.end(JSON.stringify({ token: TOKEN, device_id: uuid(1), poll_seconds: 30 }));
      }
      if (req.headers.authorization !== `Bearer ${TOKEN}`) {
        res.statusCode = 401;
        return res.end('{"error":"unauthorised"}');
      }
      if (req.url === "/api/tally-bridge/jobs")
        return res.end(JSON.stringify({ jobs, poll_seconds: 30 }));
      if (req.url === "/api/tally-bridge/results") {
        results.push(JSON.parse(body));
        return res.end('{"ok":true}');
      }
      res.statusCode = 404;
      res.end("{}");
    });
  });
  afterAll(async () => {
    await new Promise((r) => tally.server.close(r));
    await new Promise((r) => pulse.server.close(r));
  });
  beforeEach(() => {
    jobs = [];
    lookupFinds = false;
    results.length = 0;
    logs.length = 0;
    tally.seen.length = 0;
  });

  const bridge = (over: Record<string, unknown> = {}) =>
    createBridge({
      pulseUrl: `http://127.0.0.1:${pulse.port}`,
      allowInsecureLocalPulse: true,
      tallyPort: tally.port,
      token: TOKEN,
      log: (event: string, fields?: Record<string, unknown>) => logs.push({ event, ...fields }),
      ...over,
    });
  const tallyPosts = () => tally.seen.filter((s) => s.method === "POST").map((s) => s.body);
  const part = (r: Record<string, unknown>, i = 0) =>
    gunzipSync(Buffer.from((r.parts as string[])[i], "base64"));

  it("pairs with the one-time code and keeps the token it got", async () => {
    const b = createBridge({
      pulseUrl: `http://127.0.0.1:${pulse.port}`,
      allowInsecureLocalPulse: true,
      tallyPort: tally.port,
      log: () => {},
    });
    await expect(b.pair("WRONG-CODE")).rejects.toThrow(/did not accept/);
    expect(await b.pair("ABCD-EFGH-JKMN-PQRS")).toEqual({ token: TOKEN, deviceId: uuid(1) });
    expect((await b.runOnce()).jobs).toBe(0);
  });

  it("runs the export jobs with its own requests and posts Tally's answers back (gzip)", async () => {
    jobs = [
      {
        id: uuid(10),
        type: "export_masters_since",
        company: "Demo Clinic LLC",
        since_alter_id: 40,
      },
      {
        id: uuid(11),
        type: "export_vouchers_since",
        company: "Demo Clinic LLC",
        since_alter_id: 500,
        from: "2025-07-01",
        to: "2027-08-01",
      },
      {
        id: uuid(12),
        type: "export_trial_balance",
        company: "Demo Clinic LLC",
        as_at: "2026-07-31",
      },
    ];
    const r = await bridge().runOnce();
    expect(r).toMatchObject({ state: "ok", jobs: 3, pollSeconds: 30 });
    const posts = tallyPosts();
    expect(posts).toHaveLength(3 + 2 + 1);
    expect(posts.slice(0, 3)).toEqual(mastersSinceRequests("Demo Clinic LLC", 40));
    expect(posts[0]).toContain("$AlterID &gt; 40");
    expect(posts.slice(3, 5)).toEqual(
      vouchersSinceRequests("Demo Clinic LLC", 500, "2025-07-01", "2027-08-01"),
    );
    expect(posts[5]).toBe(trialBalanceRequest("Demo Clinic LLC", "2026-07-31"));
    for (const p of posts)
      expect(p).not.toMatch(/Import Data|ACTION="Delete"|<TALLYREQUEST>(?!Export)/);
    expect(results.map((x) => [x.job_id, x.outcome, (x.parts as string[]).length])).toEqual([
      [uuid(10), "ok", 3],
      [uuid(11), "ok", 2],
      [uuid(12), "ok", 1],
    ]);
    // the server parses the answer with lib/accounting/tally/
    expect(parseTallyXml(part(results[2])).ledgers[0]).toMatchObject({
      name: "Bank - Demo Main",
      closingDrMinusCr: 250_000,
    });
  });

  it("forwards one Pulse voucher byte for byte and reports Tally's counters", async () => {
    const xml = voucherXml();
    jobs = [
      {
        id: uuid(20),
        type: "import_voucher",
        company: "Demo Clinic LLC",
        remote_id: REMOTE,
        voucher_date: "2026-07-15",
        check_first: false,
        lookup_only: false,
        xml,
      },
    ];
    await bridge().runOnce();
    expect(tallyPosts()).toEqual([xml]);
    expect(results).toHaveLength(1);
    expect(results[0]).toMatchObject({ job_id: uuid(20), outcome: "ok" });
    expect(importVerdict(parseImportResponse(part(results[0])))).toEqual({
      outcome: "created",
      masterId: 31,
    });
  });

  it("after an unknown answer: looks the voucher up first and sends it only when Tally does not hold it", async () => {
    const job = {
      id: uuid(21),
      type: "import_voucher",
      company: "Demo Clinic LLC",
      remote_id: REMOTE,
      voucher_date: "2026-07-15",
      check_first: true,
      lookup_only: false,
      xml: voucherXml(),
    };
    lookupFinds = true;
    jobs = [job];
    await bridge().runOnce();
    expect(tallyPosts()).toEqual([lookupRequest("Demo Clinic LLC", REMOTE, "2026-07-15")]);
    expect(results[0]).toMatchObject({ outcome: "exists" });
    expect(parseTallyXml(part(results[0])).vouchers[0]).toMatchObject({
      remoteId: REMOTE,
      masterId: 31,
    });

    tally.seen.length = 0;
    results.length = 0;
    lookupFinds = false;
    await bridge().runOnce();
    expect(tallyPosts()).toEqual([lookupRequest("Demo Clinic LLC", REMOTE, "2026-07-15"), job.xml]);
    expect(results[0]).toMatchObject({ outcome: "ok" });

    // while pushing is stopped it only looks
    tally.seen.length = 0;
    results.length = 0;
    jobs = [{ ...job, lookup_only: true }];
    await bridge().runOnce();
    expect(tallyPosts()).toHaveLength(1);
    expect(results[0]).toEqual({ job_id: uuid(21), outcome: "absent" });
  });

  it("serves several Tally companies in one run: every request names the company of its own job (W7)", async () => {
    const REMOTE_B = "pulse-0f3c2b1a111142228333444455556666-pv-99999999222243338444555566667777-1";
    const xmlB = buildBridgeVoucherXml({
      company: "Demo Pharmacy FZ-LLC",
      costCategory: "Primary Cost Category",
      remoteId: REMOTE_B,
      number: "PB-0000000002",
      date: "2026-07-16",
      tallyType: "Pulse Payment",
      narration: "Pulse: Payment voucher PV-DEMO-2",
      entries: [
        { ledger: "Supplier Demo B", side: "debit", cents: 1_000 },
        { ledger: "Bank - Demo Main", side: "credit", cents: 1_000 },
      ],
    });
    jobs = [
      {
        id: uuid(60),
        type: "export_masters_since",
        company: "Demo Clinic LLC",
        since_alter_id: 40,
      },
      {
        id: uuid(61),
        type: "export_masters_since",
        company: "Demo Pharmacy FZ-LLC",
        since_alter_id: 7,
      },
      {
        id: uuid(62),
        type: "import_voucher",
        company: "Demo Pharmacy FZ-LLC",
        remote_id: REMOTE_B,
        voucher_date: "2026-07-16",
        check_first: false,
        lookup_only: false,
        xml: xmlB,
      },
    ];
    await bridge().runOnce();
    const posts = tallyPosts();
    // each company is asked from its own AlterID, and the import goes to the company its job names
    expect(posts.slice(0, 3)).toEqual(mastersSinceRequests("Demo Clinic LLC", 40));
    expect(posts.slice(3, 6)).toEqual(mastersSinceRequests("Demo Pharmacy FZ-LLC", 7));
    expect(posts[6]).toBe(xmlB);
    expect(posts[6]).toContain("<SVCURRENTCOMPANY>Demo Pharmacy FZ-LLC</SVCURRENTCOMPANY>");
    for (const p of posts.slice(0, 3)) expect(p).not.toContain("Pharmacy");
    for (const p of posts.slice(3, 6)) expect(p).not.toContain("Demo Clinic");
    expect(results.map((r) => [r.job_id, r.outcome])).toEqual([
      [uuid(60), "ok"],
      [uuid(61), "ok"],
      [uuid(62), "ok"],
    ]);
  });

  it("never lets a voucher reach a company other than its job's: the XML must name the job's company (W7)", async () => {
    const forClinic = voucherXml(); // built for "Demo Clinic LLC"
    jobs = [
      {
        id: uuid(63),
        type: "import_voucher",
        company: "Demo Pharmacy FZ-LLC", // the job says another company
        remote_id: REMOTE,
        voucher_date: "2026-07-15",
        check_first: false,
        lookup_only: false,
        xml: forClinic,
      },
    ];
    await bridge().runOnce();
    expect(tallyPosts()).toEqual([]);
    expect(results.map((r) => [r.job_id, r.outcome, r.code])).toEqual([
      [uuid(63), "error", "refused_job"],
    ]);
    expect(
      checkJob({
        id: uuid(63),
        type: "import_voucher",
        company: "Demo Pharmacy FZ-LLC",
        remote_id: REMOTE,
        voucher_date: "2026-07-15",
        xml: forClinic,
      }),
    ).toBe("wrong_company");
    expect(
      checkJob({
        id: uuid(64),
        type: "import_voucher",
        company: "Demo Clinic LLC",
        remote_id: REMOTE,
        voucher_date: "2026-07-15",
        xml: forClinic,
      }),
    ).toBeNull();
    // a name with characters XML escapes still matches itself
    const amp = voucherXml().replace("Demo Clinic LLC", "Demo &amp; Sons &lt;1&gt;");
    expect(
      checkJob({
        id: uuid(65),
        type: "import_voucher",
        company: "Demo & Sons <1>",
        remote_id: REMOTE,
        voucher_date: "2026-07-15",
        xml: amp,
      }),
    ).toBeNull();
  });

  it("refuses anything else: an unknown job, a delete, someone else's voucher, masters inside an import", async () => {
    const xml = voucherXml();
    const del = xml.replace('ACTION="Create"', 'ACTION="Delete"');
    const ledger = xml.replace(
      '<TALLYMESSAGE xmlns:UDF="TallyUDF">',
      '<TALLYMESSAGE xmlns:UDF="TallyUDF"><LEDGER NAME="Bank - Demo Main" ACTION="Alter"><PARENT>Suspense A/c</PARENT></LEDGER>',
    );
    const notOurs = voucherXml("pulse-x-1").replace(/pulse-x-1/g, "demo-guid-v1");
    const base = {
      company: "Demo Clinic LLC",
      remote_id: REMOTE,
      voucher_date: "2026-07-15",
      check_first: false,
      lookup_only: false,
    };
    jobs = [
      { id: uuid(30), type: "delete_voucher", company: "Demo Clinic LLC", remote_id: REMOTE },
      { id: uuid(31), type: "import_voucher", ...base, xml: del },
      { id: uuid(32), type: "import_voucher", ...base, xml: ledger },
      { id: uuid(33), type: "import_voucher", ...base, remote_id: "demo-guid-v1", xml: notOurs },
      { id: uuid(34), type: "import_voucher", ...base, xml: `${xml}${xml}` },
      {
        id: uuid(35),
        type: "export_masters_since",
        company: "Demo Clinic LLC",
        since_alter_id: -1,
      },
      {
        id: "not-a-uuid",
        type: "export_trial_balance",
        company: "Demo Clinic LLC",
        as_at: "2026-07-31",
      },
    ];
    await bridge().runOnce();
    expect(tallyPosts()).toEqual([]);
    expect(results.map((r) => [r.job_id, r.outcome, r.code])).toEqual([
      [uuid(30), "error", "refused_job"],
      [uuid(31), "error", "refused_job"],
      [uuid(32), "error", "refused_job"],
      [uuid(33), "error", "refused_job"],
      [uuid(34), "error", "refused_job"],
      [uuid(35), "error", "refused_job"],
      ["not-a-uuid", "error", "refused_job"],
    ]);
    expect(checkImportXml(del, REMOTE)).toBe("bad_action");
    expect(checkImportXml(ledger, REMOTE)).toBe("forbidden_object");
    expect(
      checkImportXml(
        xml.replace("<ISDEEMEDPOSITIVE>Yes", "<ISDELETED>Yes</ISDELETED><ISDEEMEDPOSITIVE>Yes"),
        REMOTE,
      ),
    ).toBe("delete");
    expect(
      checkImportXml(
        xml.replace("<ENVELOPE>", '<!DOCTYPE x [<!ENTITY e SYSTEM "file:///c:/">]><ENVELOPE>'),
        REMOTE,
      ),
    ).toBe("not_an_envelope");
    expect(checkImportXml(xml.replace("Import Data", "Export"), REMOTE)).toBe("not_an_import");
    expect(
      checkImportXml(xml.replace(`<GUID>${REMOTE}</GUID>`, "<GUID>other</GUID>"), REMOTE),
    ).toBe("not_pulse_voucher");
    expect(
      checkJob({
        id: uuid(1),
        type: "export_vouchers_since",
        company: "Demo Clinic LLC",
        since_alter_id: 1,
        from: "2026-08-01",
        to: "2026-07-01",
      }),
    ).toBe("bad_dates");
    expect(
      checkJob({ id: uuid(1), type: "export_trial_balance", company: "", as_at: "2026-07-31" }),
    ).toBe("bad_company");
  });

  it("Tally not running: the state says so and an import is reported as never reaching Tally", async () => {
    const closed = await listen(() => {});
    const port = closed.port;
    await new Promise((r) => closed.server.close(r));
    const b = bridge({ tallyPort: port });
    expect(await b.tallyState()).toBe("unreachable");
    expect(
      await b.runJob({
        id: uuid(40),
        type: "import_voucher",
        company: "Demo Clinic LLC",
        remote_id: REMOTE,
        voucher_date: "2026-07-15",
        check_first: false,
        lookup_only: false,
        xml: voucherXml(),
      }),
    ).toBe("unreachable");
    expect(results[0]).toEqual({
      job_id: uuid(40),
      outcome: "unreachable",
      code: "tally_unreachable",
    });
    expect(
      await b.runJob({
        id: uuid(41),
        type: "export_trial_balance",
        company: "Demo Clinic LLC",
        as_at: "2026-07-31",
      }),
    ).toBe("error");
    expect(results[1]).toEqual({ job_id: uuid(41), outcome: "error", code: "tally_unreachable" });
  });

  it("talks to Pulse over HTTPS only and to Tally on this PC only", () => {
    expect(() => createBridge({ pulseUrl: "http://pulse.example.com", token: TOKEN })).toThrow(
      /https/,
    );
    expect(() =>
      createBridge({
        pulseUrl: "http://pulse.example.com",
        token: TOKEN,
        allowInsecureLocalPulse: true,
      }),
    ).toThrow(/https/);
    expect(() =>
      createBridge({ pulseUrl: "https://user:pw@pulse.example.com", token: TOKEN }),
    ).toThrow(/user name/);
    expect(() => createBridge({ pulseUrl: "https://pulse.example.com", tallyPort: 70000 })).toThrow(
      /port/,
    );
    expect(() =>
      createBridge({ pulseUrl: "https://pulse.example.com", token: TOKEN }),
    ).not.toThrow();
  });

  it("logs job types, outcomes and timings only: no amounts, ledger names, company or XML", async () => {
    jobs = [
      {
        id: uuid(50),
        type: "import_voucher",
        company: "Demo Clinic LLC",
        remote_id: REMOTE,
        voucher_date: "2026-07-15",
        check_first: false,
        lookup_only: false,
        xml: voucherXml(),
      },
      {
        id: uuid(51),
        type: "export_trial_balance",
        company: "Demo Clinic LLC",
        as_at: "2026-07-31",
      },
    ];
    await bridge().runOnce();
    const text = JSON.stringify(logs);
    expect(logs.map((l) => [l.event, l.type, l.outcome])).toEqual([
      ["job", "import_voucher", "ok"],
      ["job", "export_trial_balance", "ok"],
    ]);
    for (const s of [
      "2500",
      "Supplier Demo B",
      "Bank - Demo Main",
      "Demo Clinic",
      "<",
      REMOTE,
      TOKEN,
    ])
      expect(text).not.toContain(s);
  });
});
