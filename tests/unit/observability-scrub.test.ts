import { readFileSync } from "node:fs";
import path from "node:path";

import { describe, expect, it } from "vitest";

import {
  scrubBreadcrumb,
  scrubEvent,
  scrubHeaders,
  scrubUrl,
  type ScrubbableEvent,
} from "@/lib/observability/scrub";
import { sentryOptions, TRACES_SAMPLE_RATE } from "@/lib/observability/sentry-options";

// Synthetic values only (reserved demo range, example domains).
const PHONE = "+447700900123";
const EMAIL = "layla.demo@example.com";

describe("scrubUrl", () => {
  it("drops the query string and fragment and redacts the path", () => {
    expect(scrubUrl(`https://x.supabase.co/rest/v1/contacts?phone_e164=eq.${PHONE}`)).toBe(
      "https://x.supabase.co/rest/v1/contacts",
    );
    expect(scrubUrl("/contacts#notes")).toBe("/contacts");
    expect(scrubUrl(`/api/lookup/${PHONE}`)).not.toContain("900123");
    expect(scrubUrl(undefined)).toBeUndefined();
  });
});

describe("scrubHeaders", () => {
  it("keeps only the allow-list", () => {
    expect(
      scrubHeaders({
        cookie: "sb-access-token=abc",
        Authorization: "Bearer abcdefghijkl",
        "x-forwarded-for": "203.0.113.9",
        "user-agent": "Mozilla/5.0",
        "Content-Type": "application/json",
      }),
    ).toEqual({ "user-agent": "Mozilla/5.0", "Content-Type": "application/json" });
  });
});

describe("scrubEvent", () => {
  const event: ScrubbableEvent = {
    message: `Could not send to ${PHONE}`,
    logentry: { message: `mail to ${EMAIL}`, params: [PHONE] },
    exception: {
      values: [
        {
          type: "Error",
          value: `Graph rejected token EAA${"x".repeat(30)} for ${PHONE}`,
          stacktrace: {
            frames: [
              { filename: "a.js", vars: { body: "hello" }, abs_path: "https://app/x.js?v=1" },
            ],
          },
        },
      ],
    },
    request: {
      method: "POST",
      url: `https://pulse.example.com/inbox?q=${EMAIL}`,
      query_string: `q=${EMAIL}`,
      data: { body: "I have chest pain" },
      cookies: { session: "s" },
      env: { REMOTE_ADDR: "203.0.113.9" },
      headers: { cookie: "a=b", "user-agent": "UA" },
    },
    user: { id: "u-1", email: EMAIL, ip_address: "203.0.113.9", username: "Layla" },
    extra: { payload: { body: "hello" } },
    tags: { route: "/inbox?x=1", who: EMAIL },
    breadcrumbs: [
      { category: "ui.click", message: 'button[aria-label="Open Layla Demo-07"]' },
      { category: "console", message: `log ${PHONE}`, data: { arguments: [PHONE] } },
      {
        category: "fetch",
        data: { url: "https://x.supabase.co/rest/v1/m?body=eq.hi", status_code: 200 },
      },
      { category: "navigation", data: { from: "/contacts?q=Layla", to: "/inbox?c=1" } },
    ],
    contexts: {
      response: { status_code: 500, headers: { "set-cookie": "a=b" } },
      trace: { trace_id: "t", data: { "http.url": "https://h/p?x=1" } },
    },
  };

  const out = scrubEvent(event);
  const text = JSON.stringify(out);

  it("never lets a phone number, e-mail, token, body, cookie or IP through", () => {
    for (const leak of [
      "900123",
      EMAIL,
      "EAAxxxx",
      "chest pain",
      "sb-access-token",
      "203.0.113.9",
      "hello",
      "Layla",
      "set-cookie",
    ])
      expect(text).not.toContain(leak);
  });

  it("keeps what is useful for debugging", () => {
    expect(out.request).toEqual({
      method: "POST",
      url: "https://pulse.example.com/inbox",
      headers: { "user-agent": "UA" },
    });
    expect(out.user).toEqual({ id: "u-1" });
    expect(out.exception?.values?.[0]?.value).toContain("Graph rejected token [token]");
    expect(out.exception?.values?.[0]?.stacktrace?.frames?.[0]).toEqual({
      filename: "a.js",
      abs_path: "https://app/x.js",
    });
    expect(out.extra).toBeUndefined();
    expect(out.logentry).toEqual({ message: "mail to [email]" });
    expect(out.contexts?.response).toEqual({ status_code: 500 });
    expect(out.tags).toEqual({ route: "/inbox", who: "[email]" });
  });

  it("drops UI breadcrumbs, console arguments and URL queries", () => {
    expect(out.breadcrumbs?.map((b) => b.category)).toEqual(["console", "fetch", "navigation"]);
    expect(out.breadcrumbs?.[0]?.data).toBeUndefined();
    expect(out.breadcrumbs?.[1]?.data).toEqual({
      url: "https://x.supabase.co/rest/v1/m",
      status_code: 200,
    });
    expect(out.breadcrumbs?.[2]?.data).toEqual({ from: "/contacts", to: "/inbox" });
  });

  it("does not mutate the original event", () => {
    expect(event.user?.email).toBe(EMAIL);
    expect((event.request as { data?: unknown }).data).toBeDefined();
  });

  it("scrubs transaction names and span descriptions and data", () => {
    const tx = scrubEvent({
      transaction: "GET /contacts?q=Layla",
      spans: [
        {
          description: `GET https://x.supabase.co/rest/v1/contacts?phone_e164=eq.${PHONE}`,
          data: {
            "url.full": `https://x.supabase.co/rest/v1/contacts?phone_e164=eq.${PHONE}`,
            nested: { a: 1 },
          },
        },
      ],
    });
    expect(tx.transaction).toBe("GET /contacts");
    expect(tx.spans?.[0]).toEqual({
      description: "GET https://x.supabase.co/rest/v1/contacts",
      data: { "url.full": "https://x.supabase.co/rest/v1/contacts" },
    });
  });
});

