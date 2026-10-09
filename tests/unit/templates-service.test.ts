import { beforeEach, describe, expect, it, vi } from "vitest";

import { emptyDraft, type TemplateDraft } from "@/lib/whatsapp/template-draft";
import { WhatsAppApiError } from "@/lib/whatsapp/errors";
import {
  attachCardSample,
  attachHeaderSample,
  ownSamplePath,
  deleteTemplate,
  duplicateTemplate,
  installGallery,
  markReviewed,
  saveDraft,
  setArchived,
  setVariableMap,
  submitTemplate,
  type Ctx,
} from "@/lib/templates/service";

import { fakeAdmin, fakeDb, type FakeDb } from "./helpers/fake-admin";

const ORG = "00000000-0000-4000-8000-0000000000a1";
const OTHER_ORG = "00000000-0000-4000-8000-0000000000b2";
const USER = "00000000-0000-4000-8000-0000000000c3";
const CH = "00000000-0000-4000-8000-0000000000d4";
const CH_OTHER = "00000000-0000-4000-8000-0000000000e5";

let db: FakeDb;
let meta: ReturnType<typeof fakeMeta>;

function fakeMeta() {
  return {
    createTemplate: vi.fn(async () => ({ id: "META1", status: "PENDING", category: "UTILITY" })),
    updateTemplate: vi.fn(async () => ({ success: true })),
    getTemplate: vi.fn(async () => ({
      id: "META1",
      status: "PENDING",
      category: "UTILITY",
      name: "x",
      language: "en",
      components: [],
    })),
    deleteTemplate: vi.fn(async () => ({ success: true })),
    uploadTemplateSample: vi.fn(async () => ({ handle: "4::fresh" })),
  };
}

function ctx(over: Partial<Ctx> = {}): Ctx {
  return {
    admin: fakeAdmin(db),
    orgId: ORG,
    userId: USER,
    appId: "APP1",
    makeClient: async () => meta as never,
    now: () => Date.parse("2026-11-02T10:00:00Z"),
    ...over,
  };
}

const draft = (over: Partial<TemplateDraft> = {}): TemplateDraft =>
  emptyDraft({
    name: "appointment_reminder",
    language: "en",
    body: "Hello {{1}}, your appointment is on {{2}}. Please let us know if it still suits you.",
    bodyExamples: ["Sara", "Monday 10 November"],
    footer: "Al Das Medical",
    buttons: [{ type: "QUICK_REPLY", text: "Confirm" }],
    variableMap: { "body.1": "contact.first_name", "body.2": "appointment.datetime" },
    ...over,
  });

const templates = () => db.tables.wa_templates ?? [];
const audited = (action: string) => db.audit.filter((a) => a.action === action).length;

beforeEach(() => {
  meta = fakeMeta();
  db = fakeDb(
    {
      channels: [
        {
          id: CH,
          org_id: ORG,
          name: "Reception",
          phone_number_id: "111",
          waba_id: "W1",
          status: "active",
        },
        {
          id: CH_OTHER,
          org_id: OTHER_ORG,
          name: "Other org",
          phone_number_id: "222",
          waba_id: "W2",
          status: "active",
        },
      ],
      orgs: [{ id: ORG, settings: {} }],
      wa_templates: [],
      messages: [],
    },
    { wa_templates: [["waba_id", "name", "language"]] },
  );
});

async function createDraft(over: Partial<TemplateDraft> = {}) {
  const r = await saveDraft(ctx(), { id: null, channelId: CH, draft: draft(over) });
  if (!r.ok) throw new Error(r.error);
  return r.id;
}

