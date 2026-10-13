import { describe, expect, it } from "vitest";

import { createFakeSmsProvider } from "@/lib/integrations/sms/fake";
import { isSmsCapablePhone, smsDecision, type SmsRecipient } from "@/lib/integrations/sms/policy";
import { smsLength } from "@/lib/integrations/sms/segments";
import {
  fromProviderStatus,
  nextSmsStatus,
  previousStatusesFor,
  SMS_STATUSES,
} from "@/lib/integrations/sms/status";
import { chooseSmsLanguage, renderReminderSms } from "@/lib/integrations/sms/templates";
import { createTwilioProvider } from "@/lib/integrations/sms/twilio";
import { smsCallbackBase, smsCallbackUrl, readSmsConfig } from "@/lib/integrations/sms/config";
import type { CallRecord } from "@/lib/integrations/client";

describe("message length", () => {
  it("counts GSM-7 septets and parts", () => {
    expect(smsLength("a".repeat(160))).toEqual({ encoding: "gsm7", units: 160, segments: 1 });
    expect(smsLength("a".repeat(161))).toEqual({ encoding: "gsm7", units: 161, segments: 2 });
    expect(smsLength("a".repeat(306))).toMatchObject({ segments: 2 });
    expect(smsLength("a".repeat(307))).toMatchObject({ segments: 3 });
    expect(smsLength("")).toMatchObject({ segments: 0 });
  });

  it("counts extension characters twice", () => {
    expect(smsLength("{}").units).toBe(4);
    expect(smsLength("€").units).toBe(2);
  });

  it("switches the whole message to UCS-2 for Arabic or an emoji", () => {
    expect(smsLength("موعدكم")).toMatchObject({ encoding: "ucs2", units: 6, segments: 1 });
    expect(smsLength("ع".repeat(70)).segments).toBe(1);
    expect(smsLength("ع".repeat(71)).segments).toBe(2);
    expect(smsLength("ع".repeat(135)).segments).toBe(3);
    expect(smsLength("hello 🙂").encoding).toBe("ucs2");
  });
});

describe("reminder text", () => {
  const base = {
    clinicName: "Al Das Clinic",
    callbackPhone: "+971 4 000 0000",
    startsAt: new Date("2026-10-20T06:30:00Z"),
    timezone: "Asia/Dubai",
  };

  it("is generic: clinic, date, time (clinic time zone) and a number, no names", () => {
    const en = renderReminderSms({ ...base, language: "en" });
    expect(en).toBe(
      "Al Das Clinic: reminder of your appointment on 20/10/2026 at 10:30. To change it please call +971 4 000 0000",
    );
    expect(smsLength(en).encoding).toBe("gsm7");
    expect(smsLength(en).segments).toBe(1);
  });

  it("has an Arabic version", () => {
    const ar = renderReminderSms({ ...base, language: "ar" });
    expect(ar).toContain("20/10/2026");
    expect(ar).toContain("10:30");
    expect(ar).toContain("+971 4 000 0000");
    expect(smsLength(ar).encoding).toBe("ucs2");
  });

  it("names the child by first name only when it goes to a guardian", () => {
    const en = renderReminderSms({
      ...base,
      language: "en",
      patientFirstName: "Omar Khalid Al Something",
    });
    expect(en).toContain("Omar's appointment");
    expect(en).not.toContain("Khalid");
    expect(renderReminderSms({ ...base, language: "ar", patientFirstName: "عمر" })).toContain(
      "عمر",
    );
  });

  it("cannot be turned into a multi-line or control-character message by a stored name", () => {
    const en = renderReminderSms({
      ...base,
      clinicName: "Clinic\r\nFree text\u0007",
      language: "en",
    });
    expect(en).not.toMatch(/[\r\n\u0007]/);
  });

  it("picks the language from the contact", () => {
    expect(chooseSmsLanguage("ar")).toBe("ar");
    expect(chooseSmsLanguage("ar-AE")).toBe("ar");
    expect(chooseSmsLanguage("en")).toBe("en");
    expect(chooseSmsLanguage("ru")).toBe("en");
    expect(chooseSmsLanguage(null)).toBe("en");
  });
});

