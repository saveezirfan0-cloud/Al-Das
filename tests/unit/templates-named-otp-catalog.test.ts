/**
 * Named variables, authentication (one-time code) and catalogue templates: builder rules, Meta payloads, the
 * stored shape, sync parsing and the send-time components. Synthetic data only; nothing here reaches Meta.
 */
import { describe, expect, it } from "vitest";

import { resolveVariables, unmappedVariables } from "@/lib/campaigns/variables";
import {
  AUTH_EXAMPLE_CODE,
  authDisplayComponents,
  authFromComponents,
  buildComponents,
  convertParameterFormat,
  defaultAuth,
  draftFromComponents,
  emptyDraft,
  metaParameterFormat,
  pruneDraft,
  storedComponents,
  storedParameterFormat,
  storedType,
  validateDraft,
  type TemplateDraft,
} from "@/lib/templates/builder";
import {
  checkNamedVariables,
  insertNamedVariable,
  namesToNumbers,
  numbersToNames,
  sanitizeParamName,
  suggestParamName,
  variableNames,
} from "@/lib/templates/named-params";
import { templateRetryDecision } from "@/lib/templates/delivery";
import {
  authTemplateSendAllowed,
  buildTemplateSend,
  renderTemplatePreview,
  templateVariables,
} from "@/lib/whatsapp/templates";
import type { MetaTemplateComponent } from "@/lib/whatsapp/types";

const errs = (d: TemplateDraft) => validateDraft(d).errors.map((e) => e.path);

// ---------------------------------------------------------------------------
// Pure name rules
// ---------------------------------------------------------------------------

describe("named-params", () => {
  const check = (text: string, examples: Record<string, string> = {}) =>
    checkNamedVariables(text, "body", { examples, examplePath: (n) => `namedExamples.${n}` });

  it("accepts lower-case snake names with examples", () => {
    expect(
      check("Hi {{first_name}}, see you {{visit_day}}.", { first_name: "Sara", visit_day: "Mon" }),
    ).toEqual([]);
  });
  it("rejects numbers, bad names, repeats and missing examples", () => {
    expect(
      check("Hi {{1}} there", {})
        .map((i) => i.message)
        .join(),
    ).toMatch(/not numbers/);
    expect(
      check("Hi {{FirstName}} there")
        .map((i) => i.message)
        .join(),
    ).toMatch(/not a valid name/);
    expect(
      check("Hi {{2nd}} there")
        .map((i) => i.message)
        .join(),
    ).toMatch(/not a valid name/);
    expect(check("Hi {{first-name}} there").length).toBe(1);
    expect(
      check("Hi {{a}} and {{a}} again", { a: "x" })
        .map((i) => i.message)
        .join(),
    ).toMatch(/more than once/);
    expect(check("Hi {{first_name}} there")).toEqual([
      { path: "namedExamples.first_name", message: "Give an example for {{first_name}}." },
    ]);
    expect(
      check(`Hi {{${"a".repeat(41)}}} there`, {})
        .map((i) => i.message)
        .join(),
    ).toMatch(/limited to 40/);
  });
  it("limits a header to one name", () => {
    const issues = checkNamedVariables("{{a}} {{b}}", "header.text", {
      headerExample: "x",
      examplePath: () => "header.example",
      maxVars: 1,
    });
    expect(issues.map((i) => i.message)).toContain("The header can contain one variable.");
  });
  it("lists, suggests, inserts and converts names", () => {
    expect(variableNames("{{b}} {{a}} {{b}} {{1}} {{Bad}}")).toEqual(["b", "a"]);
    expect(suggestParamName("contact.first_name", [])).toBe("first_name");
    expect(suggestParamName("contact.first_name", ["first_name"])).toBe("first_name_2");
    expect(suggestParamName("appointment.date", [])).toBe("appointment_date");
    expect(suggestParamName("custom.policy_no", [])).toBe("policy_no");
    expect(suggestParamName("text:Hello", [])).toBe("value");
    expect(suggestParamName(undefined, ["value"])).toBe("value_2");
    expect(sanitizeParamName("9 Lives!")).toBe("v_9_lives");
    expect(insertNamedVariable("Hi @ there", 3, "first_name", 1)).toEqual({
      text: "Hi {{first_name}} there",
      caret: 17,
    });
    expect(numbersToNames("A {{1}} B {{2}} C {{1}} D {{3}}", ["x", "y"])).toBe(
      "A {{x}} B {{y}} C {{x}} D {{3}}",
    );
    expect(namesToNumbers("A {{y}} B {{x}} C {{y}}")).toEqual({
      text: "A {{1}} B {{2}} C {{1}}",
      names: ["y", "x"],
    });
  });
});

