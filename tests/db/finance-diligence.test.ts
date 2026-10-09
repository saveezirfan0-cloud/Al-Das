/**
 * Diligence import against a real Postgres: stage -> preview -> commit -> match, with the real
 * SQL functions. A tiny pg-backed DiligenceStore stands in for the Supabase one. Synthetic data only.
 */
import type { Client } from "pg";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { DILIGENCE_FIELDS } from "@/lib/finance/diligence-mapping";
import {
  buildPreview,
  commitImport,
  discardImport,
  matchClaimsForOrg,
  stageDiligenceUpload,
  type DiligenceStore,
} from "@/lib/finance/diligence-service";
import type { ClaimRow } from "@/lib/finance/parse-diligence";

import { row, table } from "../unit/finance/diligence-factory";
import {
  asServiceRole,
  asUser,
  connect,
  count,
  createAuthUser,
  createOrg,
  resetDb,
  TEST_DATABASE_URL,
} from "./helpers";

async function xlsx(rows: Array<Record<string, unknown>>, drop: string[] = []): Promise<Buffer> {
  const ExcelJS = (await import("exceljs")).default;
  const wb = new ExcelJS.Workbook();
  const ws = wb.addWorksheet("DataSheet");
  table(rows, drop).forEach((r) => ws.addRow(r));
  return Buffer.from(await wb.xlsx.writeBuffer());
}

const CLAIM_COLS = Object.keys(DILIGENCE_FIELDS);
const ymd = (v: unknown) =>
  v instanceof Date ? v.toISOString().slice(0, 10) : (v as string | null);

function convertClaim(r: Record<string, unknown>): Partial<ClaimRow> {
  const out: Record<string, unknown> = {};
  for (const name of CLAIM_COLS) {
    const kind = DILIGENCE_FIELDS[name as keyof typeof DILIGENCE_FIELDS].kind;
    const v = r[name];
    out[name] =
      v === null || v === undefined
        ? null
        : kind === "number" || kind === "int"
          ? Number(v)
          : kind === "date"
            ? ymd(v)
            : v;
  }
  return out as Partial<ClaimRow>;
}

