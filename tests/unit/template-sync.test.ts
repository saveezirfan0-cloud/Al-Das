import { describe, expect, it } from "vitest";

import { planTemplateSync } from "@/lib/whatsapp/sync";
import type { MetaTemplate } from "@/lib/whatsapp/types";

const remote = (name: string, language = "en"): MetaTemplate => ({
  id: `id_${name}_${language}`,
  name,
  language,
  status: "APPROVED",
  category: "UTILITY",
  components: [],
});
const local = (
  name: string,
  over: Partial<{
    status: string;
    archived_at: string | null;
    meta_template_id: string | null;
    language: string;
  }> = {},
) => ({
  id: `row_${name}`,
  name,
  language: "en",
  status: "APPROVED",
  archived_at: null,
  meta_template_id: `id_${name}_en`,
  ...over,
});

describe("planTemplateSync", () => {
  it("splits new and already mirrored templates", () => {
    const plan = planTemplateSync([remote("a"), remote("b"), remote("a", "ar")], [local("a")]);
    expect(plan.inserts.map((t) => `${t.name}/${t.language}`)).toEqual(["b/en", "a/ar"]);
    expect(plan.updates.map((t) => t.name)).toEqual(["a"]);
    expect(plan.gone).toEqual([]);
  });

  it("never archives drafts or rows that were never submitted", () => {
    const plan = planTemplateSync(
      [],
      [
        local("draft_one", { status: "DRAFT", meta_template_id: null }),
        local("not_submitted", { meta_template_id: null, status: "PENDING" }),
        local("submitted"),
      ],
    );
    expect(plan.gone.map((g) => g.name)).toEqual(["submitted"]);
  });

  it("skips rows that are already archived and revives sync-deleted ones that return", () => {
    const plan = planTemplateSync(
      [remote("back")],
      [
        local("manual", { archived_at: "2026-01-01T00:00:00Z" }),
        local("back", { status: "DELETED", archived_at: "2026-01-01T00:00:00Z" }),
      ],
    );
    expect(plan.gone).toEqual([]);
    expect(plan.revive.map((r) => r.name)).toEqual(["back"]);
  });

  it("matches on name and language together", () => {
    const plan = planTemplateSync(
      [remote("a", "en")],
      [local("a", { language: "ar", meta_template_id: "x" })],
    );
    expect(plan.gone.map((g) => `${g.name}/${g.language}`)).toEqual(["a/ar"]);
    expect(plan.inserts.map((t) => t.name)).toEqual(["a"]);
  });
});

import { channelsToSync } from "@/lib/whatsapp/sync";

describe("channelsToSync", () => {
  const ch = (
    id: string,
    waba: string,
    over: Partial<{ org_id: string; status: string; created_at: string }> = {},
  ) => ({
    id,
    org_id: "o1",
    waba_id: waba,
    status: "active",
    created_at: `2026-01-0${id}T00:00:00Z`,
    ...over,
  });
  it("syncs each WABA once, using the oldest active channel", () => {
    const r = channelsToSync([ch("3", "W1"), ch("1", "W1"), ch("2", "W2")]);
    expect(r.map((c) => c.id)).toEqual(["1", "2"]);
  });
  it("skips paused and disconnected channels and keeps orgs apart", () => {
    const r = channelsToSync([
      ch("1", "W1", { status: "paused" }),
      ch("2", "W1", { status: "disconnected" }),
      ch("3", "W2"),
      ch("4", "W2", { org_id: "o2" }),
    ]);
    expect(r.map((c) => c.id)).toEqual(["3", "4"]);
  });
});

import { vi } from "vitest";

describe("templates_sync task", () => {
  it("syncs once per WABA, keeps going after a failure and returns totals", async () => {
    vi.resetModules();
    const calls: string[] = [];
    vi.doMock("@/lib/whatsapp/sync", async () => {
      const real =
        await vi.importActual<typeof import("@/lib/whatsapp/sync")>("@/lib/whatsapp/sync");
      return {
        ...real,
        syncTemplatesForChannel: vi.fn(async (_admin: unknown, ch: { id: string }) => {
          calls.push(ch.id);
          if (ch.id === "bad") throw new Error("Meta down");
          return { synced: 3, removed: 1, revived: 0 };
        }),
      };
    });
    const { getTask } = await import("@/lib/jobs/tasks");
    await import("@/lib/jobs/handlers/templates-sync");
    const task = getTask("templates_sync");
    expect(task).toBeDefined();

    const rows = [
      {
        id: "a1",
        org_id: "o",
        phone_number_id: "p1",
        waba_id: "W1",
        status: "active",
        created_at: "2026-01-01T00:00:00Z",
      },
      {
        id: "a2",
        org_id: "o",
        phone_number_id: "p2",
        waba_id: "W1",
        status: "active",
        created_at: "2026-01-02T00:00:00Z",
      },
      {
        id: "bad",
        org_id: "o",
        phone_number_id: "p3",
        waba_id: "W2",
        status: "active",
        created_at: "2026-01-03T00:00:00Z",
      },
      {
        id: "ok",
        org_id: "o",
        phone_number_id: "p4",
        waba_id: "W3",
        status: "active",
        created_at: "2026-01-04T00:00:00Z",
      },
    ];
    const admin = { from: () => ({ select: async () => ({ data: rows, error: null }) }) };
    const log = { info: vi.fn(), warn: vi.fn(), error: vi.fn() };
    const result = await task!.run(admin as never, log as never);
    expect(calls).toEqual(["a1", "bad", "ok"]);
    expect(result).toEqual({ wabas: 3, synced: 6, removed: 2, revived: 0, failed: 1 });
    expect(log.error).toHaveBeenCalledTimes(1);
    expect(JSON.stringify(log.error.mock.calls)).not.toMatch(/token/i);
  });
});
