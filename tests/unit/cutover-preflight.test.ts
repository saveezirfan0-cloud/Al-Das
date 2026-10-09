import { describe, expect, it } from "vitest";

import {
  evaluateChannels,
  evaluateData,
  evaluateEnv,
  evaluateQueues,
  evaluateSignOff,
  renderPreflight,
  summarise,
  type ChannelFacts,
} from "@/lib/cutover/preflight";
import { randomBytes } from "node:crypto";

const goodEnv = {
  NEXT_PUBLIC_SUPABASE_URL: "https://x.supabase.co",
  NEXT_PUBLIC_SUPABASE_ANON_KEY: "anon",
  SUPABASE_SERVICE_ROLE_KEY: "svc",
  META_APP_ID: "123",
  META_APP_SECRET: "secret",
  META_WEBHOOK_VERIFY_TOKEN: "verify",
  ENCRYPTION_KEY: randomBytes(32).toString("base64"),
  JOB_SECRET: "j".repeat(32),
  APP_URL: "https://pulse.example.com",
  RESEND_API_KEY: "re_x",
  SENTRY_DSN: "https://k@sentry.io/1",
  META_GRAPH_VERSION: "v21.0",
};

const failed = (checks: ReturnType<typeof evaluateEnv>, severity = "blocker") =>
  checks.filter((c) => !c.ok && c.severity === severity).map((c) => c.id);

describe("evaluateEnv", () => {
  it("passes a complete production environment", () => {
    expect(failed(evaluateEnv(goodEnv))).toEqual([]);
  });
  it("blocks on missing secrets, a short JOB_SECRET and a bad ENCRYPTION_KEY", () => {
    expect(failed(evaluateEnv({ ...goodEnv, META_APP_SECRET: "" }))).toContain(
      "env:META_APP_SECRET",
    );
    expect(failed(evaluateEnv({ ...goodEnv, JOB_SECRET: "short" }))).toContain("env:JOB_SECRET");
    expect(failed(evaluateEnv({ ...goodEnv, ENCRYPTION_KEY: "abc" }))).toContain(
      "env:ENCRYPTION_KEY:valid",
    );
    expect(failed(evaluateEnv({ ...goodEnv, ENCRYPTION_KEY: undefined }))).toEqual(
      expect.arrayContaining(["env:ENCRYPTION_KEY", "env:ENCRYPTION_KEY:valid"]),
    );
  });
  it("blocks a localhost or http APP_URL (pg_cron and Meta need the public address)", () => {
    expect(failed(evaluateEnv({ ...goodEnv, APP_URL: "http://localhost:3000" }))).toContain(
      "env:APP_URL",
    );
    expect(failed(evaluateEnv({ ...goodEnv, APP_URL: "http://pulse.example.com" }))).toContain(
      "env:APP_URL",
    );
  });
  it("blocks when the load-test Graph stub is configured", () => {
    expect(
      failed(evaluateEnv({ ...goodEnv, META_GRAPH_BASE_URL: "http://127.0.0.1:4010" })),
    ).toContain("env:graph-base");
  });
  it("warns about migration-only secrets and workspace creation", () => {
    const w = failed(
      evaluateEnv({
        ...goodEnv,
        AIRTABLE_PAT: "pat",
        MAKE_API_TOKEN: "t",
        ALLOW_WORKSPACE_CREATION: "true",
      }),
      "warning",
    );
    expect(w).toEqual(
      expect.arrayContaining([
        "env:AIRTABLE_PAT:remove",
        "env:MAKE_API_TOKEN:remove",
        "env:workspace-creation",
      ]),
    );
  });
});