function pgStore(c: Client): DiligenceStore {
  const q = (sql: string, p: unknown[] = []) => c.query(sql, p);
  return {
    async findFileBySha(org, sha) {
      const { rows } = await q(
        "select id, status, uploaded_at, row_count from public.fin_raw_diligence_files where org_id = $1 and file_sha256 = $2",
        [org, sha],
      );
      return rows[0]
        ? {
            id: rows[0].id,
            status: rows[0].status,
            uploadedAt: rows[0].uploaded_at.toISOString(),
            rowCount: rows[0].row_count,
          }
        : null;
    },
    async createFile(org, f) {
      const { rows } = await q(
        "insert into public.fin_raw_diligence_files (org_id, storage_path, file_name, file_sha256, uploaded_by, status, errors) values ($1,$2,$3,$4,$5,'rejected','[]') returning id",
        [org, f.storagePath, f.fileName, f.sha, f.userId],
      );
      return rows[0].id;
    },
    async resetFile(org, id, f) {
      await q("delete from public.ins_staged_activities where file_id = $1", [id]);
      await q(
        "update public.fin_raw_diligence_files set status='rejected', errors='[]', header_check='{}', storage_path=$2, file_name=$3, uploaded_by=$4 where id=$1",
        [id, f.storagePath, f.fileName, f.userId],
      );
    },
    async updateFile(id, p) {
      await q(
        `update public.fin_raw_diligence_files set status = coalesce($2, status), row_count = coalesce($3, row_count),
           sum_net = coalesce($4, sum_net), sum_remitted = coalesce($5, sum_remitted), sum_rejected = coalesce($6, sum_rejected),
           header_check = coalesce($7::jsonb, header_check), errors = coalesce($8::jsonb, errors) where id = $1`,
        [
          id,
          p.status ?? null,
          p.rowCount ?? null,
          p.sumNet ?? null,
          p.sumRemitted ?? null,
          p.sumRejected ?? null,
          p.headerCheck ? JSON.stringify(p.headerCheck) : null,
          p.errors ? JSON.stringify(p.errors) : null,
        ],
      );
    },
    async stageRows(org, fileId, rows) {
      for (const r of rows)
        await q(
          "insert into public.ins_staged_activities (org_id, file_id, row_no, claim_activity_number, data) values ($1,$2,$3,$4,$5::jsonb)",
          [org, fileId, r.row_no, r.claim_activity_number, JSON.stringify(r.data)],
        );
    },
    async loadFile(org, id) {
      const { rows } = await q(
        "select * from public.fin_raw_diligence_files where id = $1 and org_id = $2",
        [id, org],
      );
      const r = rows[0];
      return r
        ? {
            id: r.id,
            status: r.status,
            uploadedAt: r.uploaded_at.toISOString(),
            rowCount: r.row_count,
            fileName: r.file_name,
            headerCheck: r.header_check,
            errors: r.errors,
            sumNet: r.sum_net,
            sumRemitted: r.sum_remitted,
            sumRejected: r.sum_rejected,
          }
        : null;
    },
    async loadStaged(org, id) {
      const { rows } = await q(
        "select data from public.ins_staged_activities where org_id = $1 and file_id = $2 order by row_no",
        [org, id],
      );
      return rows.map((r) => r.data as ClaimRow);
    },
    async existingClaims(org, numbers) {
      const { rows } = await q(
        "select * from public.ins_claim_activities where org_id = $1 and claim_activity_number = any($2)",
        [org, numbers],
      );
      return new Map(rows.map((r) => [r.claim_activity_number as string, convertClaim(r)]));
    },
    async lastCommittedFile(org, exclude) {
      const { rows } = await q(
        "select id from public.fin_raw_diligence_files where org_id = $1 and status = 'committed' and id <> $2 order by committed_at desc limit 1",
        [org, exclude],
      );
      return rows[0] ?? null;
    },
    async claimNumbersSeenInFile(org, id) {
      const { rows } = await q(
        "select claim_activity_number from public.ins_claim_activities where org_id = $1 and last_seen_file_id = $2",
        [org, id],
      );
      return rows.map((r) => r.claim_activity_number);
    },
    async openException(org, rule, type, key, detail) {
      await q("select public.fin_open_exception($1,$2,$3,$4,null,$5::jsonb)", [
        org,
        rule,
        type,
        key,
        JSON.stringify(detail),
      ]);
    },
    async commit(a) {
      const { rows } = await q(
        "select public.ins_commit_import($1,$2,$3,$4::jsonb,$5::jsonb,$6,$7,$8) as r",
        [
          a.orgId,
          a.fileId,
          a.userId,
          JSON.stringify(a.rows),
          JSON.stringify(a.events),
          a.seen,
          a.missing,
          a.raiseMissing,
        ],
      );
      return rows[0].r;
    },
    async discard(org, id, reason) {
      await q("select public.ins_discard_import($1,$2,$3)", [org, id, reason]);
    },
    async claimsForMatching(org, scope, afterId, limit) {
      const params: unknown[] = [org, limit];
      let where = "org_id = $1";
      if (scope.kind === "file") {
        params.push(scope.fileId);
        where += ` and last_seen_file_id = $${params.length}`;
      } else {
        where += " and match_status <> 'matched'";
      }
      if (afterId) {
        params.push(afterId);
        where += ` and id > $${params.length}`;
      }
      const { rows } = await q(
        `select id, claim_activity_number, invoice_no, cpt_code, initial_net, net, quantity, clinician_id, activity_start_date
           from public.ins_claim_activities where ${where} order by id limit $2`,
        params,
      );
      return rows.map((r) => ({
        id: r.id,
        claim_activity_number: r.claim_activity_number,
        invoice_no: r.invoice_no,
        cpt_code: r.cpt_code,
        initial_net: r.initial_net === null ? null : Number(r.initial_net),
        net: r.net === null ? null : Number(r.net),
        quantity: r.quantity === null ? null : Number(r.quantity),
        clinician_id: r.clinician_id,
        activity_start_date: ymd(r.activity_start_date),
      }));
    },
    async invoicesByKeys(org, keys) {
      const { rows } = await q(
        "select id, inv_key, is_deleted, doctor_dha_id from public.fin_invoices where org_id = $1 and inv_key = any($2)",
        [org, keys],
      );
      const out = [];
      for (const inv of rows) {
        const lines = (
          await q(
            "select id, position, item_code, cpt_code, qty, line_net from public.fin_invoice_lines where invoice_id = $1 and is_current",
            [inv.id],
          )
        ).rows;
        out.push({
          id: inv.id,
          inv_key: inv.inv_key,
          is_deleted: inv.is_deleted,
          doctor_dha_id: inv.doctor_dha_id,
          lines: lines.map((l) => ({
            id: l.id,
            position: l.position,
            item_code: l.item_code,
            cpt_code: l.cpt_code,
            qty: l.qty === null ? null : Number(l.qty),
            line_net: l.line_net === null ? null : Number(l.line_net),
          })),
        });
      }
      return out;
    },
    async applyMatches(org, matches) {
      const { rows } = await q("select public.ins_apply_matches($1, $2::jsonb) as n", [
        org,
        JSON.stringify(matches),
      ]);
      return rows[0].n;
    },
  };
}

