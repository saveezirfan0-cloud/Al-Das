import { describe, expect, it } from "vitest";

import type { CallRecord } from "@/lib/integrations/client";
import { extraValidation } from "@/lib/integrations/extra-validate";
import { allFields, providerDef, validateFields } from "@/lib/integrations/catalog";
import { CALL_PROVIDERS } from "@/lib/integrations/health";
import { readinessProblems } from "@/lib/integrations/readiness";
import { createHttpSmsProvider, HTTP_SMS_PROVIDER } from "@/lib/integrations/sms/http";
import {
  gatewayUrlProblem,
  httpSmsConfigProblems,
  parseBodyTemplate,
  readHttpSmsConfig,
  readIdField,
  renderGatewayBody,
} from "@/lib/integrations/sms/http-config";

/**
 * Phase 20h: the generic HTTP SMS gateway. Every response here is written by hand (no real gateway exists for this test); the
 * fetch is a fake, and tests/setup.ts blocks the reserved `.example` hosts in case one ever leaks through.
 */

const URL_OK = "https://sms.gateway.example/v1/send";
const PHONE = "+971501234567";
const TEXT = "Demo Clinic: reminder of your appointment on 20/10/2026 at 10:30.";

describe("gateway address", () => {
  it("accepts a public https host and nothing else", () => {
    expect(gatewayUrlProblem(URL_OK)).toBeNull();
    expect(gatewayUrlProblem("https://api.example-gateway.com:443/sms")).toBeNull();
    for (const bad of [
      "http://sms.gateway.example/send",
      "https://user:pw@sms.gateway.example/send",
      "https://sms.gateway.example/send?api_key=abc",
      "https://sms.gateway.example/send#x",
      "https://sms.gateway.example:8443/send",
      "https://localhost/send",
      "https://gateway/send",
      "https://127.0.0.1/send",
      "https://10.0.0.5/send",
      "https://[::1]/send",
      "https://sms.internal/send",
      "https://printer.local/send",
      "https://metadata.google.internal/computeMetadata",
      "https://1.1.1.1.in-addr.arpa/x",
      "not a url",
    ])
      expect(gatewayUrlProblem(bad), bad).not.toBeNull();
  });
});

describe("body template", () => {
  it("parses name=value pairs with the three placeholders and fixed words", () => {
    const t = parseBodyTemplate("to={to}&sender={from}&message={text}&type=unicode");
    expect(t).toEqual({
      ok: true,
      parts: [
        { key: "to", kind: "placeholder", name: "to" },
        { key: "sender", kind: "placeholder", name: "from" },
        { key: "message", kind: "placeholder", name: "text" },
        { key: "type", kind: "literal", value: "unicode" },
      ],
    });
    expect(parseBodyTemplate("to={to}\nmessage={text}").ok).toBe(true);
  });

  it("refuses anything that could carry more than the number, the sender and the text", () => {
    for (const bad of [
      "",
      "message={text}",
      "to={to}",
      "to={to}&cc={to}&message={text}",
      "to={to}&message={text}&again={text}",
      "to={to}&message={text}&name={first_name}",
      "to={to}&message=Hello {text}",
      "to={to}&message={text}&to=x",
      "to={to}&message={text}&from={from}&f2={from}",
      "1to={to}&message={text}",
      "to={to}&message={text}&note=<script>",
      "to={to}&message={text}&k=" + "a".repeat(61),
      "to={to}&message={text}&" + Array.from({ length: 11 }, (_, i) => `k${i}=v`).join("&"),
      "justtext",
    ])
      expect(parseBodyTemplate(bad).ok, bad).toBe(false);
  });

  it("renders JSON or form encoding with string values only", () => {
    const t = parseBodyTemplate("to={to}&sender={from}&message={text}&type=unicode");
    if (!t.ok) throw new Error("template");
    const values = { to: PHONE, from: "DEMOCLINIC", text: 'Arabic موعد & "quotes"' };
    const json = renderGatewayBody(t.parts, "json", values);
    expect(json.contentType).toBe("application/json");
    expect(JSON.parse(json.body)).toEqual({
      to: PHONE,
      sender: "DEMOCLINIC",
      message: 'Arabic موعد & "quotes"',
      type: "unicode",
    });
    const form = renderGatewayBody(t.parts, "form", values);
    expect(form.contentType).toBe("application/x-www-form-urlencoded");
    expect(Object.fromEntries(new URLSearchParams(form.body))).toEqual({
      to: PHONE,
      sender: "DEMOCLINIC",
      message: 'Arabic موعد & "quotes"',
      type: "unicode",
    });
  });
});