describe("who may be texted", () => {
  const ok: SmsRecipient = {
    phone_e164: "+971501234567",
    sms_opt_out_at: null,
    promotions_opt_in: false,
    stop_marketing: false,
  };
  const now = new Date("2026-10-18T10:00:00Z");
  const appt = { status: "confirmed", startsAt: "2026-10-19T10:00:00Z" };

  it("recognises mobile numbers only", () => {
    expect(isSmsCapablePhone("+971501234567")).toBe(true);
    expect(isSmsCapablePhone("+97142222222")).toBe(false); // Dubai landline
    expect(isSmsCapablePhone("+9715")).toBe(false);
    expect(isSmsCapablePhone(null)).toBe(false);
    expect(isSmsCapablePhone("")).toBe(false);
  });

  it("allows a transactional reminder", () => {
    expect(
      smsDecision({ messageClass: "reminder", recipient: ok, appointment: appt, now }),
    ).toEqual({ allow: true });
  });

  it("a marketing opt-out does NOT block a reminder, an SMS opt-out does", () => {
    expect(
      smsDecision({
        messageClass: "reminder",
        recipient: { ...ok, stop_marketing: true },
        appointment: appt,
        now,
      }).allow,
    ).toBe(true);
    expect(
      smsDecision({
        messageClass: "reminder",
        recipient: { ...ok, sms_opt_out_at: "2026-10-01T00:00:00Z" },
        appointment: appt,
        now,
      }),
    ).toEqual({ allow: false, reason: "opted_out" });
  });

  it("marketing needs promotions opt-in and no stop_marketing", () => {
    expect(smsDecision({ messageClass: "marketing", recipient: ok, now })).toEqual({
      allow: false,
      reason: "marketing_blocked",
    });
    expect(
      smsDecision({
        messageClass: "marketing",
        recipient: { ...ok, promotions_opt_in: true, stop_marketing: true },
        now,
      }),
    ).toEqual({ allow: false, reason: "marketing_blocked" });
    expect(
      smsDecision({
        messageClass: "marketing",
        recipient: { ...ok, promotions_opt_in: true },
        now,
      }),
    ).toEqual({ allow: true });
  });

  it("refuses without a usable phone", () => {
    expect(
      smsDecision({ messageClass: "reminder", recipient: { ...ok, phone_e164: null }, now }),
    ).toEqual({ allow: false, reason: "no_phone" });
    expect(
      smsDecision({
        messageClass: "reminder",
        recipient: { ...ok, phone_e164: "+97142222222" },
        now,
      }),
    ).toEqual({ allow: false, reason: "not_sms_capable" });
  });

  it("does not text someone who stopped WhatsApp business messages (131050)", () => {
    expect(
      smsDecision({
        messageClass: "reminder",
        recipient: ok,
        whatsappErrorCode: 131050,
        appointment: appt,
        now,
      }),
    ).toEqual({ allow: false, reason: "whatsapp_opt_out" });
    expect(
      smsDecision({
        messageClass: "reminder",
        recipient: ok,
        whatsappErrorCode: 131026,
        appointment: appt,
        now,
      }).allow,
    ).toBe(true);
  });

  it("skips appointments that are over, cancelled or already started", () => {
    expect(
      smsDecision({
        messageClass: "reminder",
        recipient: ok,
        appointment: { status: "cancelled", startsAt: appt.startsAt },
        now,
      }),
    ).toEqual({ allow: false, reason: "appointment_inactive" });
    expect(
      smsDecision({
        messageClass: "reminder",
        recipient: ok,
        appointment: { status: "confirmed", startsAt: "2026-10-18T09:00:00Z" },
        now,
      }),
    ).toEqual({ allow: false, reason: "appointment_started" });
  });
});

describe("status ladder", () => {
  it("only moves forward", () => {
    expect(nextSmsStatus("queued", "sent")).toBe("sent");
    expect(nextSmsStatus("sent", "queued")).toBe("sent");
    expect(nextSmsStatus("delivered", "sent")).toBe("delivered");
    expect(nextSmsStatus("sent", "delivered")).toBe("delivered");
    expect(nextSmsStatus("sent", "undelivered")).toBe("undelivered");
    expect(nextSmsStatus("delivered", "failed")).toBe("delivered");
    expect(nextSmsStatus("failed", "delivered")).toBe("failed");
  });

  it("maps provider words", () => {
    expect(fromProviderStatus("accepted")).toBe("queued");
    expect(fromProviderStatus("DELIVERED")).toBe("delivered");
    expect(fromProviderStatus("read")).toBe("delivered");
    expect(fromProviderStatus("canceled")).toBe("failed");
    expect(fromProviderStatus("surprise")).toBeNull();
  });

  it("previousStatusesFor agrees with nextSmsStatus for every pair", () => {
    for (const next of SMS_STATUSES) {
      const allowed = new Set(previousStatusesFor(next));
      for (const cur of SMS_STATUSES) {
        const moves = cur !== next && nextSmsStatus(cur, next) === next;
        expect(allowed.has(cur), `${cur} -> ${next}`).toBe(moves);
      }
    }
    expect(previousStatusesFor("delivered")).toEqual(["queued", "sending", "sent"]);
    expect(previousStatusesFor("queued")).toEqual([]);
  });
});