describe.skipIf(!TEST_DATABASE_URL)("Diligence import", () => {
  let c: Client;
  let store: DiligenceStore;
  let orgA: string;
  let orgB: string;
  let userA: string;
  let userB: string;

  const svc = <T>(fn: () => Promise<T>) => asServiceRole(c, fn);
  const q = (sql: string, p: unknown[] = []) => c.query(sql, p);
  const claim = (n: number, over: Record<string, unknown> = {}) =>
    row({ ClaimActivityNumber: `CA-TEST-${n}`, InvoiceNo: `ADMC/C/9000${n}`, ...over });
  const stage = async (
    org: string,
    rows: Array<Record<string, unknown>>,
    name = "f.xlsx",
    drop: string[] = [],
  ) =>
    stageDiligenceUpload(store, {
      orgId: org,
      userId: org === orgA ? userA : userB,
      fileName: name,
      storagePath: `${org}/diligence/${name}`,
      buffer: await xlsx(rows, drop),
    });
  const openExc = (org: string, rule: string) =>
    count(
      c,
      "select 1 from public.ops_exceptions where org_id = $1 and rule_code = $2 and status in ('open','in_progress')",
      [org, rule],
    );

  async function addInvoice(
    org: string,
    no: string,
    lines: Array<{ item: string; cpt: string; net: number; qty?: number }>,
    over: { deleted?: boolean; doctor?: string } = {},
  ) {
    const { rows } = await q(
      `insert into public.fin_invoices (org_id, inv_display_number, transaction_date, branch_code, inv_type, net, total, record_hash, is_deleted, doctor_dha_id)
       values ($1,$2,'2026-03-02','P','INSURANCE',100,100,'h',$3,$4) returning id`,
      [org, no, over.deleted ?? false, over.doctor ?? "DHA-TEST-1"],
    );
    let i = 0;
    for (const l of lines)
      await q(
        "insert into public.fin_invoice_lines (org_id, invoice_id, line_key, position, item_code, cpt_code, qty, line_net) values ($1,$2,$3,$4,$5,$6,$7,$8)",
        [org, rows[0].id, `${no}|${l.item}|${++i}`, i, l.item, l.cpt, l.qty ?? 1, l.net],
      );
    return rows[0].id as string;
  }

  beforeAll(async () => {
    c = await connect();
    await resetDb(c);
    userA = await createAuthUser(c, "dil-a@example.test");
    userB = await createAuthUser(c, "dil-b@example.test");
    orgA = await createOrg(c, "Org A", "org-a", userA);
    orgB = await createOrg(c, "Org B", "org-b", userB);
    store = pgStore(c);
  });
  beforeEach(async () => {
    await svc(async () => {
      await q(
        "truncate public.ins_claim_activities, public.fin_raw_diligence_files, public.fin_invoices, public.ops_exceptions cascade",
      );
    });
  });
  afterAll(async () => {
    await c.end();
  });

  it("stages a valid file: sanitised rows only, sums recorded, nothing committed yet", async () => {
    await svc(async () => {
      const out = await stage(orgA, [claim(1), claim(2, { NetAmt: 50 })]);
      expect(out.status).toBe("staged");
      if (out.status !== "staged") return;
      expect(out.stats).toMatchObject({ rows: 2, sumNet: 150 });
      const staged = (
        await q("select data from public.ins_staged_activities where file_id = $1", [out.fileId])
      ).rows;
      expect(staged).toHaveLength(2);
      const json = JSON.stringify(staged);
      for (const secret of [
        "000-0000-0000000-0",
        "MEMBER-TEST",
        "patient said something",
        "Test Patient One",
      ])
        expect(json).not.toContain(secret);
      expect(
        (
          await q("select status, row_count from public.fin_raw_diligence_files where id = $1", [
            out.fileId,
          ])
        ).rows[0],
      ).toMatchObject({ status: "validated", row_count: 2 });
      expect(await count(c, "select 1 from public.ins_claim_activities")).toBe(0);
    });
  });

  it("previews, commits, purges staging, and blocks the same file afterwards", async () => {
    await svc(async () => {
      const rows = [claim(1), claim(2)];
      const out = await stage(orgA, rows);
      if (out.status !== "staged") throw new Error("expected staged");
      const preview = await buildPreview(store, orgA, out.fileId);
      expect(preview?.counts).toEqual({ new: 2, changed: 0, unchanged: 0, missing: 0 });

      const res = await commitImport(store, {
        orgId: orgA,
        userId: userA,
        fileId: out.fileId,
        raiseMissing: false,
      });
      expect(res.summary).toMatchObject({ upserted: 2, events: 0 });
      expect(
        await count(c, "select 1 from public.ins_claim_activities where org_id = $1", [orgA]),
      ).toBe(2);
      expect(await count(c, "select 1 from public.ins_staged_activities")).toBe(0);
      const file = (
        await q(
          "select status, commit_summary, committed_by from public.fin_raw_diligence_files where id = $1",
          [out.fileId],
        )
      ).rows[0];
      expect(file).toMatchObject({ status: "committed", committed_by: userA });
      const first = (
        await q(
          "select first_seen_file_id, last_seen_file_id from public.ins_claim_activities limit 1",
        )
      ).rows[0];
      expect(first).toEqual({ first_seen_file_id: out.fileId, last_seen_file_id: out.fileId });
      expect(
        await count(
          c,
          "select 1 from public.fin_ref_payers where org_id = $1 and payer_id = 'PAYER-TEST'",
          [orgA],
        ),
      ).toBe(1);

      const again = await stage(orgA, rows);
      expect(again.status).toBe("duplicate");
      await expect(
        commitImport(store, {
          orgId: orgA,
          userId: userA,
          fileId: out.fileId,
          raiseMissing: false,
        }),
      ).rejects.toThrow(/cannot be committed/);
    });
  });

  it("re-staging identical bytes before confirming reuses the staged file", async () => {
    await svc(async () => {
      const buf = [claim(1)];
      const a = await stage(orgA, buf);
      const b = await stage(orgA, buf);
      expect(b.status).toBe("staged");
      expect(b.fileId).toBe(a.fileId);
      expect(await count(c, "select 1 from public.ins_staged_activities")).toBe(1);
    });
  });

  it("a changed file produces events only for the changed fields, and E06 for missing claims", async () => {
    await svc(async () => {
      const f1 = await stage(orgA, [claim(1), claim(2), claim(3)], "one.xlsx");
      if (f1.status !== "staged") throw new Error("staged");
      await commitImport(store, {
        orgId: orgA,
        userId: userA,
        fileId: f1.fileId,
        raiseMissing: true,
      });

      const f2 = await stage(
        orgA,
        [claim(1), claim(2, { RemittedAmt: 100, RejectedAmt: 0, ClaimStatus: "Paid" }), claim(4)],
        "two.xlsx",
      );
      if (f2.status !== "staged") throw new Error("staged");
      const preview = await buildPreview(store, orgA, f2.fileId);
      expect(preview?.counts).toEqual({ new: 1, changed: 1, unchanged: 1, missing: 1 });
      expect(preview?.changedFieldCounts).toEqual({ remitted: 1, rejected: 1, claim_status: 1 });
      expect(preview?.looksFiltered).toBe(true); // 1 of 3 missing

      const res = await commitImport(store, {
        orgId: orgA,
        userId: userA,
        fileId: f2.fileId,
        raiseMissing: true,
      });
      expect(res.summary).toMatchObject({ upserted: 2, events: 1, missing_raised: 1 });
      const ev = (await q("select changed_fields from public.ins_claim_activity_events")).rows;
      expect(ev).toHaveLength(1);
      expect(ev[0].changed_fields).toEqual({
        remitted: { old: 60, new: 100 },
        rejected: { old: 40, new: 0 },
        claim_status: { old: "Partially Paid", new: "Paid" },
      });
      expect(await openExc(orgA, "E06")).toBe(1);
      expect(
        (await q("select entity_key from public.ops_exceptions where rule_code = 'E06'")).rows[0]
          .entity_key,
      ).toBe("CA-TEST-3");
      // the unchanged claim moved to the new file; the missing one stayed on the old file
      const seen = Object.fromEntries(
        (
          await q(
            "select claim_activity_number n, last_seen_file_id f from public.ins_claim_activities",
          )
        ).rows.map((r) => [r.n, r.f]),
      );
      expect(seen["CA-TEST-1"]).toBe(f2.fileId);
      expect(seen["CA-TEST-3"]).toBe(f1.fileId);

      // CA-TEST-3 reappears in a later file: its E06 closes by itself
      const f3 = await stage(
        orgA,
        [
          claim(1),
          claim(2, { RemittedAmt: 100, RejectedAmt: 0, ClaimStatus: "Paid" }),
          claim(3),
          claim(4),
        ],
        "three.xlsx",
      );
      if (f3.status !== "staged") throw new Error("staged");
      await commitImport(store, {
        orgId: orgA,
        userId: userA,
        fileId: f3.fileId,
        raiseMissing: true,
      });
      expect(await openExc(orgA, "E06")).toBe(0);
    });
  });

  it("raiseMissing = false raises no E06 (filtered export)", async () => {
    await svc(async () => {
      const f1 = await stage(orgA, [claim(1), claim(2)], "one.xlsx");
      if (f1.status !== "staged") throw new Error("staged");
      await commitImport(store, {
        orgId: orgA,
        userId: userA,
        fileId: f1.fileId,
        raiseMissing: true,
      });
      const f2 = await stage(orgA, [claim(1)], "two.xlsx");
      if (f2.status !== "staged") throw new Error("staged");
      await commitImport(store, {
        orgId: orgA,
        userId: userA,
        fileId: f2.fileId,
        raiseMissing: false,
      });
      expect(await openExc(orgA, "E06")).toBe(0);
    });
  });

  it("rejects an invalid file with E10 and lets the same bytes be retried", async () => {
    await svc(async () => {
      const bad = await stage(orgA, [claim(1)], "bad.xlsx", ["InvoiceNo"]);
      expect(bad.status).toBe("rejected");
      if (bad.status !== "rejected") return;
      expect(bad.header.missingRequired).toEqual(["invoice_no"]);
      expect(await openExc(orgA, "E10")).toBe(1);
      expect(await count(c, "select 1 from public.ins_staged_activities")).toBe(0);
      const again = await stage(orgA, [claim(1)], "bad.xlsx", ["InvoiceNo"]); // same bytes: allowed after a rejection
      expect(again.status).toBe("rejected");
      expect(again.fileId).toBe(bad.fileId);
    });
  });

  it("discarding removes the staged rows and rejects the file", async () => {
    await svc(async () => {
      const out = await stage(orgA, [claim(1)]);
      if (out.status !== "staged") throw new Error("staged");
      await discardImport(store, orgA, out.fileId);
      expect(await count(c, "select 1 from public.ins_staged_activities")).toBe(0);
      expect(
        (await q("select status from public.fin_raw_diligence_files where id = $1", [out.fileId]))
          .rows[0].status,
      ).toBe("rejected");
    });
  });

  it("matches claims to invoice lines, and picks up an invoice that arrives later", async () => {
    await svc(async () => {
      const out = await stage(orgA, [
        claim(1),
        claim(2, {
          InvoiceNo: "ADMC/C/90001" /* same invoice, other line */,
          CPTCode: "T-TEST-2",
          InitialNetAmt: 25,
        }),
      ]);
      if (out.status !== "staged") throw new Error("staged");
      const res = await commitImport(store, {
        orgId: orgA,
        userId: userA,
        fileId: out.fileId,
        raiseMissing: false,
      });
      expect(res.matched.examined).toBe(2);
      expect(
        (await q("select match_status, match_reason from public.ins_claim_activities")).rows.every(
          (r) => r.match_reason === "no_invoice",
        ),
      ).toBe(true);

      const invId = await addInvoice(orgA, "ADMC/C/90001", [
        { item: "T-X", cpt: "99213", net: 100 },
        { item: "T-TEST-2", cpt: "", net: 25 },
      ]);
      const m = await matchClaimsForOrg(store, orgA, { kind: "unresolved" });
      expect(m.changed).toBe(2);
      const rows = (
        await q(
          "select claim_activity_number n, match_status s, match_reason r, matched_invoice_id i, matched_line_id l from public.ins_claim_activities order by 1",
        )
      ).rows;
      expect(rows.map((r) => [r.n, r.s, r.r, r.i === invId])).toEqual([
        ["CA-TEST-1", "matched", "ok", true],
        ["CA-TEST-2", "matched", "ok", true],
      ]);
      expect(rows.every((r) => r.l)).toBe(true);
      // idempotent
      expect((await matchClaimsForOrg(store, orgA, { kind: "unresolved" })).examined).toBe(0);
    });
  });

  it("records ambiguity, deleted invoices, amount mismatches and clinician mismatches", async () => {
    await svc(async () => {
      const out = await stage(orgA, [
        claim(1, { InvoiceNo: "ADMC/C/AMB" }),
        claim(2, { InvoiceNo: "ADMC/C/DEL" }),
        claim(3, { InvoiceNo: "ADMC/C/AMT", InitialNetAmt: 90 }),
        claim(4, { InvoiceNo: "ADMC/C/CLIN", Clinician: "DHA-OTHER" }),
      ]);
      if (out.status !== "staged") throw new Error("staged");
      await commitImport(store, {
        orgId: orgA,
        userId: userA,
        fileId: out.fileId,
        raiseMissing: false,
      });
      await addInvoice(orgA, "ADMC/C/AMB", [
        { item: "A", cpt: "99213", net: 100 },
        { item: "B", cpt: "99213", net: 100 },
      ]);
      await addInvoice(orgA, "ADMC/C/DEL", [{ item: "A", cpt: "99213", net: 100 }], {
        deleted: true,
      });
      await addInvoice(orgA, "ADMC/C/AMT", [{ item: "A", cpt: "99213", net: 100 }]);
      await addInvoice(orgA, "ADMC/C/CLIN", [{ item: "A", cpt: "99213", net: 100 }]);
      await matchClaimsForOrg(store, orgA, { kind: "unresolved" });
      const r = Object.fromEntries(
        (
          await q(
            "select claim_activity_number n, match_status s, match_reason r, clinician_mismatch cm from public.ins_claim_activities",
          )
        ).rows.map((x) => [x.n, x]),
      );
      expect(r["CA-TEST-1"]).toMatchObject({ s: "ambiguous", r: "ambiguous" });
      expect(r["CA-TEST-2"]).toMatchObject({ s: "unmatched", r: "invoice_deleted" });
      expect(r["CA-TEST-3"]).toMatchObject({ s: "unmatched", r: "amount_mismatch" });
      expect(r["CA-TEST-4"]).toMatchObject({ s: "matched", r: "ok", cm: true });
    });
  });

  it("keeps organisations apart: the same claim number can exist in both", async () => {
    await svc(async () => {
      const a = await stage(orgA, [claim(1)], "a.xlsx");
      const b = await stage(orgB, [claim(1)], "a.xlsx"); // same bytes, other org: not a duplicate
      if (a.status !== "staged" || b.status !== "staged") throw new Error("staged");
      await commitImport(store, {
        orgId: orgA,
        userId: userA,
        fileId: a.fileId,
        raiseMissing: false,
      });
      await commitImport(store, {
        orgId: orgB,
        userId: userB,
        fileId: b.fileId,
        raiseMissing: false,
      });
      expect(await count(c, "select 1 from public.ins_claim_activities")).toBe(2);
      await expect(
        q("select public.ins_commit_import($1,$2,$3,'[]','[]','{}','{}',false)", [
          orgA,
          b.fileId,
          userA,
        ]),
      ).rejects.toThrow(/not found in org/);
    });
  });

  it("staged rows and the commit functions are closed to members", async () => {
    await svc(async () => {
      await stage(orgA, [claim(1)]);
    });
    await asUser(c, userA, async () => {
      expect(await count(c, "select 1 from public.ins_staged_activities")).toBe(0);
      await expect(
        q(
          "select public.ins_commit_import($1, gen_random_uuid(), $2, '[]', '[]', '{}', '{}', false)",
          [orgA, userA],
        ),
      ).rejects.toThrow(/permission denied/);
      await expect(q("select public.ins_apply_matches($1, '[]')", [orgA])).rejects.toThrow(
        /permission denied/,
      );
    });
  });

  it("purges unconfirmed staging after 7 days and marks the file expired", async () => {
    await svc(async () => {
      const out = await stage(orgA, [claim(1)]);
      if (out.status !== "staged") throw new Error("staged");
      await q(
        "update public.fin_raw_diligence_files set uploaded_at = now() - interval '8 days' where id = $1",
        [out.fileId],
      );
      const { rows } = await q("select public.ins_purge_stale_staging() as n");
      expect(rows[0].n).toBe(1);
      expect(await count(c, "select 1 from public.ins_staged_activities")).toBe(0);
      expect(
        (
          await q("select status, errors from public.fin_raw_diligence_files where id = $1", [
            out.fileId,
          ])
        ).rows[0],
      ).toMatchObject({ status: "rejected", errors: [{ row: null, code: "expired" }] });
    });
  });
});
