import { describe, expect, it } from "vitest";

import {
  applyFormat,
  blockingDraftIssues,
  emptyBuilderState,
  fromComponents,
  insertVariable,
  nextVariableIndex,
  renumberVariables,
  syncExamples,
  toComponents,
  toCreateRequest,
  validateBuilder,
  variableIndexes,
  type BuilderState,
} from "@/lib/whatsapp/template-builder";

function valid(over: Partial<BuilderState> = {}): BuilderState {
  return emptyBuilderState({
    name: "visit_reminder",
    body: "Hello {{1}}, your visit with {{2}} is tomorrow at the clinic.",
    examples: ["Sara", "Dr Example"],
    ...over,
  });
}
const paths = (s: BuilderState) => validateBuilder(s).map((i) => i.path);

describe("variables", () => {
  it("finds, appends and renumbers positional variables", () => {
    expect(variableIndexes("a {{2}} b {{1}} c {{2}}")).toEqual([2, 1]);
    expect(nextVariableIndex("a {{1}} {{3}}")).toBe(4);
    expect(nextVariableIndex("none")).toBe(1);
    const ins = insertVariable("Hello  world", 6);
    expect(ins).toEqual({ text: "Hello {{1}} world", index: 1, caret: 6 + 5 });
    const r = renumberVariables("x {{3}} y {{1}}");
    expect(r.text).toBe("x {{1}} y {{2}}");
    expect(r.mapping).toEqual([
      { from: 3, to: 1 },
      { from: 1, to: 2 },
    ]);
    expect(syncExamples("a {{1}} {{2}}", ["x"])).toEqual(["x", ""]);
    expect(syncExamples("a", ["x"])).toEqual([]);
  });
});

describe("applyFormat", () => {
  it("wraps, unwraps and handles empty selections", () => {
    expect(applyFormat("hello world", 0, 5, "bold")).toEqual({
      text: "*hello* world",
      selStart: 1,
      selEnd: 6,
    });
    expect(applyFormat("*hello* world", 1, 6, "bold").text).toBe("hello world");
    expect(applyFormat("*hello* world", 0, 7, "bold").text).toBe("hello world");
    expect(applyFormat("ab", 1, 1, "italic")).toEqual({ text: "a__b", selStart: 2, selEnd: 2 });
    expect(applyFormat("code", 0, 4, "mono").text).toBe("```code```");
    expect(applyFormat("gone", 0, 4, "strike").text).toBe("~gone~");
  });
});