describe("evaluateQueues", () => {
  const now = Date.parse("2026-11-02T10:00:00Z");
  const cron = [
    {
      jobname: "pulse:meta_events",
      active: true,
      last_status: "succeeded",
      last_end: "2026-11-02T09:59:55Z",
    },
    {
      jobname: "pulse:outbound",
      active: true,
      last_status: "succeeded",
      last_end: "2026-11-02T09:59:58Z",
    },
    {
      jobname: "pulse:scheduler",
      active: true,
      last_status: "succeeded",
      last_end: "2026-11-02T09:59:50Z",
    },
  ];
  const metrics = [{ queue_name: "meta_events", queue_length: 2, oldest_msg_age_sec: 4 }];
  it("passes a healthy system", () => {
    expect(failed(evaluateQueues(metrics, 0, 0, cron, now))).toEqual([]);
  });
  it("blocks on an old hot-queue message, dead letters and stale webhooks", () => {
    const f = failed(
      evaluateQueues(
        [{ queue_name: "outbound", queue_length: 40, oldest_msg_age_sec: 900 }],
        2,
        3,
        cron,
        now,
      ),
    );
    expect(f).toEqual(
      expect.arrayContaining(["jobs:backlog", "jobs:dead-letters", "jobs:stale-webhooks"]),
    );
  });
  it("blocks when cron is inactive, failing or silent (e.g. vault secrets missing)", () => {
    expect(
      failed(evaluateQueues(metrics, 0, 0, [{ ...cron[0], active: false }, cron[1], cron[2]], now)),
    ).toContain("jobs:cron:active");
    expect(
      failed(
        evaluateQueues(
          metrics,
          0,
          0,
          [{ ...cron[0], last_status: "failed" }, cron[1], cron[2]],
          now,
        ),
      ),
    ).toContain("jobs:cron:status");
    expect(
      failed(
        evaluateQueues(
          metrics,
          0,
          0,
          [{ ...cron[0], last_end: "2026-11-02T09:50:00Z" }, cron[1], cron[2]],
          now,
        ),
      ),
    ).toContain("jobs:cron:fresh");
    expect(failed(evaluateQueues(metrics, 0, 0, [], now))).toContain("jobs:cron:active");
  });
  it("only warns when cron status cannot be read", () => {
    expect(failed(evaluateQueues(metrics, 0, 0, null, now), "warning")).toContain("jobs:cron");
    expect(failed(evaluateQueues(metrics, 0, 0, null, now))).toEqual([]);
  });
});

const channel = (over: Partial<ChannelFacts> = {}): ChannelFacts => ({
  phoneNumberId: "111",
  name: "Reception",
  status: "active",
  qualityRating: "GREEN",
  lastSyncedAt: "2026-11-02T08:00:00Z",
  hasOwnToken: true,
  templateCount: 12,
  approvedTemplateCount: 10,
  sendRatePerSec: 20,
  meta: {
    reachable: true,
    subscribedAppIds: ["999"],
    subscribedAppNames: ["Sanoflow"],
    phoneStatus: "CONNECTED",
  },
  ...over,
});
const opts = { metaAppId: "123", envTokenSet: false, now: Date.parse("2026-11-02T10:00:00Z") };