describe("settings, readiness and the catalogue", () => {
  const good = {
    provider: "http",
    http_url: URL_OK,
    http_auth: "bearer",
    http_encoding: "json",
    http_body: "to={to}&message={text}",
    sender: "DEMOCLINIC",
    clinic_name: "Demo Clinic",
    callback_phone: "+97140000000",
  };

  it("is a second provider of the SMS fallback, with its token encrypted and its calls counted", () => {
    expect(providerDef("sms", "http")?.label).toMatch(/generic HTTP/);
    const secret = allFields("sms", "http").filter((f) => f.secret);
    expect(secret.map((f) => f.key)).toEqual(["gateway_secret"]);
    expect(secret[0].type).toBe("password");
    expect(CALL_PROVIDERS.sms).toContain(HTTP_SMS_PROVIDER);
  });

  it("the form keeps the token out of config and the extra check refuses unsafe values", () => {
    const v = validateFields(allFields("sms", "http"), { ...good, gateway_secret: "tok" });
    if (!v.ok) throw new Error(v.error);
    expect(v.secrets).toEqual({ gateway_secret: "tok" });
    expect(JSON.stringify(v.config)).not.toContain("tok");
    expect(extraValidation("sms", "http", v.config)).toBeNull();
    expect(extraValidation("sms", "twilio", { http_url: "https://127.0.0.1/" })).toBeNull();
    expect(extraValidation("sms", "http", { ...v.config, http_url: "https://10.1.2.3/x" })).toMatch(
      /IP address/,
    );
    expect(extraValidation("sms", "http", { ...v.config, http_body: "message={text}" })).toMatch(
      /\{to\}/,
    );
    expect(
      extraValidation("sms", "http", {
        ...v.config,
        http_test_url: "https://other.example/balance",
      }),
    ).toMatch(/same host/);
    expect(extraValidation("sms", "http", { ...v.config, http_auth: "basic" })).toMatch(
      /user name/,
    );
    expect(extraValidation("sms", "http", { ...v.config, http_id_field: "a..b" })).toMatch(
      /JSON field/,
    );
  });

  it("is ready only with a usable address, template and token", () => {
    const base = {
      kind: "sms" as const,
      provider: "http",
      config: good,
      secretsStored: { gateway_secret: true },
    };
    expect(readinessProblems(base)).toEqual([]);
    expect(readinessProblems({ ...base, secretsStored: {} })).toContain(
      "Token or password is missing.",
    );
    expect(
      readinessProblems({ ...base, config: { ...good, http_url: "https://localhost/x" } }).join(
        " ",
      ),
    ).toMatch(/public host/);
    expect(
      readinessProblems({ ...base, config: { ...good, http_body: "text={text}" } }).join(" "),
    ).toMatch(/\{to\}/);
    expect(readinessProblems({ ...base, config: { ...good, http_url: "" } })).toEqual([
      "Gateway address is missing.",
    ]);
  });

  it("reads defaults and the id path", () => {
    expect(readHttpSmsConfig({})).toMatchObject({ auth: "bearer", encoding: "json", url: "" });
    expect(httpSmsConfigProblems(readHttpSmsConfig(good))).toEqual([]);
    expect(readIdField({ data: { message_id: 42 } }, "data.message_id")).toBe("42");
    expect(readIdField({ id: "abc" }, "id")).toBe("abc");
    expect(readIdField({ id: "" }, "id")).toBeNull();
    expect(readIdField([{ id: "x" }], "id")).toBeNull();
    expect(readIdField(null, "id")).toBeNull();
  });
});