// ---------------------------------------------------------------------------
// Positional templates behave exactly as before
// ---------------------------------------------------------------------------

describe("positional templates are unchanged", () => {
  const positional = emptyDraft({
    name: "visit_reminder",
    type: "media_interactive",
    header: { kind: "text", text: "Hi {{1}}", example: "Sara" },
    body: "Your visit with {{1}} is on {{2}}. Reply to confirm.",
    bodyExamples: ["Dr Example", "Mon 10:00"],
    footer: "Thanks",
    buttons: [{ type: "QUICK_REPLY", text: "Confirm" }],
    variableMap: { "body.1": "appointment.specialist", "body.9": "contact.first_name" },
  });

  it("builds the same payload and stores positional", () => {
    expect(buildComponents(positional)).toEqual([
      { type: "HEADER", format: "TEXT", text: "Hi {{1}}", example: { header_text: ["Sara"] } },
      {
        type: "BODY",
        text: "Your visit with {{1}} is on {{2}}. Reply to confirm.",
        example: { body_text: [["Dr Example", "Mon 10:00"]] },
      },
      { type: "FOOTER", text: "Thanks" },
      { type: "BUTTONS", buttons: [{ type: "QUICK_REPLY", text: "Confirm" }] },
    ]);
    expect(storedComponents(positional)).toEqual(buildComponents(positional));
    expect(metaParameterFormat(positional)).toBe("POSITIONAL");
    expect(storedParameterFormat(positional)).toBe("positional");
    expect(storedType(positional)).toBe("media_interactive");
    expect(validateDraft(positional).errors).toEqual([]);
  });
  it("prunes like before and round-trips without a parameter format", () => {
    const pruned = pruneDraft(positional);
    expect(pruned.variableMap).toEqual({ "body.1": "appointment.specialist" });
    expect("namedExamples" in pruned).toBe(false);
    const back = draftFromComponents(
      { name: positional.name, language: "en", category: "UTILITY", parameterFormat: "positional" },
      buildComponents(positional),
    );
    expect(back.parameterFormat).toBeUndefined();
    expect(back.bodyExamples).toEqual(["Dr Example", "Mon 10:00"]);
    expect(back.header).toEqual({ kind: "text", text: "Hi {{1}}", example: "Sara" });
  });
  it("sends positional params without parameter names", () => {
    const t = buildTemplateSend(
      { name: "visit_reminder", language: "en", components: buildComponents(positional) },
      { "header.1": "Sara", "body.1": "Dr X", "body.2": "Tue" },
    );
    expect(t.components).toEqual([
      { type: "header", parameters: [{ type: "text", text: "Sara" }] },
      {
        type: "body",
        parameters: [
          { type: "text", text: "Dr X" },
          { type: "text", text: "Tue" },
        ],
      },
    ]);
  });
});

// ---------------------------------------------------------------------------
// Named templates
// ---------------------------------------------------------------------------

