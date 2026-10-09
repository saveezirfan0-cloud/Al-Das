import { describe, expect, it } from "vitest";

import { buildTranscript, maskContactDetails } from "@/lib/ai/context";
import type { TranscriptMessage } from "@/lib/ai/types";

const msg = (over: Partial<TranscriptMessage>): TranscriptMessage => ({
  direction: "in",
  kind: "text",
  body: "hello",
  at: "2026-01-01T00:00:00Z",
  ...over,
});

describe("maskContactDetails", () => {
  it("masks emails and long numbers but keeps doses, times and short numbers", () => {
    expect(maskContactDetails("mail me at pat@example.test")).toBe("mail me at [email]");
    expect(maskContactDetails("call +971 50 123 4567 please")).toBe("call [number] please");
    expect(maskContactDetails("my id is 784-1990-1234567-1")).toBe("my id is [number]");
    expect(maskContactDetails("take 500 mg at 10:30, room 12")).toBe("take 500 mg at 10:30, room 12");
  });
});

describe("buildTranscript", () => {
  it("labels speakers without names and keeps order", () => {
    const t = buildTranscript([
      msg({ direction: "in", body: "Can I book Tuesday?" }),
      msg({ direction: "out", byStaff: true, body: "Yes, 10am works." }),
      msg({ direction: "out", byStaff: false, kind: "template", body: null }),
    ]);
    expect(t).toBe(
      ["Patient: Can I book Tuesday?", "Staff: Yes, 10am works.", "Automated: [template message]"].join("\n"),
    );
  });

  it("excludes internal notes unless asked", () => {
    const messages = [msg({ body: "hi" }), msg({ direction: "note", kind: "note", body: "she is difficult" })];
    expect(buildTranscript(messages)).not.toContain("difficult");
    expect(buildTranscript(messages, { includeNotes: true })).toContain("Internal note: she is difficult");
  });

  it("describes media instead of linking it and masks contact details", () => {
    const t = buildTranscript([
      msg({ kind: "image", body: null }),
      msg({ kind: "audio", body: null }),
      msg({ body: "reach me on pat@example.test or +971501234567" }),
    ]);
    expect(t).toContain("Patient: [image]");
    expect(t).toContain("Patient: [voice note]");
    expect(t).toContain("[email]");
    expect(t).toContain("[number]");
    expect(t).not.toContain("example.test");
    expect(t).not.toContain("971501234567");
  });

  it("keeps the newest messages when over the character budget", () => {
    const messages = Array.from({ length: 10 }, (_, i) => msg({ body: `message number ${i}` }));
    const t = buildTranscript(messages, { maxChars: 70 });
    const lines = t.split("\n");
    expect(lines.at(-1)).toBe("Patient: message number 9");
    expect(lines).not.toContain("Patient: message number 0");
    expect(lines.length).toBeLessThan(10);
  });

  it("always keeps at least the latest message, truncated per message", () => {
    const t = buildTranscript([msg({ body: "x".repeat(5000) })], { maxChars: 10, maxCharsPerMessage: 100 });
    expect(t.length).toBeLessThan(120);
    expect(t.endsWith("…")).toBe(true);
  });

  it("returns an empty string for an empty thread", () => {
    expect(buildTranscript([])).toBe("");
    expect(buildTranscript([msg({ kind: "text", body: "  " })])).toBe("");
  });

  it("caps the message count", () => {
    const messages = Array.from({ length: 100 }, (_, i) => msg({ body: `m${i}` }));
    expect(buildTranscript(messages, { maxMessages: 5 }).split("\n")).toHaveLength(5);
  });
});
