import { describe, expect, it } from "vitest";

import { tokenizeWhatsAppText } from "@/lib/whatsapp/format";

const t = (s: string) => tokenizeWhatsAppText(s);

describe("tokenizeWhatsAppText", () => {
  it("returns plain text untouched", () => {
    expect(t("hello world")).toEqual([{ text: "hello world" }]);
    expect(t("")).toEqual([]);
  });

  it("formats bold, italic, strike and monospace", () => {
    expect(t("a *b* c")).toEqual([{ text: "a " }, { text: "b", bold: true }, { text: " c" }]);
    expect(t("_i_")).toEqual([{ text: "i", italic: true }]);
    expect(t("~s~")).toEqual([{ text: "s", strike: true }]);
    expect(t("```code```")).toEqual([{ text: "code", mono: true }]);
    expect(t("`x`")).toEqual([{ text: "x", mono: true }]);
  });

  it("nests styles", () => {
    expect(t("*bold _both_*")).toEqual([
      { text: "bold ", bold: true },
      { text: "both", bold: true, italic: true },
    ]);
  });

  it("ignores markers that do not hug the text or sit inside a word", () => {
    expect(t("2 * 3 * 4")).toEqual([{ text: "2 * 3 * 4" }]);
    expect(t("snake_case_name")).toEqual([{ text: "snake_case_name" }]);
    expect(t("* not bold *")).toEqual([{ text: "* not bold *" }]);
    expect(t("unclosed *marker")).toEqual([{ text: "unclosed *marker" }]);
    expect(t("**")).toEqual([{ text: "**" }]);
  });

  it("works with Arabic and keeps variables intact", () => {
    expect(t("مرحباً *{{1}}* بك")).toEqual([
      { text: "مرحباً " },
      { text: "{{1}}", bold: true },
      { text: " بك" },
    ]);
  });

  it("does not format inside monospace", () => {
    expect(t("```*raw*```")).toEqual([{ text: "*raw*", mono: true }]);
  });
});
