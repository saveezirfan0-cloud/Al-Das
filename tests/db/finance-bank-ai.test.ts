/**
 * Phase 20H: the AI reviewer's tables in the database. Who reads (the bank permissions; nobody in another org, not
 * Billing), that nobody writes directly, the permission grant to Finance and Finance Manager, the ai_usage feature, and
 * the rules: a suggestion belongs to an accepted review of the same run, never changes, is decided once, and only while
 * the run is open and its month is not locked. Accepting a pair writes the same fin_bank_matches row as a person's
 * accept, so the 20C guards and the two-person sign-off still decide. Synthetic data only. Needs TEST_DATABASE_URL.
 */
import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";

import type { Client } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { FINANCE_ROLES } from "@/lib/auth/permissions";

import {
  asServiceRole,
  asUser,
  connect,
  createAuthUser,
  createOrg,
  resetDb,
  TEST_DATABASE_URL,
} from "./helpers";

const sha = (s: string) => createHash("sha256").update(s).digest("hex");

describe.skipIf(!TEST_DATABASE_URL)("Finance bank reconciliation AI reviewer (Phase 20H)", () => {
  let c: Client;
  let orgA: string;
  let orgB: string;
  let accA: string;
  let recOct: string;
  let recSep: string;
  let recB: string;
  let reviewA: string;
  let lineIds: string[] = [];
  const users: Record<string, string> = {};
  const q = (sql: string, p: unknown[] = []) => c.query(sql, p);
  const svc = <T>(fn: () => Promise<T>) => asServiceRole(c, fn);
  const asRole = <T>(n: string, fn: () => Promise<T>) => asUser(c, users[n], fn);
  const err = (p: Promise<unknown>) =>
    p.then(
      () => null,
      (e: { code?: string; message?: string }) => e,
    );
  const set = (sql: string, p: unknown[] = []) => err(svc(() => q(sql, p)));
  const one = async (sql: string, p: unknown[]) =>
    (await svc(() => q(sql, p))).rows[0].id as string;
  const review = (org: string, rec: string, status = "ok") =>
    one(
      status === "ok"
        ? "insert into public.fin_bank_ai_reviews (org_id, rec_id, status, model, summary, item_count, suggestion_count) values ($1, $2, 'ok', 'fake-model', 'E1 looks like a fee.', 3, 1) returning id"
        : "insert into public.fin_bank_ai_reviews (org_id, rec_id, status, model, reject_reason, item_count) values ($1, $2, 'rejected', 'fake-model', 'Suggestion 1: unknown item.', 3) returning id",
      [org, rec],
    );
  const suggest = (rev: string, key: string, line: string | null, rec = recOct, org = orgA) =>
    one(
      "insert into public.fin_bank_ai_suggestions (org_id, rec_id, review_id, item_key, candidate_line_id, reason_code, confidence) values ($1, $2, $3, $4, $5, $6, 'medium') returning id",
      [org, rec, rev, key, line, line ? "amount_and_date" : "needs_person"],
    );

  beforeAll(async () => {
    c = await connect();
    await resetDb(c);
    for (const n of ["alice", "bob", "fin", "fin2", "ceo", "billing"])
      users[n] = await createAuthUser(c, `${n}-bank-ai@example.test`);
    orgA = await createOrg(c, "Org A", "org-a", users.alice);
    orgB = await createOrg(c, "Org B", "org-b", users.bob);
    await svc(async () => {
      for (const r of FINANCE_ROLES)
        await q(
          "insert into public.roles (org_id, name, description, permissions, is_system) values ($1, $2, $3, $4::jsonb, true) on conflict (org_id, name) do nothing",
          [orgA, r.name, r.description, JSON.stringify(r.permissions)],
        );
      const member = (u: string, role: string) =>
        q(
          "insert into public.memberships (org_id, user_id, role_id) select $1, $2, id from public.roles where org_id = $1 and name = $3",
          [orgA, users[u], role],
        );
      await member("fin", "Finance");
      await member("fin2", "Finance Manager");
      await member("ceo", "CEO");
      await member("billing", "Billing");

      const account = async (org: string, last4: string) =>
        (
          await q(
            "insert into public.fin_bank_accounts (org_id, name, bank_name, last4) values ($1, 'Operating', 'Synthetic Bank', $2) returning id",
            [org, last4],
          )
        ).rows[0].id as string;
      accA = await account(orgA, "4321");
      const accB = await account(orgB, "9999");
      const rows = [1, 2, 3, 4].map((d) => ({
        value_date: `2026-10-0${d}`,
        amount: 100 * d,
        reference: `R${d}`,
        description: "SYNTHETIC",
      }));
      const imp = (
        await q(
          "select public.fin_bank_import($1, 'bank_statement', $2, null, null, 'statement.csv', $3, $4::jsonb, $5) as id",
          [orgA, accA, sha("ai-a-oct"), JSON.stringify(rows), users.fin],
        )
      ).rows[0].id;
      lineIds = (
        await q("select id from public.fin_bank_lines where import_id = $1 order by row_no", [imp])
      ).rows.map((r) => r.id);
      const rec = async (org: string, acc: string, month: string, start: string, end: string) =>
        (
          await q(
            "insert into public.fin_bank_recs (org_id, account_id, month, period_start, period_end) values ($1, $2, $3, $4, $5) returning id",
            [org, acc, month, start, end],
          )
        ).rows[0].id as string;
      recOct = await rec(orgA, accA, "2026-10-01", "2026-10-01", "2026-10-30");
      recSep = await rec(orgA, accA, "2026-09-01", "2026-09-01", "2026-09-30");
      recB = await rec(orgB, accB, "2026-10-01", "2026-10-01", "2026-10-30");
    });
    reviewA = await review(orgA, recOct);
    await suggest(reviewA, "col|Card|2026-10-01", lineIds[0]);
    const reviewB = await review(orgB, recB);
    await suggest(reviewB, "col|Cash|2026-10-02", null, recB, orgB);
  });

  afterAll(async () => {
    await resetDb(c);
    await c.end();
  });

  describe("access", () => {
    const visible = (who: string) =>
      asRole(who, async () => {
        const n = async (t: string) =>
          Number((await q(`select count(*)::int as n from public.${t}`)).rows[0].n);
        return {
          reviews: await n("fin_bank_ai_reviews"),
          suggestions: await n("fin_bank_ai_suggestions"),
        };
      });

    it("Finance, the Finance Manager and the CEO read their own org's rows only; Billing nothing; org B only org B", async () => {
      for (const who of ["fin", "fin2", "ceo", "alice", "bob"])
        expect(await visible(who), who).toEqual({ reviews: 1, suggestions: 1 });
      expect(await visible("billing")).toEqual({ reviews: 0, suggestions: 0 });
      const bobKeys = await asRole("bob", () =>
        q("select item_key from public.fin_bank_ai_suggestions"),
      );
      expect(bobKeys.rows).toEqual([{ item_key: "col|Cash|2026-10-02" }]);
    });

    it("nobody writes directly, not even Finance", async () => {
      expect(
        await err(
          asRole("fin", () =>
            q(
              "insert into public.fin_bank_ai_reviews (org_id, rec_id, status, model, summary) values ($1, $2, 'ok', 'm', 's')",
              [orgA, recOct],
            ),
          ),
        ),
      ).toMatchObject({ code: "42501" });
      const upd = await asRole("fin", () =>
        q("update public.fin_bank_ai_suggestions set decision = 'accepted', decided_at = now()"),
      );
      expect(upd.rowCount).toBe(0);
      const del = await asRole("fin", () => q("delete from public.fin_bank_ai_reviews"));
      expect(del.rowCount).toBe(0);
    });

    it("grants finance.bank.ai to the Finance and Finance Manager system roles only (idempotent), as the code presets do", async () => {
      const sql = fs.readFileSync(
        path.join(process.cwd(), "supabase/migrations/20261104000100_finance_bank_ai.sql"),
        "utf8",
      );
      const grant = /do \$\$\ndeclare\n  g record;[\s\S]*?end \$\$;/.exec(sql)?.[0];
      expect(grant).toBeTruthy();
      const orgC = await svc(async () => {
        const id = (
          await q("insert into public.orgs (name, slug) values ('Org C', 'org-c-20h') returning id")
        ).rows[0].id as string;
        for (const [name, system] of [
          ["Finance", true],
          ["Finance Manager", true],
          ["CEO", true],
          ["Billing", true],
          ["Finance helper", false],
        ] as const)
          await q(
            "insert into public.roles (org_id, name, description, permissions, is_system) values ($1, $2, '', '[\"finance.bank.view\"]'::jsonb, $3)",
            [id, name, system],
          );
        return id;
      });
      await svc(() => q(grant!));
      await svc(() => q(grant!));
      const { rows } = await svc(() =>
        q("select name, permissions from public.roles where org_id = $1 order by name", [orgC]),
      );
      const has = Object.fromEntries(
        rows.map((r) => [
          r.name,
          (r.permissions as string[]).filter((p) => p === "finance.bank.ai").length,
        ]),
      );
      expect(has).toEqual({
        Billing: 0,
        CEO: 0,
        Finance: 1,
        "Finance helper": 0,
        "Finance Manager": 1,
      });
      const preset = (n: string) => FINANCE_ROLES.find((r) => r.name === n)!.permissions;
      expect(preset("Finance")).toContain("finance.bank.ai");
      expect(preset("Finance Manager")).toContain("finance.bank.ai");
      for (const n of ["CEO", "Billing", "Insurance", "Medical Director", "Cost / Payroll"])
        expect(preset(n), n).not.toContain("finance.bank.ai");
    });

    it("ai_usage accepts the bank_review feature and still refuses an unknown one", async () => {
      expect(
        await set(
          "insert into public.ai_usage (org_id, feature, model) values ($1, 'bank_review', 'm')",
          [orgA],
        ),
      ).toBeNull();
      expect(
        await set(
          "insert into public.ai_usage (org_id, feature, model) values ($1, 'appeal_draft', 'm')",
          [orgA],
        ),
      ).toBeNull();
      expect(
        await set(
          "insert into public.ai_usage (org_id, feature, model) values ($1, 'made_up', 'm')",
          [orgA],
        ),
      ).toMatchObject({ code: "23514" });
    });
  });

  describe("rules", () => {
    it("a suggestion belongs to an accepted review of the same run, in the same org, from the closed lists", async () => {
      const rejected = await review(orgA, recOct, "rejected");
      expect(
        await set(
          "insert into public.fin_bank_ai_suggestions (org_id, rec_id, review_id, item_key, reason_code, confidence) values ($1, $2, $3, 'k', 'needs_person', 'low')",
          [orgA, recOct, rejected],
        ),
      ).toMatchObject({ code: "23514" });
      expect(
        await set(
          "insert into public.fin_bank_ai_suggestions (org_id, rec_id, review_id, item_key, reason_code, confidence) values ($1, $2, $3, 'k', 'needs_person', 'low')",
          [orgA, recSep, reviewA],
        ),
      ).toMatchObject({ code: "23514" });
      for (const [reason, confidence, line] of [
        ["made_up", "low", null],
        ["needs_person", "certain", null],
        ["amount_and_date", "high", null], // needs a candidate
        ["no_match_likely_missing", "low", lineIds[1]], // cannot have one
      ])
        expect(
          await set(
            "insert into public.fin_bank_ai_suggestions (org_id, rec_id, review_id, item_key, candidate_line_id, reason_code, confidence) values ($1, $2, $3, 'k2', $4, $5, $6)",
            [orgA, recOct, reviewA, line, reason, confidence],
          ),
          `${reason} ${confidence}`,
        ).toMatchObject({ code: "23514" });
      // another org's run, review or bank line
      expect(
        await set(
          "insert into public.fin_bank_ai_suggestions (org_id, rec_id, review_id, item_key, reason_code, confidence) values ($1, $2, $3, 'k3', 'needs_person', 'low')",
          [orgB, recOct, reviewA],
        ),
      ).toMatchObject({ code: "23514" });
      // a rejected review carries no summary and a reason; an accepted one a summary
      expect(
        await set(
          "insert into public.fin_bank_ai_reviews (org_id, rec_id, status, model) values ($1, $2, 'ok', 'm')",
          [orgA, recOct],
        ),
      ).toMatchObject({ code: "23514" });
      expect(
        await set(
          "insert into public.fin_bank_ai_reviews (org_id, rec_id, status, model, summary) values ($1, $2, 'ok', 'm', $3)",
          [orgA, recOct, "x".repeat(801)],
        ),
      ).toMatchObject({ code: "23514" });
    });

    it("what the AI said never changes, and a decision is made once", async () => {
      const id = await suggest(reviewA, "bank|x1", null);
      expect(
        await set(
          "update public.fin_bank_ai_suggestions set reason_code = 'fee_deducted' where id = $1",
          [id],
        ),
      ).toMatchObject({ code: "23514" });
      expect(
        await set(
          "update public.fin_bank_ai_suggestions set candidate_line_id = $2 where id = $1",
          [id, lineIds[2]],
        ),
      ).toMatchObject({ code: "23514" });
      expect(
        await set("update public.fin_bank_ai_suggestions set decision = 'accepted' where id = $1", [
          id,
        ]),
      ).toMatchObject({ code: "23514" }); // a decision needs its time
      await svc(() =>
        q(
          "update public.fin_bank_ai_suggestions set decision = 'rejected', decided_by = $2, decided_at = now() where id = $1",
          [id, users.fin],
        ),
      );
      expect(
        await set(
          "update public.fin_bank_ai_suggestions set decision = 'accepted', decided_at = now() where id = $1",
          [id],
        ),
      ).toMatchObject({ code: "23514" });
      expect(
        await set(
          "update public.fin_bank_ai_suggestions set decision = 'pending', decided_at = null where id = $1",
          [id],
        ),
      ).toMatchObject({ code: "23514" });
      expect(
        await set(
          "insert into public.fin_bank_ai_suggestions (org_id, rec_id, review_id, item_key, reason_code, confidence, decision, decided_at) values ($1, $2, $3, 'bank|x2', 'needs_person', 'low', 'accepted', now())",
          [orgA, recOct, reviewA],
        ),
      ).toMatchObject({ code: "23514" });
    });

    it("accepting a pair is the 20C match: one line once; then the person who prepared it cannot sign it, and the run freezes the AI too", async () => {
      const sugg = (
        await svc(() =>
          q(
            "select id, item_key, candidate_line_id from public.fin_bank_ai_suggestions where review_id = $1 and candidate_line_id is not null",
            [reviewA],
          ),
        )
      ).rows[0];
      // what applyMatchDecision writes, then the decision
      const accept = (line: string) =>
        q(
          "insert into public.fin_bank_matches (org_id, rec_id, bank_line_id, expected_key, expected_kind, expected_date, expected_amount, bank_amount, score, status, auto, decided_by) values ($1, $2, $3, $4, 'collection', '2026-10-01', 100, 100, 90, 'matched', false, $5)",
          [orgA, recOct, line, sugg.item_key, users.fin],
        );
      await svc(() => accept(sugg.candidate_line_id));
      await svc(() =>
        q(
          "update public.fin_bank_ai_suggestions set decision = 'accepted', decided_by = $2, decided_at = now() where id = $1",
          [sugg.id, users.fin],
        ),
      );
      expect(
        (
          await svc(() =>
            q("select match_status from public.fin_bank_lines where id = $1", [
              sugg.candidate_line_id,
            ]),
          )
        ).rows[0].match_status,
      ).toBe("matched");
      // the same item cannot be matched twice, whoever (or whatever) suggested it
      expect(await err(svc(() => accept(lineIds[3])))).toMatchObject({ code: "23505" });

      // review by fin; fin cannot sign; the Finance Manager (a different person) can
      const pending = await suggest(reviewA, "bank|x3", null);
      await svc(() =>
        q(
          "update public.fin_bank_recs set status = 'reviewed', figures = '{\"problems\": []}'::jsonb, prepared_by = $2 where id = $1",
          [recOct, users.fin],
        ),
      );
      // while reviewed: no new review, no decision
      expect(await err(review(orgA, recOct))).toMatchObject({ code: "23514" });
      expect(
        await set(
          "update public.fin_bank_ai_suggestions set decision = 'rejected', decided_by = $2, decided_at = now() where id = $1",
          [pending, users.fin],
        ),
      ).toMatchObject({ code: "23514" });
      expect(
        await set(
          "update public.fin_bank_recs set status = 'signed', signed_by = $2 where id = $1",
          [recOct, users.fin],
        ),
      ).toMatchObject({ code: "23514" });
      await svc(() =>
        q("update public.fin_bank_recs set status = 'signed', signed_by = $2 where id = $1", [
          recOct,
          users.fin2,
        ]),
      );
      expect(
        await set(
          "update public.fin_bank_ai_suggestions set decision = 'rejected', decided_by = $2, decided_at = now() where id = $1",
          [pending, users.fin2],
        ),
      ).toMatchObject({ code: "23514" });
      // the quality record stays readable after the sign-off
      const { rows } = await asRole("ceo", () =>
        q(
          "select decision, count(*)::int as n from public.fin_bank_ai_suggestions where rec_id = $1 group by decision order by decision",
          [recOct],
        ),
      );
      expect(rows).toEqual([
        { decision: "accepted", n: 1 },
        { decision: "pending", n: 1 },
        { decision: "rejected", n: 1 },
      ]);
    });

    it("a locked month refuses new reviews, decisions and the match an accept would write", async () => {
      const rev = await review(orgA, recSep);
      const id = await suggest(rev, "col|Card|2026-09-29", lineIds[1], recSep);
      await svc(() =>
        q(
          `insert into public.fin_period_closes (org_id, month, status, snapshot, snapshot_hash, built_at, finance_signed_at, ceo_signed_at, locked_at)
           values ($1, '2026-09-01', 'locked', '{}'::jsonb, encode(sha256(convert_to('{}', 'UTF8')), 'hex'), now(), now(), now(), now())`,
          [orgA],
        ),
      );
      expect(await err(review(orgA, recSep))).toMatchObject({ code: "42501" });
      expect(
        await set(
          "update public.fin_bank_ai_suggestions set decision = 'accepted', decided_by = $2, decided_at = now() where id = $1",
          [id, users.fin],
        ),
      ).toMatchObject({ code: "42501" });
      expect(
        await set(
          "insert into public.fin_bank_matches (org_id, rec_id, bank_line_id, expected_key, expected_kind, expected_date, expected_amount, bank_amount, score, status) values ($1, $2, $3, 'col|Card|2026-09-29', 'collection', '2026-09-30', 200, 200, 90, 'matched')",
          [orgA, recSep, lineIds[1]],
        ),
      ).toMatchObject({ code: "42501" });
    });
  });
});