describe("scrubBreadcrumb", () => {
  it("returns null for UI input breadcrumbs", () => {
    expect(scrubBreadcrumb({ category: "ui.input", message: "input#name" })).toBeNull();
  });
  it("redacts other messages", () => {
    expect(scrubBreadcrumb({ category: "sentry.event", message: `x ${EMAIL}` })?.message).toBe(
      "x [email]",
    );
  });
});

describe("Sentry options and wiring", () => {
  it("never sends default PII, samples traces low and scrubs every hook", () => {
    const o = sentryOptions("https://k@o1.ingest.sentry.io/1", "production");
    expect(o.sendDefaultPii).toBe(false);
    expect(o.tracesSampleRate).toBe(TRACES_SAMPLE_RATE);
    expect(TRACES_SAMPLE_RATE).toBeLessThanOrEqual(0.1);
    const ev = { message: `x ${EMAIL}`, user: { id: "u", email: EMAIL } };
    expect(o.beforeSend(ev)).toEqual({ message: "x [email]", user: { id: "u" } });
    expect(o.beforeSendTransaction({ transaction: "/a?b=c" })).toEqual({ transaction: "/a" });
    expect(o.beforeBreadcrumb({ category: "ui.click", message: "x" })).toBeNull();
    expect(o.includeLocalVariables).toBe(false);
  });

  const src = (f: string) => readFileSync(path.join(process.cwd(), f), "utf8");

  it("is a no-op without a DSN (the SDK is only imported behind the DSN check)", () => {
    const inst = src("instrumentation.ts");
    expect(inst).toMatch(
      /if \(!process\.env\.SENTRY_DSN\) return;\s+if \(process\.env\.NEXT_RUNTIME/,
    );
    expect(inst).not.toMatch(/^import .*@sentry\/nextjs/m);
    const client = src("instrumentation-client.ts");
    expect(client).not.toMatch(/from "@sentry\/nextjs"/);
    expect(src("lib/observability/client.ts")).toMatch(
      /if \(!dsn\) return Promise\.resolve\(null\)/,
    );
  });

  it("never enables session replay", () => {
    const browser = src("lib/observability/sentry-browser.ts");
    expect(browser).toContain("replaysSessionSampleRate: 0");
    expect(browser).toContain("replaysOnErrorSampleRate: 0");
    expect(browser).not.toMatch(/replayIntegration/);
  });
});