describe("saveDraft", () => {
  it("creates a DRAFT with Meta components, a pruned variable map and an audit row", async () => {
    const id = await createDraft({
      variableMap: { "body.1": "contact.first_name", "body.9": "contact.name" },
    });
    const row = templates()[0];
    expect(row).toMatchObject({
      id,
      status: "DRAFT",
      source: "local",
      org_id: ORG,
      waba_id: "W1",
      channel_id: CH,
      type: "media_interactive",
      parameter_format: "positional",
    });
    expect(row.variable_map).toEqual({ "body.1": "contact.first_name" });
    expect((row.components as Array<{ type: string }>).map((c) => c.type)).toEqual([
      "BODY",
      "FOOTER",
      "BUTTONS",
    ]);
    expect(audited("template.created")).toBe(1);
  });

  it("refuses another org's number, missing names and duplicates", async () => {
    expect(await saveDraft(ctx(), { id: null, channelId: CH_OTHER, draft: draft() })).toMatchObject(
      { ok: false },
    );
    expect(
      await saveDraft(ctx(), { id: null, channelId: CH, draft: draft({ name: " " }) }),
    ).toMatchObject({ ok: false, error: "Give the template a name." });
    await createDraft();
    expect(await saveDraft(ctx(), { id: null, channelId: CH, draft: draft() })).toMatchObject({
      ok: false,
      error: expect.stringContaining("already exists"),
    });
  });

  it("updates a draft and refuses to rename a template that exists on Meta", async () => {
    const id = await createDraft();
    expect(
      await saveDraft(ctx(), { id, channelId: CH, draft: draft({ footer: "New footer" }) }),
    ).toMatchObject({ ok: true });
    expect(audited("template.saved")).toBe(1);
    templates()[0].meta_template_id = "META1";
    templates()[0].status = "REJECTED";
    const renamed = await saveDraft(ctx(), {
      id,
      channelId: CH,
      draft: draft({ name: "other_name" }),
    });
    expect(renamed).toMatchObject({
      ok: false,
      error: expect.stringContaining("name cannot change"),
    });
  });

  it("will not save over an approved or pending template", async () => {
    const id = await createDraft();
    templates()[0].status = "PENDING";
    expect(await saveDraft(ctx(), { id, channelId: CH, draft: draft() })).toMatchObject({
      ok: false,
    });
  });

  it("cannot touch another org's template", async () => {
    const id = await createDraft();
    const r = await saveDraft(ctx({ orgId: OTHER_ORG }), {
      id,
      channelId: CH_OTHER,
      draft: draft(),
    });
    expect(r).toMatchObject({ ok: false, error: "Template not found." });
  });
});

