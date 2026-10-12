import { describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

import { parseSource, resolveVariables, unmappedVariables } from "@/lib/campaigns/variables";
import { headerAssetId, headerMediaKind, referencedAssetIds } from "@/lib/media/header";
import { checkMediaReferences, MediaUseError, resolveHeaderMedia } from "@/lib/media/resolve";
import { buildTemplateSend } from "@/lib/whatsapp/templates";
import type { AdminClient } from "@/lib/supabase/admin";
import type { MetaTemplateComponent } from "@/lib/whatsapp/types";

const ORG = "11111111-1111-4111-8111-111111111111";
const A = "33333333-3333-4333-8333-333333333333";
const imageHeader: MetaTemplateComponent[] = [
  { type: "HEADER", format: "IMAGE", example: { header_handle: ["4::h"] } },
  { type: "BODY", text: "Hello {{1}}", example: { body_text: [["Sara"]] } },
] as MetaTemplateComponent[];
const textOnly: MetaTemplateComponent[] = [
  { type: "BODY", text: "Hello" },
] as MetaTemplateComponent[];
const pdfHeader: MetaTemplateComponent[] = [
  { type: "HEADER", format: "DOCUMENT" },
  { type: "BODY", text: "Report" },
] as MetaTemplateComponent[];

function admin(opts: {
  asset?: Record<string, unknown> | null;
  signed?: string | null;
}): AdminClient {
  const asset = opts.asset === undefined ? null : opts.asset;
  const q: Record<string, unknown> = {};
  for (const m of ["select", "eq"]) q[m] = () => q;
  q.maybeSingle = async () => ({ data: asset, error: null });
  return {
    from: () => q,
    storage: {
      from: () => ({
        createSignedUrl: async () =>
          opts.signed === null
            ? { data: null, error: { message: "x" } }
            : {
                data: { signedUrl: opts.signed ?? "https://storage.example.test/signed?token=abc" },
                error: null,
              },
      }),
    },
  } as unknown as AdminClient;
}
const goodAsset = (over: Record<string, unknown> = {}) => ({
  id: A,
  org_id: ORG,
  kind: "image",
  mime_type: "image/jpeg",
  size_bytes: 1000,
  storage_path: `${ORG}/${A}/original.jpg`,
  status: "ready",
  scan_status: "unscanned",
  ...over,
});

describe("header media references", () => {
  it("finds the header kind and the referenced asset", () => {
    expect(headerMediaKind(imageHeader)).toBe("image");
    expect(headerMediaKind(pdfHeader)).toBe("document");
    expect(headerMediaKind(textOnly)).toBeNull();
    expect(headerAssetId({ "header.media": `media:${A}` })).toBe(A);
    expect(
      headerAssetId(
        { "header.media": "text:https://x.test/a.png" },
        { "header.media": `media:${A}` },
      ),
    ).toBe(A);
    expect(headerAssetId({ "header.media": "https://x.test/a.png" })).toBeNull();
    expect(headerAssetId(null, undefined)).toBeNull();
    expect(
      referencedAssetIds({ "header.media": `media:${A}`, "body.1": "contact.first_name" }),
    ).toEqual([A]);
  });

  it("campaign variables accept media:<id> and pass it through unchanged for the outbound job", () => {
    expect(parseSource(`media:${A}`)).toEqual({ kind: "media", assetId: A });
    expect(parseSource("media:junk")).toBeNull();
    const r = resolveVariables({
      components: imageHeader,
      map: { "header.media": `media:${A}`, "body.1": "contact.first_name" },
      contact: { first_name: "Sara" },
    });
    expect(r.missing).toEqual([]);
    expect(r.values["header.media"]).toBe(`media:${A}`);
    expect(
      unmappedVariables(
        imageHeader,
        { "body.1": "contact.first_name" },
        { "header.media": `media:${A}` },
      ),
    ).toEqual([]);
  });

  it("falls back to the template's own library file when the campaign maps nothing", () => {
    const r = resolveVariables({
      components: imageHeader,
      map: { "body.1": "contact.first_name" },
      templateMap: { "header.media": `media:${A}` },
      contact: { first_name: "Sara" },
    });
    expect(r.values["header.media"]).toBe(`media:${A}`);
  });
});

describe("resolveHeaderMedia (outbound job, just before sending)", () => {
  it("swaps the reference for a signed link that buildTemplateSend sends as a link", async () => {
    const values = await resolveHeaderMedia(admin({ asset: goodAsset() }), ORG, imageHeader, {
      "header.media": `media:${A}`,
      "body.1": "Sara",
    });
    expect(values["header.media"]).toBe("https://storage.example.test/signed?token=abc");
    expect(values["body.1"]).toBe("Sara");
    const tpl = buildTemplateSend({ name: "t", language: "en", components: imageHeader }, values);
    expect(JSON.stringify(tpl)).toContain('"link":"https://storage.example.test/signed?token=abc"');
  });

  it("leaves other values untouched (a plain link, or a text template)", async () => {
    const plain = { "header.media": "https://cdn.example.test/a.png" };
    expect(await resolveHeaderMedia(admin({}), ORG, imageHeader, plain)).toBe(plain);
    const lib = { "header.media": `media:${A}` };
    expect(await resolveHeaderMedia(admin({}), ORG, textOnly, lib)).toBe(lib);
  });

  it.each([
    ["a file that no longer exists", { asset: null }],
    ["an upload that never finished", { asset: goodAsset({ status: "pending" }) }],
    ["a file the malware scan blocked", { asset: goodAsset({ scan_status: "infected" }) }],
    [
      "a file stored outside its own folder",
      { asset: goodAsset({ storage_path: `${A}/${A}/original.jpg` }) },
    ],
    [
      "a file of the wrong kind",
      { asset: goodAsset({ kind: "document", mime_type: "application/pdf" }) },
    ],
    ["an image Meta would refuse as a header", { asset: goodAsset({ mime_type: "image/webp" }) }],
    ["a file Meta would refuse as too big", { asset: goodAsset({ size_bytes: 6 * 1024 * 1024 }) }],
    ["a file storage cannot sign", { asset: goodAsset(), signed: null }],
  ])(
    "refuses %s with a MediaUseError (the job marks the message failed, not retried)",
    async (_n, opts) => {
      await expect(
        resolveHeaderMedia(admin(opts as never), ORG, imageHeader, {
          "header.media": `media:${A}`,
        }),
      ).rejects.toBeInstanceOf(MediaUseError);
    },
  );

  it("serves an unscanned file (flagged in the UI) but not an infected one", async () => {
    await expect(
      resolveHeaderMedia(
        admin({ asset: goodAsset({ scan_status: "unscanned" }) }),
        ORG,
        imageHeader,
        { "header.media": `media:${A}` },
      ),
    ).resolves.toBeTruthy();
  });

  it("accepts a PDF for a document header", async () => {
    const asset = goodAsset({
      kind: "document",
      mime_type: "application/pdf",
      storage_path: `${ORG}/${A}/original.pdf`,
    });
    const v = await resolveHeaderMedia(admin({ asset }), ORG, pdfHeader, {
      "header.media": `media:${A}`,
    });
    expect(v["header.media"]).toMatch(/^https:/);
  });
});

describe("checkMediaReferences (before a campaign starts or a template is mapped)", () => {
  it("passes when nothing refers to the library", async () => {
    expect(
      await checkMediaReferences(admin({}), ORG, imageHeader, {
        "header.media": "text:https://x.test/a.png",
      }),
    ).toBeNull();
  });
  it("passes for a usable file and explains a bad one in plain words", async () => {
    expect(
      await checkMediaReferences(admin({ asset: goodAsset() }), ORG, imageHeader, {
        "header.media": `media:${A}`,
      }),
    ).toBeNull();
    const msg = await checkMediaReferences(admin({ asset: null }), ORG, imageHeader, {
      "header.media": `media:${A}`,
    });
    expect(msg).toMatch(/no longer exists/);
    const wrong = await checkMediaReferences(
      admin({
        asset: goodAsset({
          kind: "document",
          mime_type: "application/pdf",
          storage_path: `${ORG}/${A}/original.pdf`,
        }),
      }),
      ORG,
      imageHeader,
      { "header.media": `media:${A}` },
    );
    expect(wrong).toMatch(/image/);
  });
});