describe("named templates", () => {
  const named = emptyDraft({
    name: "visit_named",
    parameterFormat: "named",
    header: { kind: "text", text: "Hello {{first_name}}", example: "Sara" },
    type: "media_interactive",
    body: "Your visit with {{doctor}} is on {{visit_day}}. Reply to confirm.",
    namedExamples: { doctor: "Dr Example", visit_day: "Monday" },
    variableMap: {
      "body.doctor": "appointment.specialist",
      "header.first_name": "contact.first_name",
    },
  });

  it("validates and builds Meta's named payload", () => {
    expect(validateDraft(named).errors).toEqual([]);
    expect(metaParameterFormat(named)).toBe("NAMED");
    expect(storedParameterFormat(named)).toBe("named");
    expect(buildComponents(named)).toEqual([
      {
        type: "HEADER",
        format: "TEXT",
        text: "Hello {{first_name}}",
        example: { header_text_named_params: [{ param_name: "first_name", example: "Sara" }] },
      },
      {
        type: "BODY",
        text: "Your visit with {{doctor}} is on {{visit_day}}. Reply to confirm.",
        example: {
          body_text_named_params: [
            { param_name: "doctor", example: "Dr Example" },
            { param_name: "visit_day", example: "Monday" },
          ],
        },
      },
    ]);
  });
  it("reports bad names, numbers, repeats, missing examples and placement", () => {
    expect(errs({ ...named, body: "Visit with {{Doctor}} soon, see you then." })).toContain("body");
    expect(errs({ ...named, body: "Visit with {{1}} soon, see you then." })).toContain("body");
    expect(errs({ ...named, namedExamples: { doctor: "Dr" } })).toContain(
      "namedExamples.visit_day",
    );
    expect(errs({ ...named, body: "{{doctor}} is booked for tomorrow at noon" })).toContain("body");
    expect(errs({ ...named, body: "You are booked with {{doctor}}" })).toContain("body");
    expect(errs({ ...named, footer: "Bye {{doctor}}" })).toContain("footer");
    expect(
      errs({ ...named, header: { kind: "text", text: "Hi {{a}} {{b}}", example: "x" } }),
    ).toContain("header.text");
    expect(errs({ ...named, header: { kind: "text", text: "Hi {{a}}" } })).toContain(
      "header.example",
    );
    expect(errs({ ...named, type: "carousel", header: { kind: "none" } })).toContain(
      "parameterFormat",
    );
  });
  it("round-trips through the stored and synced shape", () => {
    const comps = buildComponents(named);
    for (const parameterFormat of ["named", undefined] as const) {
      const back = draftFromComponents(
        {
          name: named.name,
          language: "en",
          category: "UTILITY",
          variableMap: named.variableMap,
          parameterFormat,
        },
        comps,
      );
      expect(back.parameterFormat).toBe("named");
      expect(back.namedExamples).toEqual({ doctor: "Dr Example", visit_day: "Monday" });
      expect(back.header).toEqual({ kind: "text", text: "Hello {{first_name}}", example: "Sara" });
      expect(buildComponents(back)).toEqual(comps);
    }
  });
  it("maps variables by name and sends parameter_name", () => {
    const comps = buildComponents(named);
    expect(templateVariables(comps).map((v) => v.key)).toEqual([
      "header.first_name",
      "body.doctor",
      "body.visit_day",
    ]);
    const { values, missing } = resolveVariables({
      components: comps,
      map: { "body.visit_day": "text:Tuesday" },
      templateMap: named.variableMap,
      contact: { first_name: "Layla" },
    });
    expect(missing).toEqual(["body.doctor"]);
    expect(values).toEqual({ "header.first_name": "Layla", "body.visit_day": "Tuesday" });
    const t = buildTemplateSend(
      { name: named.name, language: "en", components: comps, parameterFormat: "named" },
      { ...values, "body.doctor": "Dr X" },
    );
    expect(t.components).toEqual([
      {
        type: "header",
        parameters: [{ type: "text", text: "Layla", parameter_name: "first_name" }],
      },
      {
        type: "body",
        parameters: [
          { type: "text", text: "Dr X", parameter_name: "doctor" },
          { type: "text", text: "Tuesday", parameter_name: "visit_day" },
        ],
      },
    ]);
  });
  it("converts between numbered and named, keeping examples and mappings", () => {
    const pos = emptyDraft({
      name: "conv",
      type: "media_interactive",
      header: { kind: "text", text: "Hi {{1}}", example: "Sara" },
      body: "Dear {{1}}, your visit is on {{2}} with {{3}} today.",
      bodyExamples: ["Sara", "Monday", "Dr X"],
      variableMap: {
        "body.1": "contact.first_name",
        "body.2": "appointment.date",
        "header.1": "contact.first_name",
        "header.media": "media:x",
      },
    });
    const n = convertParameterFormat(pos, "named");
    expect(n.body).toBe(
      "Dear {{first_name}}, your visit is on {{appointment_date}} with {{value}} today.",
    );
    expect(n.namedExamples).toEqual({
      first_name: "Sara",
      appointment_date: "Monday",
      value: "Dr X",
    });
    expect(n.header).toEqual({ kind: "text", text: "Hi {{first_name}}", example: "Sara" });
    expect(n.variableMap).toEqual({
      "body.first_name": "contact.first_name",
      "body.appointment_date": "appointment.date",
      "header.first_name": "contact.first_name",
      "header.media": "media:x",
    });
    expect(validateDraft(n).errors).toEqual([]);
    const back = convertParameterFormat(n, "positional");
    expect(back.body).toBe(pos.body);
    expect(back.bodyExamples).toEqual(pos.bodyExamples);
    expect(back.variableMap).toEqual(pos.variableMap);
    expect(back.header).toEqual(pos.header);
    expect(convertParameterFormat(pos, "positional")).toBe(pos);
  });
  it("prunes examples and mappings of removed names", () => {
    const p = pruneDraft({
      ...named,
      body: "Your visit with {{doctor}} is booked, see you soon.",
    });
    expect(p.namedExamples).toEqual({ doctor: "Dr Example" });
    expect(p.variableMap).toEqual({ "body.doctor": "appointment.specialist" });
  });
});

