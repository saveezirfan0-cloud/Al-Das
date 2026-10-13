import { describe, expect, it } from "vitest";

import type { CallRecord } from "@/lib/integrations/client";
import { formatMoney, majorToMinor, minorToMajor } from "@/lib/integrations/payments/money";
import { paymentValues, PROBE_CONTEXT } from "@/lib/integrations/payments/message";
import {
  createPaytabsProvider,
  parsePaytabsEvents,
  paytabsSignature,
  verifyPaytabsWebhook,
} from "@/lib/integrations/payments/paytabs";
import {
  decidePaymentEvent,
  EXPIRY_GRACE_MS,
  type RequestSnapshot,
} from "@/lib/integrations/payments/state";
import {
  createStripeProvider,
  parseStripeEvents,
  stripeSignatureHeader,
  verifyStripeWebhook,
} from "@/lib/integrations/payments/stripe";
import type { PaymentEvent } from "@/lib/integrations/payments/types";
import { createFakePaymentProvider } from "@/lib/integrations/payments/fake";
import {
  readPaymentsConfig,
  parseVariableMap,
  paymentReturnUrl,
  paymentWebhookBase,
} from "@/lib/integrations/payments/config";
import type { MetaTemplateComponent } from "@/lib/whatsapp/types";

describe("money", () => {
  it("parses plain decimals into minor units without floating point", () => {
    expect(majorToMinor("150.00", "AED")).toBe(15000);
    expect(majorToMinor("150", "AED")).toBe(15000);
    expect(majorToMinor("0.07", "AED")).toBe(7);
    expect(majorToMinor("19.99", "AED")).toBe(1999);
    expect(majorToMinor("1.500", "KWD")).toBe(1500);
    expect(majorToMinor(150.5, "AED")).toBe(15050);
    expect(majorToMinor("150.50", "AED")).toBe(15050);
    expect(majorToMinor("150.500", "AED")).toBe(15050); // trailing zeros beyond the exponent are fine
  });

  it("rejects what is not a plain positive amount", () => {
    for (const bad of [
      "",
      "abc",
      "-5",
      "0",
      "0.00",
      "1e3",
      "1,000",
      "12.345",
      "1.2.3",
      " ",
      "99999999999",
      "1000000.01",
    ])
      expect(majorToMinor(bad, "AED"), bad).toBeNull();
    expect(majorToMinor("5", "XXX")).toBeNull();
    expect(majorToMinor(Number.NaN, "AED")).toBeNull();
  });

  it("accepts exactly the ceiling", () => {
    expect(majorToMinor("1000000", "AED")).toBe(100_000_000);
  });

  it("formats back, with the currency's exponent", () => {
    expect(minorToMajor(15000, "AED")).toBe("150.00");
    expect(minorToMajor(7, "AED")).toBe("0.07");
    expect(minorToMajor(1500, "KWD")).toBe("1.500");
    expect(formatMoney(1999, "AED")).toBe("AED 19.99");
  });
});

const REQ: RequestSnapshot = {
  status: "sent",
  amount_minor: 15000,
  currency: "AED",
  expires_at: "2026-10-19T12:00:00Z",
};
const NOW = Date.parse("2026-10-18T12:00:00Z");
const paid = (over: Partial<PaymentEvent> = {}): PaymentEvent => ({
  key: "k",
  type: "paid",
  providerRef: "ref",
  requestId: null,
  amountMinor: 15000,
  currency: "AED",
  code: null,
  ...over,
});