describe("submitTemplate (create)", () => {
  it("validates, calls Meta once with Meta-shaped components and stores the answer", async () => {
    const id = await createDraft();
    const r = await submitTemplate(ctx(), id);
    expect(r).toEqual({ ok: true, status: "PENDING" });
    expect(meta.createTemplate).toHaveBeenCalledTimes(1);
    const [body, waba] = meta.createTemplate.mock.calls[0] as unknown as [
      Record<string, unknown>,
      string,
    ];
    expect(waba).toBe("W1");
    expect(body).toMatchObject({
      name: "appointment_reminder",
      language: "en",
      category: "UTILITY",
      parameter_format: "POSITIONAL",
      allow_category_change: true,
    });
    expect(templates()[0]).toMatchObject({
      meta_template_id: "META1",
      status: "PENDING",
      last_error: null,
      submitted_at: expect.any(String),
    });
    expect(audited("template.submitted")).toBe(1);
  });

  it("stores the category Meta chose when it reclassifies", async () => {
    meta.createTemplate.mockResolvedValueOnce({
      id: "META1",
      status: "PENDING",
      category: "MARKETING",
    });
    const id = await createDraft();
    await submitTemplate(ctx(), id);
    expect(templates()[0].category).toBe("MARKETING");
  });

  it("blocks invalid drafts before calling Meta and returns the issues", async () => {
    const id = await createDraft({
      body: "{{1}} starts with a variable and is far too clever.",
      bodyExamples: ["x"],
    });
    const r = await submitTemplate(ctx(), id);
    expect(r).toMatchObject({ ok: false, issues: expect.any(Array) });
    expect(meta.createTemplate).not.toHaveBeenCalled();
  });

  it("keeps Meta's rejection text on the row (redacted) and audits the failure", async () => {
    meta.createTemplate.mockRejectedValueOnce(
      new WhatsAppApiError(400, {
        error: {
          message: "Invalid parameter",
          code: 100,
          error_data: { details: "Template name already exists for +971501234567" },
        },
      }),
    );
    const id = await createDraft();
    const r = await submitTemplate(ctx(), id);
    expect(r.ok).toBe(false);
    const stored = String(templates()[0].last_error);
    expect(stored).toContain("already exists");
    expect(stored).not.toContain("971501234567");
    expect(templates()[0].status).toBe("DRAFT");
    expect(audited("template.submit_failed")).toBe(1);
  });

  it("refuses unreviewed machine-written copy until it is marked reviewed", async () => {
    const id = await createDraft();
    templates()[0].needs_review = true;
    expect(await submitTemplate(ctx(), id)).toMatchObject({
      ok: false,
      error: expect.stringContaining("not been reviewed"),
    });
    expect(meta.createTemplate).not.toHaveBeenCalled();
    expect(await markReviewed(ctx(), id)).toEqual({ ok: true });
    expect(templates()[0]).toMatchObject({ needs_review: false, reviewed_by: USER });
    expect(audited("template.reviewed")).toBe(1);
    expect(await submitTemplate(ctx(), id)).toMatchObject({ ok: true });
  });

  it("refuses paused channels, foreign channels and templates already with Meta", async () => {
    const id = await createDraft();
    db.tables.channels[0].status = "paused";
    expect(await submitTemplate(ctx(), id)).toMatchObject({
      ok: false,
      error: expect.stringContaining("paused"),
    });
    db.tables.channels[0].status = "active";
    templates()[0].status = "PENDING";
    expect(await submitTemplate(ctx(), id)).toMatchObject({
      ok: false,
      error: expect.stringContaining("already with Meta"),
    });
    expect(await submitTemplate(ctx({ orgId: OTHER_ORG }), id)).toMatchObject({
      ok: false,
      error: "Template not found.",
    });
  });

  it("uploads the stored header sample to Meta and sends the fresh handle", async () => {
    const id = await createDraft({ header: { format: "IMAGE" } });
    const up = await attachHeaderSample(ctx(), id, {
      data: new Uint8Array([1, 2, 3]),
      mimeType: "image/png",
      filename: "a.png",
    });
    expect(up.ok).toBe(true);
    await submitTemplate(ctx(), id);
    expect(meta.uploadTemplateSample).toHaveBeenCalledWith(
      "APP1",
      expect.objectContaining({ mimeType: "image/png" }),
    );
    const [body] = meta.createTemplate.mock.calls[0] as unknown as [
      { components: Array<{ type: string; example?: { header_handle?: string[] } }> },
    ];
    expect(body.components[0]).toMatchObject({
      type: "HEADER",
      example: { header_handle: ["4::fresh"] },
    });
  });
});

describe("attachHeaderSample", () => {
  it("rejects the wrong type, an empty file and a template without a media header", async () => {
    const id = await createDraft({ header: { format: "IMAGE" } });
    expect(
      await attachHeaderSample(ctx(), id, {
        data: new Uint8Array([1]),
        mimeType: "image/gif",
        filename: "a.gif",
      }),
    ).toMatchObject({ ok: false });
    expect(
      await attachHeaderSample(ctx(), id, {
        data: new Uint8Array(),
        mimeType: "image/png",
        filename: "a.png",
      }),
    ).toMatchObject({ ok: false });
    const plain = await createDraft({ name: "plain" });
    expect(
      await attachHeaderSample(ctx(), plain, {
        data: new Uint8Array([1]),
        mimeType: "image/png",
        filename: "a.png",
      }),
    ).toMatchObject({ ok: false });
    expect(db.files.size).toBe(0);
  });

  it("replaces an earlier sample and removes the old file", async () => {
    const id = await createDraft({ header: { format: "IMAGE" } });
    await attachHeaderSample(ctx(), id, {
      data: new Uint8Array([1]),
      mimeType: "image/png",
      filename: "a.png",
    });
    const first = String(templates()[0].header_sample_path);
    await attachHeaderSample(ctx(), id, {
      data: new Uint8Array([2]),
      mimeType: "image/jpeg",
      filename: "b.jpg",
    });
    expect(db.files.size).toBe(1);
    expect([...db.files.keys()][0]).not.toContain(first.split("/").pop());
    expect(String(templates()[0].header_sample_path)).toMatch(new RegExp(`^${ORG}/${id}/`));
  });
});

