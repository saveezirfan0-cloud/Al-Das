import { describe, expect, it } from "vitest";

import {
  classifySuggestionOutcome,
  OUTCOME_THRESHOLDS,
  similarityPercent,
} from "@/lib/ai/insights/outcome";
import {
  buildQualityReport,
  lastCompleteWeek,
  topicFor,
  weekStartOf,
  type UsageRow,
} from "@/lib/ai/insights/report";
import {
  DEFAULT_COPILOT_SETTINGS,
  readCopilotSettings,
  tagMayStartFlows,
  writeCopilotSettings,
} from "@/lib/ai/copilot/settings";

describe("suggestion outcome", () => {
  const suggestion =
    "Thank you for contacting us. Our clinic opens at 9 am and closes at 6 pm, Saturday to Thursday.";

  it("accepted when sent as written, ignoring case, spacing and punctuation", () => {
    expect(classifySuggestionOutcome(suggestion, suggestion.toUpperCase() + "  ").outcome).toBe(
      "accepted",
    );
    expect(
      classifySuggestionOutcome(
        suggestion,
        "Thank you for contacting us - our clinic opens at 9 am and closes at 6 pm Saturday to Thursday",
      ).outcome,
    ).toBe("accepted");
  });

  it("edited when changed but recognisably the same", () => {
    const r = classifySuggestionOutcome(
      suggestion,
      "Thank you for contacting us. We open at 9 am and close at 6 pm, Saturday to Thursday. See you soon!",
    );
    expect(r.outcome).toBe("edited");
    expect(r.similarity).toBeGreaterThanOrEqual(OUTCOME_THRESHOLDS.edited);
    expect(r.similarity).toBeLessThan(OUTCOME_THRESHOLDS.accepted);
  });

  it("rejected when the person wrote something else", () => {
    expect(
      classifySuggestionOutcome(suggestion, "Please come to reception tomorrow and ask for Layla.")
        .outcome,
    ).toBe("rejected");
  });

  it("works for Arabic and handles empty input", () => {
    const ar = "شكرا لتواصلكم معنا. تفتح العيادة الساعة التاسعة صباحا";
    expect(classifySuggestionOutcome(ar, ar).outcome).toBe("accepted");
    expect(similarityPercent("", "")).toBe(100);
    expect(similarityPercent("hello", "")).toBe(0);
  });

  it("is bounded on very long input", () => {
    const start = Date.now();
    similarityPercent("word ".repeat(50_000), "other ".repeat(50_000));
    expect(Date.now() - start).toBeLessThan(500);
  });
});

const usage = (id: string, over: Partial<UsageRow> = {}): UsageRow => ({
  id,
  feature: "suggest_reply",
  status: "ok",
  conversation_id: `c-${id}`,
  created_at: "2026-10-12T09:00:00Z",
  grounded: true,
  input_tokens: 100,
  output_tokens: 50,
  ...over,
});

describe("weekly quality report", () => {
  it("counts accepted, edited, rejected and unused suggestions, and thumbs", () => {
    const { stats } = buildQualityReport({
      usage: [
        usage("1"),
        usage("2"),
        usage("3"),
        usage("4"),
        usage("5", { status: "needs_review" }),
      ],
      outcomes: [
        { ai_usage_id: "1", outcome: "accepted" },
        { ai_usage_id: "2", outcome: "edited" },
        { ai_usage_id: "3", outcome: "rejected" },
      ],
      feedback: [
        { ai_usage_id: "1", positive: true },
        { ai_usage_id: "3", positive: false },
      ],
      intents: [],
    });
    expect(stats.suggestions).toMatchObject({
      total: 5,
      accepted: 1,
      edited: 1,
      rejected: 1,
      unused: 2,
      flagged: 1,
      thumbs_up: 1,
      thumbs_down: 1,
      used_rate: 67,
    });
  });

  it("keeps refused and failed calls out of the suggestion counts but in the per-feature totals", () => {
    const { stats } = buildQualityReport({
      usage: [
        usage("1"),
        usage("2", { status: "refused" }),
        usage("3", { status: "error" }),
        usage("4", { feature: "summarize" }),
      ],
      outcomes: [],
      feedback: [],
      intents: [],
    });
    expect(stats.suggestions).toMatchObject({ total: 1, refused: 1, errors: 1 });
    expect(stats.by_feature.find((f) => f.feature === "suggest_reply")).toMatchObject({
      calls: 3,
      errors: 1,
      input_tokens: 300,
    });
    expect(stats.by_feature.find((f) => f.feature === "summarize")!.calls).toBe(1);
  });

  it("lists knowledge gaps by closed topic with conversation ids only", () => {
    const { gaps } = buildQualityReport({
      usage: [
        usage("1", { grounded: false, conversation_id: "conv-a" }),
        usage("2", { grounded: false, conversation_id: "conv-b" }),
        usage("3", { grounded: true, conversation_id: "conv-c" }),
        usage("4", { grounded: false, conversation_id: "conv-d" }),
      ],
      outcomes: [],
      feedback: [{ ai_usage_id: "3", positive: false }],
      intents: [
        { conversation_id: "conv-a", topic: "price", created_at: "2026-10-12T08:59:00Z" },
        { conversation_id: "conv-b", topic: "price", created_at: "2026-10-12T08:59:30Z" },
        { conversation_id: "conv-c", topic: "insurance", created_at: "2026-10-12T08:00:00Z" },
        { conversation_id: "conv-d", topic: "hacked", created_at: "2026-10-12T08:00:00Z" },
      ],
    });
    expect(gaps).toEqual([
      { topic: "price", count: 2, conversation_ids: ["conv-a", "conv-b"] },
      { topic: "insurance", count: 1, conversation_ids: ["conv-c"] },
      { topic: "unclassified", count: 1, conversation_ids: ["conv-d"] },
    ]);
    // nothing but counts, closed topics and ids
    expect(JSON.stringify(gaps)).not.toMatch(/body|text|message/);
  });

  it("picks the patient's most recent message topic from before the suggestion, not after", () => {
    const u = usage("1", { created_at: "2026-10-12T09:00:00Z", conversation_id: "x" });
    expect(
      topicFor(u, [
        { conversation_id: "x", topic: "location", created_at: "2026-10-12T08:00:00Z" },
        { conversation_id: "x", topic: "price", created_at: "2026-10-12T08:30:00Z" },
        { conversation_id: "x", topic: "doctors", created_at: "2026-10-12T09:30:00Z" },
      ]),
    ).toBe("price");
    expect(topicFor({ ...u, conversation_id: null }, [])).toBe("unclassified");
  });

  it("caps the ids per topic", () => {
    const many = Array.from({ length: 30 }, (_, i) =>
      usage(String(i), { grounded: false, conversation_id: `c${i}` }),
    );
    const { gaps } = buildQualityReport({ usage: many, outcomes: [], feedback: [], intents: [] });
    expect(gaps[0]!.count).toBe(30);
    expect(gaps[0]!.conversation_ids).toHaveLength(10);
  });

  it("finds the Monday of a week and the last complete week", () => {
    expect(weekStartOf(new Date("2026-10-14T12:00:00Z"))).toBe("2026-10-12"); // Wednesday
    expect(weekStartOf(new Date("2026-10-18T23:59:00Z"))).toBe("2026-10-12"); // Sunday
    expect(weekStartOf(new Date("2026-10-12T00:00:00Z"))).toBe("2026-10-12"); // Monday
    expect(lastCompleteWeek(new Date("2026-10-19T04:30:00Z"))).toEqual({
      start: "2026-10-12",
      end: "2026-10-19",
    });
  });
});