describe("payment state machine", () => {
  it("applies a matching payment", () => {
    const d = decidePaymentEvent(REQ, paid(), NOW);
    expect(d).toMatchObject({ action: "apply", reason: "paid", notify: "paid" });
    if (d.action === "apply") {
      expect(d.patch).toMatchObject({
        status: "paid",
        amount_paid_minor: 15000,
        failure_code: null,
      });
      expect(d.patch.needs_review).toBeUndefined();
      expect(d.from).toEqual(["pending", "created", "sent", "expired", "cancelled", "failed"]);
    }
  });

  it("NEVER applies a payment whose amount or currency differs: flags it for review instead", () => {
    for (const ev of [
      paid({ amountMinor: 14999 }),
      paid({ amountMinor: 15001 }),
      paid({ currency: "USD" }),
    ]) {
      const d = decidePaymentEvent(REQ, ev, NOW);
      expect(d).toMatchObject({ action: "apply", reason: "amount_mismatch", notify: "review" });
      if (d.action === "apply") {
        expect(d.patch.status).toBeUndefined();
        expect(d.patch).toMatchObject({ needs_review: true, review_reason: "amount_mismatch" });
      }
    }
  });

  it("flags a payment with no amount", () => {
    const d = decidePaymentEvent(REQ, paid({ amountMinor: null }), NOW);
    expect(d).toMatchObject({ action: "apply", reason: "amount_missing" });
    if (d.action === "apply") expect(d.patch.status).toBeUndefined();
  });

  it("is case-insensitive about the currency code", () => {
    expect(decidePaymentEvent(REQ, paid({ currency: "aed" }), NOW)).toMatchObject({
      reason: "paid",
    });
  });

  it("paid is final: repeats are ignored, a second mismatching payment is flagged", () => {
    const done = { ...REQ, status: "paid" as const };
    expect(decidePaymentEvent(done, paid(), NOW)).toEqual({
      action: "ignore",
      reason: "already_paid",
    });
    expect(decidePaymentEvent(done, { ...paid(), type: "failed" }, NOW)).toEqual({
      action: "ignore",
      reason: "already_paid",
    });
    expect(decidePaymentEvent(done, { ...paid(), type: "expired" }, NOW)).toEqual({
      action: "ignore",
      reason: "already_paid",
    });
    expect(decidePaymentEvent(done, paid({ amountMinor: 1 }), NOW)).toMatchObject({
      reason: "amount_mismatch",
    });
  });

  it("records a late payment as paid but flags it", () => {
    for (const status of ["expired", "cancelled", "failed"] as const) {
      const d = decidePaymentEvent({ ...REQ, status }, paid(), NOW);
      expect(d).toMatchObject({
        action: "apply",
        reason: `paid_after_${status}`,
        notify: "review",
      });
      if (d.action === "apply")
        expect(d.patch).toMatchObject({
          status: "paid",
          needs_review: true,
          review_reason: `paid_after_${status}`,
        });
    }
    const afterExpiry = decidePaymentEvent(
      REQ,
      paid(),
      Date.parse(REQ.expires_at!) + EXPIRY_GRACE_MS + 1,
    );
    expect(afterExpiry).toMatchObject({ reason: "paid_after_expiry", notify: "review" });
    const insideGrace = decidePaymentEvent(
      REQ,
      paid(),
      Date.parse(REQ.expires_at!) + EXPIRY_GRACE_MS - 1000,
    );
    expect(insideGrace).toMatchObject({ reason: "paid", notify: "paid" });
  });

  it("a declined attempt keeps the request open; a terminal failure closes it", () => {
    const declined = decidePaymentEvent(
      REQ,
      { ...paid(), type: "declined", code: "D", amountMinor: null },
      NOW,
    );
    expect(declined).toMatchObject({ action: "apply", reason: "declined", notify: null });
    if (declined.action === "apply") expect(declined.patch.status).toBeUndefined();
    const failed = decidePaymentEvent(
      REQ,
      { ...paid(), type: "failed", code: "async_payment_failed" },
      NOW,
    );
    expect(failed).toMatchObject({ action: "apply", reason: "failed", notify: "failed" });
    if (failed.action === "apply") expect(failed.patch.status).toBe("failed");
  });

  it("expiry and failure only touch open requests", () => {
    for (const status of ["expired", "cancelled", "failed"] as const) {
      expect(decidePaymentEvent({ ...REQ, status }, { ...paid(), type: "expired" }, NOW)).toEqual({
        action: "ignore",
        reason: "not_open",
      });
      expect(decidePaymentEvent({ ...REQ, status }, { ...paid(), type: "failed" }, NOW)).toEqual({
        action: "ignore",
        reason: "not_open",
      });
      expect(decidePaymentEvent({ ...REQ, status }, { ...paid(), type: "declined" }, NOW)).toEqual({
        action: "ignore",
        reason: "not_open",
      });
    }
    const exp = decidePaymentEvent(REQ, { ...paid(), type: "expired" }, NOW);
    expect(exp).toMatchObject({ action: "apply", reason: "expired" });
  });

  it("ignores informational events", () => {
    expect(decidePaymentEvent(REQ, { ...paid(), type: "ignored" }, NOW)).toEqual({
      action: "ignore",
      reason: "ignored_event",
    });
  });
});

