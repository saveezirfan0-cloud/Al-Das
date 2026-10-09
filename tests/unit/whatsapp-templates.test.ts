import { describe, expect, it } from "vitest";

import {
  buildTemplateSend,
  isTemplateSendable,
  renderTemplatePreview,
  templateVariables,
} from "@/lib/whatsapp/templates";
import type { MetaTemplateComponent } from "@/lib/whatsapp/types";

const positional: MetaTemplateComponent[] = [
  { type: "HEADER", format: "TEXT", text: "Hi {{1}}", example: { header_text: ["Sara"] } },
  {
    type: "BODY",
    text: "Your appointment with {{1}} is on {{2}}. Reply 1 to confirm.",
    example: { body_text: [["Dr Example", "Mon 10:00"]] },
  },
  { type: "FOOTER", text: "Al Das Medical" },
  {
    type: "BUTTONS",
    buttons: [
      { type: "QUICK_REPLY", text: "Confirm" },
      {
        type: "URL",
        text: "Directions",
        url: "https://example.invalid/loc/{{1}}",
        example: ["palm"],
      },
    ],
  },
];

const media: MetaTemplateComponent[] = [
  { type: "HEADER", format: "IMAGE", example: { header_handle: ["4::aW1h"] } },
  {
    type: "BODY",
    text: "Hello {{name}}, your {{item}} is ready.",
    example: {
      body_text_named_params: [
        { param_name: "name", example: "Sara" },
        { param_name: "item", example: "report" },
      ],
    },
  },
  { type: "BUTTONS", buttons: [{ type: "COPY_CODE", example: "WELCOME10" }] },
];

describe("templateVariables", () => {
  it("lists positional variables with examples", () => {
    const vars = templateVariables(positional);
    expect(vars.map((v) => v.key)).toEqual(["header.1", "body.1", "body.2", "button.1"]);
    expect(vars[1]).toMatchObject({
      component: "body",
      index: 1,
      example: "Dr Example",
      kind: "text",
    });
    expect(vars[3]).toMatchObject({ kind: "url_suffix", example: "palm" });
  });
  it("lists named variables and media headers", () => {
    const vars = templateVariables(media);
    expect(vars.map((v) => v.key)).toEqual(["header.media", "body.name", "body.item", "button.0"]);
    expect(vars[0].kind).toBe("image");
    expect(vars[1].example).toBe("Sara");
    expect(vars[3].kind).toBe("copy_code");
  });
});

describe("renderTemplatePreview", () => {
  it("fills values and falls back to examples", () => {
    const p = renderTemplatePreview(positional, { "body.2": "Tue 09:30" });
    expect(p.headerText).toBe("Hi Sara");
    expect(p.body).toBe("Your appointment with Dr Example is on Tue 09:30. Reply 1 to confirm.");
    expect(p.footer).toBe("Al Das Medical");
    expect(p.buttons).toEqual([
      { type: "QUICK_REPLY", text: "Confirm" },
      { type: "URL", text: "Directions" },
    ]);
    expect(p.missing).toEqual(["header.1", "body.1", "button.1"]);
  });
  it("keeps placeholders when there is no example", () => {
    const p = renderTemplatePreview([{ type: "BODY", text: "Code {{1}}" }], {});
    expect(p.body).toBe("Code {{1}}");
    expect(p.headerMedia).toBeNull();
  });
});

describe("buildTemplateSend", () => {
  it("builds positional components", () => {
    const t = buildTemplateSend(
      { name: "appt", language: "en", components: positional },
      { "header.1": "Sara", "body.1": "Dr X", "body.2": "Mon", "button.1": "palm" },
    );
    expect(t).toEqual({
      name: "appt",
      language: { code: "en", policy: "deterministic" },
      components: [
        { type: "header", parameters: [{ type: "text", text: "Sara" }] },
        {
          type: "body",
          parameters: [
            { type: "text", text: "Dr X" },
            { type: "text", text: "Mon" },
          ],
        },
        { type: "button", sub_type: "url", index: 1, parameters: [{ type: "text", text: "palm" }] },
      ],
    });
  });
  it("builds named params, media header and copy code", () => {
    const t = buildTemplateSend(
      { name: "ready", language: "en", components: media, parameterFormat: "named" },
      {
        "header.media": "MEDIA123",
        "body.name": "Sara",
        "body.item": "report",
        "button.0": "WELCOME10",
      },
    );
    expect(t.components?.[0]).toEqual({
      type: "header",
      parameters: [{ type: "image", image: { id: "MEDIA123" } }],
    });
    expect(t.components?.[1]).toEqual({
      type: "body",
      parameters: [
        { type: "text", text: "Sara", parameter_name: "name" },
        { type: "text", text: "report", parameter_name: "item" },
      ],
    });
    expect(t.components?.[2]).toEqual({
      type: "button",
      sub_type: "copy_code",
      index: 0,
      parameters: [{ type: "coupon_code", coupon_code: "WELCOME10" }],
    });
  });
  it("uses a link when the media value is a URL and omits components when none", () => {
    const t = buildTemplateSend(
      {
        name: "x",
        language: "ar",
        components: [
          { type: "HEADER", format: "DOCUMENT" },
          { type: "BODY", text: "hi" },
        ],
      },
      { "header.media": "https://example.invalid/a.pdf" },
    );
    expect(t.components?.[0]).toEqual({
      type: "header",
      parameters: [{ type: "document", document: { link: "https://example.invalid/a.pdf" } }],
    });
    expect(
      buildTemplateSend(
        { name: "y", language: "en", components: [{ type: "BODY", text: "plain" }] },
        {},
      ),
    ).toEqual({ name: "y", language: { code: "en", policy: "deterministic" } });
  });
  it("throws on missing values", () => {
    expect(() =>
      buildTemplateSend({ name: "appt", language: "en", components: positional }, {}),
    ).toThrow(/Missing template values: header.1/);
  });
  it("only APPROVED templates are sendable", () => {
    expect(isTemplateSendable("APPROVED")).toBe(true);
    expect(isTemplateSendable("PENDING")).toBe(false);
    expect(isTemplateSendable(null)).toBe(false);
  });
});