describe("copilot settings", () => {
  it("are all OFF by default, including after reading garbage", () => {
    expect(DEFAULT_COPILOT_SETTINGS).toEqual({
      intent_detection: false,
      tag_flows: { enabled: false, tags: [], signed_by: null, signed_at: null },
    });
    expect(readCopilotSettings(null)).toEqual(DEFAULT_COPILOT_SETTINGS);
    expect(readCopilotSettings({ ai_copilot: "yes please" })).toEqual(DEFAULT_COPILOT_SETTINGS);
    expect(
      readCopilotSettings({ ai_copilot: { tag_flows: { enabled: true, tags: ["emergency"] } } }),
    ).toEqual(DEFAULT_COPILOT_SETTINGS);
  });

  it("round-trips and keeps every other org setting", () => {
    const next = { ...DEFAULT_COPILOT_SETTINGS, intent_detection: true };
    const written = writeCopilotSettings({ ai: { enabled: true }, timezone: "x" }, next);
    expect(written).toMatchObject({ ai: { enabled: true }, timezone: "x" });
    expect(readCopilotSettings(written).intent_detection).toBe(true);
  });

  it("an AI tag may start a flow only when EVERY condition holds, and never for emergencies", () => {
    const signed = {
      intent_detection: true,
      tag_flows: {
        enabled: true,
        tags: ["booking", "price"] as ("booking" | "price")[],
        signed_by: "9d2e6f0a-1b2c-4d3e-8f4a-5b6c7d8e9f01",
        signed_at: "2026-10-17T10:00:00Z",
      },
    };
    expect(tagMayStartFlows({ enabled: true }, signed, "booking")).toBe(true);
    expect(tagMayStartFlows({ enabled: false }, signed, "booking")).toBe(false); // master switch off
    expect(
      tagMayStartFlows({ enabled: true }, { ...signed, intent_detection: false }, "booking"),
    ).toBe(false);
    expect(
      tagMayStartFlows(
        { enabled: true },
        { ...signed, tag_flows: { ...signed.tag_flows, enabled: false } },
        "booking",
      ),
    ).toBe(false);
    expect(
      tagMayStartFlows(
        { enabled: true },
        { ...signed, tag_flows: { ...signed.tag_flows, signed_by: null } },
        "booking",
      ),
    ).toBe(false);
    expect(
      tagMayStartFlows(
        { enabled: true },
        { ...signed, tag_flows: { ...signed.tag_flows, signed_at: null } },
        "booking",
      ),
    ).toBe(false);
    expect(tagMayStartFlows({ enabled: true }, signed, "complaint")).toBe(false); // not on the approved list
    expect(tagMayStartFlows({ enabled: true }, signed, "emergency")).toBe(false);
    expect(tagMayStartFlows({ enabled: true }, signed, "made_up")).toBe(false);
    expect(tagMayStartFlows({ enabled: true }, DEFAULT_COPILOT_SETTINGS, "booking")).toBe(false);
  });
});