describe("config", () => {
  it("reads the catalogue defaults and builds callback URLs with the sms id", () => {
    const c = readSmsConfig({
      provider: "twilio",
      sender: "ALDAS",
      account_sid: "AC1",
      clinic_name: "Clinic",
      callback_phone: "+97140000000",
    });
    expect(c).toMatchObject({ ratePerSec: 5, dailyCap: 200, segmentPrice: null, sender: "ALDAS" });
    expect(smsCallbackBase("https://pulse.test/", "acc")).toBe(
      "https://pulse.test/api/webhooks/integrations/sms/acc",
    );
    expect(smsCallbackUrl("https://pulse.test", "acc", "sms1")).toBe(
      "https://pulse.test/api/webhooks/integrations/sms/acc?m=sms1",
    );
    expect(readSmsConfig({ segment_price: "0.18" }).segmentPrice).toBe(0.18);
  });
});

describe("Twilio-style adapter (recorded responses)", () => {
  // Shapes recorded from Twilio's documentation, not from a live account.
  const CREATED = {
    sid: "SM0123456789abcdef0123456789abcdef",
    status: "queued",
    num_segments: "1",
    error_code: null,
    error_message: null,
  };
  const UNSUBSCRIBED = {
    code: 21610,
    message: "Attempt to send to unsubscribed recipient",
    more_info: "https://www.twilio.com/docs/errors/21610",
    status: 400,
  };
  const BAD_NUMBER = { code: 21211, message: "Invalid 'To' Phone Number", status: 400 };
  const AUTH = { code: 20003, message: "Authenticate", status: 401 };

  function make(responses: Array<{ status: number; body: unknown } | Error>) {
    const requests: Array<{ url: string; init: RequestInit }> = [];
    const calls: CallRecord[] = [];
    let i = 0;
    const provider = createTwilioProvider({
      accountSid: "AC00000000000000000000000000000000",
      authToken: "tok_secret",
      sender: "ALDAS",
      fetchFn: (async (url: string, init: RequestInit) => {
        requests.push({ url: String(url), init });
        const r = responses[Math.min(i++, responses.length - 1)];
        if (r instanceof Error) throw r;
        return new Response(JSON.stringify(r.body), {
          status: r.status,
          headers: { "content-type": "application/json" },
        });
      }) as unknown as typeof fetch,
      sleep: async () => undefined,
      sink: { record: (c) => void calls.push(c) },
    });
    return { provider, requests, calls };
  }
  const input = {
    to: "+971501234567",
    body: "Hello",
    clientRef: "sms-1",
    statusCallbackUrl: "https://pulse.test/api/webhooks/integrations/sms/acc?m=sms-1",
  };

  it("posts the documented form to the documented URL with Basic auth", async () => {
    const { provider, requests } = make([{ status: 201, body: CREATED }]);
    const r = await provider.send(input);
    expect(r).toEqual({ ok: true, providerMessageId: CREATED.sid, status: "queued", segments: 1 });
    const req = requests[0];
    expect(req.url).toBe(
      "https://api.twilio.com/2010-04-01/Accounts/AC00000000000000000000000000000000/Messages.json",
    );
    expect(req.init.method).toBe("POST");
    const headers = req.init.headers as Record<string, string>;
    expect(headers.Authorization).toBe(
      "Basic " + Buffer.from("AC00000000000000000000000000000000:tok_secret").toString("base64"),
    );
    expect(headers["Content-Type"]).toBe("application/x-www-form-urlencoded");
    const form = new URLSearchParams(String(req.init.body));
    expect(Object.fromEntries(form)).toEqual({
      To: "+971501234567",
      From: "ALDAS",
      Body: "Hello",
      StatusCallback: input.statusCallbackUrl,
    });
  });

  it("uses a Messaging Service when the sender is one", async () => {
    const requests: string[] = [];
    const p = createTwilioProvider({
      accountSid: "AC1",
      authToken: "t",
      sender: "MG" + "a".repeat(32),
      fetchFn: (async (_u: string, init: RequestInit) => {
        requests.push(String(init.body));
        return new Response(JSON.stringify(CREATED), { status: 201 });
      }) as unknown as typeof fetch,
    });
    await p.send(input);
    expect(new URLSearchParams(requests[0]).get("MessagingServiceSid")).toBe("MG" + "a".repeat(32));
    expect(new URLSearchParams(requests[0]).has("From")).toBe(false);
  });

  it("maps an unsubscribed recipient (21610) to an opt-out, and bad numbers to a permanent failure", async () => {
    expect(await make([{ status: 400, body: UNSUBSCRIBED }]).provider.send(input)).toEqual({
      ok: false,
      code: "21610",
      retryable: false,
      ambiguous: false,
      optOut: true,
    });
    expect(await make([{ status: 400, body: BAD_NUMBER }]).provider.send(input)).toEqual({
      ok: false,
      code: "21211",
      retryable: false,
      ambiguous: false,
      optOut: false,
    });
    expect(await make([{ status: 401, body: AUTH }]).provider.send(input)).toMatchObject({
      ok: false,
      code: "20003",
      retryable: false,
    });
  });

  it("reports a 5xx or timeout as AMBIGUOUS (may have been sent) and does not retry the POST", async () => {
    const a = make([{ status: 503, body: {} }]);
    expect(await a.provider.send(input)).toMatchObject({
      ok: false,
      ambiguous: true,
      retryable: false,
    });
    expect(a.requests).toHaveLength(1);
    const b = make([Object.assign(new Error("t"), { name: "TimeoutError" })]);
    expect(await b.provider.send(input)).toMatchObject({ ok: false, ambiguous: true });
  });

  it("retries after a 429 and then succeeds", async () => {
    const m = make([
      { status: 429, body: { code: 20429 } },
      { status: 201, body: CREATED },
    ]);
    expect(await m.provider.send(input)).toMatchObject({ ok: true });
    expect(m.requests).toHaveLength(2);
  });

  it("verifies credentials with a read-only GET", async () => {
    const ok = make([{ status: 200, body: { sid: "AC0", status: "active" } }]);
    expect(await ok.provider.verify()).toEqual({ ok: true });
    expect(ok.requests[0].init.method).toBe("GET");
    expect(ok.requests[0].url).toBe(
      "https://api.twilio.com/2010-04-01/Accounts/AC00000000000000000000000000000000.json",
    );
    expect(await make([{ status: 401, body: AUTH }]).provider.verify()).toEqual({
      ok: false,
      code: "auth",
    });
  });

  it("logs provider, operation, outcome, status and latency only: no number, text, token or URL", async () => {
    const m = make([{ status: 201, body: CREATED }]);
    await m.provider.send({ ...input, body: "PRIVATEBODY" });
    const dump = JSON.stringify(m.calls);
    for (const s of ["PRIVATEBODY", "971501234567", "tok_secret", "twilio.com", "AC0000"])
      expect(dump).not.toContain(s);
    expect(m.calls[0]).toMatchObject({
      provider: "twilio",
      operation: "sms.send",
      outcome: "ok",
      httpStatus: 201,
    });
  });

  it("cannot be pointed at another host", async () => {
    // the client's host list is fixed to api.twilio.com
    const { provider, requests } = make([{ status: 201, body: CREATED }]);
    await provider.send(input);
    expect(new URL(requests[0].url).hostname).toBe("api.twilio.com");
  });
});

describe("fake provider", () => {
  it("records sends and follows its script", async () => {
    const fake = createFakeSmsProvider([
      { ok: false, code: "21211", retryable: false, ambiguous: false, optOut: false },
    ]);
    expect(
      await fake.send({ to: "+1", body: "x", clientRef: "a", statusCallbackUrl: "u" }),
    ).toMatchObject({ ok: false });
    expect(fake.sent).toHaveLength(1);
    const plain = createFakeSmsProvider();
    expect(
      await plain.send({ to: "+1", body: "x", clientRef: "a", statusCallbackUrl: "u" }),
    ).toMatchObject({ ok: true });
  });
});