describe("evaluateChannels", () => {
  it("pre-cutover: a number still on Sanoflow is ready to move; the foreign app is informational", () => {
    const checks = evaluateChannels([channel()], "pre-cutover", opts);
    expect(failed(checks)).toEqual([]);
    expect(checks.find((c) => c.id === "wa:111:others")?.detail).toContain("Sanoflow");
  });
  it("post-cutover: requires our app subscribed and Sanoflow gone", () => {
    const stillThere = evaluateChannels([channel()], "post-cutover", opts);
    expect(failed(stillThere)).toEqual(expect.arrayContaining(["wa:111:ours", "wa:111:legacy"]));
    const done = evaluateChannels(
      [
        channel({
          meta: { reachable: true, subscribedAppIds: ["123"], subscribedAppNames: ["Pulse"] },
        }),
      ],
      "post-cutover",
      opts,
    );
    expect(failed(done)).toEqual([]);
  });
  it("blocks on RED quality, a paused channel, no token, no approved templates, or Meta unreachable", () => {
    expect(
      failed(evaluateChannels([channel({ qualityRating: "RED" })], "pre-cutover", opts)),
    ).toContain("wa:111:quality");
    expect(
      failed(evaluateChannels([channel({ status: "paused" })], "pre-cutover", opts)),
    ).toContain("wa:111:active");
    expect(
      failed(evaluateChannels([channel({ hasOwnToken: false })], "pre-cutover", opts)),
    ).toContain("wa:111:token");
    expect(
      failed(
        evaluateChannels([channel({ hasOwnToken: false })], "pre-cutover", {
          ...opts,
          envTokenSet: true,
        }),
      ),
    ).toEqual([]);
    expect(
      failed(evaluateChannels([channel({ approvedTemplateCount: 0 })], "pre-cutover", opts)),
    ).toContain("wa:111:templates");
    expect(
      failed(
        evaluateChannels(
          [
            channel({
              meta: {
                reachable: false,
                error: "401",
                subscribedAppIds: [],
                subscribedAppNames: [],
              },
            }),
          ],
          "pre-cutover",
          opts,
        ),
      ),
    ).toContain("wa:111:meta");
  });
  it("warns (does not block) when Graph was skipped, sync is stale, or the rate could exceed Meta throughput", () => {
    const w = failed(
      evaluateChannels(
        [channel({ meta: null, lastSyncedAt: null, sendRatePerSec: 60 })],
        "pre-cutover",
        opts,
      ),
      "warning",
    );
    expect(w).toEqual(expect.arrayContaining(["wa:111:meta", "wa:111:synced", "wa:111:rate"]));
  });
  it("blocks when no number is configured", () => {
    expect(failed(evaluateChannels([], "pre-cutover", opts))).toContain("wa:channels");
  });
});

describe("evaluateData / evaluateSignOff", () => {
  it("blocks on open reviews, leftover load-test data, and no admin", () => {
    const f = failed(
      evaluateData({
        openReviews: 3,
        contactsLive: 100,
        loadTestContacts: 2,
        adminMembers: 0,
        outboundFailed24h: 0,
      }),
    );
    expect(f).toEqual(expect.arrayContaining(["data:reviews", "data:load-test", "data:admin"]));
    expect(
      failed(
        evaluateData({
          openReviews: 0,
          contactsLive: 100,
          loadTestContacts: 0,
          adminMembers: 1,
          outboundFailed24h: 0,
        }),
      ),
    ).toEqual([]);
    expect(
      failed(
        evaluateData({
          openReviews: 0,
          contactsLive: 0,
          loadTestContacts: 0,
          adminMembers: 1,
          outboundFailed24h: 0,
        }),
      ),
    ).toContain("data:contacts");
  });
  it("requires a ready, signed reconciliation", () => {
    expect(failed(evaluateSignOff(null, null, null))).toContain("signoff:report");
    expect(failed(evaluateSignOff(null, "r.md", true))).toContain("signoff:signed");
    expect(failed(evaluateSignOff(["decision is NO-GO"], "r.md", true))).toContain(
      "signoff:signed",
    );
    expect(failed(evaluateSignOff([], "r.md", false))).toContain("signoff:report");
    expect(failed(evaluateSignOff([], "r.md", true))).toEqual([]);
  });
});

describe("render", () => {
  it("shows GO/NO-GO and groups checks", () => {
    const checks = [
      ...evaluateEnv(goodEnv),
      ...evaluateData({
        openReviews: 1,
        contactsLive: 5,
        loadTestContacts: 0,
        adminMembers: 1,
        outboundFailed24h: 0,
      }),
    ];
    const md = renderPreflight(checks, {
      stage: "pre-cutover",
      generatedAt: "2026-11-02T10:00:00Z",
      orgSlug: "al-das",
    });
    expect(md).toContain("NO-GO");
    expect(md).toContain("## Environment");
    expect(md).toContain("## Data");
    expect(summarise(checks).blockers).toBe(1);
    expect(md).toContain("Read-only");
  });
});
