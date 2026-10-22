import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

import { allFields, integrationDef, validateFields } from "@/lib/integrations/catalog";
import type { CallRecord } from "@/lib/integrations/client";
import { CALL_PROVIDERS } from "@/lib/integrations/health";
import { readinessProblems } from "@/lib/integrations/readiness";
import {
  answerSaysFailed,
  answerStopsMarketing,
  createSanoflowClient,
  readMessageId,
} from "@/lib/integrations/sanoflow/client";
import {
  isSanoflowChannel,
  readSanoflowConfig,
  SANOFLOW_SEND_TEMPLATE_URL,
  sanoflowPhone,
  sanoflowWebhookBase,
} from "@/lib/integrations/sanoflow/config";
import { sanoflowMapperValues } from "@/lib/integrations/sanoflow/params";
import { sanoflowChannelRef, sanoflowTemplateDraft } from "@/lib/integrations/sanoflow/setup";
import {
  parseSanoflowStatus,
  sanoflowEventKey,
  verifySanoflowToken,
} from "@/lib/integrations/sanoflow/webhook";
import type { MetaTemplateComponent } from "@/lib/whatsapp/types";

// Synthetic values only (CLAUDE.md rule 10): numbers in the reserved +44 7700 900xxx range, "Layla Demo-07".
const PHONE = "+447700900123";
const KEY = "sanoflow-test-key-not-real";
const TOKEN = "t".repeat(40);

const body = (text: string): MetaTemplateComponent[] => [
  { type: "BODY", text } as MetaTemplateComponent,
];

type Call = { url: string; init: RequestInit };
function fakeFetch(answers: Array<{ status: number; json?: unknown } | "timeout">) {
  const calls: Call[] = [];
  let i = 0;
  const fn = (async (url: string, init: RequestInit) => {
    calls.push({ url, init });
    const a = answers[Math.min(i++, answers.length - 1)]!;
    if (a === "timeout") {
      const e = new Error("timed out");
      e.name = "TimeoutError";
      throw e;
    }
    return new Response(a.json === undefined ? "" : JSON.stringify(a.json), {
      status: a.status,
      headers: { "content-type": "application/json" },
    });
  }) as unknown as typeof fetch;
  return { fn, calls };
}

function client(answers: Parameters<typeof fakeFetch>[0]) {
  const f = fakeFetch(answers);
  const records: CallRecord[] = [];
  const c = createSanoflowClient({
    accessToken: KEY,
    fetchFn: f.fn,
    sleep: async () => undefined,
    sink: { record: (r) => void records.push(r) },
  })!;
  return { c, calls: f.calls, records };
}

describe("template values → mapper_value", () => {
  it("fills {{1}}, {{2}}, {{3}} in order (the appointment reminder shape Make uses)", () => {
    const r = sanoflowMapperValues(body("Dear {{1}}, tomorrow at {{2}} with {{3}}."), {
      "body.1": "Layla",
      "body.2": "10:30",
      "body.3": "the doctor",
    });
    expect(r).toEqual({ ok: true, values: ["Layla", "10:30", "the doctor"] });
  });

  it("a template without variables sends an empty list", () => {
    expect(sanoflowMapperValues(body("Happy birthday from the clinic."), {})).toEqual({
      ok: true,
      values: [],
    });
  });

  it("refuses what one ordered list cannot express, and missing values", () => {
    expect(sanoflowMapperValues(body("Hi {{name}}"), { "body.name": "x" }, "named").ok).toBe(false);
    expect(
      sanoflowMapperValues(body("Hi {{1}} and {{3}}"), { "body.1": "a", "body.3": "c" }).ok,
    ).toBe(false);
    expect(sanoflowMapperValues(body("Hi {{1}}"), {}).ok).toBe(false);
    expect(sanoflowMapperValues(body("Hi {{1}}"), { "body.1": "  " }).ok).toBe(false);
    const withHeader: MetaTemplateComponent[] = [
      { type: "HEADER", format: "TEXT", text: "For {{1}}" } as MetaTemplateComponent,
      ...body("Hi {{1}}"),
    ];
    expect(sanoflowMapperValues(withHeader, { "header.1": "a", "body.1": "b" }).ok).toBe(false);
    const withMedia: MetaTemplateComponent[] = [
      { type: "HEADER", format: "IMAGE" } as MetaTemplateComponent,
      ...body("Hi"),
    ];
    expect(sanoflowMapperValues(withMedia, { "header.media": "media:x" }).ok).toBe(false);
  });
});

