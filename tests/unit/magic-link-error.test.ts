import { describe, expect, it } from "vitest";

import { MAGIC_LINK_COPY, magicLinkErrorMessage } from "@/lib/auth/magic-link-error";

describe("magicLinkErrorMessage", () => {
  it("explains an unknown address as needing an invite", () => {
    expect(magicLinkErrorMessage({ code: "otp_disabled", status: 422 })).toBe(
      MAGIC_LINK_COPY.noAccount,
    );
    expect(magicLinkErrorMessage({ code: "user_not_found", status: 400 })).toBe(
      MAGIC_LINK_COPY.noAccount,
    );
  });

  it("reports email rate limits instead of blaming the address", () => {
    expect(magicLinkErrorMessage({ code: "over_email_send_rate_limit", status: 429 })).toBe(
      MAGIC_LINK_COPY.rateLimited,
    );
    expect(magicLinkErrorMessage({ status: 429 })).toBe(MAGIC_LINK_COPY.rateLimited);
  });

  it("reports mail delivery failures separately", () => {
    expect(magicLinkErrorMessage({ code: "unexpected_failure", status: 500 })).toBe(
      MAGIC_LINK_COPY.mailFailed,
    );
    expect(magicLinkErrorMessage({ status: 502 })).toBe(MAGIC_LINK_COPY.mailFailed);
  });

  it("falls back to the invite hint for anything unrecognised", () => {
    expect(magicLinkErrorMessage({})).toBe(MAGIC_LINK_COPY.noAccount);
  });
});