describe("Stripe Checkout adapter (recorded responses)", () => {
  // Shapes recorded from Stripe's documentation, not from a live or test account.
  const SESSION = {
    id: "cs_test_a1B2c3",
    object: "checkout.session",
    url: "https://checkout.stripe.com/c/pay/cs_test_a1B2c3#fid",
    expires_at: 1_800_086_400,
    status: "open",
    amount_total: 15000,
    currency: "aed",
  };
  const CARD_ERROR = {
    error: {
      type: "invalid_request_error",
      code: "parameter_invalid_integer",
      message: "Invalid integer",
    },
  };

  function make(
    responses: Array<{ status: number; body: unknown; headers?: Record<string, string> } | Error>,
  ) {
    const requests: Array<{ url: string; init: RequestInit }> = [];
    const calls: CallRecord[] = [];
    let i = 0;
    const provider = createStripeProvider({
      secretKey: "sk_test_SECRETKEY",
      fetchFn: (async (url: string, init: RequestInit) => {
        requests.push({ url: String(url), init });
        const r = responses[Math.min(i++, responses.length - 1)];
        if (r instanceof Error) throw r;
        return new Response(JSON.stringify(r.body), { status: r.status, headers: r.headers });
      }) as unknown as typeof fetch,
      sleep: async () => undefined,
      sink: { record: (c) => void calls.push(c) },
    });
    return { provider, requests, calls };
  }
  const input = {
    requestId: "11111111-2222-3333-4444-555555555555",
    amountMinor: 15000,
    currency: "AED",
    description: "Invoice INV-1042",
    expiresAt: new Date(1_800_086_400 * 1000),
    returnUrl: "https://pulse.test/pay/done",
    webhookUrl: "https://pulse.test/api/webhooks/integrations/payments/acc",
  };

  it("creates a Checkout Session with the documented fields, an idempotency key and no patient data", async () => {
    const { provider, requests } = make([{ status: 200, body: SESSION }]);
    const r = await provider.createPayment(input);
    expect(r).toEqual({
      ok: true,
      ref: SESSION.id,
      url: SESSION.url,
      expiresAt: new Date(SESSION.expires_at * 1000),
    });
    const req = requests[0];
    expect(req.url).toBe("https://api.stripe.com/v1/checkout/sessions");
    const headers = req.init.headers as Record<string, string>;
    expect(headers.Authorization).toBe("Bearer sk_test_SECRETKEY");
    expect(headers["Idempotency-Key"]).toBe(`pulse-pay-${input.requestId}`);
    const form = Object.fromEntries(new URLSearchParams(String(req.init.body)));
    expect(form).toMatchObject({
      mode: "payment",
      client_reference_id: input.requestId,
      expires_at: "1800086400",
      "line_items[0][quantity]": "1",
      "line_items[0][price_data][currency]": "aed",
      "line_items[0][price_data][unit_amount]": "15000",
      "line_items[0][price_data][product_data][name]": "Invoice INV-1042",
      "metadata[request_id]": input.requestId,
      success_url: input.returnUrl,
    });
    expect(
      Object.keys(form).some(
        (k) => /name$/i.test(k) && k !== "line_items[0][price_data][product_data][name]",
      ),
    ).toBe(false);
  });

  it("maps a gateway rejection to a stable code, not message text", async () => {
    const r = await make([{ status: 400, body: CARD_ERROR }]).provider.createPayment(input);
    expect(r).toEqual({
      ok: false,
      code: "parameter_invalid_integer",
      retryable: false,
      ambiguous: false,
    });
    const auth = await make([
      { status: 401, body: { error: { type: "invalid_request_error" } } },
    ]).provider.createPayment(input);
    expect(auth).toMatchObject({ ok: false, retryable: false });
  });

  it("retries a 5xx safely because the request carries an idempotency key", async () => {
    const m = make([
      { status: 503, body: {} },
      { status: 200, body: SESSION },
    ]);
    expect(await m.provider.createPayment(input)).toMatchObject({ ok: true });
    expect(m.requests).toHaveLength(2);
    expect(m.calls.map((c) => c.outcome)).toEqual(["server_error", "ok"]);
  });

  it("expires a session and verifies credentials with read-only calls", async () => {
    const e = make([{ status: 200, body: { id: "cs_x", status: "expired" } }]);
    expect(await e.provider.expire!("cs_test_a1B2c3")).toBe(true);
    expect(e.requests[0].url).toBe(
      "https://api.stripe.com/v1/checkout/sessions/cs_test_a1B2c3/expire",
    );
    expect(await make([{ status: 404, body: {} }]).provider.expire!("cs_nope")).toBe(false);
    const v = make([{ status: 200, body: { object: "balance" } }]);
    expect(await v.provider.verify!()).toEqual({ ok: true });
    expect(v.requests[0].init.method).toBe("GET");
    expect(await make([{ status: 401, body: {} }]).provider.verify!()).toMatchObject({
      ok: false,
      code: "auth",
    });
  });

  it("logs no key, amount, link or reference", async () => {
    const m = make([{ status: 200, body: SESSION }]);
    await m.provider.createPayment(input);
    const dump = JSON.stringify(m.calls);
    for (const s of [
      "SECRETKEY",
      "15000",
      "checkout.stripe.com",
      "cs_test",
      "INV-1042",
      input.requestId,
    ])
      expect(dump).not.toContain(s);
  });

  describe("webhook events", () => {
    const evt = (type: string, obj: Record<string, unknown>) =>
      JSON.stringify({ id: "evt_123", type, data: { object: obj } });
    const session = {
      id: "cs_1",
      client_reference_id: "req-1",
      amount_total: 15000,
      currency: "aed",
      payment_status: "paid",
    };

    it("maps the four checkout events", () => {
      expect(parseStripeEvents(evt("checkout.session.completed", session))[0]).toEqual({
        key: "evt_123",
        type: "paid",
        providerRef: "cs_1",
        requestId: "req-1",
        amountMinor: 15000,
        currency: "AED",
        code: null,
      });
      expect(
        parseStripeEvents(
          evt("checkout.session.completed", { ...session, payment_status: "unpaid" }),
        )[0].type,
      ).toBe("ignored");
      expect(
        parseStripeEvents(evt("checkout.session.async_payment_succeeded", session))[0].type,
      ).toBe("paid");
      expect(
        parseStripeEvents(evt("checkout.session.async_payment_failed", session))[0],
      ).toMatchObject({ type: "failed", code: "async_payment_failed" });
      expect(parseStripeEvents(evt("checkout.session.expired", session))[0].type).toBe("expired");
    });

    it("ignores everything else, refunds included", () => {
      expect(parseStripeEvents(evt("charge.refunded", { id: "ch_1", amount: 5 }))[0].type).toBe(
        "ignored",
      );
      expect(parseStripeEvents(evt("customer.created", {}))[0].type).toBe("ignored");
    });

    it("falls back to metadata.request_id and rejects non-events", () => {
      const e = parseStripeEvents(
        evt("checkout.session.completed", {
          ...session,
          client_reference_id: undefined,
          metadata: { request_id: "req-2" },
        }),
      );
      expect(e[0].requestId).toBe("req-2");
      expect(() => parseStripeEvents("{}")).toThrow();
      expect(() => parseStripeEvents("not json")).toThrow();
    });

    it("a signed delivery verifies end to end", () => {
      const raw = evt("checkout.session.completed", session);
      const now = 1_800_000_000_000;
      expect(
        verifyStripeWebhook("whsec_x", raw, stripeSignatureHeader("whsec_x", raw, now / 1000), now),
      ).toBe(true);
    });
  });
});