describe("phone, config and channel", () => {
  it("writes the number as digits by default, with + when chosen, and refuses anything not E.164", () => {
    expect(sanoflowPhone(PHONE, "digits")).toBe("447700900123");
    expect(sanoflowPhone(PHONE, "plus")).toBe(PHONE);
    expect(sanoflowPhone("07700900123", "digits")).toBeNull();
    expect(sanoflowPhone(null, "digits")).toBeNull();
    expect(readSanoflowConfig({}).phoneFormat).toBe("digits");
    expect(readSanoflowConfig({ phone_format: "plus" }).phoneFormat).toBe("plus");
    expect(readSanoflowConfig({ phone_format: "other" }).phoneFormat).toBe("digits");
  });

  it("only transport 'sanoflow' is a Sanoflow number", () => {
    expect(isSanoflowChannel({ transport: "sanoflow" })).toBe(true);
    expect(isSanoflowChannel({ transport: "meta" })).toBe(false);
    expect(isSanoflowChannel(null)).toBe(false);
    expect(sanoflowChannelRef("00000000-0000-4000-8000-000000000001")).toMatch(/^sanoflow:/);
  });
});

describe("Sanoflow client", () => {
  it("posts Make's exact request: template_id, phone, mapper_value, access-token header", async () => {
    const { c, calls, records } = client([
      { status: 200, json: { status: true, data: { message_id: "abc" } } },
    ]);
    const r = await c.sendTemplate({
      templateId: 11885,
      phone: "447700900123",
      values: ["Layla", "10:30"],
    });
    expect(r).toEqual({ ok: true, providerMessageId: "abc" });
    expect(calls).toHaveLength(1);
    expect(calls[0]!.url).toBe(SANOFLOW_SEND_TEMPLATE_URL);
    expect(calls[0]!.init.method).toBe("POST");
    expect((calls[0]!.init.headers as Record<string, string>)["access-token"]).toBe(KEY);
    expect(JSON.parse(String(calls[0]!.init.body))).toEqual({
      template_id: 11885,
      phone: "447700900123",
      mapper_value: ["Layla", "10:30"],
    });
    // The call log holds the operation and outcome only, never the key, number or body.
    expect(JSON.stringify(records)).not.toContain(KEY);
    expect(JSON.stringify(records)).not.toContain("447700900123");
    expect(records[0]).toMatchObject({
      provider: "sanoflow",
      operation: "sanoflow.send_template",
      outcome: "ok",
    });
  });

  it("a 2xx that says it failed is a definite failure, not a success", async () => {
    const { c } = client([
      { status: 200, json: { status: false, message: "Invalid channel details" } },
    ]);
    const r = await c.sendTemplate({ templateId: 1, phone: "447700900123", values: [] });
    expect(r).toMatchObject({ ok: false, ambiguous: false, retryable: false, code: "rejected" });
  });

  it("401 is an auth failure; 131050 in the answer stops marketing", async () => {
    expect(
      await client([{ status: 401, json: {} }]).c.sendTemplate({
        templateId: 1,
        phone: "4477",
        values: [],
      }),
    ).toMatchObject({ ok: false, auth: true, code: "auth" });
    expect(
      await client([{ status: 400, json: { error: { code: 131050 } } }]).c.sendTemplate({
        templateId: 1,
        phone: "4477",
        values: [],
      }),
    ).toMatchObject({ ok: false, stopMarketing: true });
  });

  it("retries a 429 (not processed) but never re-sends after a 5xx or a timeout (ambiguous)", async () => {
    const throttled = client([{ status: 429 }, { status: 200, json: {} }]);
    expect(await throttled.c.sendTemplate({ templateId: 1, phone: "4477", values: [] })).toEqual({
      ok: true,
      providerMessageId: null,
    });
    expect(throttled.calls).toHaveLength(2);

    const down = client([{ status: 502 }, { status: 200, json: {} }]);
    expect(await down.c.sendTemplate({ templateId: 1, phone: "4477", values: [] })).toMatchObject({
      ok: false,
      ambiguous: true,
    });
    expect(down.calls).toHaveLength(1);

    const slow = client(["timeout", { status: 200, json: {} }]);
    expect(await slow.c.sendTemplate({ templateId: 1, phone: "4477", values: [] })).toMatchObject({
      ok: false,
      ambiguous: true,
    });
    expect(slow.calls).toHaveLength(1);
  });

  it("the key check asks for contact id 0 (no patient comes back) and never posts", async () => {
    const { c, calls } = client([{ status: 200, json: { data: [] } }]);
    expect(await c.verify()).toEqual({ ok: true });
    expect(calls[0]!.init.method).toBe("GET");
    expect(calls[0]!.url).toContain("contact_id=0");
    expect(await client([{ status: 403 }]).c.verify()).toEqual({ ok: false, code: "auth" });
  });

  it("judges answers conservatively", () => {
    expect(answerSaysFailed({ success: false })).toBe(true);
    expect(answerSaysFailed({ status: "error" })).toBe(true);
    expect(answerSaysFailed({ error: "bad" })).toBe(true);
    expect(answerSaysFailed({ status: true })).toBe(false);
    expect(answerSaysFailed(null)).toBe(false);
    expect(readMessageId({ id: 42 })).toBe("42");
    expect(readMessageId({ data: { wamid: "wamid.X" } })).toBe("wamid.X");
    expect(readMessageId({})).toBeNull();
    expect(answerStopsMarketing({ data: { error_code: "131050" } })).toBe(true);
    expect(createSanoflowClient({ accessToken: "" })).toBeNull();
  });
});

