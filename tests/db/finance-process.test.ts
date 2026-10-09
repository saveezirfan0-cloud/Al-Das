/**
 * Raw batch -> fin_* tables: the real TypeScript mapper + processBatch against the
 * real SQL (fin_apply_invoices) on a plain Postgres. Synthetic data only.
 */
import type { Client } from "pg";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { mapBatch } from "@/lib/finance/map-invoice";
import { processBatch, type ProcessDeps } from "@/lib/finance/process-batch";

import { rawInvoice, rawLine, rawPayment } from "../unit/finance/factory";
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

describe.skipIf(!TEST_DATABASE_URL)("Finance batch processing", () => {
  let c: Client;
  let orgA: string;
  let orgB: string;
  let admin: string;

  const q = (sql: string, params: unknown[] = []) => c.query(sql, params);
  const svc = <T>(fn: () => Promise<T>) => asServiceRole(c, fn);

  const deps: ProcessDeps = {
    loadBatch: async (id) => {
      const { rows } = await q(
        "select id, org_id, payload, record_count from public.fin_raw_unite_batches where id = $1",
        [id],
      );
      return rows[0]
        ? {
            id: rows[0].id,
            orgId: rows[0].org_id,
            payload: rows[0].payload,
            recordCount: rows[0].record_count,
          }
        : null;
    },
    apply: async (org, batch, invoices, duplicates) => {
      const { rows } = await q("select public.fin_apply_invoices($1, $2, $3::jsonb, $4) as r", [
        org,
        batch,
        JSON.stringify(invoices),
        duplicates,
      ]);
      return rows[0].r;
    },
    markFailed: async (batch, error) => {
      await q("select public.fin_batch_mark_failed($1, $2)", [batch, error]);
    },
  };

  async function rawBatch(
    org: string,
    data: unknown[],
    requestedAt = "2026-10-01T10:00:00Z",
    recordCount: number | null = data.length,
  ) {
    const { rows } = await q(
      `insert into public.fin_raw_unite_batches (org_id, requested_at, from_date, to_date, count_requested, record_count, payload)
       values ($1, $2, '2026-01-01', '2026-10-09', 50, $3, $4::jsonb) returning id`,
      [
        org,
        requestedAt,
        recordCount,
        JSON.stringify({ MessageStatus: "Success", DataBalancetoSync: 0, Data: data }),
      ],
    );
    return rows[0].id as string;
  }
  const inv = async (org: string, no = "ADMC/C/90001") =>
    (
      await q("select * from public.fin_invoices where org_id = $1 and inv_display_number = $2", [
        org,
        no,
      ])
    ).rows[0];
  const openExceptions = async (org: string, rule: string) =>
    count(
      c,
      "select 1 from public.ops_exceptions where org_id = $1 and rule_code = $2 and status in ('open','in_progress')",
      [org, rule],
    );

  beforeAll(async () => {
    c = await connect();
    await resetDb(c);
    admin = await createAuthUser(c, "fin-admin@example.test");
    const other = await createAuthUser(c, "fin-other@example.test");
    orgA = await createOrg(c, "Org A", "org-a", admin);
    orgB = await createOrg(c, "Org B", "org-b", other);
  });
  beforeEach(async () => {
    await svc(async () => {
      await q("truncate public.fin_raw_unite_batches, public.ops_exceptions cascade");
      await q("delete from public.fin_ref_doctors");
      await q("delete from public.fin_ref_services");
      await q("update public.fin_ref_branches set unite_clinic_long_name = null");
    });
    await q("delete from pgmq.q_finance_capture");
  });
  afterAll(async () => {
    await c.end();
  });

  it("processes a raw batch end to end and fills reference data", async () => {
    await svc(async () => {
      await q(
        "update public.fin_ref_branches set unite_clinic_long_name = 'Test Clinic One' where org_id = $1 and code = 'P'",
        [orgA],
      );
      const id = await rawBatch(orgA, [
        rawInvoice(),
        rawInvoice({
          InvDisplayNumber: "ADMC/90002",
          ItemsDetails: [rawLine({ ItemCode: "T-TEST-2" }), rawLine({ ItemCode: "T-TEST-2" })],
          PaymentDetails: [],
        }),
      ]);
      const res = await processBatch(deps, id);
      expect(res).toMatchObject({
        ok: true,
        counts: { invoices: 2, created: 2, lines: 3, payments: 1 },
      });

      const a = await inv(orgA);
      expect(a).toMatchObject({
        branch_code: "P",
        version: 1,
        patient_pin: "PIN-TEST-1",
        is_deleted: false,
      });
      expect(Number(a.net)).toBe(100);
      expect(
        a.transaction_date.toISOString?.().slice(0, 10) ?? String(a.transaction_date),
      ).toContain("2026");
      const lines = (
        await q(
          "select line_key from public.fin_invoice_lines where org_id = $1 order by line_key",
          [orgA],
        )
      ).rows.map((r) => r.line_key);
      expect(lines).toEqual([
        "ADMC/90002|T-TEST-2|1",
        "ADMC/90002|T-TEST-2|2",
        "ADMC/C/90001|T-TEST-1|1",
      ]);
      expect(
        (
          await q(
            "select process_status, process_counts from public.fin_raw_unite_batches where id = $1",
            [id],
          )
        ).rows[0].process_status,
      ).toBe("processed");
      expect(
        (
          await q(
            "select service_category from public.fin_ref_services where org_id = $1 and item_code = 'T-TEST-1'",
            [orgA],
          )
        ).rows[0].service_category,
      ).toBe("Unmapped");
      expect(
        await count(
          c,
          "select 1 from public.fin_ref_doctors where org_id = $1 and dha_id = 'DHA-TEST-1'",
          [orgA],
        ),
      ).toBe(1);
      expect(
        await count(c, "select 1 from public.fin_invoice_versions where org_id = $1", [orgA]),
      ).toBe(2);
    });
  });

  it("is idempotent: processing the same batch twice changes nothing", async () => {
    await svc(async () => {
      const id = await rawBatch(orgA, [rawInvoice()]);
      await processBatch(deps, id);
      const before = JSON.stringify(await inv(orgA));
      const second = await processBatch(deps, id);
      expect(second).toMatchObject({
        ok: true,
        counts: { created: 0, updated: 0, unchanged: 1, versions: 0 },
      });
      expect(JSON.stringify(await inv(orgA))).toBe(before);
      expect(await count(c, "select 1 from public.fin_invoice_versions")).toBe(1);
      expect(await count(c, "select 1 from public.fin_invoice_lines")).toBe(1);
    });
  });

  it("records an amendment as version 2 and keeps the history", async () => {
    await svc(async () => {
      await processBatch(deps, await rawBatch(orgA, [rawInvoice()], "2026-10-01T10:00:00Z"));
      const res = await processBatch(
        deps,
        await rawBatch(
          orgA,
          [
            rawInvoice({
              NetAmount: "80.00",
              TotalAmount: "80.00",
              ItemsDetails: [rawLine({ NetAmount: "80.00" })],
            }),
          ],
          "2026-10-02T10:00:00Z",
        ),
      );
      expect(res).toMatchObject({ ok: true, counts: { updated: 1, versions: 1 } });
      const a = await inv(orgA);
      expect(a.version).toBe(2);
      expect(Number(a.net)).toBe(80);
      const versions = (
        await q("select version from public.fin_invoice_versions order by version")
      ).rows.map((r) => r.version);
      expect(versions).toEqual([1, 2]);
      expect(
        Number((await q("select line_net from public.fin_invoice_lines")).rows[0].line_net),
      ).toBe(80);
    });
  });

  it("never deletes lines or payments: absent ones become not current and can return", async () => {
    await svc(async () => {
      const both = rawInvoice({
        ItemsDetails: [rawLine(), rawLine({ ItemCode: "T-TEST-2" })],
        PaymentDetails: [
          rawPayment(),
          rawPayment({ InstalmentNo: 2, ReceiptNumber: "R-2", Paid: "5" }),
        ],
      });
      await processBatch(deps, await rawBatch(orgA, [both], "2026-10-01T10:00:00Z"));
      const one = rawInvoice({ ItemsDetails: [rawLine()], PaymentDetails: [rawPayment()] });
      await processBatch(deps, await rawBatch(orgA, [one], "2026-10-02T10:00:00Z"));
      expect(await count(c, "select 1 from public.fin_invoice_lines")).toBe(2);
      expect(await count(c, "select 1 from public.fin_invoice_lines where is_current")).toBe(1);
      expect(await count(c, "select 1 from public.fin_payments")).toBe(2);
      expect(await count(c, "select 1 from public.fin_payments where is_current")).toBe(1);
      await processBatch(deps, await rawBatch(orgA, [both], "2026-10-03T10:00:00Z"));
      expect(await count(c, "select 1 from public.fin_invoice_lines where is_current")).toBe(2);
      expect(await count(c, "select 1 from public.fin_payments where is_current")).toBe(2);
    });
  });

  it("captures deletion, a refund and a later instalment", async () => {
    await svc(async () => {
      await processBatch(deps, await rawBatch(orgA, [rawInvoice()], "2026-10-01T10:00:00Z"));
      await processBatch(
        deps,
        await rawBatch(
          orgA,
          [
            rawInvoice({
              IsDeleted: "Y",
              PaymentDetails: [
                rawPayment({ Refund: "100", RefundDate: "04-03-2026" }),
                rawPayment({ InstalmentNo: 2, ReceiptNumber: "R-9", Paid: "10" }),
              ],
            }),
          ],
          "2026-10-02T10:00:00Z",
        ),
      );
      expect((await inv(orgA)).is_deleted).toBe(true);
      const pays = (
        await q("select payment_key, refund from public.fin_payments order by payment_key")
      ).rows;
      expect(pays).toHaveLength(2);
      expect(Number(pays.find((p) => p.payment_key.endsWith("R-TEST-1")).refund)).toBe(100);
    });
  });

  it("opens E07 for an unknown clinic and auto-closes it once the clinic is mapped", async () => {
    await svc(async () => {
      await processBatch(deps, await rawBatch(orgA, [rawInvoice()]));
      expect((await inv(orgA)).branch_code).toBeNull();
      expect(await openExceptions(orgA, "E07")).toBe(1);

      await q(
        "update public.fin_ref_branches set unite_clinic_long_name = 'Test Clinic One' where org_id = $1 and code = 'M'",
        [orgA],
      );
      const { rows } = await q("select public.fin_rederive_branches($1) as n", [orgA]);
      expect(rows[0].n).toBe(1);
      expect((await inv(orgA)).branch_code).toBe("M");
      expect(await openExceptions(orgA, "E07")).toBe(0);
      expect(
        (await q("select status from public.ops_exceptions where rule_code = 'E07'")).rows[0]
          .status,
      ).toBe("auto_closed");
    });
  });

  it("a replay of an OLDER batch never overwrites newer state", async () => {
    await svc(async () => {
      const older = await rawBatch(orgA, [rawInvoice()], "2026-10-01T10:00:00Z");
      await processBatch(deps, older);
      await processBatch(
        deps,
        await rawBatch(
          orgA,
          [rawInvoice({ NetAmount: "70.00", TotalAmount: "70.00" })],
          "2026-10-02T10:00:00Z",
        ),
      );
      expect(Number((await inv(orgA)).net)).toBe(70);

      const replay = await processBatch(deps, older);
      expect(replay).toMatchObject({ ok: true, counts: { stale: 1, unchanged: 0 } }); // older than what is stored now
      expect(Number((await inv(orgA)).net)).toBe(70); // not regressed
      expect((await inv(orgA)).version).toBe(2);

      // a never-before-applied older batch only records history
      const older2 = await rawBatch(
        orgA,
        [rawInvoice({ NetAmount: "60.00", TotalAmount: "60.00" })],
        "2026-09-30T10:00:00Z",
      );
      const r2 = await processBatch(deps, older2);
      expect(r2).toMatchObject({ ok: true, counts: { stale: 1, created: 0, updated: 0 } });
      expect(Number((await inv(orgA)).net)).toBe(70);
      expect(
        await count(c, "select 1 from public.fin_invoice_versions where batch_id = $1", [older2]),
      ).toBe(1);
    });
  });

  it("a duplicate invoice inside one batch keeps the last occurrence and does not block the batch", async () => {
    await svc(async () => {
      const id = await rawBatch(orgA, [
        rawInvoice(),
        rawInvoice({ NetAmount: "55.00", TotalAmount: "55.00" }),
      ]);
      const res = await processBatch(deps, id);
      expect(res).toMatchObject({ ok: true, counts: { invoices: 1, duplicates: 1 } });
      expect(Number((await inv(orgA)).net)).toBe(55);
      expect(
        (await q("select process_status from public.fin_raw_unite_batches where id = $1", [id]))
          .rows[0].process_status,
      ).toBe("processed");
    });
  });

  it("a replay never blanks txn_ref_name (stripped payloads do not carry it)", async () => {
    await svc(async () => {
      await processBatch(
        deps,
        await rawBatch(
          orgA,
          [rawInvoice({ PaymentDetails: [rawPayment({ TxnRefName: "Test Holder" })] })],
          "2026-10-01T10:00:00Z",
        ),
      );
      await processBatch(
        deps,
        await rawBatch(
          orgA,
          [rawInvoice({ PaymentDetails: [rawPayment()] })],
          "2026-10-02T10:00:00Z",
        ),
      );
      expect((await q("select txn_ref_name from public.fin_payments")).rows[0].txn_ref_name).toBe(
        "Test Holder",
      );
    });
  });

  it("is atomic: a bad record rolls the whole batch back", async () => {
    await svc(async () => {
      const id = await rawBatch(orgA, [
        rawInvoice(),
        rawInvoice({ InvDisplayNumber: "ADMC/90002" }),
      ]);
      const good = mapBatch([
        rawInvoice(),
        rawInvoice({ InvDisplayNumber: "ADMC/90002" }),
      ]).invoices;
      (good[1].lines[0] as { line_key: string | null }).line_key = null; // violates NOT NULL inside the transaction
      await expect(
        q("select public.fin_apply_invoices($1, $2, $3::jsonb)", [orgA, id, JSON.stringify(good)]),
      ).rejects.toThrow();
      expect(await count(c, "select 1 from public.fin_invoices")).toBe(0);
      expect(
        (await q("select process_status from public.fin_raw_unite_batches where id = $1", [id]))
          .rows[0].process_status,
      ).toBe("received");
    });
  });

  it("rejects a count mismatch and a batch from another org", async () => {
    await svc(async () => {
      const id = await rawBatch(
        orgA,
        [rawInvoice(), rawInvoice({ InvDisplayNumber: "ADMC/90002" })],
        undefined,
        2,
      );
      const one = mapBatch([rawInvoice()]).invoices;
      await expect(
        q("select public.fin_apply_invoices($1, $2, $3::jsonb)", [orgA, id, JSON.stringify(one)]),
      ).rejects.toThrow(/count mismatch/);
      await expect(
        q("select public.fin_apply_invoices($1, $2, $3::jsonb)", [
          orgB,
          id,
          JSON.stringify(
            mapBatch([rawInvoice(), rawInvoice({ InvDisplayNumber: "ADMC/90002" })]).invoices,
          ),
        ]),
      ).rejects.toThrow(/not found in org/);
      expect(await count(c, "select 1 from public.fin_invoices")).toBe(0);
    });
  });

  it("a mapping failure keeps the raw batch, opens E09, and a replay after the fix recovers", async () => {
    await svc(async () => {
      const id = await rawBatch(orgA, [rawInvoice({ NetAmount: undefined })]);
      const res = await processBatch(deps, id);
      expect(res).toMatchObject({ ok: false, error: expect.stringContaining("net is missing") });
      const row = (
        await q(
          "select process_status, error, payload is not null as kept from public.fin_raw_unite_batches where id = $1",
          [id],
        )
      ).rows[0];
      expect(row).toMatchObject({ process_status: "failed", kept: true });
      expect(await openExceptions(orgA, "E09")).toBe(1);
      expect(await count(c, "select 1 from public.fin_invoices")).toBe(0);

      // "fix the mapping": here, correct the stored payload; the replay path is identical
      await q("update public.fin_raw_unite_batches set payload = $2::jsonb where id = $1", [
        id,
        JSON.stringify({ Data: [rawInvoice()] }),
      ]);
      expect(await processBatch(deps, id)).toMatchObject({ ok: true });
      expect(await openExceptions(orgA, "E09")).toBe(0);
      expect(
        (
          await q("select process_status, error from public.fin_raw_unite_batches where id = $1", [
            id,
          ])
        ).rows[0],
      ).toMatchObject({ process_status: "processed", error: null });
    });
  });

  it("kill-after-raw: a replay produces exactly what a direct run produces", async () => {
    await svc(async () => {
      const data = [
        rawInvoice(),
        rawInvoice({
          InvDisplayNumber: "ADMC/90002",
          ItemsDetails: [rawLine(), rawLine()],
          PaymentDetails: [
            rawPayment({ Paid: "10" }),
            rawPayment({ InstalmentNo: 2, ReceiptNumber: "R-2" }),
          ],
        }),
      ];
      await processBatch(deps, await rawBatch(orgA, data)); // direct run in org A

      // org B: the raw row exists but processing "died" (status stays received), then a replay runs
      const idB = await rawBatch(orgB, data);
      expect(
        (await q("select process_status from public.fin_raw_unite_batches where id = $1", [idB]))
          .rows[0].process_status,
      ).toBe("received");
      await processBatch(deps, idB);

      const dump = async (org: string) => ({
        invoices: (
          await q(
            "select inv_display_number, version, record_hash, net, total, patient_pin, branch_code from public.fin_invoices where org_id = $1 order by 1",
            [org],
          )
        ).rows,
        lines: (
          await q(
            "select line_key, line_net, is_current from public.fin_invoice_lines where org_id = $1 order by 1",
            [org],
          )
        ).rows,
        payments: (
          await q(
            "select payment_key, paid, is_current from public.fin_payments where org_id = $1 order by 1",
            [org],
          )
        ).rows,
        services: (
          await q(
            "select item_code, service_category from public.fin_ref_services where org_id = $1 order by 1",
            [org],
          )
        ).rows,
      });
      expect(await dump(orgB)).toEqual(await dump(orgA));
    });
  });

  it("reports gaps inside each invoice-number series", async () => {
    await svc(async () => {
      const nos = ["ADMC/C/90001", "ADMC/C/90002", "ADMC/C/90005", "ADMC/90010", "ADMC/90012"];
      await processBatch(
        deps,
        await rawBatch(
          orgA,
          nos.map((n) => rawInvoice({ InvDisplayNumber: n })),
        ),
      );
      const { rows } = await q("select * from public.fin_invoice_number_gaps($1, '2026-01-01')", [
        orgA,
      ]);
      expect(
        rows.map((r) => [
          r.series,
          Number(r.missing_from),
          Number(r.missing_to),
          Number(r.missing_count),
        ]),
      ).toEqual([
        ["ADMC/", 90011, 90011, 1],
        ["ADMC/C/", 90003, 90004, 2],
      ]);
      expect(
        (await q("select * from public.fin_invoice_number_gaps($1, '2027-01-01')", [orgA])).rows,
      ).toHaveLength(0);
    });
  });

  it("exception helpers are idempotent and respect inactive rules", async () => {
    await svc(async () => {
      const open = () =>
        q("select public.fin_open_exception($1, 'E09', 'batch', 'k1') as id", [orgA]);
      const first = (await open()).rows[0].id;
      const again = (await open()).rows[0].id;
      expect(first).toBeTruthy();
      expect(again).toBeNull(); // already open
      expect(await openExceptions(orgA, "E09")).toBe(1);
      await q(
        "update public.fin_ref_exception_rules set active = false where org_id = $1 and rule_code = 'E07'",
        [orgA],
      );
      expect(
        (await q("select public.fin_open_exception($1, 'E07', 'invoice', 'x') as id", [orgA]))
          .rows[0].id,
      ).toBeNull();
      await q(
        "update public.fin_ref_exception_rules set active = true where org_id = $1 and rule_code = 'E07'",
        [orgA],
      );
    });
  });

  it("the daily maintenance message is enqueued once per org, enabled or not", async () => {
    const run = () =>
      svc(
        async () => (await q("select public.fin_maintenance_enqueue() as n")).rows[0].n as number,
      );
    const orgs = (await q("select count(*)::int as n from public.fin_capture_settings")).rows[0]
      .n as number;
    expect(await run()).toBe(orgs);
    expect(await run()).toBe(0);
    const kinds = (
      await q("select distinct message ->> 'kind' as k from pgmq.q_finance_capture")
    ).rows.map((r) => r.k);
    expect(kinds).toEqual(["maintenance"]);
  });

  it("new orgs start with one batch per run", async () => {
    const { rows } = await q(
      "select max_batches_per_run from public.fin_capture_settings where org_id = $1",
      [orgA],
    );
    expect(rows[0].max_batches_per_run).toBe(1);
  });

  it("the hourly tick enqueues one message per ENABLED org, without duplicates", async () => {
    const tick = () =>
      svc(
        async () => (await q("select public.fin_capture_enqueue_ticks() as n")).rows[0].n as number,
      );
    await q("update public.fin_capture_settings set enabled = false");
    expect(await tick()).toBe(0);
    await q("update public.fin_capture_settings set enabled = true where org_id = $1", [orgA]);
    expect(await tick()).toBe(1);
    expect(await tick()).toBe(0);
    const { rows } = await q("select message from pgmq.q_finance_capture");
    expect(rows).toHaveLength(1);
    expect(rows[0].message).toEqual({ kind: "tick", org_id: orgA });
    await q("update public.fin_capture_settings set enabled = false");
  });

  it("credentials and the API call log are invisible and unwritable for members", async () => {
    await svc(async () => {
      await q(
        "insert into public.integration_accounts (org_id, kind, config_enc) values ($1, 'unite', 'v1.x.y.z') on conflict do nothing",
        [orgA],
      );
      await q(
        "insert into public.unite_api_calls (org_id, endpoint, http_status) values ($1, 'authorize', 200)",
        [orgA],
      );
    });
    await asUser(c, admin, async () => {
      expect(await count(c, "select 1 from public.integration_accounts")).toBe(0);
      expect(await count(c, "select 1 from public.unite_api_calls")).toBe(0);
      await expect(
        q(
          "insert into public.integration_accounts (org_id, kind, config_enc) values ($1, 'x', 'y')",
          [orgA],
        ),
      ).rejects.toThrow();
      await expect(
        q("select public.fin_apply_invoices($1, gen_random_uuid(), '[]'::jsonb)", [orgA]),
      ).rejects.toThrow(/permission denied/);
    });
  });
});
