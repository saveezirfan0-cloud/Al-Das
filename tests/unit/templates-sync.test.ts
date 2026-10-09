import { describe, expect, it, vi } from "vitest";

vi.mock("@/lib/whatsapp/channel", () => ({
  clientForChannel: async () => ({
    listAllTemplates: async () => [
      {
        id: "M1",
        name: "kept",
        language: "en",
        category: "UTILITY",
        status: "APPROVED",
        components: [{ type: "BODY", text: "Hello there, welcome." }],
      },
    ],
  }),
}));

import { syncTemplatesForChannel } from "@/lib/whatsapp/sync";

import { fakeAdmin, fakeDb } from "./helpers/fake-admin";

// The fake does not implement upsert; give it a minimal one for this test.
function adminWithUpsert(db: ReturnType<typeof fakeDb>) {
  const admin = fakeAdmin(db) as unknown as { from: (t: string) => Record<string, unknown> };
  const from = admin.from.bind(admin);
  admin.from = (t: string) => {
    const q = from(t);
    q.upsert = async (rows: Array<Record<string, unknown>>) => {
      for (const r of rows) {
        const existing = db.tables[t].find(
          (x) => x.waba_id === r.waba_id && x.name === r.name && x.language === r.language,
        );
        if (existing) Object.assign(existing, r);
        else db.tables[t].push({ id: `id-${r.name}`, ...r });
      }
      return { error: null };
    };
    return q;
  };
  return admin as never;
}

describe("syncTemplatesForChannel", () => {
  it("archives templates that disappeared from Meta but never touches local drafts", async () => {
    const db = fakeDb({
      wa_templates: [
        {
          id: "a",
          waba_id: "W1",
          name: "kept",
          language: "en",
          status: "APPROVED",
          meta_template_id: "M1",
          archived_at: null,
        },
        {
          id: "b",
          waba_id: "W1",
          name: "removed_on_meta",
          language: "en",
          status: "APPROVED",
          meta_template_id: "M2",
          archived_at: null,
        },
        {
          id: "c",
          waba_id: "W1",
          name: "my_draft",
          language: "en",
          status: "DRAFT",
          meta_template_id: null,
          archived_at: null,
        },
        {
          id: "d",
          waba_id: "W1",
          name: "my_draft_ar",
          language: "ar",
          status: "DRAFT",
          meta_template_id: null,
          archived_at: null,
        },
      ],
    });
    const r = await syncTemplatesForChannel(adminWithUpsert(db), {
      id: "ch",
      org_id: "o",
      phone_number_id: "1",
      waba_id: "W1",
    });
    expect(r).toEqual({ synced: 1, removed: 1 });
    const by = Object.fromEntries(db.tables.wa_templates.map((t) => [t.id as string, t]));
    expect(by.b).toMatchObject({ status: "DELETED" });
    expect(by.b.archived_at).toBeTruthy();
    expect(by.c).toMatchObject({ status: "DRAFT", archived_at: null });
    expect(by.d).toMatchObject({ status: "DRAFT", archived_at: null });
    expect(by.a).toMatchObject({ status: "APPROVED", archived_at: null });
  });
});
