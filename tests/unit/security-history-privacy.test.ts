import { describe, expect, it } from "vitest";

import { PORTAL_OBJECTS } from "@/lib/portal/objects";
import {
  describeOp,
  fieldLabel,
  formatHistoryValue,
  HISTORY_PERMISSION,
  HISTORY_TABLES,
  isHistoryTable,
  parseChanges,
} from "@/lib/security/history";
import {
  canCancel,
  canDecide,
  canExecute,
  exportCounts,
  EXPORT_SECTIONS,
  validReason,
} from "@/lib/security/privacy";

describe("history table list", () => {
  it("covers appointments, enquiries, tasks, templates, flows and every portal object", () => {
    for (const t of ["appointments", "enquiries", "tasks", "wa_templates", "flows"])
      expect(isHistoryTable(t), t).toBe(true);
    for (const o of PORTAL_OBJECTS)
      expect(
        isHistoryTable(o.table),
        `portal object ${o.key} (${o.table}) needs record_history`,
      ).toBe(true);
    expect(isHistoryTable("contacts")).toBe(false);
    expect(isHistoryTable("__proto__")).toBe(false);
    expect(isHistoryTable("constructor")).toBe(false);
  });
  it("names a permission for every non-portal table", () => {
    const portalTables = new Set(PORTAL_OBJECTS.map((o) => o.table));
    for (const t of Object.keys(HISTORY_TABLES)) {
      if (!portalTables.has(t))
        expect(HISTORY_PERMISSION[t as keyof typeof HISTORY_TABLES], t).toBeTruthy();
    }
  });
});

describe("parseChanges", () => {
  it("turns stored from/to pairs into readable rows, sorted by label", () => {
    const rows = parseChanges({
      status: { from: "booked", to: "arrived" },
      notes: { from: null, to: "Bring the card" },
      done: { from: false, to: true },
      graph: { from: { changed: true }, to: { changed: true } },
      sla_due_at: { from: "", to: 5 },
    });
    expect(rows.map((r) => r.label)).toEqual(["Done", "Graph", "Notes", "Sla due at", "Status"]);
    expect(rows.find((r) => r.field === "notes")).toMatchObject({
      from: "empty",
      to: "Bring the card",
    });
    expect(rows.find((r) => r.field === "done")).toMatchObject({ from: "no", to: "yes" });
    expect(rows.find((r) => r.field === "graph")).toMatchObject({
      from: "(changed)",
      to: "(changed)",
    });
  });
  it("ignores malformed values instead of throwing", () => {
    expect(parseChanges(null)).toEqual([]);
    expect(parseChanges([1, 2])).toEqual([]);
    expect(parseChanges({ a: 1, b: "x", c: [1], d: null })).toEqual([]);
  });
  it("formats and labels", () => {
    expect(fieldLabel("assignee_id")).toBe("Assignee");
    expect(fieldLabel("starts_at")).toBe("Starts at");
    expect(formatHistoryValue({ a: 1 })).toBe('{"a":1}');
    expect(formatHistoryValue("x".repeat(200)).length).toBe(200); // strings are shortened by the database, not here
    expect(describeOp("insert")).toBe("Created");
    expect(describeOp("delete")).toBe("Deleted");
    expect(describeOp("update")).toBe("Changed");
  });
});

describe("privacy request rules", () => {
  const pending = { kind: "erasure" as const, status: "pending" as const, requestedBy: "alice" };

  it("needs a second person: the requester cannot decide", () => {
    expect(canDecide(pending, "alice")).toMatchObject({ ok: false });
    expect(canDecide(pending, "bob")).toEqual({ ok: true });
  });
  it("only decides pending requests", () => {
    for (const status of ["approved", "completed", "rejected", "cancelled"] as const) {
      expect(canDecide({ ...pending, status }, "bob").ok, status).toBe(false);
    }
  });
  it("only the requester cancels, and only while pending", () => {
    expect(canCancel(pending, "alice")).toEqual({ ok: true });
    expect(canCancel(pending, "bob").ok).toBe(false);
    expect(canCancel({ ...pending, status: "approved" }, "alice").ok).toBe(false);
  });
  it("carries out only approved requests", () => {
    expect(canExecute({ ...pending, status: "approved" })).toEqual({ ok: true });
    for (const status of ["pending", "completed", "rejected", "cancelled"] as const) {
      expect(canExecute({ ...pending, status }).ok, status).toBe(false);
    }
  });
  it("wants a real reason", () => {
    expect(validReason("   ").ok).toBe(false);
    expect(validReason("abcd").ok).toBe(false);
    expect(validReason("Patient asked in writing, ref 123").ok).toBe(true);
    expect(validReason("x".repeat(1001)).ok).toBe(false);
  });
  it("counts export sections without keeping any data", () => {
    const counts = exportCounts({ contact: { id: "c" }, phones: [1, 2], messages: [] });
    expect(counts.contact).toBe(1);
    expect(counts.phones).toBe(2);
    expect(counts.messages).toBe(0);
    expect(Object.keys(counts)).toEqual([...EXPORT_SECTIONS]);
  });
});
