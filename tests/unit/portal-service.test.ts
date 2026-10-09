import { beforeEach, describe, expect, it, vi } from "vitest";

import { clearListeners, on, type DomainEvent } from "@/lib/events/emit";
import { addComment, diffRecord, pathBelongsToRecord, portalFilePath } from "@/lib/portal/service";
import type { ServiceMember } from "@/lib/portal/service";

// A tiny in-memory stand-in for the supabase-js query builder, enough for the service layer.
type Row = Record<string, unknown>;
function fakeAdmin(seed: Record<string, Row[]> = {}) {
  const tables: Record<string, Row[]> = JSON.parse(JSON.stringify(seed));
  const log: Array<{ table: string; op: string; payload?: unknown }> = [];
  let seq = 0;
  function builder(table: string) {
    const filters: Array<[string, unknown]> = [];
    let op: "select" | "insert" | "update" | "delete" = "select";
    let payload: Row | undefined;
    let inFilter: [string, unknown[]] | null = null;
    const matches = () =>
      (tables[table] ??= []).filter(
        (r) =>
          filters.every(([k, v]) => r[k] === v) &&
          (!inFilter || inFilter[1].includes(r[inFilter[0]])),
      );
    const run = () => {
      log.push({ table, op, payload });
      if (op === "insert") {
        const row = { id: `id-${++seq}`, ...payload } as Row;
        (tables[table] ??= []).push(row);
        return { data: [row], error: null, count: 1 };
      }
      if (op === "update") {
        const rows = matches();
        rows.forEach((r) => Object.assign(r, payload));
        return { data: rows, error: null, count: rows.length };
      }
      if (op === "delete") {
        const rows = matches();
        tables[table] = (tables[table] ?? []).filter((r) => !rows.includes(r));
        return { data: rows, error: null, count: rows.length };
      }
      return { data: matches(), error: null, count: matches().length };
    };
    const b: Record<string, unknown> = {
      select: () => b,
      insert: (p: Row) => ((op = "insert"), (payload = p), b),
      update: (p: Row) => ((op = "update"), (payload = p), b),
      delete: () => ((op = "delete"), b),
      eq: (k: string, v: unknown) => (filters.push([k, v]), b),
      in: (k: string, v: unknown[]) => ((inFilter = [k, v]), b),
      single: () => Promise.resolve({ ...run(), data: run().data[0] ?? null }),
      maybeSingle: () => Promise.resolve({ error: null, data: run().data[0] ?? null }),
      then: (resolve: (v: unknown) => unknown) => Promise.resolve(run()).then(resolve),
    };
    return b;
  }
  return { client: { from: builder } as never, tables, log };
}

const ORG = "org-1";
const manager: ServiceMember = {
  userId: "u-manager",
  orgId: ORG,
  roleId: "r",
  status: "active",
  permissions: ["portal.*"],
};
const reader: ServiceMember = { ...manager, userId: "u-reader", permissions: ["portal.*.read"] };

// The service imports modules that touch Supabase; the portal helpers it calls are exercised
// against the fake above. Importing lazily keeps the mock setup simple.
const { createRecord, updateRecord, deleteRecord } = await import("@/lib/portal/service");