describe("PayTabs-style adapter (recorded responses)", () => {
  // Shapes recorded from PayTabs' documentation, not from a live or sandbox account.
  const CREATED = {
    tran_ref: "TST2628400110566",
    cart_id: "req-1",
    cart_description: "Invoice INV-1042",
    cart_currency: "AED",
    cart_amount: "150.00",
    redirect_url: "https://secure.paytabs.com/payment/wr/ABC123",
    serviceId: 2,
  };
  const input = {
    requestId: "11111111-2222-3333-4444-555555555555",
    amountMinor: 15050,
    currency: "AED",
    description: "Invoice INV-1042",
    expiresAt: new Date("2026-10-19T12:00:00Z"),
    returnUrl: "https://pulse.test/pay/done",
    webhookUrl: "https://pulse.test/api/webhooks/integrations/payments/acc",
  };

  function make(
    responses: Array<{ status: number; body: unknown }>,
    regionHost = "secure.paytabs.com",
  ) {
    const requests: Array<{ url: string; init: RequestInit }> = [];
    let i = 0;
    const provider = createPaytabsProvider({
      serverKey: "SERVERKEY_SECRET",
      profileId: "12345",
      regionHost,
      fetchFn: (async (url: string, init: RequestInit) => {
        requests.push({ url: String(url), init });
        const r = responses[Math.min(i++, responses.length - 1)];
        return new Response(JSON.stringify(r.body), { status: r.status });
      }) as unknown as typeof fetch,
      sleep: async () => undefined,
    });
    return { provider, requests };
  }

  it("creates a hosted payment page request with the documented JSON and no customer details", async () => {
    const { provider, requests } = make([{ status: 200, body: CREATED }]);
    const r = await provider.createPayment(input);
    expect(r).toEqual({
      ok: true,
      ref: CREATED.tran_ref,
      url: CREATED.redirect_url,
      expiresAt: null,
    });
    expect(requests[0].url).toBe("https://secure.paytabs.com/payment/request");
    expect((requests[0].init.headers as Record<string, string>).authorization).toBe(
      "SERVERKEY_SECRET",
    );
    const body = JSON.parse(String(requests[0].init.body));
    expect(body).toEqual({
      profile_id: 12345,
      tran_type: "sale",
      tran_class: "ecom",
      cart_id: input.requestId,
      cart_currency: "AED",
      cart_amount: 150.5,
      cart_description: "Invoice INV-1042",
      paypage_lang: "en",
      callback: input.webhookUrl,
      return: input.returnUrl,
      hide_shipping: true,
    });
    expect(body).not.toHaveProperty("customer_details");
  });

  it("turns a rejection into a code and never retries the POST after a 5xx (ambiguous)", async () => {
    expect(
      await make([{ status: 400, body: { code: 1, message: "bad" } }]).provider.createPayment(
        input,
      ),
    ).toEqual({ ok: false, code: "1", retryable: false, ambiguous: false });
    const m = make([{ status: 500, body: {} }]);
    expect(await m.provider.createPayment(input)).toMatchObject({
      ok: false,
      ambiguous: true,
      retryable: false,
    });
    expect(m.requests).toHaveLength(1);
  });

  it("refuses a region host that was not chosen", async () => {
    const { provider, requests } = make(
      [{ status: 200, body: CREATED }],
      "secure-oman.paytabs.com",
    );
    await provider.createPayment(input);
    expect(new URL(requests[0].url).hostname).toBe("secure-oman.paytabs.com");
    const evil = createPaytabsProvider({
      serverKey: "k",
      profileId: "1",
      regionHost: "evil.example.test",
      fetchFn: (async () => {
        throw new Error("must not be called");
      }) as unknown as typeof fetch,
    });
    expect(await evil.createPayment(input)).toMatchObject({ ok: false, code: "blocked" });
  });

  describe("callback", () => {
    const cb = (status: string, over: Record<string, unknown> = {}) =>
      JSON.stringify({
        tran_ref: "TST1",
        cart_id: "req-1",
        cart_currency: "AED",
        cart_amount: "150.50",
        tran_currency: "AED",
        tran_total: "150.50",
        payment_result: { response_status: status, response_code: "G12345" },
        ...over,
      });

    it("maps response statuses", () => {
      expect(parsePaytabsEvents(cb("A"))[0]).toEqual({
        key: "TST1:A",
        type: "paid",
        providerRef: "TST1",
        requestId: "req-1",
        amountMinor: 15050,
        currency: "AED",
        code: "G12345",
      });
      for (const s of ["D", "E", "V"]) expect(parsePaytabsEvents(cb(s))[0].type).toBe("declined");
      expect(parsePaytabsEvents(cb("X"))[0].type).toBe("expired");
      for (const s of ["H", "P", "Z"]) expect(parsePaytabsEvents(cb(s))[0].type).toBe("ignored");
    });

    it("keys events by transaction and status so a retry is idempotent but a new status is not", () => {
      expect(parsePaytabsEvents(cb("A"))[0].key).toBe(parsePaytabsEvents(cb("A"))[0].key);
      expect(parsePaytabsEvents(cb("D"))[0].key).not.toBe(parsePaytabsEvents(cb("A"))[0].key);
    });

    it("reads the amount actually charged, in its currency, as an integer", () => {
      const e = parsePaytabsEvents(cb("A", { tran_total: "150.51", tran_currency: "AED" }))[0];
      expect(e.amountMinor).toBe(15051);
      expect(parsePaytabsEvents(cb("A", { tran_total: "abc" }))[0].amountMinor).toBeNull();
      expect(
        parsePaytabsEvents(cb("A", { tran_total: undefined, tran_currency: undefined }))[0],
      ).toMatchObject({ amountMinor: 15050, currency: "AED" });
    });

    it("rejects a body that is not a callback", () => {
      expect(() => parsePaytabsEvents("{}")).toThrow();
      expect(() => parsePaytabsEvents("nope")).toThrow();
    });

    it("verifies the signature over the raw body", () => {
      const raw = cb("A");
      expect(verifyPaytabsWebhook("K", raw, paytabsSignature("K", raw))).toBe(true);
      expect(
        verifyPaytabsWebhook("K", raw.replace("150.50", "1.00"), paytabsSignature("K", raw)),
      ).toBe(false);
    });
  });
});