describe("replied / booked webhook", () => {
  it("needs the stored token (32+ characters), in the header or the query, compared exactly", () => {
    const h = (v?: string) => new Headers(v ? { "x-pulse-token": v } : {});
    expect(verifySanoflowToken(h(TOKEN), "", TOKEN)).toBe(true);
    expect(verifySanoflowToken(h(), `?token=${TOKEN}`, TOKEN)).toBe(true);
    expect(verifySanoflowToken(h("wrong"), "", TOKEN)).toBe(false);
    expect(verifySanoflowToken(h(), "", TOKEN)).toBe(false);
    expect(verifySanoflowToken(h("short"), "", "short")).toBe(false);
    expect(verifySanoflowToken(h(TOKEN), "", undefined)).toBe(false);
  });

  it("reads Make's payload (Mobile, Status) case-insensitively and nothing else", () => {
    expect(
      parseSanoflowStatus(
        JSON.stringify({ Mobile: PHONE, Status: "Replied", "Trigger Data": "{}" }),
      ),
    ).toEqual({ phone: PHONE, status: "replied" });
    expect(
      parseSanoflowStatus(JSON.stringify({ phone: "447700900123", status: "BOOKED" })),
    ).toEqual({
      phone: PHONE,
      status: "booked",
    });
    expect(parseSanoflowStatus(JSON.stringify({ Mobile: PHONE, Status: "Opened" }))).toBeNull();
    expect(parseSanoflowStatus(JSON.stringify({ Mobile: "abc", Status: "Replied" }))).toBeNull();
    expect(parseSanoflowStatus("not json")).toBeNull();
    expect(parseSanoflowStatus("[]")).toBeNull();
  });

  it("the event key repeats for the same body on the same day only, and holds no number", () => {
    const raw = JSON.stringify({ Mobile: PHONE, Status: "Replied" });
    const day1 = Date.UTC(2026, 9, 20, 9);
    expect(sanoflowEventKey(raw, day1)).toBe(sanoflowEventKey(raw, day1 + 3_600_000));
    expect(sanoflowEventKey(raw, day1)).not.toBe(sanoflowEventKey(raw, day1 + 86_400_000));
    expect(sanoflowEventKey(raw, day1)).not.toContain("7700900123");
  });

  it("the address is per account", () => {
    expect(sanoflowWebhookBase("https://pulse.example/", "abc")).toBe(
      "https://pulse.example/api/webhooks/integrations/sanoflow/abc",
    );
  });
});