describe("generic HTTP adapter (fake fetch)", () => {
  type Reply = { status: number; body?: unknown; text?: string } | Error;
  function make(replies: Reply[], over: Partial<Parameters<typeof createHttpSmsProvider>[0]> = {}) {
    const requests: Array<{ url: string; init: RequestInit }> = [];
    const calls: CallRecord[] = [];
    let i = 0;
    const provider = createHttpSmsProvider({
      url: URL_OK,
      auth: "bearer",
      username: "",
      encoding: "json",
      body: "to={to}&sender={from}&message={text}",
      idField: "",
      testUrl: "",
      secret: "tok_secret_value",
      sender: "DEMOCLINIC",
      fetchFn: (async (url: string, init: RequestInit) => {
        requests.push({ url: String(url), init });
        const r = replies[Math.min(i++, replies.length - 1)];
        if (r instanceof Error) throw r;
        return new Response(r.text ?? JSON.stringify(r.body ?? {}), {
          status: r.status,
          headers: { "content-type": "application/json" },
        });
      }) as unknown as typeof fetch,
      sleep: async () => undefined,
      sink: { record: (c) => void calls.push(c) },
      ...over,
    });
    if (!provider) throw new Error("provider not built");
    return { provider, requests, calls };
  }
  const input = {
    to: PHONE,
    body: TEXT,
    clientRef: "11111111-2222-4333-8444-555555555555",
    statusCallbackUrl: "https://pulse.test/api/webhooks/integrations/sms/acc?m=x",
  };

  it("posts exactly the template to exactly the configured address, with a bearer token", async () => {
    const { provider, requests } = make([{ status: 200, body: { ok: true } }]);
    const r = await provider.send(input);
    expect(r).toEqual({
      ok: true,
      providerMessageId: `http:${input.clientRef}`,
      status: "sent",
      segments: null,
    });
    expect(requests).toHaveLength(1);
    expect(requests[0].url).toBe(URL_OK);
    expect(requests[0].init.method).toBe("POST");
    expect(requests[0].init.redirect).toBe("manual");
    const headers = requests[0].init.headers as Record<string, string>;
    expect(headers.Authorization).toBe("Bearer tok_secret_value");
    expect(headers["Content-Type"]).toBe("application/json");
    expect(JSON.parse(String(requests[0].init.body))).toEqual({
      to: PHONE,
      sender: "DEMOCLINIC",
      message: TEXT,
    });
    // the callback address is never sent: the generic gateway has no receipts
    expect(String(requests[0].init.body)).not.toContain("pulse.test");
  });

  it("uses Basic sign-in and form encoding when chosen", async () => {
    const { provider, requests } = make([{ status: 201, body: {} }], {
      auth: "basic",
      username: "clinic",
      encoding: "form",
    });
    expect((await provider.send(input)).ok).toBe(true);
    const headers = requests[0].init.headers as Record<string, string>;
    expect(headers.Authorization).toBe(
      "Basic " + Buffer.from("clinic:tok_secret_value").toString("base64"),
    );
    expect(headers["Content-Type"]).toBe("application/x-www-form-urlencoded");
    expect(new URLSearchParams(String(requests[0].init.body)).get("to")).toBe(PHONE);
  });

  it("reads the provider's message id when a field is configured, and treats a 2xx without it as not confirmed", async () => {
    const withId = make([{ status: 200, body: { data: { message_id: "gw-123" } } }], {
      idField: "data.message_id",
    });
    expect(await withId.provider.send(input)).toMatchObject({
      ok: true,
      providerMessageId: "gw-123",
    });
    const without = make([{ status: 200, body: { status: "error", reason: "balance" } }], {
      idField: "data.message_id",
    });
    expect(await without.provider.send(input)).toEqual({
      ok: false,
      code: "no_message_id",
      retryable: false,
      ambiguous: true,
      optOut: false,
    });
    expect(without.requests).toHaveLength(1);
  });

  it("maps 4xx without retrying, and auth separately", async () => {
    const bad = make([{ status: 400, body: { error: "bad number" } }]);
    expect(await bad.provider.send(input)).toEqual({
      ok: false,
      code: "http_400",
      retryable: false,
      ambiguous: false,
      optOut: false,
    });
    expect(bad.requests).toHaveLength(1);
    const auth = make([{ status: 401, body: {} }]);
    expect(await auth.provider.send(input)).toMatchObject({
      ok: false,
      code: "auth",
      ambiguous: false,
    });
  });

  it("never sends twice after a 5xx or a timeout (ambiguous), and retries only a 429", async () => {
    const five = make([
      { status: 503, body: {} },
      { status: 200, body: {} },
    ]);
    expect(await five.provider.send(input)).toMatchObject({
      ok: false,
      ambiguous: true,
      retryable: false,
    });
    expect(five.requests).toHaveLength(1);

    const timeout = Object.assign(new Error("aborted"), { name: "AbortError" });
    const slow = make([timeout, { status: 200, body: {} }]);
    expect(await slow.provider.send(input)).toMatchObject({
      ok: false,
      code: "timeout",
      ambiguous: true,
    });
    expect(slow.requests).toHaveLength(1);

    const limited = make([
      { status: 429, body: {} },
      { status: 200, body: {} },
    ]);
    expect(await limited.provider.send(input)).toMatchObject({ ok: true });
    expect(limited.requests).toHaveLength(2);

    const stillLimited = make([{ status: 429, body: {} }]);
    expect(await stillLimited.provider.send(input)).toMatchObject({
      ok: false,
      code: "rate_limited",
      retryable: true,
      ambiguous: false,
    });
  });

  it("does not follow a redirect to another host", async () => {
    const { provider, requests } = make([{ status: 302, body: {} }]);
    expect(await provider.send(input)).toMatchObject({ ok: false, code: "http_302" });
    expect(requests).toHaveLength(1);
  });

  it("logs provider, operation and outcome only: never the address, number, text or token", async () => {
    const { provider, calls } = make([{ status: 503, body: {} }]);
    await provider.send(input);
    expect(calls).toHaveLength(1);
    expect(Object.keys(calls[0]).sort()).toEqual(
      ["attempt", "durationMs", "httpStatus", "operation", "outcome", "provider"].sort(),
    );
    expect(calls[0]).toMatchObject({
      provider: "sms_http",
      operation: "sms.send",
      outcome: "server_error",
    });
    const logged = JSON.stringify(calls);
    for (const leak of ["gateway.example", "971501234567", "reminder", "tok_secret_value"])
      expect(logged).not.toContain(leak);
  });

  it("is not built from unusable settings", () => {
    const base = {
      url: URL_OK,
      auth: "bearer" as const,
      username: "",
      encoding: "json" as const,
      body: "to={to}&message={text}",
      idField: "",
      testUrl: "",
      secret: "t",
      sender: "S",
    };
    expect(createHttpSmsProvider(base)).not.toBeNull();
    expect(createHttpSmsProvider({ ...base, url: "https://127.0.0.1/x" })).toBeNull();
    expect(createHttpSmsProvider({ ...base, secret: "" })).toBeNull();
    expect(createHttpSmsProvider({ ...base, body: "message={text}" })).toBeNull();
    expect(createHttpSmsProvider({ ...base, auth: "basic" })).toBeNull();
  });

  it("Test connection is a GET to the check address only; without one it sends nothing", async () => {
    const none = make([{ status: 200, body: {} }]);
    expect(await none.provider.verify()).toEqual({ ok: false, code: "unsupported" });
    expect(none.requests).toHaveLength(0);

    const check = make([{ status: 200, body: { balance: 10 } }], {
      testUrl: "https://sms.gateway.example/v1/balance",
    });
    expect(await check.provider.verify()).toEqual({ ok: true });
    expect(check.requests[0].init.method).toBe("GET");
    expect(check.requests[0].url).toBe("https://sms.gateway.example/v1/balance");
    expect(check.requests[0].init.body).toBeUndefined();

    const denied = make([{ status: 403, body: {} }], {
      testUrl: "https://sms.gateway.example/v1/balance",
    });
    expect(await denied.provider.verify()).toEqual({ ok: false, code: "auth" });

    const otherHost = make([{ status: 200, body: {} }], {
      testUrl: "https://other.example/balance",
    });
    expect(await otherHost.provider.verify()).toEqual({ ok: false, code: "unsupported" });
    expect(otherHost.requests).toHaveLength(0);
  });
});
