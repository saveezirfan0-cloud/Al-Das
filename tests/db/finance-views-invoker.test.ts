/**
 * Finance reporting views after the security-advisor fix (migration 20261119000100, docs/34): no view the API roles
 * can read runs with its owner's rights any more, and every member still sees exactly the rows they saw before.
 *
 * "Before" is the previous view query itself, read from the migration that last defined it and run the way an
 * owner-rights view ran: as the owner (who bypasses RLS) with the member's JWT, so app.has_perm sees the member.
 * Synthetic data only. Runs only with TEST_DATABASE_URL.
 */
import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";

import type { Client } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { FINANCE_ROLES } from "@/lib/auth/permissions";

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

const THIS_MIGRATION = "20261119000100";

/** Views the screens read: now security_invoker, rows unchanged. */
const SWITCHED = [
  "v_fin_receivables_ageing",
  "v_fin_denials",
  "v_fin_claims_status",
  "v_fin_revenue_monthly",
  "v_fin_monthly_measures",
  "v_fin_data_freshness",
  "v_fin_billing_readiness",
  "v_fin_invoice_list",
] as const;

/** Views nothing reads: no API access any more. */
const REVOKED = [
  "v_ins_invoice_match",
  "v_ins_invoice_line_match",
  "v_fin_revenue_daily",
  "v_fin_adjustments_daily",
  "v_fin_collections_daily",
  "v_fin_monthly_summary",
] as const;

const HELPERS = [
  "fin_view_receivables_ageing",
  "fin_view_denials",
  "fin_view_claims_status",
  "fin_view_revenue_monthly",
  "fin_view_monthly_measures",
  "fin_view_data_freshness",
  "fin_view_billing_readiness",
  "fin_invoice_claim_totals",
];

/** The body of the last owner-rights definition of a view before this migration. */
function previousDefinition(view: string): string {
  const dir = path.resolve(__dirname, "../../supabase/migrations");
  const files = readdirSync(dir)
    .filter((f) => f.endsWith(".sql") && f < THIS_MIGRATION)
    .sort();
  const re = new RegExp(
    `create (?:or replace )?view public\\.${view} with \\(security_invoker = false\\) as\\n([\\s\\S]*?);\\n`,
    "g",
  );
  let body: string | null = null;
  for (const f of files) {
    for (const m of readFileSync(path.join(dir, f), "utf8").matchAll(re)) body = m[1];
  }
  if (!body) throw new Error(`no previous definition found for ${view}`);
  return body;
}

/** Order-free comparison of result sets (same driver, so values compare as the API would see them). */
const canon = (rows: Record<string, unknown>[]) =>
  rows
    .map((r) =>
      JSON.stringify(
        Object.keys(r)
          .sort()
          .map((k) => [k, r[k]]),
      ),
    )
    .sort();

