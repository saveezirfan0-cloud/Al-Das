/**
 * docs/48: insurance receivable control, database side. The SQL rule (app.fin_ins_receivable_compare) gives the same
 * answers as the TS twin on the shared synthetic cases; the figures (app.fin_ins_receivable_block, through
 * fin_close_controls) read Diligence at the month end and the Tally MIRROR only (tally_import / opening journals and
 * their reversals) on the ledgers the insurance receivable posting rules name; another org never counts; a month that
 * differs cannot be signed for Finance until the preparer explains THIS build, and not by the person who explained it;
 * the explanation freezes with the sign-off and the lock. Synthetic data only. Needs TEST_DATABASE_URL.
 */
import type { Client } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import {
  compareInsuranceReceivable,
  readInsReceivable,
  recompute,
  type ControlInput,
} from "@/lib/finance/insurance-receivable-control";

import fixture from "../unit/finance/fixtures/ins-receivable-control.synthetic.json";
import {
  asServiceRole,
  connect,
  createAuthUser,
  createOrg,
  resetDb,
  TEST_DATABASE_URL,
} from "./helpers";

const SEPT = "2026-09-01";
const AUG = "2026-08-01";

describe.skipIf(!TEST_DATABASE_URL)("Insurance receivable control (docs/48)", () => {
  let c: Client;
  let orgA: string;
  let orgB: string;
  const u: Record<string, string> = {};
  const q = (sql: string, p: unknown[] = []) => c.query(sql, p);
  const svc = <T>(fn: () => Promise<T>) => asServiceRole(c, fn);
  const rpc = async (fn: string, args: unknown[]) => {
    const ph = args.map((_, i) => `$${i + 1}`).join(", ");
    return (await svc(() => q(`select public.${fn}(${ph}) as r`, args))).rows[0].r;
  };
  /** The SQLSTATE hint of a refused statement, or "ok". Each attempt is rolled back. */
  const attempt = async (sql: string, p: unknown[] = []) => {
    await q("begin");
    try {
      await q("set local role service_role");
      await q(sql, p);
      return "ok";
    } catch (e) {
      const err = e as { hint?: string; code?: string; message?: string };
      return err.hint ?? `${err.code}:${err.message}`;
    } finally {
      await q("rollback");
    }
  };
  const block = async (org: string, month = SEPT) =>
    ((await rpc("fin_close_controls", [org, month, "2026-10-14"])) as { ins_receivable: unknown })
      .ins_receivable as Record<string, unknown>;
  const tallyPost = (org: string, id: string, version: number, date: string, lines: unknown[]) =>
    rpc("acc_post_from_source", [
      org,
      null,
      "tally_import",
      id,
      version,
      date,
      "journal",
      `Synthetic Tally ${id}`,
      JSON.stringify(lines),
    ]);

  async function seedClaims(org: string, k: number) {
    const claim = (
      no: string,
      payer: string | null,
      tx: string,
      net: number,
      remitted: number,
      first: string | null,
      last: string | null,
      writeOff = 0,
      writeOffStatus: string | null = null,
    ) =>
      q(
        `insert into public.ins_claim_activities (org_id, claim_activity_number, payer_id, transaction_date, net, remitted,
                                                  first_remittance_date, last_remittance_date, write_off, write_off_status)
         values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)`,
        [org, no, payer, tx, net * k, remitted * k, first, last, writeOff * k, writeOffStatus],
      );
    await svc(async () => {
      await claim("C1", "INS-A", "2026-08-10", 500, 0, null, null); // 500 open
      await claim("C2", "INS-A", "2026-09-05", 300, 300, "2026-09-20", "2026-09-20"); // paid in the month
      await claim("C3", "INS-B", "2026-09-12", 200, 200, "2026-10-05", "2026-10-05"); // paid after: added back
      await claim("C4", "INS-B", "2026-09-15", 150, 0, null, null, 50, "Approved"); // 100 after write-off
      await claim("C5", "INS-B", "2026-10-02", 999, 0, null, null); // after the month end
      await claim("C6", " INS-A ", "2026-09-01", 100, 80, "2026-09-10", "2026-10-03"); // straddling: 20
      await claim("C7", "INS-B", "2026-09-20", 70, 0, null, null, 70, "pending"); // write-off not approved: 70
    });
  }

  beforeAll(async () => {
    c = await connect();
    await resetDb(c);
    for (const n of ["admin", "prep", "fm", "ceo", "other", "prep2"])
      u[n] = await createAuthUser(c, `${n}-irc@example.test`);
    orgA = await createOrg(c, "Org A", "org-a-irc", u.admin);
    orgB = await createOrg(c, "Org B", "org-b-irc", u.other);
    await seedClaims(orgA, 1);
    await seedClaims(orgB, 1000);
    // org B's Tally mirror must never count in org A
    await tallyPost(orgB, "B-1", 1, "2026-09-10", [
      { account_code: "1200", debit: 777777 },
      { account_code: "1210", credit: 777777 },
    ]);
  });
  afterAll(async () => {
    await resetDb(c);
    await c.end();
  });

  describe("the SQL rule matches the TS rule on every shared case", () => {
    for (const k of fixture.cases) {
      it(k.name, async () => {
        const i = k.input as Record<string, unknown>;
        const sql = (
          await q("select app.fin_ins_receivable_compare($1, $2, $3::jsonb, $4::jsonb) as r", [
            i.tolerance,
            i.tally_state,
            i.diligence === null ? null : JSON.stringify(i.diligence),
            i.tally === null ? null : JSON.stringify(i.tally),
          ])
        ).rows[0].r as Record<string, unknown>;
        const ts = compareInsuranceReceivable(i as unknown as ControlInput);
        const n = (v: unknown) => (v === null ? null : Number(v));
        expect(sql.status).toBe(ts.status);
        expect(sql.basis).toBe(ts.basis);
        expect(n(sql.diligence_total)).toBe(ts.diligence_total);
        expect(n(sql.tally_total)).toBe(ts.tally_total);
        expect(n(sql.difference)).toBe(ts.difference);
        expect(n(sql.unassigned_diligence)).toBe(ts.unassigned_diligence);
        expect(n(sql.unassigned_tally)).toBe(ts.unassigned_tally);
        expect(
          (sql.payers as Array<Record<string, unknown>>).map((p) => ({
            payer_id: p.payer_id,
            diligence: Number(p.diligence),
            tally: Number(p.tally),
            difference: Number(p.difference),
            agrees: p.agrees,
          })),
        ).toEqual(ts.payers);
        expect(sql.status).toBe(k.expected.status);
      });
    }
  });

  describe("figures", () => {
    it("Diligence at the month end: remitted after it added back, approved write-offs only, later claims left out", async () => {
      const b = await block(orgA);
      const dil = Object.fromEntries(
        (b.diligence as Array<{ payer_id: string; amount: number }>).map((r) => [
          r.payer_id,
          Number(r.amount),
        ]),
      );
      expect(dil).toEqual({ "INS-A": 520, "INS-B": 370 });
      expect(b.remitted_after).toEqual({ claims: 1, amount: 200 });
      expect(b.remitted_straddling).toBe(1);
      expect(b.month_end).toBe("2026-09-30");
      expect(Number(b.tolerance)).toBe(1);
    });

    it("nothing mirrored from Tally yet is No Tally data, not a difference", async () => {
      const b = await block(orgA);
      expect(b.tally_state).toBe("no_data");
      expect(b.tally).toBeNull();
      expect((b.result as { status: string }).status).toBe("no_tally_data");
      expect((b.accounts as Array<{ code: string }>).map((a) => a.code)).toEqual(["1200"]);
    });

    it("no insurer receivable ledger mapped is No Tally data", async () => {
      await svc(() =>
        q(
          "update public.acc_posting_rules set active = false where org_id = $1 and kind = 'receivable'",
          [orgA],
        ),
      );
      try {
        const b = await block(orgA);
        expect(b.tally_state).toBe("no_account");
        expect((b.result as { status: string }).status).toBe("no_tally_data");
      } finally {
        await svc(() =>
          q(
            "update public.acc_posting_rules set active = true where org_id = $1 and kind = 'receivable'",
            [orgA],
          ),
        );
      }
    });

    it("an org with no Diligence claims up to the month end is No Diligence data", async () => {
      const b = await block(orgA, "2026-07-01");
      expect(b.diligence).toBeNull();
    });

    it("the Tally mirror at the month end: later vouchers and replaced versions do not count; in total when the ledger has no payer", async () => {
      await tallyPost(orgA, "T-1", 1, "2026-09-25", [
        { account_code: "1200", debit: 1000 },
        { account_code: "1210", credit: 1000 },
      ]);
      // Tally altered the voucher: the mirror reverses version 1 and posts version 2
      await tallyPost(orgA, "T-1", 2, "2026-09-25", [
        { account_code: "1200", debit: 890 },
        { account_code: "1210", credit: 890 },
      ]);
      await tallyPost(orgA, "T-2", 1, "2026-10-01", [
        { account_code: "1200", debit: 50 },
        { account_code: "1210", credit: 50 },
      ]);
      const b = await block(orgA);
      expect(b.tally_state).toBe("mirrored");
      expect((b.tally as Array<{ amount: number }>).map((r) => Number(r.amount))).toEqual([890]);
      const r = b.result as { status: string; basis: string; difference: number };
      expect(r.status).toBe("agrees");
      expect(r.basis).toBe("total");
      expect(Number(r.difference)).toBe(0);
      expect(b.tally_last_voucher_date).toBe("2026-10-01");
      expect(b.tally_last_mirrored_at).not.toBeNull();
      // the TS twin agrees with the frozen result
      const parsed = readInsReceivable(b)!;
      expect(recompute(parsed).status).toBe("agrees");
    });

    it("per payer when each insurer has its own Tally ledger", async () => {
      await svc(async () => {
        for (const [code, name, payer] of [
          ["T-INSA", "Synthetic Health", "INS-A"],
          ["T-INSB", "Synthetic Care", "INS-B"],
        ]) {
          await q(
            `insert into public.acc_accounts (org_id, parent_id, code, name, nature)
             select $1, p.parent_id, $2, $3, p.nature from public.acc_accounts p where p.org_id = $1 and p.code = '1200'`,
            [orgA, code, name],
          );
          await q(
            `insert into public.acc_posting_rules (org_id, kind, key, qualifier, account_id)
             select $1, 'receivable', 'insurance', $3, a.id from public.acc_accounts a where a.org_id = $1 and a.code = $2`,
            [orgA, code, payer],
          );
        }
        await q(
          "update public.acc_posting_rules set active = false where org_id = $1 and kind = 'receivable' and key = 'insurance' and qualifier = '*'",
          [orgA],
        );
      });
      await tallyPost(orgA, "T-3", 1, "2026-09-28", [
        { account_code: "T-INSA", debit: 520 },
        { account_code: "T-INSB", debit: 380 },
        { account_code: "1210", credit: 900 },
      ]);
      const b = await block(orgA);
      const r = b.result as {
        status: string;
        basis: string;
        payers: Array<{ payer_id: string; difference: number; agrees: boolean }>;
      };
      expect(r.basis).toBe("per_payer");
      expect(r.status).toBe("differs");
      expect(r.payers.map((p) => [p.payer_id, Number(p.difference), p.agrees])).toEqual([
        ["INS-A", 0, true],
        ["INS-B", 10, false],
      ]);
      expect(b.payer_names).toEqual({});
      // the tolerance is data: 10 dirhams makes it agree
      await svc(() =>
        q(
          `insert into public.fin_ref_finance_settings (org_id, ins_receivable_tolerance) values ($1, 10)
           on conflict (org_id) do update set ins_receivable_tolerance = 10`,
          [orgA],
        ),
      );
      expect(((await block(orgA)).result as { status: string }).status).toBe("agrees");
      await svc(() =>
        q(
          "update public.fin_ref_finance_settings set ins_receivable_tolerance = 1 where org_id = $1",
          [orgA],
        ),
      );
    });

    it("a manual (non-Tally) journal on the ledger is not part of the Tally figure", async () => {
      const before = await block(orgA);
      // inside a transaction that is rolled back: a ledger start cannot be cleared once Pulse has posted
      await q("begin");
      try {
        await q(
          "update public.acc_entities set ledger_start_date = '2000-01-01' where org_id = $1",
          [orgA],
        );
        await rpc("acc_post_from_source", [
          orgA,
          null,
          "remittance",
          "R-1",
          1,
          "2026-09-29",
          "receipt",
          "Synthetic remittance",
          JSON.stringify([
            { account_code: "1210", debit: 100 },
            { account_code: "T-INSB", credit: 100 },
          ]),
        ]);
        const posted = await q(
          "select count(*)::int as n from public.acc_journals where org_id = $1 and source_kind = 'remittance'",
          [orgA],
        );
        expect(posted.rows[0].n).toBe(1);
        const after = await block(orgA);
        expect(after.tally).toEqual(before.tally);
      } finally {
        await q("rollback");
      }
    });

    it("the tolerance cannot be negative", async () => {
      expect(
        await attempt(
          "update public.fin_ref_finance_settings set ins_receivable_tolerance = -1 where org_id = $1",
          [orgA],
        ),
      ).toMatch(/ins_receivable_tolerance/);
    });
  });

  describe("sign-off", () => {
    const snapshot = (ins: unknown, month = SEPT) =>
      JSON.stringify({ version: 1, month, controls: { version: 1, ins_receivable: ins } });
    let closeId: string;
    let hash: string;
    const hashOf = async (id: string) =>
      (await q("select snapshot_hash as h from public.fin_period_closes where id = $1", [id]))
        .rows[0].h as string;

    it("a month that differs cannot be signed for Finance without the preparer's explanation", async () => {
      const ins = await block(orgA); // differs per payer (INS-B 10 over)
      expect((ins.result as { status: string }).status).toBe("differs");
      closeId = (await rpc("fin_close_store_snapshot", [
        orgA,
        SEPT,
        u.prep,
        snapshot(ins),
      ])) as string;
      hash = await hashOf(closeId);
      expect(
        await attempt("select public.fin_close_sign_finance($1, $2, $3, $4, null)", [
          orgA,
          closeId,
          u.fm,
          hash,
        ]),
      ).toBe("ins_receivable_unexplained");
      // the signed path refuses too (it calls the same function first)
      expect(
        await attempt(
          "select public.fin_close_sign_signed($1, $2, $3, 'finance', $4, null, '{}'::jsonb)",
          [orgA, closeId, u.fm, hash],
        ),
      ).toBe("ins_receivable_unexplained");
    });

    it("the explanation needs 10 characters, the pack the explainer saw, and a difference", async () => {
      expect(
        await attempt("select public.fin_close_explain_ins_receivable($1, $2, $3, $4, 'short')", [
          orgA,
          closeId,
          u.prep,
          hash,
        ]),
      ).toBe("invalid");
      expect(
        await attempt(
          "select public.fin_close_explain_ins_receivable($1, $2, $3, $4, 'A long enough reason')",
          [orgA, closeId, u.prep, "0".repeat(64)],
        ),
      ).toMatch(/pack changed/);
      expect(
        await attempt(
          "select public.fin_close_explain_ins_receivable($1, $2, $3, $4, 'A long enough reason')",
          [orgB, closeId, u.prep, hash],
        ),
      ).toMatch(/close not found/);
    });

    it("a stale explanation (written for an earlier build) does not count", async () => {
      await rpc("fin_close_explain_ins_receivable", [
        orgA,
        closeId,
        u.prep,
        hash,
        "Remittance for INS-B posted in Tally on 1 Oct.",
      ]);
      const ins = await block(orgA);
      await rpc("fin_close_store_snapshot", [
        orgA,
        SEPT,
        u.prep,
        snapshot({ ...ins, rebuilt: true }),
      ]);
      const newHash = await hashOf(closeId);
      expect(newHash).not.toBe(hash);
      expect(
        await attempt("select public.fin_close_sign_finance($1, $2, $3, $4, null)", [
          orgA,
          closeId,
          u.fm,
          newHash,
        ]),
      ).toBe("ins_receivable_unexplained");
      hash = newHash;
    });

    it("the explainer cannot sign for Finance; someone else can", async () => {
      await rpc("fin_close_explain_ins_receivable", [
        orgA,
        closeId,
        u.prep,
        hash,
        "Remittance for INS-B posted in Tally on 1 Oct.",
      ]);
      expect(
        await attempt("select public.fin_close_sign_finance($1, $2, $3, $4, null)", [
          orgA,
          closeId,
          u.prep,
          hash,
        ]),
      ).toBe("ins_receivable_same_person");
      await rpc("fin_close_sign_finance", [orgA, closeId, u.fm, hash, "Reviewed"]);
      const row = (
        await q(
          "select status, ins_control_note, ins_control_note_by, ins_control_note_hash from public.fin_period_closes where id = $1",
          [closeId],
        )
      ).rows[0];
      expect(row.status).toBe("finance_signed");
      expect(row.ins_control_note_by).toBe(u.prep);
      expect(row.ins_control_note_hash).toBe(hash);
    });

    it("the explanation is frozen once Finance has signed, for every role", async () => {
      expect(
        await attempt(
          "select public.fin_close_explain_ins_receivable($1, $2, $3, $4, 'Changed after signing')",
          [orgA, closeId, u.prep, hash],
        ),
      ).toBe("ins_receivable_note_frozen");
      expect(
        await attempt(
          "update public.fin_period_closes set ins_control_note = 'Changed after signing' where id = $1",
          [closeId],
        ),
      ).toBe("ins_receivable_note_frozen");
    });

    it("an agreeing pack needs nothing and refuses an explanation", async () => {
      const ins = { ...(await block(orgA)), tolerance: 100 };
      const id = (await rpc("fin_close_store_snapshot", [
        orgA,
        AUG,
        u.prep,
        snapshot(ins, AUG),
      ])) as string;
      const h = await hashOf(id);
      expect(
        await attempt(
          "select public.fin_close_explain_ins_receivable($1, $2, $3, $4, 'Nothing to explain here')",
          [orgA, id, u.prep, h],
        ),
      ).toBe("ins_receivable_nothing_to_explain");
      expect(
        await attempt("select public.fin_close_sign_finance($1, $2, $3, $4, null)", [
          orgA,
          id,
          u.fm,
          h,
        ]),
      ).toBe("ok");
    });

    it("a pack built before the control (no block) signs as before", async () => {
      const id = (await rpc("fin_close_store_snapshot", [
        orgB,
        AUG,
        u.prep,
        JSON.stringify({ version: 1, month: AUG, controls: { version: 1 } }),
      ])) as string;
      expect(
        await attempt("select public.fin_close_sign_finance($1, $2, $3, $4, null)", [
          orgB,
          id,
          u.fm,
          await hashOf(id),
        ]),
      ).toBe("ok");
    });

    it("an unreadable block fails closed (needs an explanation)", async () => {
      const id = (await rpc("fin_close_store_snapshot", [
        orgB,
        "2026-07-01",
        u.prep,
        JSON.stringify({
          version: 1,
          month: "2026-07-01",
          controls: { ins_receivable: { tally_state: "started" } },
        }),
      ])) as string;
      expect(
        await attempt("select public.fin_close_sign_finance($1, $2, $3, $4, null)", [
          orgB,
          id,
          u.fm,
          await hashOf(id),
        ]),
      ).toBe("ins_receivable_unexplained");
    });

    it("locked: the explanation is immutable, yet a deleted explainer's id can still be cleared", async () => {
      // a fresh month in org B explained by prep2, signed by fm, locked by the CEO
      const ins = await block(orgA);
      const id = (await rpc("fin_close_store_snapshot", [
        orgB,
        "2026-06-01",
        u.prep2,
        snapshot(ins, "2026-06-01"),
      ])) as string;
      const h = await hashOf(id);
      await rpc("fin_close_explain_ins_receivable", [
        orgB,
        id,
        u.prep2,
        h,
        "Explained by someone who later leaves.",
      ]);
      await rpc("fin_close_sign_finance", [orgB, id, u.fm, h, null]);
      await rpc("fin_close_sign_ceo", [orgB, id, u.ceo, h, null]);
      expect(
        await attempt(
          "update public.fin_period_closes set ins_control_note = 'Rewritten after the lock' where id = $1",
          [id],
        ),
      ).toMatch(/immutable|note_frozen/);
      await q("delete from auth.users where id = $1", [u.prep2]);
      const row = (
        await q(
          "select status, ins_control_note_by, ins_control_note from public.fin_period_closes where id = $1",
          [id],
        )
      ).rows[0];
      expect(row.status).toBe("locked");
      expect(row.ins_control_note_by).toBeNull();
      expect(row.ins_control_note).toBe("Explained by someone who later leaves.");
    });
  });

  it("the new functions are not callable by signed-in users", async () => {
    for (const sql of [
      "select public.fin_close_explain_ins_receivable(gen_random_uuid(), gen_random_uuid(), gen_random_uuid(), 'x', 'x')",
      "select app.fin_ins_receivable_block(gen_random_uuid(), '2026-09-30')",
      "select app.fin_ins_receivable_compare(1, 'mirrored', null, null)",
    ]) {
      await q("begin");
      try {
        await q("set local role authenticated");
        await expect(q(sql)).rejects.toThrow(/permission denied/);
      } finally {
        await q("rollback");
      }
    }
  });
});
