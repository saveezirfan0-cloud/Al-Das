import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

import {
  CHUNK_SIZE,
  parseUniteExport,
  UniteExportError,
  validPulledOn,
} from "@/lib/finance/unite-export";
import {
  storeAndProcessUniteExport,
  type ExportDeps,
  type RawFileBatchInsert,
} from "@/lib/finance/unite-export-server";

import { rawInvoice } from "./factory";

const invoices = (n: number) =>
  Array.from({ length: n }, (_, i) => rawInvoice({ InvDisplayNumber: `ADMC/T/${i + 1}` }));
const text = (v: unknown) => JSON.stringify(v);

describe("parseUniteExport", () => {
  it("accepts an envelope and keeps its other keys", () => {
    const r = parseUniteExport(
      text({ MessageStatus: "Success", DataBalancetoSync: 0, Data: invoices(3) }),
    );
    expect(r.totalRecords).toBe(3);
    expect(r.chunks).toHaveLength(1);
    expect(r.chunks[0].payload).toMatchObject({ MessageStatus: "Success", DataBalancetoSync: 0 });
  });
  it("wraps a bare array", () => {
    const r = parseUniteExport(text(invoices(2)));
    expect(r.chunks[0].payload).toMatchObject({ MessageStatus: "file" });
    expect(r.chunks[0].recordCount).toBe(2);
  });
  it("rejects garbage, empty and records without a number", () => {
    expect(() => parseUniteExport("not json")).toThrow(UniteExportError);
    expect(() => parseUniteExport(text({ foo: 1 }))).toThrow(UniteExportError);
    expect(() => parseUniteExport(text([]))).toThrow(/no invoice records/);
    expect(() => parseUniteExport(text([{ PatientPIN: "x" }]))).toThrow(/no invoice number/);
  });
  it("splits into chunks of at most 200 with a deterministic hash", () => {
    const body = text(invoices(450));
    const a = parseUniteExport(body);
    expect(a.chunks.map((c) => c.recordCount)).toEqual([CHUNK_SIZE, CHUNK_SIZE, 50]);
    const b = parseUniteExport(body);
    expect(b.chunks.map((c) => c.sha256)).toEqual(a.chunks.map((c) => c.sha256));
    expect(new Set(a.chunks.map((c) => c.sha256)).size).toBe(3);
  });
  it("checks the pulled-on date", () => {
    expect(validPulledOn("2026-10-01", "2026-10-17")).toBe("2026-10-01");
    expect(validPulledOn("2026-10-18", "2026-10-17")).toBeNull();
    expect(validPulledOn("2026-02-30", "2026-10-17")).toBeNull();
    expect(validPulledOn("17/10/2026", "2026-10-17")).toBeNull();
  });
});

function fakeDeps(failAt: number | null = null) {
  const log: string[] = [];
  const rows: (RawFileBatchInsert & { id: string; status: string })[] = [];
  const deps: ExportDeps = {
    findBySha: async (sha) => {
      const r = rows.find((x) => x.payload_sha256 === sha);
      return r ? { id: r.id, processStatus: r.status } : null;
    },
    insertRaw: async (row) => {
      const id = `b${rows.length + 1}`;
      rows.push({ ...row, id, status: "received" });
      log.push(`insert ${id}`);
      return id;
    },
    processBatch: async (id) => {
      log.push(`process ${id}`);
      if (failAt !== null && id === `b${failAt}`) return { ok: false, error: "mapping" };
      rows.find((x) => x.id === id)!.status = "processed";
      return { ok: true, counts: {} };
    },
  };
  return { deps, log, rows };
}
const input = (body: string) => ({
  text: body,
  pulledOn: "2026-10-01",
  today: "2026-10-17",
  nowIso: "2026-10-17T10:00:00Z",
  fileName: "export.json",
  userId: "u1",
});

describe("storeAndProcessUniteExport", () => {
  it("inserts every chunk before processing any, with requested_at at 00:00Z of the pulled-on date", async () => {
    const { deps, log, rows } = fakeDeps();
    const res = await storeAndProcessUniteExport(deps, input(text(invoices(450))));
    expect(log).toEqual([
      "insert b1",
      "insert b2",
      "insert b3",
      "process b1",
      "process b2",
      "process b3",
    ]);
    expect(res).toMatchObject({ chunks: 3, storedNow: 3, processedNow: 3, failed: null });
    for (const r of rows) {
      expect(r.requested_at).toBe("2026-10-01T00:00:00Z");
      expect(r.from_date).toBe("2026-10-01");
      expect(r.balance_in_range).toBeNull();
      expect(r.source).toBe("file");
      expect(r.count_requested).toBe(r.record_count);
    }
  });
  it("never dates a chunk in the future (the org's today can be tomorrow in UTC)", async () => {
    const { deps, rows } = fakeDeps();
    await storeAndProcessUniteExport(deps, {
      ...input(text(invoices(1))),
      pulledOn: "2026-10-17",
      today: "2026-10-17",
      nowIso: "2026-10-16T21:00:00Z",
    });
    expect(rows[0].requested_at).toBe("2026-10-16T21:00:00Z");
  });
  it("stops at the first failed chunk and leaves the rest for replay", async () => {
    const { deps, log } = fakeDeps(2);
    const res = await storeAndProcessUniteExport(deps, input(text(invoices(450))));
    expect(log.filter((l) => l.startsWith("process"))).toEqual(["process b1", "process b2"]);
    expect(res).toMatchObject({ processedNow: 1, notProcessed: 2, failed: { chunk: 2 } });
  });
  it("is idempotent on re-upload and re-processes what is not processed yet", async () => {
    const { deps, rows } = fakeDeps(2);
    await storeAndProcessUniteExport(deps, input(text(invoices(450))));
    const again = fakeDeps();
    again.rows.push(...rows);
    const res = await storeAndProcessUniteExport(again.deps, input(text(invoices(450))));
    expect(res).toMatchObject({
      storedNow: 0,
      alreadyStored: 3,
      alreadyProcessed: 1,
      processedNow: 2,
    });
    expect(again.rows).toHaveLength(3);
  });
  it("refuses a missing or future pulled-on date before storing anything", async () => {
    const { deps, rows } = fakeDeps();
    await expect(
      storeAndProcessUniteExport(deps, { ...input(text(invoices(1))), pulledOn: "2026-11-01" }),
    ).rejects.toThrow(UniteExportError);
    expect(rows).toHaveLength(0);
  });
});

describe("never calls Unite", () => {
  it("the new files do not import the Unite client", () => {
    for (const f of [
      "lib/finance/unite-export.ts",
      "lib/finance/unite-export-server.ts",
      "lib/finance/unite-export-db.ts",
      "app/(app)/finance/upload/unite-export-actions.ts",
      "app/(app)/finance/upload/unite-export-flow.tsx",
    ]) {
      const src = readFileSync(f, "utf8");
      expect(src, f).not.toMatch(/lib\/unite\//);
      expect(src, f).not.toMatch(/financeDetails|createUniteClient/);
    }
  });
});