describe("payment message", () => {
  const comps: MetaTemplateComponent[] = [
    {
      type: "BODY",
      text: "Hello {{1}}, please pay {{2}} for invoice {{3}} here: {{4}}",
    } as MetaTemplateComponent,
  ];
  const ctx = {
    ...PROBE_CONTEXT,
    first_name: "Layla",
    amount_due: "AED 150.00",
    invoice_ref: "INV-1",
    payment_link: "https://pay.test/x",
  };

  it("fills mapped variables and reports the link", () => {
    const map = {
      "body.1": "first_name",
      "body.2": "amount_due",
      "body.3": "invoice_ref",
      "body.4": "payment_link",
    };
    const r = paymentValues(comps, map, ctx);
    expect(r.values).toEqual({
      "body.1": "Layla",
      "body.2": "AED 150.00",
      "body.3": "INV-1",
      "body.4": "https://pay.test/x",
    });
    expect(r.missing).toEqual([]);
    expect(r.hasLink).toBe(true);
  });

  it("lists unmapped variables and notices a missing link", () => {
    const r = paymentValues(comps, { "body.1": "first_name", "body.2": "bogus" }, ctx);
    expect(r.missing).toEqual(["body.2", "body.3", "body.4"]);
    expect(r.hasLink).toBe(false);
  });

  it("cannot use media headers or buttons", () => {
    const withMedia = [
      { type: "HEADER", format: "IMAGE", example: { header_handle: ["h"] } },
      ...comps,
    ] as MetaTemplateComponent[];
    expect(paymentValues(withMedia, {}, ctx).unsupported).toEqual(["header.media"]);
  });
});

