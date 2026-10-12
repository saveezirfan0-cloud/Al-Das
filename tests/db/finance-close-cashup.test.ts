/**
 * Month-end close and cash-up, database side. The lock is enforced by triggers that apply to EVERY role including the
 * service role: once both sign-offs are in, the close row, its snapshot and the cash-ups of that month cannot change.
 * Sign-offs are bound to the hash the signer saw and must come from two different people. Synthetic data only.
 */
import type { Client } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import {
  asServiceRole,
  asUser,
  connect,
  createAuthUser,
  createOrg,
  resetDb,
  TEST_DATABASE_URL,
} from "./helpers";

describe.skipIf(!TEST_DATABASE_URL)("phase 18: month-end close lock and cash-up", () => {
  let c: Client;
  let alice: string; // admin A
  let finance: string;
  let ceo: string;
  let orgA: string;
  let orgB: string;
  const q = (sql: string, params: unknown[] = []) => c.query(sql, params);
  /** Runs one statement in its own transaction that is ALWAYS rolled back; resolves to "ok" or "<sqlstate>:<message>". */
  const code = async (sql: string, params: unknown[] = []) => {
    await q("begin");
    try {
      await q(sql, params);
      return "ok";
    } catch (e) {
      return `${(e as { code?: string }).code}:${(e as Error).message}`;
    } finally {
      await q("rollback");
    }
  };
  const snap = (n: number) =>
    JSON.stringify({ version: 1, month: "2026-08-01", totals: { generated: n } });
  const hashOf = async (id: string) =>
    (await q("select snapshot_hash as h from public.fin_period_closes where id = $1", [id])).rows[0]
      .h as string;
  const statusOf = async (id: string) =>
    (await q("select status from public.fin_period_closes where id = $1", [id])).rows[0]
      .status as string;

  beforeAll(async () => {
    c = await connect();
    await resetDb(c);
    alice = await createAuthUser(c, "alice@example.test");
    finance = await createAuthUser(c, "finance@example.test");
    ceo = await createAuthUser(c, "ceo@example.test");
    const bob = await createAuthUser(c, "bob@example.test");
    orgA = await createOrg(c, "Org A", "org-a", alice);
    orgB = await createOrg(c, "Org B", "org-b", bob);
  });
  afterAll(async () => {
    await resetDb(c);
    await c.end();
  });

  describe("close lifecycle", () => {
    let id: string;
    it("only closes a month that has ended", async () => {
      await asServiceRole(c, async () => {
        const now = await code(
          "select public.fin_close_store_snapshot($1, date_trunc('month', current_date)::date, $2, $3::jsonb)",
          [orgA, finance, snap(1)],
        );
        expect(now).toMatch(/has ended/);
        const future = await code(
          "select public.fin_close_store_snapshot($1, (date_trunc('month', current_date) + interval '2 months')::date, $2, $3::jsonb)",
          [orgA, finance, snap(1)],
        );
        expect(future).toMatch(/has ended/);
      });
    });

    it("stores a snapshot with its sha256, and a rebuild replaces both", async () => {
      await asServiceRole(c, async () => {
        id = (
          await q("select public.fin_close_store_snapshot($1, '2026-08-17', $2, $3::jsonb) as id", [
            orgA,
            finance,
            snap(100),
          ])
        ).rows[0].id;
        const row = (
          await q(
            "select month::text, status, snapshot_hash, encode(sha256(convert_to(snapshot::text, 'UTF8')), 'hex') as expected, built_by from public.fin_period_closes where id = $1",
            [id],
          )
        ).rows[0];
        expect(row).toMatchObject({ month: "2026-08-01", status: "built", built_by: finance });
        expect(row.snapshot_hash).toBe(row.expected);
        const first = row.snapshot_hash;
        await q("select public.fin_close_store_snapshot($1, '2026-08-01', $2, $3::jsonb)", [
          orgA,
          finance,
          snap(200),
        ]);
        expect(await hashOf(id)).not.toBe(first);
        expect(
          (
            await q(
              "select count(*)::int as n from public.fin_period_closes where org_id = $1 and month = '2026-08-01'",
              [orgA],
            )
          ).rows[0].n,
        ).toBe(1);
      });
    });

    it("binds a sign-off to the hash the signer was looking at", async () => {
      await asServiceRole(c, async () => {
        const stale = "0".repeat(64);
        expect(
          await code("select public.fin_close_sign_finance($1, $2, $3, $4, 'ok')", [
            orgA,
            id,
            finance,
            stale,
          ]),
        ).toMatch(/changed since you opened/);
        expect(await statusOf(id)).toBe("built");
      });
    });

    it("cannot be signed by the CEO before finance, nor for a close of another org", async () => {
      await asServiceRole(c, async () => {
        expect(
          await code("select public.fin_close_sign_ceo($1, $2, $3, $4, null)", [
            orgA,
            id,
            ceo,
            await hashOf(id),
          ]),
        ).toMatch(/cannot be signed for the CEO/);
        expect(
          await code("select public.fin_close_sign_finance($1, $2, $3, $4, null)", [
            orgB,
            id,
            finance,
            await hashOf(id),
          ]),
        ).toMatch(/not found/);
      });
    });

    it("finance signs; the pack can no longer be rebuilt or edited; a withdrawal reopens it", async () => {
      await asServiceRole(c, async () => {
        await q("select public.fin_close_sign_finance($1, $2, $3, $4, ' reviewed ')", [
          orgA,
          id,
          finance,
          await hashOf(id),
        ]);
        const row = (
          await q(
            "select status, finance_signed_by, finance_note from public.fin_period_closes where id = $1",
            [id],
          )
        ).rows[0];
        expect(row).toEqual({
          status: "finance_signed",
          finance_signed_by: finance,
          finance_note: "reviewed",
        });
        expect(
          await code("select public.fin_close_store_snapshot($1, '2026-08-01', $2, $3::jsonb)", [
            orgA,
            finance,
            snap(300),
          ]),
        ).toMatch(/cannot be rebuilt/);
        expect(
          await code("update public.fin_period_closes set snapshot = $2::jsonb where id = $1", [
            id,
            snap(999),
          ]),
        ).toMatch(/snapshot cannot change/);
        await q("select public.fin_close_withdraw($1, $2)", [orgA, id]);
        expect(
          (
            await q(
              "select status, finance_signed_by, finance_signed_at from public.fin_period_closes where id = $1",
              [id],
            )
          ).rows[0],
        ).toEqual({ status: "built", finance_signed_by: null, finance_signed_at: null });
        expect(await code("select public.fin_close_withdraw($1, $2)", [orgA, id])).toMatch(
          /waiting for the CEO/,
        );
        // rebuild is possible again, then finance signs the new pack
        await q("select public.fin_close_store_snapshot($1, '2026-08-01', $2, $3::jsonb)", [
          orgA,
          finance,
          snap(400),
        ]);
        await q("select public.fin_close_sign_finance($1, $2, $3, $4, null)", [
          orgA,
          id,
          finance,
          await hashOf(id),
        ]);
      });
    });

    it("refuses a CEO sign-off by the same person, or on a stale hash", async () => {
      await asServiceRole(c, async () => {
        expect(
          await code("select public.fin_close_sign_ceo($1, $2, $3, $4, null)", [
            orgA,
            id,
            finance,
            await hashOf(id),
          ]),
        ).toMatch(/two different people/);
        expect(
          await code("select public.fin_close_sign_ceo($1, $2, $3, $4, null)", [
            orgA,
            id,
            ceo,
            "f".repeat(64),
          ]),
        ).toMatch(/changed since you opened/);
        expect(await statusOf(id)).toBe("finance_signed");
      });
    });

    it("locks the month on the CEO sign-off", async () => {
      await asServiceRole(c, async () => {
        await q("select public.fin_close_sign_ceo($1, $2, $3, $4, 'approved')", [
          orgA,
          id,
          ceo,
          await hashOf(id),
        ]);
        const row = (
          await q(
            "select status, ceo_signed_by, ceo_note, locked_at is not null as locked from public.fin_period_closes where id = $1",
            [id],
          )
        ).rows[0];
        expect(row).toEqual({
          status: "locked",
          ceo_signed_by: ceo,
          ceo_note: "approved",
          locked: true,
        });
      });
    });

    it("is immutable afterwards for every role, including the service role", async () => {
      await asServiceRole(c, async () => {
        const attempts: Array<[string, unknown[]]> = [
          ["update public.fin_period_closes set snapshot = '{}'::jsonb where id = $1", [id]],
          ["update public.fin_period_closes set status = 'built' where id = $1", [id]],
          [
            "update public.fin_period_closes set status = 'open', locked_at = null where id = $1",
            [id],
          ],
          ["update public.fin_period_closes set ceo_note = 'changed' where id = $1", [id]],
          ["update public.fin_period_closes set finance_signed_by = ceo where id = $1", [id]],
          ["update public.fin_period_closes set snapshot_hash = 'x' where id = $1", [id]],
          ["delete from public.fin_period_closes where id = $1", [id]],
        ];
        for (const [sql, params] of attempts) {
          const r = await code(sql.replace("= ceo", `= '${ceo}'`), params);
          expect(r, sql).toMatch(/^(42501|23514):/);
        }
        expect(
          await code("select public.fin_close_store_snapshot($1, '2026-08-01', $2, $3::jsonb)", [
            orgA,
            finance,
            snap(1),
          ]),
        ).toMatch(/cannot be rebuilt/);
        expect(await code("select public.fin_close_withdraw($1, $2)", [orgA, id])).toMatch(
          /waiting for the CEO/,
        );
        expect(
          await code("select public.fin_close_sign_ceo($1, $2, $3, $4, null)", [
            orgA,
            id,
            ceo,
            await hashOf(id),
          ]),
        ).toMatch(/cannot be signed for the CEO/);
        expect(await statusOf(id)).toBe("locked");
        // and the snapshot is still exactly what was signed
        const { rows } = await q(
          "select snapshot_hash = encode(sha256(convert_to(snapshot::text, 'UTF8')), 'hex') as ok, snapshot #>> '{totals,generated}' as g from public.fin_period_closes where id = $1",
          [id],
        );
        expect(rows[0]).toEqual({ ok: true, g: "400" });
      });
    });

    it("lets a deleted user's id go to null on a locked month (the only permitted change)", async () => {
      await asServiceRole(c, async () => {
        await q("delete from public.profiles where id = $1", [finance]);
        const row = (
          await q("select finance_signed_by, status from public.fin_period_closes where id = $1", [
            id,
          ])
        ).rows[0];
        expect(row).toEqual({ finance_signed_by: null, status: "locked" });
      });
    });

    it("cannot be forced to lock without the sign-offs, by any route", async () => {
      await asServiceRole(c, async () => {
        const other = (
          await q("select public.fin_close_store_snapshot($1, '2026-07-01', $2, $3::jsonb) as id", [
            orgA,
            ceo,
            snap(5),
          ])
        ).rows[0].id;
        expect(
          await code(
            "update public.fin_period_closes set status = 'locked', locked_at = now() where id = $1",
            [other],
          ),
        ).toMatch(/^(23514):/);
        expect(
          await code(
            "update public.fin_period_closes set status = 'finance_signed', finance_signed_at = now() where id = $1",
            [other],
          ),
        ).toMatch(/^(23514|42501)?:?/);
        expect(await statusOf(other)).toBe("built");
        // a locked month needs a snapshot that matches its hash
        await q("select public.fin_close_sign_finance($1, $2, $3, $4, null)", [
          orgA,
          other,
          alice,
          await hashOf(other),
        ]);
        expect(
          await code(
            "update public.fin_period_closes set status = 'locked', ceo_signed_at = now(), locked_at = now(), snapshot_hash = 'tampered' where id = $1",
            [other],
          ),
        ).toMatch(/^(23514):/);
      });
    });

    it("shows closes only to the right permissions in the right org", async () => {
      await asUser(c, alice, async () => {
        expect(
          (
            await q("select count(*)::int as n from public.fin_period_closes where org_id = $1", [
              orgA,
            ])
          ).rows[0].n,
        ).toBeGreaterThan(0);
        // the browser cannot move a month
        expect(
          (
            await q("update public.fin_period_closes set finance_note = 'x' where org_id = $1", [
              orgA,
            ])
          ).rowCount,
        ).toBe(0);
      });
      await asUser(c, ceo, async () => {
        expect((await q("select count(*)::int as n from public.fin_period_closes")).rows[0].n).toBe(
          0,
        ); // no membership
      });
    });

    it("keeps a history of who signed (without the snapshot itself)", async () => {
      await asServiceRole(c, async () => {
        const { rows } = await q(
          "select changes::text as c from public.record_history where table_name = 'fin_period_closes' and record_id = $1",
          [id],
        );
        expect(rows.length).toBeGreaterThan(3);
        for (const r of rows) {
          expect(r.c).not.toContain('"snapshot"');
          expect(r.c).not.toContain('"snapshot_hash"');
        }
        expect(rows.map((r) => r.c).join(" ")).toContain("locked");
      });
    });
  });

  describe("cash-up", () => {
    let cashupId: string;
    const lines = async () =>
      (
        await q(
          "select payment_mode, expected_amount::float as e, counted_amount::float as n, variance::float as v from public.fin_cashup_lines where cashup_id = $1 order by 1",
          [cashupId],
        )
      ).rows;

    beforeAll(async () => {
      await asServiceRole(c, async () => {
        const inv = (
          await q(
            "insert into public.fin_invoices (org_id, inv_display_number, transaction_date, branch_code, inv_type, net, total, record_hash) values ($1, 'CU-1', '2026-10-01', 'P', 'SELF PAID', 300, 300, 'h') returning id",
            [orgA],
          )
        ).rows[0].id;
        await q(
          "insert into public.fin_payments (org_id, invoice_id, payment_key, payment_mode, paid, paid_date) values ($1, $2, 'CU-1|1|a', 'CASH', 120, '2026-10-01'), ($1, $2, 'CU-1|2|b', 'CARD', 180, '2026-10-01')",
          [orgA, inv],
        );
        cashupId = (
          await q(
            "insert into public.fin_cashups (org_id, branch_code, business_date, prepared_by) values ($1, 'P', '2026-10-01', $2) returning id",
            [orgA, alice],
          )
        ).rows[0].id;
      });
    });

    it("fills the expected amounts from the payments of that branch and day, and refreshes them while a draft", async () => {
      await asServiceRole(c, async () => {
        await q("select public.fin_cashup_refresh($1, $2)", [orgA, cashupId]);
        expect(await lines()).toEqual([
          { payment_mode: "CARD", e: 180, n: null, v: null },
          { payment_mode: "CASH", e: 120, n: null, v: null },
        ]);
        await q("update public.fin_payments set paid = 130 where payment_key = 'CU-1|1|a'");
        await q("select public.fin_cashup_refresh($1, $2)", [orgA, cashupId]);
        expect((await lines()).find((l) => l.payment_mode === "CASH")?.e).toBe(130);
      });
    });

    it("will not submit until every mode is counted, or while a difference above the tolerance has no reason", async () => {
      await asServiceRole(c, async () => {
        expect(
          await code("select public.fin_cashup_submit($1, $2, $3)", [orgA, cashupId, alice]),
        ).toMatch(/count every payment mode/);
        await q(
          "update public.fin_cashup_lines set counted_amount = 130 where cashup_id = $1 and payment_mode = 'CASH'",
          [cashupId],
        );
        await q(
          "update public.fin_cashup_lines set counted_amount = 170 where cashup_id = $1 and payment_mode = 'CARD'",
          [cashupId],
        ); // 10 short, tolerance 5
        expect(
          await code("select public.fin_cashup_submit($1, $2, $3)", [orgA, cashupId, alice]),
        ).toMatch(/give a reason/);
        await q(
          "update public.fin_cashup_lines set reason = 'Terminal slip missing' where cashup_id = $1 and payment_mode = 'CARD'",
          [cashupId],
        );
        await q("select public.fin_cashup_submit($1, $2, $3)", [orgA, cashupId, alice]);
        expect(
          (
            await q(
              "select status, submitted_by, submitted_at is not null as at from public.fin_cashups where id = $1",
              [cashupId],
            )
          ).rows[0],
        ).toEqual({ status: "submitted", submitted_by: alice, at: true });
      });
    });

    it("freezes a submitted cash-up until it is reopened, and a refresh cannot change it", async () => {
      await asServiceRole(c, async () => {
        expect(
          await code(
            "update public.fin_cashup_lines set counted_amount = 999 where cashup_id = $1",
            [cashupId],
          ),
        ).toMatch(/frozen/);
        expect(
          await code("delete from public.fin_cashup_lines where cashup_id = $1", [cashupId]),
        ).toMatch(/frozen/);
        expect(
          await code("update public.fin_cashups set note = 'edited' where id = $1", [cashupId]),
        ).toMatch(/frozen/);
        expect(await code("select public.fin_cashup_refresh($1, $2)", [orgA, cashupId])).toMatch(
          /frozen/,
        );
        await q(
          "update public.fin_cashups set status = 'draft', submitted_at = null, submitted_by = null where id = $1",
          [cashupId],
        ); // reopen
        await q(
          "update public.fin_cashup_lines set counted_amount = 171 where cashup_id = $1 and payment_mode = 'CARD'",
          [cashupId],
        );
        expect((await lines()).find((l) => l.payment_mode === "CARD")?.n).toBe(171);
        await q("select public.fin_cashup_submit($1, $2, $3)", [orgA, cashupId, alice]);
      });
    });

    it("allows one cash-up per branch and day", async () => {
      await asServiceRole(c, async () => {
        expect(
          await code(
            "insert into public.fin_cashups (org_id, branch_code, business_date) values ($1, 'P', '2026-10-01')",
            [orgA],
          ),
        ).toMatch(/^23505:/);
        expect(
          await code(
            "insert into public.fin_cashups (org_id, branch_code, business_date) values ($1, 'M', '2026-10-01')",
            [orgA],
          ),
        ).toBe("ok");
      });
    });

    it("cannot be created, changed or deleted inside a locked month", async () => {
      await asServiceRole(c, async () => {
        // August 2026 was locked above
        expect(
          await code(
            "insert into public.fin_cashups (org_id, branch_code, business_date) values ($1, 'P', '2026-08-15')",
            [orgA],
          ),
        ).toMatch(/^42501:.*locked/);
        // a cash-up that already existed when the month locked is frozen too
        const id = (
          await q(
            "insert into public.fin_cashups (org_id, branch_code, business_date) values ($1, 'G', '2026-06-20') returning id",
            [orgA],
          )
        ).rows[0].id;
        await q(
          "insert into public.fin_cashup_lines (org_id, cashup_id, payment_mode, expected_amount, counted_amount) values ($1, $2, 'CASH', 5, 5)",
          [orgA, id],
        );
        const close = (
          await q("select public.fin_close_store_snapshot($1, '2026-06-01', $2, $3::jsonb) as id", [
            orgA,
            alice,
            snap(6),
          ])
        ).rows[0].id;
        const h = (
          await q("select snapshot_hash as h from public.fin_period_closes where id = $1", [close])
        ).rows[0].h;
        await q("select public.fin_close_sign_finance($1, $2, $3, $4, null)", [
          orgA,
          close,
          alice,
          h,
        ]);
        await q("select public.fin_close_sign_ceo($1, $2, $3, $4, null)", [orgA, close, ceo, h]);
        expect(
          await code("update public.fin_cashups set note = 'late edit' where id = $1", [id]),
        ).toMatch(/^42501:.*locked/);
        expect(await code("delete from public.fin_cashups where id = $1", [id])).toMatch(
          /^42501:.*locked/,
        );
        expect(
          await code("update public.fin_cashup_lines set counted_amount = 6 where cashup_id = $1", [
            id,
          ]),
        ).toMatch(/^42501:.*locked/);
        expect(
          await code("delete from public.fin_cashup_lines where cashup_id = $1", [id]),
        ).toMatch(/^42501:.*locked/);
        expect(
          await code(
            "insert into public.fin_cashup_lines (org_id, cashup_id, payment_mode, expected_amount) values ($1, $2, 'CARD', 1)",
            [orgA, id],
          ),
        ).toMatch(/^42501:.*locked/);
        // another month and another organisation are not affected
        expect(
          await code(
            "insert into public.fin_cashups (org_id, branch_code, business_date) values ($1, 'P', '2026-09-15')",
            [orgA],
          ),
        ).toBe("ok");
        expect(
          await code(
            "insert into public.fin_cashups (org_id, branch_code, business_date) values ($1, 'P', '2026-08-15')",
            [orgB],
          ),
        ).toBe("ok");
      });
    });

    it("counts the submitted cash-ups of the month in the close figures", async () => {
      await asServiceRole(c, async () => {
        const f = (await q("select public.fin_close_month_figures($1, '2026-10-01') as f", [orgA]))
          .rows[0].f;
        const p = f.cashups.find((x: { branch: string }) => x.branch === "P");
        expect(p).toMatchObject({ days: 1, expected: 310, counted: 301 }); // expected 130 + 180, counted 130 + 171
        expect(p.variance).toBe(-9);
      });
    });
  });
});