describe("editing a template that is on Meta", () => {
  async function approved(lastEdited: string | null = null) {
    const id = await createDraft();
    Object.assign(templates()[0], {
      status: "APPROVED",
      meta_template_id: "META1",
      last_edited_at: lastEdited,
    });
    return id;
  }

  it("calls updateTemplate (not create), stamps last_edited_at and stores the status Meta reports", async () => {
    const id = await approved();
    const r = await submitTemplate(ctx(), id, draft({ footer: "Edited footer" }));
    expect(r).toMatchObject({ ok: true });
    expect(meta.createTemplate).not.toHaveBeenCalled();
    expect(meta.updateTemplate).toHaveBeenCalledWith("META1", { components: expect.any(Array) });
    expect(templates()[0]).toMatchObject({
      status: "PENDING",
      last_edited_at: "2026-11-02T10:00:00.000Z",
    });
    expect(audited("template.edited")).toBe(1);
  });

  it("blocks a second edit within 24 hours without calling Meta", async () => {
    const id = await approved("2026-11-02T04:00:00Z");
    const r = await submitTemplate(ctx(), id, draft({ footer: "Again" }));
    expect(r).toMatchObject({ ok: false, error: expect.stringContaining("every 24 hours") });
    expect(meta.updateTemplate).not.toHaveBeenCalled();
  });

  it("will not rename, re-language or re-categorise an approved template", async () => {
    const id = await approved();
    expect(await submitTemplate(ctx(), id, draft({ name: "renamed" }))).toMatchObject({
      ok: false,
      error: expect.stringContaining("name cannot change"),
    });
    expect(await submitTemplate(ctx(), id, draft({ language: "ar" }))).toMatchObject({ ok: false });
    expect(await submitTemplate(ctx(), id, draft({ category: "MARKETING" }))).toMatchObject({
      ok: false,
      error: expect.stringContaining("category"),
    });
    expect(meta.updateTemplate).not.toHaveBeenCalled();
  });

  it("still succeeds when the status refresh fails after the edit", async () => {
    const id = await approved();
    meta.getTemplate.mockRejectedValueOnce(new Error("boom"));
    expect(await submitTemplate(ctx(), id, draft({ footer: "x" }))).toMatchObject({
      ok: true,
      status: "APPROVED",
    });
  });
});

describe("duplicate, archive, delete", () => {
  it("duplicates into a fresh draft with a safe name, carrying the sample file but not the Meta handle", async () => {
    const id = await createDraft({ header: { format: "IMAGE" } });
    await attachHeaderSample(ctx(), id, {
      data: new Uint8Array([1]),
      mimeType: "image/png",
      filename: "a.png",
    });
    Object.assign(templates()[0], { status: "APPROVED", meta_template_id: "META1" });
    const r = await duplicateTemplate(ctx(), id, { name: "Reminder Copy!", language: "ar" });
    expect(r.ok).toBe(true);
    const copy = templates()[1];
    expect(copy).toMatchObject({
      name: "reminder_copy_",
      language: "ar",
      status: "DRAFT",
    });
    // the sample is copied into the new template's own folder, so the copy can be submitted on its own
    expect(String(copy.header_sample_path)).toMatch(new RegExp(`^${ORG}/${String(copy.id)}/`));
    expect(copy.header_sample_path).not.toBe(templates()[0].header_sample_path);
    expect(db.files.size).toBe(2);
    expect(copy.meta_template_id ?? null).toBeNull();
    expect(audited("template.duplicated")).toBe(1);
    expect(
      await duplicateTemplate(ctx(), id, { name: "reminder_copy_", language: "ar" }),
    ).toMatchObject({ ok: false, error: expect.stringContaining("already exists") });
  });

  it("warns before archiving or deleting a template that reminders use, and honours force", async () => {
    const id = await createDraft();
    Object.assign(templates()[0], { status: "APPROVED", meta_template_id: "META1" });
    db.tables.orgs[0].settings = { appointments: { templates: { reminder: id, confirmed: null } } };
    const warn = await setArchived(ctx(), id, true);
    expect(warn).toMatchObject({
      ok: false,
      error: expect.stringContaining("appointment reminder"),
    });
    expect(templates()[0].archived_at).toBeUndefined();
    expect(await setArchived(ctx(), id, true, true)).toEqual({ ok: true });
    expect(templates()[0].archived_at).toBeTruthy();
    expect(await setArchived(ctx(), id, false)).toEqual({ ok: true });
    expect(templates()[0].archived_at).toBeNull();
  });

  it("hard-deletes an unused draft, including its sample file", async () => {
    const id = await createDraft({ header: { format: "IMAGE" } });
    await attachHeaderSample(ctx(), id, {
      data: new Uint8Array([1]),
      mimeType: "image/png",
      filename: "a.png",
    });
    expect(await deleteTemplate(ctx(), id)).toEqual({ ok: true, hard: true });
    expect(templates()).toHaveLength(0);
    expect(db.files.size).toBe(0);
    expect(meta.deleteTemplate).not.toHaveBeenCalled();
  });

  it("deletes a submitted template on Meta by id and keeps the row (DELETED, archived)", async () => {
    const id = await createDraft();
    Object.assign(templates()[0], { status: "APPROVED", meta_template_id: "META1" });
    expect(await deleteTemplate(ctx(), id)).toEqual({ ok: true, hard: false });
    expect(meta.deleteTemplate).toHaveBeenCalledWith("appointment_reminder", {
      wabaId: "W1",
      hsmId: "META1",
    });
    expect(templates()[0]).toMatchObject({ status: "DELETED" });
    expect(templates()[0].archived_at).toBeTruthy();
  });

  it("keeps the local row when Meta refuses the delete", async () => {
    const id = await createDraft();
    Object.assign(templates()[0], { status: "APPROVED", meta_template_id: "META1" });
    meta.deleteTemplate.mockRejectedValueOnce(
      new WhatsAppApiError(400, { error: { message: "nope", code: 100 } }),
    );
    expect((await deleteTemplate(ctx(), id)).ok).toBe(false);
    expect(templates()[0].status).toBe("APPROVED");
  });

  it("counts recent sends as usage", async () => {
    const id = await createDraft();
    db.tables.messages.push({
      id: "m1",
      org_id: ORG,
      direction: "out",
      kind: "template",
      at: "2026-11-01T10:00:00Z",
      payload: { send: { template_id: id } },
    });
    expect(await deleteTemplate(ctx(), id)).toMatchObject({
      ok: false,
      error: expect.stringContaining("sent 1 time"),
    });
  });
});

