import { describe, expect, it } from "vitest";

import {
  isArabic,
  matchShortcuts,
  pickQuickReplyText,
  renderQuickReply,
  unknownVariables,
  variablesIn,
} from "@/lib/inbox/quick-reply";

describe("bilingual quick replies", () => {
  const reply = { text: "Hello {{first_name}}", text_ar: "مرحبا {{first_name}}" };

  it("picks the Arabic text for an Arabic-speaking patient and English otherwise", () => {
    expect(pickQuickReplyText(reply, "ar")).toBe(reply.text_ar);
    expect(pickQuickReplyText(reply, "AR-AE")).toBe(reply.text_ar);
    expect(pickQuickReplyText(reply, "en")).toBe(reply.text);
    expect(pickQuickReplyText(reply, null)).toBe(reply.text);
  });

  it("falls back to the other language rather than sending nothing", () => {
    expect(pickQuickReplyText({ text: "Hello", text_ar: null }, "ar")).toBe("Hello");
    expect(pickQuickReplyText({ text: "  ", text_ar: "مرحبا" }, "en")).toBe("مرحبا");
    expect(isArabic("ar")).toBe(true);
    expect(isArabic("en")).toBe(false);
  });
});

describe("variables", () => {
  it("fills known variables and leaves missing ones visible", () => {
    const r = renderQuickReply(
      "Hi {{first_name}}, see {{ doctor }} at {{appointment_time}} {{nonsense}}",
      {
        first_name: "Layla",
        doctor: "Dr Example",
        appointment_time: null,
      },
    );
    expect(r.text).toBe("Hi Layla, see Dr Example at {{appointment_time}} {{nonsense}}");
    expect(r.unresolved.sort()).toEqual(["appointment_time", "nonsense"]);
  });

  it("is case-insensitive about names and trims values", () => {
    expect(renderQuickReply("{{FIRST_NAME}}", { first_name: "  Omar " }).text).toBe("Omar");
  });

  it("lists the variables used and the ones nobody supports", () => {
    expect(variablesIn("{{doctor}} {{Doctor}} {{location}}")).toEqual(["doctor", "location"]);
    expect(unknownVariables("{{doctor}} {{docter}}")).toEqual(["docter"]);
  });

  it("matches slash shortcuts by prefix and ignores multi-line text", () => {
    const list = [{ shortcut: "hours" }, { shortcut: "hello" }, { shortcut: "directions" }];
    expect(matchShortcuts(list, "/h").map((x) => x.shortcut)).toEqual(["hours", "hello"]);
    expect(matchShortcuts(list, "/").length).toBe(3);
    expect(matchShortcuts(list, "h")).toEqual([]);
    expect(matchShortcuts(list, "/h\nmore")).toEqual([]);
  });
});
