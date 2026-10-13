import { describe, expect, it } from "vitest";

import {
  parseStripeSignatureHeader,
  stripeSignatureHeader,
  verifyStripeWebhook,
} from "@/lib/integrations/payments/stripe";
import { paytabsSignature, verifyPaytabsWebhook } from "@/lib/integrations/payments/paytabs";
import { twilioSignature, verifyTwilioSignature } from "@/lib/integrations/sms/twilio";
import { hmac, parseForm, safeEqual, withinReplayWindow } from "@/lib/integrations/webhook";

describe("primitives", () => {
  it("compares in constant time and treats different lengths as unequal", () => {
    expect(safeEqual("abc", "abc")).toBe(true);
    expect(safeEqual("abc", "abd")).toBe(false);
    expect(safeEqual("abc", "abcd")).toBe(false);
    expect(safeEqual("", "")).toBe(true);
  });

  it("replay window is symmetric and rejects non-numbers", () => {
    const now = 1_800_000_000_000;
    expect(withinReplayWindow(now / 1000, now, 300)).toBe(true);
    expect(withinReplayWindow(now / 1000 - 299, now, 300)).toBe(true);
    expect(withinReplayWindow(now / 1000 - 301, now, 300)).toBe(false);
    expect(withinReplayWindow(now / 1000 + 301, now, 300)).toBe(false);
    expect(withinReplayWindow(Number.NaN, now)).toBe(false);
  });

  it("parses a form body", () => {
    expect(parseForm("a=1&b=%2B971&a=2")).toEqual({ a: "2", b: "+971" });
  });

  it("hmac is deterministic", () => {
    expect(hmac("sha256", "k", "d", "hex")).toBe(hmac("sha256", "k", "d", "hex"));
    expect(hmac("sha256", "k", "d", "hex")).not.toBe(hmac("sha256", "k2", "d", "hex"));
  });
});

describe("Stripe signature", () => {
  const secret = "whsec_test_secret";
  const raw = '{"id":"evt_1","type":"checkout.session.completed"}';
  const now = 1_800_000_000_000;
  const t = Math.floor(now / 1000);

  it("accepts a genuine delivery", () => {
    expect(verifyStripeWebhook(secret, raw, stripeSignatureHeader(secret, raw, t), now)).toBe(true);
  });

  it("rejects a tampered body, a wrong secret and a missing header", () => {
    const header = stripeSignatureHeader(secret, raw, t);
    expect(verifyStripeWebhook(secret, raw + " ", header, now)).toBe(false);
    expect(verifyStripeWebhook("whsec_other", raw, header, now)).toBe(false);
    expect(verifyStripeWebhook(secret, raw, null, now)).toBe(false);
    expect(verifyStripeWebhook("", raw, header, now)).toBe(false);
    expect(verifyStripeWebhook(secret, raw, "garbage", now)).toBe(false);
  });

  it("rejects a replay of an old capture and a timestamp from the future", () => {
    expect(verifyStripeWebhook(secret, raw, stripeSignatureHeader(secret, raw, t - 301), now)).toBe(
      false,
    );
    expect(verifyStripeWebhook(secret, raw, stripeSignatureHeader(secret, raw, t + 301), now)).toBe(
      false,
    );
    expect(verifyStripeWebhook(secret, raw, stripeSignatureHeader(secret, raw, t - 299), now)).toBe(
      true,
    );
  });

  it("accepts any matching v1 when Stripe sends several (secret rotation) and ignores v0", () => {
    const good = stripeSignatureHeader(secret, raw, t).split(",v1=")[1];
    expect(verifyStripeWebhook(secret, raw, `t=${t},v1=deadbeef,v1=${good},v0=ffff`, now)).toBe(
      true,
    );
    expect(parseStripeSignatureHeader(`t=${t},v0=abc`)).toBeNull();
  });
});

describe("PayTabs signature", () => {
  const key = "SERVERKEYTEST";
  const raw = '{"tran_ref":"TST1","cart_id":"abc"}';

  it("accepts the HMAC of the exact raw body, case-insensitive hex", () => {
    const sig = paytabsSignature(key, raw);
    expect(verifyPaytabsWebhook(key, raw, sig)).toBe(true);
    expect(verifyPaytabsWebhook(key, raw, sig.toUpperCase())).toBe(true);
  });

  it("rejects other bodies, keys and empty headers", () => {
    const sig = paytabsSignature(key, raw);
    expect(verifyPaytabsWebhook(key, raw.replace("TST1", "TST2"), sig)).toBe(false);
    expect(verifyPaytabsWebhook("other", raw, sig)).toBe(false);
    expect(verifyPaytabsWebhook(key, raw, null)).toBe(false);
    expect(verifyPaytabsWebhook(key, raw, "")).toBe(false);
  });
});

describe("Twilio signature", () => {
  it("reproduces the example published in Twilio's documentation", () => {
    // Token 12345; URL with a query string; POST fields sorted by name and appended as name+value; HMAC-SHA1, base64.
    const params = {
      CallSid: "CA1234567890ABCDE",
      Caller: "+14158675309",
      Digits: "1234",
      From: "+14158675309",
      To: "+18005551212",
    };
    const url = "https://mycompany.com/myapp.php?foo=1&bar=2";
    expect(twilioSignature("12345", url, params)).toBe("RSOYDt4T1cUTdK1PDd93/VVr8B8=");
    expect(verifyTwilioSignature("12345", url, params, "RSOYDt4T1cUTdK1PDd93/VVr8B8=")).toBe(true);
  });

  it("rejects a changed field, URL or token", () => {
    const params = { MessageSid: "SM1", MessageStatus: "delivered" };
    const url = "https://pulse.test/api/webhooks/integrations/sms/acc?m=abc";
    const sig = twilioSignature("tok", url, params);
    expect(verifyTwilioSignature("tok", url, { ...params, MessageStatus: "failed" }, sig)).toBe(
      false,
    );
    expect(verifyTwilioSignature("tok", url + "x", params, sig)).toBe(false);
    expect(verifyTwilioSignature("tok2", url, params, sig)).toBe(false);
    expect(verifyTwilioSignature("tok", url, params, null)).toBe(false);
    expect(verifyTwilioSignature("", url, params, sig)).toBe(false);
  });
});
