import { describe, expect, it } from "vitest";

import { DEFAULT_AI_SETTINGS, readAiSettings, writeAiSettings } from "@/lib/ai/settings";

describe("ai settings", () => {
  it("is OFF by default and tolerates missing or junk values", () => {
    expect(DEFAULT_AI_SETTINGS.enabled).toBe(false);
    expect(readAiSettings(null)).toEqual(DEFAULT_AI_SETTINGS);
    expect(readAiSettings({})).toEqual(DEFAULT_AI_SETTINGS);
    expect(readAiSettings({ ai: { enabled: "yes" } })).toEqual(DEFAULT_AI_SETTINGS);
    expect(readAiSettings([1, 2])).toEqual(DEFAULT_AI_SETTINGS);
  });

  it("round-trips and leaves the other org settings alone", () => {
    const next = { enabled: true, kb_group_ids: ["3f2b8c1e-4d5a-4b6c-8d7e-9f0a1b2c3d4e"], rate_limit_per_minute: 20 };
    const written = writeAiSettings({ inbox: { show_agent_name: true } }, next);
    expect(written.inbox).toEqual({ show_agent_name: true });
    expect(readAiSettings(written)).toEqual(next);
  });

  it("rejects an out-of-range rate limit when writing", () => {
    expect(() => writeAiSettings({}, { enabled: true, kb_group_ids: [], rate_limit_per_minute: 0 })).toThrow();
  });
});