// ---------------------------------------------------------------------------
// Authentication (one-time code)
// ---------------------------------------------------------------------------

describe("authentication templates", () => {
  const authDraft = emptyDraft({
    name: "login_code",
    language: "en_US",
    category: "AUTHENTICATION",
    auth: { securityRecommendation: true, codeExpiryMinutes: 10, buttonText: "Copy code" },
    body: "ignored text",
  });

  it("validates only the options", () => {
    expect(validateDraft(authDraft).errors).toEqual([]);
    const withAuth = (a: Partial<TemplateDraft["auth"] & object>) =>
      ({ ...authDraft, auth: { ...defaultAuth(), ...a } }) as TemplateDraft;
    expect(errs(withAuth({ codeExpiryMinutes: 0 }))).toContain("auth.codeExpiryMinutes");
    expect(errs(withAuth({ codeExpiryMinutes: 91 }))).toContain("auth.codeExpiryMinutes");
    expect(errs(withAuth({ codeExpiryMinutes: 1.5 }))).toContain("auth.codeExpiryMinutes");
    expect(errs(withAuth({ codeExpiryMinutes: null }))).toEqual([]);
    expect(errs(withAuth({ codeExpiryMinutes: 90 }))).toEqual([]);
    expect(errs(withAuth({ buttonText: " " }))).toContain("auth.buttonText");
    expect(errs(withAuth({ buttonText: "x".repeat(26) }))).toContain("auth.buttonText");
    // Named variables never apply to an authentication template.
    expect(metaParameterFormat({ ...authDraft, parameterFormat: "named" })).toBeUndefined();
    expect(storedParameterFormat({ ...authDraft, parameterFormat: "named" })).toBe("positional");
  });
  it("sends Meta the create shape: settings only, no text", () => {
    expect(buildComponents(authDraft)).toEqual([
      { type: "BODY", add_security_recommendation: true },
      { type: "FOOTER", code_expiration_minutes: 10 },
      { type: "BUTTONS", buttons: [{ type: "OTP", otp_type: "COPY_CODE", text: "Copy code" }] },
    ]);
    expect(
      buildComponents({
        ...authDraft,
        auth: { ...defaultAuth(), codeExpiryMinutes: null, securityRecommendation: false },
      }),
    ).toEqual([
      { type: "BODY", add_security_recommendation: false },
      { type: "BUTTONS", buttons: [{ type: "OTP", otp_type: "COPY_CODE", text: "Copy code" }] },
    ]);
    expect(storedType(authDraft)).toBe("media_interactive");
  });
  it("stores a readable shape whose only variable is the code", () => {
    const stored = storedComponents(authDraft);
    expect(templateVariables(stored).map((v) => [v.key, v.example])).toEqual([
      ["body.1", AUTH_EXAMPLE_CODE],
    ]);
    const p = renderTemplatePreview(stored, { "body.1": "135790" });
    expect(p.body).toContain("135790");
    expect(p.footer).toMatch(/10 minutes/);
    expect(p.buttons).toEqual([{ type: "OTP", text: "Copy code" }]);
    expect(p.missing).toEqual([]);
  });
  it("puts the code in the body and the copy-code button at send time", () => {
    const expected = [
      { type: "body", parameters: [{ type: "text", text: "135790" }] },
      { type: "button", sub_type: "url", index: 0, parameters: [{ type: "text", text: "135790" }] },
    ];
    const t = buildTemplateSend(
      { name: "login_code", language: "en_US", components: storedComponents(authDraft) },
      { "body.1": "135790" },
    );
    expect(t.components).toEqual(expected);
    // The shape a sync returns (Meta lists the button as a URL to whatsapp.com/otp).
    const synced: MetaTemplateComponent[] = [
      {
        type: "BODY",
        text: "*{{1}}* is the code. Keep it private.",
        add_security_recommendation: true,
        example: { body_text: [["123456"]] },
      },
      { type: "FOOTER", text: "Valid for 5 minutes.", code_expiration_minutes: 5 },
      {
        type: "BUTTONS",
        buttons: [
          {
            type: "URL",
            text: "Copy code",
            url: "https://www.whatsapp.com/otp/code/?otp_type=COPY_CODE&code_expiration_minutes=5&code=otp{{1}}",
            example: [
              "https://www.whatsapp.com/otp/code/?otp_type=COPY_CODE&code_expiration_minutes=5&code=otp123456",
            ],
          },
        ],
      },
    ];
    expect(templateVariables(synced).map((v) => v.key)).toEqual(["body.1"]);
    expect(
      buildTemplateSend(
        { name: "login_code", language: "en_US", components: synced },
        { "body.1": "135790" },
      ).components,
    ).toEqual(expected);
    expect(() =>
      buildTemplateSend({ name: "login_code", language: "en_US", components: synced }, {}),
    ).toThrow(/Missing template values/);
  });
  it("reads the options back from stored, created and synced shapes", () => {
    expect(authFromComponents(authDisplayComponents(authDraft.auth!))).toEqual(authDraft.auth);
    expect(authFromComponents(buildComponents(authDraft))).toEqual(authDraft.auth);
    expect(
      authFromComponents([
        { type: "BODY", text: "{{1}} code" },
        { type: "FOOTER", text: "Expires in 15 minutes." },
        {
          type: "BUTTONS",
          buttons: [
            { type: "URL", text: "Copy", url: "https://www.whatsapp.com/otp/code/?code=otp{{1}}" },
          ],
        },
      ]),
    ).toEqual({ securityRecommendation: true, codeExpiryMinutes: 15, buttonText: "Copy" });
    // Only an explicit false turns the security note off.
    expect(
      authFromComponents([{ type: "BODY", add_security_recommendation: false } as never])
        .securityRecommendation,
    ).toBe(false);
    const d = draftFromComponents(
      { name: "login_code", language: "en_US", category: "AUTHENTICATION" },
      storedComponents(authDraft),
    );
    expect(d.category).toBe("AUTHENTICATION");
    expect(d.auth).toEqual(authDraft.auth);
    expect(validateDraft(d).errors).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// Catalogue
// ---------------------------------------------------------------------------

describe("catalogue templates", () => {
  const cat = emptyDraft({
    name: "shop_skincare",
    category: "MARKETING",
    type: "media_interactive",
    body: "Browse our skincare range and order on WhatsApp today.",
    footer: "Reply STOP to unsubscribe",
    buttons: [{ type: "CATALOG", text: "View catalog" }],
  });

  it("validates: marketing only, one button, no header", () => {
    expect(validateDraft(cat).errors).toEqual([]);
    expect(errs({ ...cat, category: "UTILITY" })).toContain("buttons");
    expect(
      errs({ ...cat, buttons: [...cat.buttons, { type: "QUICK_REPLY", text: "Hi" }] }),
    ).toContain("buttons");
    expect(errs({ ...cat, header: { kind: "text", text: "Shop" } })).toContain("header");
    expect(errs({ ...cat, buttons: [{ type: "CATALOG", text: "" }] })).toContain("buttons.0.text");
    const card = {
      format: "IMAGE" as const,
      handle: "4::h",
      body: "Card",
      buttons: [{ type: "CATALOG" as const, text: "View" }],
    };
    expect(errs({ ...cat, type: "carousel", buttons: [], cards: [card, card] })).toContain(
      "cards.0.buttons",
    );
  });
  it("builds, previews and parses the catalogue button", () => {
    const comps = buildComponents(cat);
    expect(comps[comps.length - 1]).toEqual({
      type: "BUTTONS",
      buttons: [{ type: "CATALOG", text: "View catalog" }],
    });
    const p = renderTemplatePreview(comps, {});
    expect(p.buttons).toEqual([{ type: "CATALOG", text: "View catalog" }]);
    expect(p.missing).toEqual([]);
    const back = draftFromComponents(
      { name: cat.name, language: "en", category: "MARKETING" },
      comps,
    );
    expect(back.buttons).toEqual(cat.buttons);
    expect(back.type).toBe("media_interactive");
  });
  it("sends the thumbnail item only when one is given", () => {
    const comps = buildComponents(cat);
    const vars = templateVariables(comps);
    expect(vars).toEqual([
      expect.objectContaining({ key: "button.0", kind: "catalog_thumbnail", optional: true }),
    ]);
    expect(unmappedVariables(comps, {})).toEqual([]);
    expect(resolveVariables({ components: comps, map: {}, contact: {} }).missing).toEqual([]);
    expect(buildTemplateSend({ name: cat.name, language: "en", components: comps }, {})).toEqual({
      name: cat.name,
      language: { code: "en", policy: "deterministic" },
      components: [
        {
          type: "button",
          sub_type: "CATALOG",
          index: 0,
          parameters: [{ type: "action", action: {} }],
        },
      ],
    });
    expect(
      buildTemplateSend(
        { name: cat.name, language: "en", components: comps },
        { "button.0": "SKU-TEST-1" },
      ).components,
    ).toEqual([
      {
        type: "button",
        sub_type: "CATALOG",
        index: 0,
        parameters: [{ type: "action", action: { thumbnail_product_retailer_id: "SKU-TEST-1" } }],
      },
    ]);
  });
});

describe("one-time code templates are never sent by automations", () => {
  it("allows an Authentication template only on a spec marked otp", () => {
    expect(authTemplateSendAllowed("AUTHENTICATION", undefined)).toBe(false);
    expect(authTemplateSendAllowed("authentication", undefined)).toBe(false);
    expect(authTemplateSendAllowed("AUTHENTICATION", true)).toBe(true);
    expect(authTemplateSendAllowed("UTILITY", undefined)).toBe(true);
    expect(authTemplateSendAllowed("MARKETING", undefined)).toBe(true);
    expect(authTemplateSendAllowed(null, undefined)).toBe(true);
  });
  it("never retries an Authentication template", () => {
    const base = {
      retryOnFail: true,
      isTemplate: true,
      campaignRecipientId: null,
      errorCode: 131026,
      previousRetries: 0,
      ttlSeconds: null,
      originAt: new Date("2026-01-01T10:00:00Z"),
      now: new Date("2026-01-01T10:00:00Z"),
    };
    expect(templateRetryDecision({ ...base, category: "AUTHENTICATION" })).toEqual({
      retry: false,
      reason: "authentication",
    });
    expect(templateRetryDecision({ ...base, category: "UTILITY" }).retry).toBe(
      templateRetryDecision(base).retry,
    );
  });
});