describe("payments config", () => {
  it("reads defaults, the variable map and URLs", () => {
    const c = readPaymentsConfig({
      provider: "paytabs",
      profile_id: "9",
      region_host: "secure-oman.paytabs.com",
      template_id: "t1",
      variable_map: '{"body.1":"first_name","body.2":"nope"}',
    });
    expect(c).toMatchObject({
      provider: "paytabs",
      currency: "AED",
      expiryHours: 24,
      profileId: "9",
      regionHost: "secure-oman.paytabs.com",
      templateId: "t1",
      variableMap: { "body.1": "first_name" },
    });
    expect(readPaymentsConfig({}).provider).toBe("stripe");
    expect(parseVariableMap("not json")).toEqual({});
    expect(parseVariableMap('["x"]')).toEqual({});
    expect(paymentReturnUrl("https://pulse.test/", null)).toBe("https://pulse.test/pay/done");
    expect(paymentReturnUrl("https://pulse.test", "https://clinic.test/thanks")).toBe(
      "https://clinic.test/thanks",
    );
    expect(paymentWebhookBase("https://pulse.test/", "acc")).toBe(
      "https://pulse.test/api/webhooks/integrations/payments/acc",
    );
  });
});

describe("fake payment provider", () => {
  it("records requests and can be told to fail", async () => {
    const ok = createFakePaymentProvider();
    const r = await ok.createPayment({
      requestId: "r",
      amountMinor: 1,
      currency: "AED",
      description: "d",
      expiresAt: new Date(),
      returnUrl: "u",
      webhookUrl: "w",
    });
    expect(r).toMatchObject({ ok: true });
    await ok.expire!("x");
    expect(ok.expired).toEqual(["x"]);
    const bad = createFakePaymentProvider({
      fail: { ok: false, code: "boom", retryable: false, ambiguous: false },
    });
    expect(
      await bad.createPayment({
        requestId: "r",
        amountMinor: 1,
        currency: "AED",
        description: "d",
        expiresAt: new Date(),
        returnUrl: "u",
        webhookUrl: "w",
      }),
    ).toMatchObject({ ok: false, code: "boom" });
  });
});