describe("variable map", () => {
  it("accepts known sources for live variables only", async () => {
    const id = await createDraft();
    expect(
      await setVariableMap(ctx(), id, { "body.1": "contact.name", "body.2": "appointment.time" }),
    ).toEqual({ ok: true });
    expect(templates()[0].variable_map).toEqual({
      "body.1": "contact.name",
      "body.2": "appointment.time",
    });
    expect(await setVariableMap(ctx(), id, { "body.1": "contact.shoe" })).toMatchObject({
      ok: false,
    });
    expect(await setVariableMap(ctx(), id, { "body.7": "contact.name" })).toMatchObject({
      ok: false,
    });
    expect(audited("template.variables_mapped")).toBe(1);
  });
});

describe("installGallery", () => {
  it("installs drafts, flags Arabic for review, skips existing and unknown keys, and never submits", async () => {
    const r = await installGallery(ctx(), CH, [
      "appointment_reminder:en",
      "appointment_reminder:ar",
      "nope:en",
    ]);
    expect(r).toEqual({ ok: true, created: 2, skipped: 1 });
    const [en, ar] = templates();
    expect(en).toMatchObject({
      status: "DRAFT",
      source: "gallery",
      gallery_key: "appointment_reminder:en",
      needs_review: false,
    });
    expect(ar).toMatchObject({ language: "ar", needs_review: true });
    expect(meta.createTemplate).not.toHaveBeenCalled();
    const again = await installGallery(ctx(), CH, ["appointment_reminder:en"]);
    expect(again).toEqual({ ok: true, created: 0, skipped: 1 });
    expect(audited("template.gallery_installed")).toBe(2);
  });

  it("refuses another org's number", async () => {
    expect(await installGallery(ctx(), CH_OTHER, ["appointment_reminder:en"])).toMatchObject({
      ok: false,
    });
  });
});