describe("validateBuilder", () => {
  it("accepts a well-formed standard template", () => {
    expect(validateBuilder(valid())).toEqual([]);
  });

  it("validates identity", () => {
    expect(paths(valid({ name: "Bad Name" }))).toContain("name");
    expect(paths(valid({ name: "" }))).toContain("name");
    expect(paths(valid({ language: "english" }))).toContain("language");
    expect(blockingDraftIssues(validateBuilder(valid({ name: "Bad-Name" })))).toHaveLength(1);
  });

  it("requires body, examples and sane variable placement", () => {
    expect(paths(valid({ body: "", examples: [] }))).toContain("body");
    expect(paths(valid({ examples: ["Sara", ""] }))).toContain("body.example.2");
    expect(paths(valid({ body: "{{1}} is here today", examples: ["x"] }))).toContain("body");
    expect(paths(valid({ body: "Hi there {{1}}", examples: ["x"] }))).toContain("body");
    expect(paths(valid({ body: "Hi {{1}}{{2}} there", examples: ["a", "b"] }))).toContain("body");
    expect(paths(valid({ body: "Hi {{2}} there", examples: ["a"] }))).toContain("body");
    expect(paths(valid({ body: "Hi {{name}} there", examples: [] }))).toContain("body");
    expect(
      validateBuilder(valid({ body: "x".repeat(1025), examples: ["a", "b"] })).some(
        (i) => i.level === "draft" && i.path === "body",
      ),
    ).toBe(true);
  });

  it("limits header text and media headers", () => {
    const text = valid({
      header: { format: "TEXT", text: "Hi {{1}} and {{2}}", example: "A" },
    });
    expect(paths(text)).toContain("header");
    expect(
      paths(valid({ header: { format: "TEXT", text: "Welcome back to us", example: "" } })),
    ).toEqual([]);
    const img = valid({ header: { format: "IMAGE", handle: "" }, type: "media_interactive" });
    expect(paths(img)).toContain("header.media");
    expect(
      paths(valid({ header: { format: "IMAGE", handle: "4::abc" }, type: "standard" })),
    ).toContain("header");
    expect(
      paths(valid({ header: { format: "IMAGE", handle: "4::abc" }, type: "media_interactive" })),
    ).toEqual([]);
  });

  it("limits footer", () => {
    expect(paths(valid({ footer: "x".repeat(61) }))).toContain("footer");
    expect(paths(valid({ footer: "Hi {{1}}" }))).toContain("footer");
    expect(paths(valid({ footer: "Al Das Medical" }))).toEqual([]);
  });

  it("validates buttons", () => {
    const base = { type: "media_interactive" as const };
    expect(paths(valid({ ...base, buttons: [{ type: "QUICK_REPLY", text: "Confirm" }] }))).toEqual(
      [],
    );
    expect(paths(valid({ buttons: [{ type: "QUICK_REPLY", text: "Confirm" }] }))).toContain(
      "buttons",
    ); // standard type has no buttons
    expect(
      paths(valid({ ...base, buttons: [{ type: "QUICK_REPLY", text: "x".repeat(26) }] })),
    ).toContain("buttons.0.text");
    expect(
      paths(
        valid({
          ...base,
          buttons: [{ type: "URL", text: "Open", url: "http://insecure.example", example: "" }],
        }),
      ),
    ).toContain("buttons.0.url");
    expect(
      paths(
        valid({
          ...base,
          buttons: [
            { type: "URL", text: "Open", url: "https://example.invalid/p/{{1}}", example: "" },
          ],
        }),
      ),
    ).toContain("buttons.0.example");
    expect(
      paths(
        valid({
          ...base,
          buttons: [
            {
              type: "URL",
              text: "Open",
              url: "https://example.invalid/{{1}}/x",
              example: "https://example.invalid/a/x",
            },
          ],
        }),
      ),
    ).toContain("buttons.0.url");
    expect(
      paths(
        valid({ ...base, buttons: [{ type: "PHONE_NUMBER", text: "Call", phone_number: "12" }] }),
      ),
    ).toContain("buttons.0.phone_number");
    expect(
      paths(
        valid({
          ...base,
          buttons: [{ type: "PHONE_NUMBER", text: "Call", phone_number: "+971501234567" }],
        }),
      ),
    ).toEqual([]);
    expect(paths(valid({ ...base, buttons: [{ type: "COPY_CODE", example: "" }] }))).toContain(
      "buttons.0.example",
    );
    const many = Array.from({ length: 11 }, (_v, i) => ({
      type: "QUICK_REPLY" as const,
      text: `B${i}`,
    }));
    expect(paths(valid({ ...base, buttons: many }))).toContain("buttons");
    const twoPhones = [
      { type: "PHONE_NUMBER" as const, text: "A", phone_number: "+971501234567" },
      { type: "PHONE_NUMBER" as const, text: "B", phone_number: "+971501234568" },
    ];
    expect(paths(valid({ ...base, buttons: twoPhones }))).toContain("buttons");
    const interleaved = [
      { type: "QUICK_REPLY" as const, text: "A" },
      { type: "COPY_CODE" as const, example: "CODE1" },
      { type: "QUICK_REPLY" as const, text: "B" },
    ];
    expect(paths(valid({ ...base, buttons: interleaved }))).toContain("buttons");
  });

  it("validates authentication templates", () => {
    const auth = valid({ category: "AUTHENTICATION", body: "", examples: [] });
    expect(validateBuilder(auth)).toEqual([]);
    expect(paths({ ...auth, auth: { ...auth.auth, expiryMinutes: 200 } })).toContain(
      "auth.expiryMinutes",
    );
    expect(toComponents(auth)).toEqual([
      { type: "BODY", add_security_recommendation: true },
      { type: "FOOTER", code_expiration_minutes: 10 },
      { type: "BUTTONS", buttons: [{ type: "OTP", otp_type: "COPY_CODE", text: "Copy code" }] },
    ]);
  });

  const card = (n: number) => ({
    format: "IMAGE" as const,
    handle: `4::h${n}`,
    body: `Service number ${n}`,
    examples: [],
    buttons: [{ type: "QUICK_REPLY" as const, text: "Book" }],
  });
  const carousel = (cards: BuilderState["cards"]) =>
    valid({ type: "carousel", cards, body: "Our services", examples: [] });

  it("validates carousels", () => {
    expect(validateBuilder(carousel([card(1), card(2)]))).toEqual([]);
    expect(paths(carousel([card(1)]))).toContain("cards");
    expect(paths(carousel(Array.from({ length: 11 }, (_v, i) => card(i))))).toContain("cards");
    expect(paths(carousel([card(1), { ...card(2), format: "VIDEO" }]))).toContain("cards");
    expect(
      paths(
        carousel([
          card(1),
          {
            ...card(2),
            buttons: [{ type: "URL", text: "Open", url: "https://e.invalid", example: "" }],
          },
        ]),
      ),
    ).toContain("cards");
    expect(paths(carousel([card(1), { ...card(2), handle: "" }]))).toContain("cards.1.media");
    expect(paths(carousel([card(1), { ...card(2), body: "x".repeat(161) }]))).toContain(
      "cards.1.body",
    );
    expect(paths(carousel([card(1), { ...card(2), buttons: [] }]))).toContain("cards.1.buttons");
    expect(paths({ ...carousel([card(1), card(2)]), footer: "no footers" })).toContain("footer");
  });
});

