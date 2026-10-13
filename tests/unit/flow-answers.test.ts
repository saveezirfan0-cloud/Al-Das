import { describe, expect, it } from "vitest";

import {
  checkAnswer,
  matchOption,
  MAX_ANSWER_CHARS,
  patternProblem,
} from "@/lib/flow-engine/answers";
import { parseWaFlowReply, WA_FLOW_LIMITS } from "@/lib/flow-engine/wa-flow";

describe("question answer checks", () => {
  it("text: anything non-empty, trimmed, capped", () => {
    expect(checkAnswer({ type: "text" }, "  hello ")).toEqual({ ok: true, value: "hello" });
    expect(checkAnswer({ type: "text" }, "   ")).toMatchObject({ ok: false, reason: "empty" });
    expect(checkAnswer({ type: "text" }, "x".repeat(MAX_ANSWER_CHARS + 1))).toMatchObject({
      ok: false,
      reason: "too_long",
    });
  });

  it("number: digits (Arabic-Indic too), thousands commas, min / max", () => {
    expect(checkAnswer({ type: "number" }, "42")).toEqual({ ok: true, value: "42" });
    expect(checkAnswer({ type: "number" }, "1,250.5")).toEqual({ ok: true, value: "1250.5" });
    expect(checkAnswer({ type: "number" }, "٣٥")).toEqual({ ok: true, value: "35" });
    expect(checkAnswer({ type: "number" }, "about 5")).toMatchObject({ ok: false });
    expect(checkAnswer({ type: "number", min: 1, max: 10 }, "0")).toMatchObject({
      ok: false,
      reason: "too_small",
    });
    expect(checkAnswer({ type: "number", min: 1, max: 10 }, "11")).toMatchObject({
      ok: false,
      reason: "too_large",
    });
    expect(checkAnswer({ type: "number", min: 1, max: 10 }, "10")).toMatchObject({ ok: true });
  });

  it("phone: normalised to E.164 (synthetic reserved numbers only)", () => {
    expect(checkAnswer({ type: "phone" }, "+44 7700 900123")).toEqual({
      ok: true,
      value: "+447700900123",
    });
    expect(checkAnswer({ type: "phone" }, "not a phone")).toMatchObject({ ok: false });
  });

  it("email: lower-cased, must look like an address", () => {
    expect(checkAnswer({ type: "email" }, " Layla.Demo07@Example.test ")).toEqual({
      ok: true,
      value: "layla.demo07@example.test",
    });
    expect(checkAnswer({ type: "email" }, "layla@")).toMatchObject({ ok: false });
  });

  it("date: ISO or day-first, real calendar dates only", () => {
    expect(checkAnswer({ type: "date" }, "2026-11-05")).toEqual({ ok: true, value: "2026-11-05" });
    expect(checkAnswer({ type: "date" }, "5/11/2026")).toEqual({ ok: true, value: "2026-11-05" });
    expect(checkAnswer({ type: "date" }, "05.11.2026")).toEqual({ ok: true, value: "2026-11-05" });
    expect(checkAnswer({ type: "date" }, "31/02/2026")).toMatchObject({ ok: false });
    expect(checkAnswer({ type: "date" }, "tomorrow")).toMatchObject({ ok: false });
  });

  it("regex: matches the author's pattern; a dangerous or broken pattern never matches", () => {
    expect(checkAnswer({ type: "regex", pattern: "^[A-Z]{2}\\d{4}$" }, "AB1234")).toMatchObject({
      ok: true,
    });
    expect(checkAnswer({ type: "regex", pattern: "^[A-Z]{2}\\d{4}$" }, "ab")).toMatchObject({
      ok: false,
      reason: "no_match",
    });
    expect(checkAnswer({ type: "regex", pattern: "(a+)+$" }, "aaaa")).toMatchObject({
      ok: false,
      reason: "bad_pattern",
    });
    expect(checkAnswer({ type: "regex" }, "x")).toMatchObject({ ok: false, reason: "bad_pattern" });
  });

  it("patternProblem refuses nested repeats, back-references, broken and over-long patterns", () => {
    expect(patternProblem("^\\d+(\\.\\d+)?$")).toBeNull();
    expect(patternProblem("(a+)+")).not.toBeNull();
    expect(patternProblem("(\\d*)*")).not.toBeNull();
    expect(patternProblem("(a)\\1")).not.toBeNull();
    expect(patternProblem("([a-z")).not.toBeNull();
    expect(patternProblem("a".repeat(201))).not.toBeNull();
    expect(patternProblem("")).not.toBeNull();
  });

  it("matchOption: tapped id, then title, then the option's number", () => {
    const opts = [
      { id: "yes", title: "Yes please" },
      { id: "no", title: "No" },
    ];
    expect(matchOption(opts, { text: "whatever", optionId: "no" })?.id).toBe("no");
    expect(matchOption(opts, { text: " yes PLEASE " })?.id).toBe("yes");
    expect(matchOption(opts, { text: "2" })?.id).toBe("no");
    expect(matchOption(opts, { text: "3" })).toBeUndefined();
    expect(matchOption(opts, { text: "maybe" })).toBeUndefined();
  });
});

describe("WhatsApp Flow replies (nfm_reply)", () => {
  const payload = (response: unknown) => ({
    interactive: {
      type: "nfm_reply",
      nfm_reply: {
        name: "flow",
        body: "Sent",
        response_json: typeof response === "string" ? response : JSON.stringify(response),
      },
    },
  });

  it("flattens the answers and keeps the flow token apart", () => {
    expect(
      parseWaFlowReply(
        payload({
          flow_token: "tok-1",
          first_name: "Layla",
          visits: 2,
          consent: true,
          days: ["mon", "tue"],
          nested: { a: 1 },
          "bad key": "x",
        }),
      ),
    ).toEqual({
      token: "tok-1",
      fields: { first_name: "Layla", visits: "2", consent: "true", days: "mon, tue" },
    });
  });

  it("caps field count and value size, and ignores oversized or broken replies", () => {
    const many = Object.fromEntries(
      Array.from({ length: 50 }, (_, i) => [`f${i}`, "v".repeat(20)]),
    );
    expect(Object.keys(parseWaFlowReply(payload(many))!.fields)).toHaveLength(
      WA_FLOW_LIMITS.maxFields,
    );
    const long = parseWaFlowReply(payload({ note: "v".repeat(1000) }))!;
    expect(long.fields.note!.length).toBe(WA_FLOW_LIMITS.maxValueChars);
    expect(parseWaFlowReply(payload("x".repeat(WA_FLOW_LIMITS.maxRawChars + 1)))).toEqual({
      token: null,
      fields: {},
    });
    expect(parseWaFlowReply(payload("{not json"))).toEqual({ token: null, fields: {} });
    expect(parseWaFlowReply({ interactive: { type: "button_reply" } })).toBeNull();
    expect(parseWaFlowReply(null)).toBeNull();
  });
});