describe("sample paths are never trusted from the browser", () => {
  it("only accepts paths under this org and template", () => {
    const t = "00000000-0000-4000-8000-0000000000f6";
    expect(ownSamplePath(ORG, t, `${ORG}/${t}/a.png`)).toBe(`${ORG}/${t}/a.png`);
    expect(ownSamplePath(ORG, t, `${OTHER_ORG}/${t}/a.png`)).toBeUndefined();
    expect(ownSamplePath(ORG, t, `${ORG}/other-template/a.png`)).toBeUndefined();
    expect(ownSamplePath(ORG, t, `${ORG}/${t}/../x.png`)).toBeUndefined();
    expect(ownSamplePath(ORG, t, `${ORG}/${t}//x.png`)).toBeUndefined();
    expect(ownSamplePath(ORG, t, `${ORG}/${t}/a b.png`)).toBeUndefined();
    expect(ownSamplePath(ORG, t, 42)).toBeUndefined();
    expect(ownSamplePath(ORG, t, null)).toBeUndefined();
  });

  it("a submit with a forged header path uploads nothing from that path", async () => {
    const id = await createDraft({ header: { format: "IMAGE" } });
    await attachHeaderSample(ctx(), id, {
      data: new Uint8Array([1]),
      mimeType: "image/png",
      filename: "a.png",
    });
    Object.assign(templates()[0], { status: "APPROVED", meta_template_id: "META1" });
    db.files.set(`wa-template-media/${OTHER_ORG}/x/secret.png`, new Uint8Array([9, 9, 9]));
    const forged = draft({
      header: { format: "IMAGE", samplePath: `${OTHER_ORG}/x/secret.png`, handle: "4::stale" },
    });
    const r = await submitTemplate(ctx(), id, forged);
    expect(r.ok).toBe(true);
    const sent = meta.uploadTemplateSample.mock.calls[0] as unknown as [
      string,
      { data: Uint8Array },
    ];
    expect(Array.from(sent[1].data)).toEqual([1]); // the template's own sample, not the forged file
  });
});

describe("carousel samples", () => {
  const card = (n: number) => ({
    header: { format: "IMAGE" as const },
    body: `Card ${n} describes one of our services.`,
    bodyExamples: [],
    buttons: [{ type: "QUICK_REPLY" as const, text: "Book" }],
  });
  const carousel = () =>
    draft({
      name: "services",
      kind: "carousel",
      category: "MARKETING",
      body: "Our services are below. Reply STOP to opt out.",
      footer: "",
      buttons: [],
      bodyExamples: [],
      variableMap: {},
      cards: [card(1), card(2)],
    });

  it("stores a sample per card, uploads each to Meta on submit and sends the fresh handles", async () => {
    const id = await createDraft(carousel());
    expect(
      (
        await attachCardSample(ctx(), id, 0, {
          data: new Uint8Array([1]),
          mimeType: "image/png",
          filename: "a.png",
        })
      ).ok,
    ).toBe(true);
    expect(
      (
        await attachCardSample(ctx(), id, 1, {
          data: new Uint8Array([2]),
          mimeType: "image/jpeg",
          filename: "b.jpg",
        })
      ).ok,
    ).toBe(true);
    expect(
      await attachCardSample(ctx(), id, 5, {
        data: new Uint8Array([2]),
        mimeType: "image/jpeg",
        filename: "b.jpg",
      }),
    ).toMatchObject({ ok: false });
    meta.uploadTemplateSample
      .mockResolvedValueOnce({ handle: "4::c0" })
      .mockResolvedValueOnce({ handle: "4::c1" });
    const r = await submitTemplate(ctx(), id);
    expect(r).toMatchObject({ ok: true });
    expect(meta.uploadTemplateSample).toHaveBeenCalledTimes(2);
    const [body] = meta.createTemplate.mock.calls[0] as unknown as [
      {
        components: Array<{
          type: string;
          cards?: Array<{ components: Array<{ example?: { header_handle?: string[] } }> }>;
        }>;
      },
    ];
    const cards = body.components.find((c) => c.type === "CAROUSEL")!.cards!;
    expect(cards.map((c) => c.components[0].example?.header_handle?.[0])).toEqual([
      "4::c0",
      "4::c1",
    ]);
  });

  it("will not submit a carousel whose cards have no sample", async () => {
    const id = await createDraft(carousel());
    const r = await submitTemplate(ctx(), id);
    expect(r).toMatchObject({ ok: false, error: expect.stringContaining("sample") });
    expect(meta.createTemplate).not.toHaveBeenCalled();
  });
});