describe("adding a Sanoflow template", () => {
  const ok = {
    name: "Appointment_Reminder",
    language: "en",
    category: "utility",
    body: "Dear {{1}}, see you at {{2}}.",
    sanoflowTemplateId: 11885,
  };

  it("keeps a numbered body and lower-cases the name", () => {
    const r = sanoflowTemplateDraft(ok);
    expect(r.ok && r.draft).toMatchObject({
      name: "appointment_reminder",
      category: "UTILITY",
      sanoflowTemplateId: 11885,
      components: [{ type: "BODY", text: "Dear {{1}}, see you at {{2}}." }],
    });
  });

  it("refuses authentication templates, named or gapped variables, bad numbers", () => {
    expect(sanoflowTemplateDraft({ ...ok, category: "AUTHENTICATION" }).ok).toBe(false);
    expect(sanoflowTemplateDraft({ ...ok, body: "Hi {{name}}" }).ok).toBe(false);
    expect(sanoflowTemplateDraft({ ...ok, body: "Hi {{1}} {{3}}" }).ok).toBe(false);
    expect(sanoflowTemplateDraft({ ...ok, sanoflowTemplateId: 0 }).ok).toBe(false);
    expect(sanoflowTemplateDraft({ ...ok, sanoflowTemplateId: 1.5 }).ok).toBe(false);
    expect(sanoflowTemplateDraft({ ...ok, language: "English" }).ok).toBe(false);
    expect(sanoflowTemplateDraft({ ...ok, name: "has space" }).ok).toBe(false);
  });
});

describe("catalogue entry", () => {
  it("messages patients, so it is off by default behind typed words and an Admin", () => {
    const def = integrationDef("sanoflow");
    expect(def.contactsPatients).toBe(true);
    expect(def.confirmWord).toBe("SEND THROUGH SANOFLOW");
    expect(def.viewPermission).toBe("integrations.manage");
    expect(CALL_PROVIDERS.sanoflow).toEqual(["sanoflow"]);
  });

  it("stores the API key and webhook token encrypted, and checks the token's shape", () => {
    const fields = allFields("sanoflow", "sanoflow");
    expect(
      fields
        .filter((f) => f.secret)
        .map((f) => f.key)
        .sort(),
    ).toEqual(["access_token", "webhook_token"]);
    expect(validateFields(fields, { access_token: KEY, webhook_token: "short" }).ok).toBe(false);
    const good = validateFields(fields, { access_token: KEY, webhook_token: TOKEN });
    expect(good.ok).toBe(true);
    if (good.ok) {
      expect(good.config.phone_format).toBe("digits");
      expect(good.config.tag_contacts).toBe("on");
      expect(good.config.birthday_tag_id).toBe(3590);
      expect(good.config.chronic_tag_id).toBe(4654);
      expect(good.config.chronic_label_id).toBe(1800);
      expect(Object.values(good.config)).not.toContain(KEY);
    }
  });

  it("cannot be switched on without the API key", () => {
    expect(
      readinessProblems({ kind: "sanoflow", provider: "sanoflow", config: {}, secretsStored: {} }),
    ).toContain("Sanoflow API key is missing.");
  });
});

describe("guards in the source", () => {
  const read = (p: string) => readFileSync(p, "utf8");

  it("the outbound job hands Sanoflow numbers over before any Meta client is built", () => {
    const src = read("lib/jobs/handlers/outbound.ts");
    const handOver = src.indexOf("isSanoflowChannel(channel)");
    const meta = src.indexOf("await clientForChannel(admin, channel)");
    expect(handOver).toBeGreaterThan(0);
    expect(handOver).toBeLessThan(meta);
    expect(src.indexOf("claim_send_slot")).toBeLessThan(handOver);
  });

  it("clientForChannel refuses a Sanoflow number, and the nightly Meta jobs skip them", () => {
    expect(read("lib/whatsapp/channel.ts")).toContain('owner?.transport === "sanoflow"');
    expect(read("lib/jobs/handlers/templates-sync.ts")).toContain('.eq("transport", "meta")');
    expect(read("lib/jobs/handlers/wa-pricing.ts")).toContain('.eq("transport", "meta")');
  });

  it("no bare fetch to Sanoflow outside the shared client", () => {
    for (const f of [
      "client.ts",
      "deliver.ts",
      "server.ts",
      "webhook.ts",
      "config.ts",
      "params.ts",
      "setup.ts",
      "contacts.ts",
      "tagging.ts",
    ]) {
      expect(read(`lib/integrations/sanoflow/${f}`)).not.toMatch(/\bfetch\(/);
    }
  });
});