describe("portal service", () => {
  let events: DomainEvent[];
  beforeEach(() => {
    clearListeners();
    events = [];
    on("*", (e) => void events.push(e));
    vi.spyOn(console, "error").mockImplementation(() => {});
  });

  it("denies writes without the write permission and writes nothing", async () => {
    const { client, tables } = fakeAdmin();
    const res = await createRecord(client, reader, "ref_items", { code: "X1" });
    expect(res).toMatchObject({ ok: false, error: expect.stringMatching(/permission/i) });
    expect(tables.ref_items ?? []).toHaveLength(0);
    expect(events).toHaveLength(0);
  });

  it("validates with Zod before touching the table", async () => {
    const { client, tables } = fakeAdmin();
    const res = await createRecord(client, manager, "ref_medication_classes", {
      unite_local_code: "D1",
      class: "nope",
    });
    expect(res.ok).toBe(false);
    expect(tables.ref_medication_classes ?? []).toHaveLength(0);
  });

  it("creates with the caller's org (never the payload's), audits, records a timeline event and emits", async () => {
    const { client, tables } = fakeAdmin();
    const res = await createRecord(client, manager, "ref_items", {
      code: "X1",
      org_id: "attacker",
    });
    expect(res.ok).toBe(true);
    expect(tables.ref_items[0]).toMatchObject({ org_id: ORG, code: "X1" });
    expect(tables.audit_log[0]).toMatchObject({
      action: "portal.record_created",
      entity: "ref_items",
      org_id: ORG,
    });
    expect(tables.portal_record_events[0]).toMatchObject({
      type: "created",
      object_key: "ref_items",
    });
    expect(events.map((e) => e.name)).toEqual(["portal.record_created"]);
  });

  it("refuses to create objects that are not creatable here", async () => {
    const { client } = fakeAdmin();
    const res = await createRecord(
      client,
      { ...manager, permissions: ["*"] },
      "clinical_settings",
      { label: "x" },
    );
    expect(res).toMatchObject({ ok: false, error: expect.stringMatching(/cannot be created/) });
  });

  it("updates only changed fields and records a field-level diff", async () => {
    const { client, tables } = fakeAdmin({
      ref_items: [
        { id: "i1", org_id: ORG, code: "X1", description: "old", doctor_verified: false },
      ],
    });
    const res = await updateRecord(client, manager, "ref_items", "i1", {
      description: "new",
      doctor_verified: false,
    });
    expect(res.ok).toBe(true);
    expect(tables.ref_items[0].description).toBe("new");
    const ev = tables.portal_record_events[0] as { payload: { changes: Record<string, unknown> } };
    expect(Object.keys(ev.payload.changes)).toEqual(["description"]);
    expect(events.map((e) => e.name)).toEqual(["portal.record_updated"]);
  });

  it("a no-op update writes nothing and emits nothing", async () => {
    const { client, log } = fakeAdmin({
      ref_items: [{ id: "i1", org_id: ORG, code: "X1", description: "same" }],
    });
    const res = await updateRecord(client, manager, "ref_items", "i1", { description: "same" });
    expect(res).toMatchObject({ ok: true, message: "No changes." });
    expect(log.some((l) => l.op === "update")).toBe(false);
    expect(events).toHaveLength(0);
  });

  it("cannot read or update another org's record", async () => {
    const { client, tables } = fakeAdmin({
      ref_items: [{ id: "i9", org_id: "other-org", code: "Z", description: "keep" }],
    });
    const res = await updateRecord(client, manager, "ref_items", "i9", { description: "pwn" });
    expect(res).toMatchObject({ ok: false, error: "Record not found." });
    expect(tables.ref_items[0].description).toBe("keep");
  });

  it("delete is limited to objects that allow it and to the caller's org", async () => {
    const { client, tables } = fakeAdmin({
      ref_items: [{ id: "i1", org_id: ORG, code: "X" }],
      website_entry_points: [
        { id: "w1", org_id: ORG, section: "s", source_key: "k" },
        { id: "w2", org_id: "other-org", section: "s", source_key: "k" },
      ],
    });
    expect(await deleteRecord(client, manager, "ref_items", "i1")).toMatchObject({
      ok: false,
      error: expect.stringMatching(/cannot be deleted/),
    });
    expect(await deleteRecord(client, manager, "website_entry_points", "w2")).toMatchObject({
      ok: false,
    });
    expect(tables.website_entry_points).toHaveLength(2);
    expect((await deleteRecord(client, manager, "website_entry_points", "w1")).ok).toBe(true);
    expect(tables.website_entry_points.map((r) => r.id)).toEqual(["w2"]);
  });

  it("comments need read access, parse mentions and only notify members who can read", async () => {
    const { client, tables } = fakeAdmin({
      ref_items: [{ id: "i1", org_id: ORG, code: "X" }],
    });
    const denied = await addComment(
      client,
      { ...manager, permissions: [] },
      "ref_items",
      "i1",
      "hi",
    );
    expect(denied.ok).toBe(false);
    const res = await addComment(
      client,
      reader,
      "ref_items",
      "i1",
      "ping @[Dana](11111111-1111-4111-8111-111111111111)",
    );
    expect(res.ok).toBe(true);
    expect(tables.portal_comments[0].body).toBe("ping @Dana");
    // the fake has no memberships, so nobody qualifies as a mention target
    expect(tables.portal_comments[0].mentioned_user_ids).toEqual([]);
  });
});

describe("helpers", () => {
  it("diffRecord truncates long values and ignores equal ones", () => {
    const d = diffRecord({ a: "x".repeat(300), b: 1 }, { a: "y", b: 1 }, ["a", "b"]);
    expect(Object.keys(d)).toEqual(["a"]);
    expect(String(d.a.from).length).toBeLessThan(210);
  });

  it("attachment paths are scoped to org/object/record", () => {
    const p = portalFilePath("o", "ref_items", "r", "u", "PDF");
    expect(p).toBe("o/ref_items/r/u.pdf");
    expect(pathBelongsToRecord(p, "o", "ref_items", "r")).toBe(true);
    expect(pathBelongsToRecord(p, "o2", "ref_items", "r")).toBe(false);
    expect(pathBelongsToRecord("o/ref_items/r/../x/u.pdf", "o", "ref_items", "r")).toBe(false);
    expect(portalFilePath("o", "k", "r", "u", "../../x")).toBe("o/k/r/u.x");
  });
});