describe("components round trip", () => {
  const full = valid({
    type: "media_interactive",
    header: { format: "IMAGE", handle: "4::abc" },
    footer: "Al Das Medical",
    buttons: [
      { type: "QUICK_REPLY", text: "Confirm" },
      {
        type: "URL",
        text: "Directions",
        url: "https://example.invalid/loc/{{1}}",
        example: "https://example.invalid/loc/palm",
      },
      { type: "PHONE_NUMBER", text: "Call us", phone_number: "+97140000000" },
    ],
  });

  it("builds Meta components with examples", () => {
    const c = toComponents(full) as Array<Record<string, unknown>>;
    expect(c.map((x) => x.type)).toEqual(["HEADER", "BODY", "FOOTER", "BUTTONS"]);
    expect(c[0]).toMatchObject({ format: "IMAGE", example: { header_handle: ["4::abc"] } });
    expect(c[1]).toMatchObject({ example: { body_text: [["Sara", "Dr Example"]] } });
    const buttons = c[3].buttons as Array<Record<string, unknown>>;
    expect(buttons[1]).toMatchObject({ example: ["https://example.invalid/loc/palm"] });
    expect(buttons[2]).toMatchObject({ phone_number: "+97140000000" });
  });

  it("omits body examples when there are no variables and text-header examples without vars", () => {
    const s = valid({
      body: "No variables here at all.",
      examples: [],
      header: { format: "TEXT", text: "Hello", example: "" },
    });
    const c = toComponents(s) as Array<Record<string, unknown>>;
    expect(c[0]).toEqual({ type: "HEADER", format: "TEXT", text: "Hello" });
    expect(c[1]).toEqual({ type: "BODY", text: "No variables here at all." });
  });

  it("round-trips through fromComponents", () => {
    const { state, unsupported } = fromComponents(
      { name: full.name, language: full.language, category: full.category },
      toComponents(full),
    );
    expect(unsupported).toEqual([]);
    expect(state).toMatchObject({
      name: full.name,
      type: "media_interactive",
      body: full.body,
      examples: full.examples,
      footer: full.footer,
      header: full.header,
      buttons: full.buttons,
    });
    expect(validateBuilder(state)).toEqual([]);
  });

  it("round-trips carousels and authentication", () => {
    const cs = valid({
      type: "carousel",
      body: "Our services",
      examples: [],
      cards: [1, 2].map((n) => ({
        format: "IMAGE" as const,
        handle: `4::${n}`,
        body: `Card ${n}`,
        examples: [],
        buttons: [{ type: "QUICK_REPLY" as const, text: "Book" }],
      })),
    });
    const back = fromComponents(
      { name: cs.name, language: "en", category: "UTILITY" },
      toComponents(cs),
    );
    expect(back.state.type).toBe("carousel");
    expect(back.state.cards).toEqual(cs.cards);

    const auth = valid({ category: "AUTHENTICATION", body: "", examples: [] });
    const a = fromComponents(
      { name: auth.name, language: "en", category: "AUTHENTICATION" },
      toComponents(auth),
    );
    expect(a.state.auth).toEqual(auth.auth);
  });

  it("reports what it cannot round-trip instead of dropping it", () => {
    const r = fromComponents(
      { name: "x", language: "en", category: "UTILITY", parameter_format: "NAMED" },
      [
        { type: "HEADER", format: "LOCATION" },
        { type: "BODY", text: "Hello {{name}} thanks" },
        { type: "BUTTONS", buttons: [{ type: "FLOW", text: "Open", flow_id: "1" }] },
      ],
    );
    expect(r.unsupported).toEqual(
      expect.arrayContaining([
        "Named parameters",
        "LOCATION header",
        "Named body parameters",
        "FLOW button",
      ]),
    );
  });

  it("builds the Meta create request", () => {
    expect(toCreateRequest(valid())).toMatchObject({
      name: "visit_reminder",
      language: "en",
      category: "UTILITY",
      parameter_format: "POSITIONAL",
    });
  });
});