describe.skipIf(!TEST_DATABASE_URL)("finance views: security_invoker and unchanged rows", () => {
  let c: Client;
  let orgA: string;
  let orgB: string;
  const users: Record<string, string> = {};
  const invoices: Record<string, string> = {};
  const q = (sql: string, params: unknown[] = []) => c.query(sql, params);

  /** Runs as the view owner with the member's JWT (or none): how an owner-rights view evaluated. */
  async function asOwnerFor<T>(userId: string | null, fn: () => Promise<T>): Promise<T> {
    await q("reset role");
    await q("select set_config('request.jwt.claims', $1, false)", [
      userId ? JSON.stringify({ sub: userId, role: "authenticated" }) : "",
    ]);
    try {
      return await fn();
    } finally {
      await q("select set_config('request.jwt.claims', '', false)");
    }
  }

  async function seedOrg(org: string, tag: string) {
    const batch = (
      await q(
        `insert into public.fin_raw_unite_batches (org_id, from_date, to_date, count_requested, record_count, payload)
         values ($1, current_date - 60, current_date, 50, 4, '{"Data":[]}') returning id`,
        [org],
      )
    ).rows[0].id;
    const invoice = async (
      key: string,
      days: number,
      pin: string | null,
      branch: string,
      type: string,
      net: number,
      deleted = false,
    ) => {
      const id = (
        await q(
          `insert into public.fin_invoices (org_id, inv_display_number, transaction_date, patient_pin, branch_code, inv_type,
             department, doctor_dha_id, doctor_name, gross, discount, net, vat, total, write_off, credit_note, is_deleted,
             record_hash, last_batch_id)
           values ($1, $2, current_date - $3::int, $4, $5, $6, 'Dental', 'DHA-T-1', 'Dr Test One', $7::numeric, 0, $7::numeric, 5, $7::numeric + 5,
             1, 2, $8, 'h', $9) returning id`,
          [org, `ADMC/C/9${tag}${key}`, days, pin, branch, type, net, deleted, batch],
        )
      ).rows[0].id as string;
      invoices[`${tag}${key}`] = id;
      return id;
    };
    const claimed = await invoice("01", 10, "PIN-T-1", "P", "INSURANCE", 100);
    const unclaimed = await invoice("02", 5, "PIN-T-2", "Q", "INSURANCE", 200);
    const selfPay = await invoice("03", 40, null, "P", "SELF PAY", 50);
    await invoice("04", 3, "PIN-T-4", "P", "INSURANCE", 70, true);

    await q(
      "insert into public.fin_ref_services (org_id, item_code, service_category, requires_preauth) values ($1, 'T-PA', 'Procedures', true) on conflict (org_id, item_code) do update set requires_preauth = true, service_category = 'Procedures'",
      [org],
    );
    const line = async (inv: string, key: string, item: string, net: number, current = true) =>
      q(
        `insert into public.fin_invoice_lines (org_id, invoice_id, line_key, position, item_code, cpt_code, qty, line_gross,
           line_discount, line_net, vat, is_current)
         values ($1, $2, $3, 1, $4, '99213', 1, $5, 0, $5, 5, $6)`,
        [org, inv, `${tag}|${key}`, item, net, current],
      );
    await line(claimed, "L1", "T-PA", 100);
    await line(claimed, "L1-old", "T-PA", 90, false);
    await line(unclaimed, "L2", "T-PA", 200);
    await line(selfPay, "L3", "T-PLAIN", 50);

    const payment = async (inv: string, key: string, paid: number) =>
      q(
        `insert into public.fin_payments (org_id, invoice_id, payment_key, instalment, payment_mode, paid, paid_date)
         values ($1, $2, $3, '1', 'CARD', $4, current_date - 2)`,
        [org, inv, `${tag}|${key}`, paid],
      );
    await payment(claimed, "R1", 5);
    await payment(selfPay, "R3", 55);

    await q(
      "update public.fin_ref_finance_settings set ready_start_date = current_date - 365, ready_grace_days = 1, accepted_claim_statuses = '{Approved}' where org_id = $1",
      [org],
    );
    const claim = async (
      no: string,
      inv: string | null,
      days: number,
      net: number,
      remitted: number,
      rejected: number,
      status: string | null,
    ) =>
      q(
        `insert into public.ins_claim_activities (org_id, claim_activity_number, invoice_no, matched_invoice_id, match_status,
           transaction_date, cpt_code, cpt_category, clinician_id, payer_id, net, remitted, rejected, claim_status,
           denial_type, last_denial_code, resubmission_count, claim_year, claim_month)
         values ($1, $2, $3, $4, $5, current_date - $6::int, '99213', 'Procedures', 'DHA-T-1', 'PAYER-T', $7, $8, $9, $10,
           case when $9::numeric > 0 then 'Technical' end, case when $9::numeric > 0 then 'MNEC-T' end, 0,
           extract(year from current_date - $6::int)::int, extract(month from current_date - $6::int)::int)`,
        [
          org,
          `CA-${tag}-${no}`,
          inv ? `ADMC/C/9${tag}01` : `ADMC/C/X${tag}${no}`,
          inv,
          inv ? "matched" : "unmatched",
          days,
          net,
          remitted,
          rejected,
          status,
        ],
      );
    await claim("1", claimed, 10, 100, 60, 40, "Remitted");
    await claim("2", null, 100, 80, 0, 0, null);
    await claim("3", null, 45, 30, 0, 0, "Approved");

    await q(
      "insert into public.ops_exceptions (org_id, rule_code, entity_type, entity_key, owner_role) values ($1, 'E01', 'invoice', $2, 'insurance')",
      [org, `ADMC/C/9${tag}01`],
    );
  }

  beforeAll(async () => {
    c = await connect();
    await resetDb(c);
    await q("truncate public.fin_raw_unite_batches, public.fin_capture_lease cascade");
    for (const n of ["alice", "bob", "fin", "ceo", "md", "billing", "ins", "agent"])
      users[n] = await createAuthUser(c, `${n}@example.test`);
    orgA = await createOrg(c, "Org A", "org-a", users.alice);
    orgB = await createOrg(c, "Org B", "org-b", users.bob);

    await asServiceRole(c, async () => {
      for (const r of FINANCE_ROLES)
        await q(
          "insert into public.roles (org_id, name, description, permissions, is_system) values ($1, $2, $3, $4::jsonb, true) on conflict do nothing",
          [orgA, r.name, r.description, JSON.stringify(r.permissions)],
        );
      const member = (user: string, role: string) =>
        q(
          "insert into public.memberships (org_id, user_id, role_id) select $1, $2, id from public.roles where org_id = $1 and name = $3",
          [orgA, users[user], role],
        );
      await member("fin", "Finance");
      await member("ceo", "CEO");
      await member("md", "Medical Director");
      await member("billing", "Billing");
      await member("ins", "Insurance");
      await member("agent", "Agent"); // a member of org A with no finance permission
      await seedOrg(orgA, "A");
      await seedOrg(orgB, "B");
    });
  });

  afterAll(async () => {
    await c.end();
  });

  it("leaves no view the API roles can read running with its owner's rights (the advisor's security_definer_view rule)", async () => {
    const { rows } = await q(`
      select c.relname as name
      from pg_class c join pg_namespace n on n.oid = c.relnamespace
      where n.nspname = 'public' and c.relkind = 'v'
        and (has_table_privilege('anon', c.oid, 'select') or has_table_privilege('authenticated', c.oid, 'select'))
        and not (lower(coalesce(c.reloptions::text, '{}'))::text[]
                 && array['security_invoker=1', 'security_invoker=true', 'security_invoker=yes', 'security_invoker=on'])`);
    expect(rows.map((r) => r.name)).toEqual([]);
  });

  it("keeps the screen views readable by signed-in users only, and the unread ones by the service role only", async () => {
    for (const v of SWITCHED) {
      const { rows } = await q(
        "select has_table_privilege('anon', $1, 'select') as anon, has_table_privilege('authenticated', $1, 'select') as auth, has_table_privilege('service_role', $1, 'select') as svc",
        [`public.${v}`],
      );
      expect(rows[0], v).toEqual({ anon: false, auth: true, svc: true });
    }
    for (const v of REVOKED) {
      const { rows } = await q(
        "select has_table_privilege('anon', $1, 'select') as anon, has_table_privilege('authenticated', $1, 'select') as auth, has_table_privilege('service_role', $1, 'select') as svc",
        [`public.${v}`],
      );
      expect(rows[0], v).toEqual({ anon: false, auth: false, svc: true });
    }
  });

  it("puts the owner-rights part in app-schema SECURITY DEFINER functions with a pinned search_path, not callable by anon", async () => {
    const { rows } = await q(
      `select p.proname as name, p.prosecdef as definer,
              exists (select 1 from unnest(coalesce(p.proconfig, '{}')) cfg where cfg = 'search_path=""') as pinned,
              has_function_privilege('anon', p.oid, 'execute') as anon,
              has_function_privilege('authenticated', p.oid, 'execute') as auth
       from pg_proc p join pg_namespace n on n.oid = p.pronamespace
       where n.nspname = 'app' and p.proname = any($1)`,
      [HELPERS],
    );
    expect(rows.map((r) => r.name).sort()).toEqual([...HELPERS].sort());
    for (const r of rows)
      expect(r, r.name).toMatchObject({ definer: true, pinned: true, anon: false, auth: true });
  });

  it("refuses signed-in members the unread views, which the service role can still open", async () => {
    for (const v of REVOKED) {
      await asUser(c, users.alice, async () => {
        await expect(q(`select 1 from public.${v}`), v).rejects.toMatchObject({ code: "42501" });
      });
      await asServiceRole(c, async () => {
        // the service role never had rows here (app.has_perm needs a signed-in user), only the grant
        expect(await count(c, `select 1 from public.${v}`)).toBe(0);
      });
    }
  });

  describe.each(SWITCHED)("%s", (view) => {
    const who = ["alice", "fin", "ceo", "md", "billing", "ins", "agent", "bob"];

    it.each(who)("shows %s exactly the rows the owner-rights view showed", async (name) => {
      const before = await asOwnerFor(users[name], () =>
        q(`select * from (${previousDefinition(view)}) v`),
      );
      const after = await asUser(c, users[name], () => q(`select * from public.${view}`));
      expect(after.fields.map((f) => f.name)).toEqual(before.fields.map((f) => f.name));
      expect(canon(after.rows)).toEqual(canon(before.rows));
    });

    it("shows the service role nothing, as before", async () => {
      const before = await asOwnerFor(null, () =>
        q(`select count(*)::int as n from (${previousDefinition(view)}) v`),
      );
      expect(before.rows[0].n).toBe(0);
      await asServiceRole(c, async () => {
        expect(await count(c, `select 1 from public.${view}`)).toBe(0);
      });
    });

    it("shows a member of another organisation and a member without the permission none of org A's rows", async () => {
      for (const name of ["bob", "agent"])
        await asUser(c, users[name], async () => {
          expect(await count(c, `select 1 from public.${view} where org_id = $1`, [orgA])).toBe(0);
        });
      await asUser(c, users.agent, async () => {
        expect(await count(c, `select 1 from public.${view}`)).toBe(0);
      });
      await asUser(c, users.bob, async () => {
        // org B's admin does see org B's own rows (control: the view is not simply empty)
        expect(
          await count(c, `select 1 from public.${view} where org_id = $1`, [orgB]),
        ).toBeGreaterThan(0);
      });
    });
  });

  it("is not vacuous: each permission holder in org A sees rows, including where RLS alone would show none", async () => {
    const seen = async (name: string, view: string) =>
      asUser(c, users[name], () =>
        count(c, `select 1 from public.${view} where org_id = $1`, [orgA]),
      );
    // finance.view aggregates: the Medical Director reads none of the invoice or claim tables directly
    await asUser(c, users.md, async () => {
      expect(await count(c, "select 1 from public.fin_invoices")).toBe(0);
      expect(await count(c, "select 1 from public.ins_claim_activities")).toBe(0);
    });
    for (const view of [
      "v_fin_receivables_ageing",
      "v_fin_denials",
      "v_fin_claims_status",
      "v_fin_revenue_monthly",
      "v_fin_monthly_measures",
      "v_fin_data_freshness",
    ])
      for (const name of ["fin", "ceo", "md", "alice"])
        expect(await seen(name, view), `${name} ${view}`).toBeGreaterThan(0);
    // finance.eligibility.manage: Billing and Insurance, not Finance or the CEO
    for (const name of ["billing", "ins", "alice"])
      expect(await seen(name, "v_fin_billing_readiness"), name).toBeGreaterThan(0);
    for (const name of ["fin", "ceo", "md"])
      expect(await seen(name, "v_fin_billing_readiness"), name).toBe(0);
    // finance.invoices.view: three current invoices and the deleted one
    for (const name of ["fin", "ceo", "billing", "alice"])
      expect(await seen(name, "v_fin_invoice_list"), name).toBe(4);
    for (const name of ["md", "ins"]) expect(await seen(name, "v_fin_invoice_list"), name).toBe(0);
  });

  it("gives Billing claim sums on the invoice list without any claim rows", async () => {
    await asUser(c, users.billing, async () => {
      expect(await count(c, "select 1 from public.ins_claim_activities")).toBe(0);
      const { rows } = await q(
        "select claim_count, claimed, remitted, rejected, paid from public.v_fin_invoice_list where id = $1",
        [invoices.A01],
      );
      expect(rows).toHaveLength(1);
      expect(Number(rows[0].claim_count)).toBe(1);
      expect(Number(rows[0].claimed)).toBe(100);
      expect(Number(rows[0].remitted)).toBe(60);
      expect(Number(rows[0].rejected)).toBe(40);
      expect(Number(rows[0].paid)).toBe(5);
    });
  });

  it("gates the claim-sum helper on the invoice's own permission", async () => {
    const totals = (name: string) =>
      asUser(c, users[name], async () => {
        const { rows } = await q(
          "select claim_count::int as n, claimed from app.fin_invoice_claim_totals($1)",
          [invoices.A01],
        );
        return rows[0];
      });
    expect(await totals("billing")).toMatchObject({ n: 1 });
    for (const name of ["bob", "agent", "md", "ins"])
      expect(await totals(name), name).toEqual({ n: 0, claimed: null });
  });
});
