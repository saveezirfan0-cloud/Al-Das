/**
 * One doctor, one identity (specialists ↔ fin_ref_doctors ↔ Unite report key) on Postgres:
 *   - specialists.dha_id and report_doctor_key are unique per org when set (another org may reuse them);
 *   - a signed-in session cannot set or change them, even with settings.manage and finance.reference.manage (the
 *     Doctors page server action does, through the service role), while its other edits still work;
 *   - fin_report_doctor_keys() lists the current report keys with their most frequent spelling, never the direct-sales
 *     bucket or another org's rows, and is service role only.
 * Synthetic data only. Needs TEST_DATABASE_URL.
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

type Err = { code?: string; hint?: string };
const SHA = (i: number) => i.toString(16).padStart(64, "0");

describe.skipIf(!TEST_DATABASE_URL)("doctor identity links", () => {
  let c: Client;
  let org: string;
  let otherOrg: string;
  let owner: string;
  const doc: Record<string, string> = {};

  const q = (sql: string, p: unknown[] = []) => c.query(sql, p);
  const svc = <T>(fn: () => Promise<T>) => asServiceRole(c, fn);
  /** Runs one statement in a transaction that is rolled back; call it inside asUser/svc (the role stays set). */
  async function fails(sql: string, p: unknown[] = []): Promise<Err | null> {
    await q("begin");
    try {
      await q(sql, p);
      return null;
    } catch (e) {
      return e as Err;
    } finally {
      await q("rollback");
    }
  }

  beforeAll(async () => {
    c = await connect();
    await resetDb(c);
    owner = await createAuthUser(c, "owner-link@example.test");
    const stranger = await createAuthUser(c, "stranger-link@example.test");
    org = await createOrg(c, "Org Link", "org-link", owner);
    otherOrg = await createOrg(c, "Org Link Other", "org-link-other", stranger);
    await svc(async () => {
      for (const [k, o, name] of [
        ["a", org, "Dr. Layla Demo-01"],
        ["b", org, "Omar Demo-02"],
        ["x", otherOrg, "Sara Demo-03"],
      ] as const) {
        const { rows } = await q(
          "insert into public.specialists (org_id, name) values ($1, $2) returning id",
          [o, name],
        );
        doc[k] = rows[0].id;
      }
      const { rows: up } = await q(
        `insert into public.fin_report_uploads (org_id, from_date, to_date, file_sha256, status, reconciled, committed_at)
         values ($1, '2026-09-01', '2026-09-30', $2, 'committed', true, now()) returning id`,
        [org, SHA(1)],
      );
      const { rows: upOther } = await q(
        `insert into public.fin_report_uploads (org_id, from_date, to_date, file_sha256, status, reconciled, committed_at)
         values ($1, '2026-09-01', '2026-09-30', $2, 'committed', true, now()) returning id`,
        [otherOrg, SHA(2)],
      );
      const rows: Array<[string, string, number, string, string, boolean]> = [
        [org, up[0].id, 1, "Dr. Layla Demo-01", "layla demo-01", true],
        [org, up[0].id, 2, "Dr.Layla Demo-01", "layla demo-01", true],
        [org, up[0].id, 3, "Dr. Layla Demo-01", "layla demo-01", true],
        [org, up[0].id, 4, "(no doctor)", "(no doctor)", true],
        [org, up[0].id, 5, "Old Demo-04", "old demo-04", false],
        [otherOrg, upOther[0].id, 1, "Away Demo-05", "away demo-05", true],
      ];
      for (const [o, u, n, name, key, current] of rows)
        await q(
          `insert into public.fin_report_visits (org_id, upload_id, row_no, report_date, doctor_name, doctor_key, is_current)
           values ($1, $2, $3, '2026-09-10', $4, $5, $6)`,
          [o, u, n, name, key, current],
        );
    });
  });

  afterAll(async () => {
    await resetDb(c);
    await c.end();
  });

  it("keeps each link unique per org, not across orgs", async () => {
    await svc(async () => {
      await q(
        "update public.specialists set dha_id = 'DHA0001', report_doctor_key = 'k1' where id = $1",
        [doc.a],
      );
      for (const [col, value] of [
        ["dha_id", "DHA0001"],
        ["report_doctor_key", "k1"],
      ]) {
        const e = await fails(`update public.specialists set ${col} = $2 where id = $1`, [
          doc.b,
          value,
        ]);
        expect(e?.code).toBe("23505");
        await q(`update public.specialists set ${col} = $2 where id = $1`, [doc.x, value]);
      }
      const bad = await fails(
        "update public.specialists set report_doctor_key = '(no doctor)' where id = $1",
        [doc.b],
      );
      expect(bad?.code).toBe("23514");
    });
  });

  it("refuses link changes from a signed-in session, even an Admin's", async () => {
    // Admin (*) has settings.manage and finance.reference.manage; the update policy alone would let it through.
    await asUser(c, owner, async () => {
      const set = await fails("update public.specialists set dha_id = 'DHA0009' where id = $1", [
        doc.b,
      ]);
      expect(set).toMatchObject({ code: "42501", hint: "doctor_link_server_only" });
      const clear = await fails(
        "update public.specialists set report_doctor_key = null where id = $1",
        [doc.a],
      );
      expect(clear?.hint).toBe("doctor_link_server_only");
      const insert = await fails(
        "insert into public.specialists (org_id, name, dha_id) values ($1, 'New Demo-06', 'D6')",
        [org],
      );
      expect(insert?.hint).toBe("doctor_link_server_only");
      // Other edits through the browser policy still work, and leave the links alone.
      await q("update public.specialists set title = 'Consultant' where id = $1", [doc.a]);
    });
    await svc(async () => {
      const { rows } = await q(
        "select dha_id, report_doctor_key, title from public.specialists where id = $1",
        [doc.a],
      );
      expect(rows[0]).toEqual({ dha_id: "DHA0001", report_doctor_key: "k1", title: "Consultant" });
      await q(
        "update public.specialists set dha_id = null, report_doctor_key = null where id = $1",
        [doc.a],
      );
    });
  });

  it("lists the current report keys with their most frequent spelling, service role only", async () => {
    const { rows } = await svc(() => q("select public.fin_report_doctor_keys($1) as j", [org]));
    expect(rows[0].j).toEqual([{ key: "layla demo-01", name: "Dr. Layla Demo-01" }]);
    const none = await asUser(c, owner, () =>
      fails("select public.fin_report_doctor_keys($1)", [org]),
    );
    expect(none?.code).toBe("42501");
  });
});
