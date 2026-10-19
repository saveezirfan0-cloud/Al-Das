/**
 * docs/48, database side: the rejection origin / avoidable columns of fin_ref_denial_codes (the starter placeholders get
 * the proposed table, anything Finance adds stays not classified, unknown words are refused, a member of another
 * organisation cannot read them) and the diligence_remitted_nets_takebacks setting (null until confirmed, never
 * changed by a browser write). Synthetic data only.
 */
import type { Client } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import proposal from "../unit/finance/fixtures/rejection-origin-proposal.synthetic.json";
import {
  asServiceRole,
  asUser,
  connect,
  createAuthUser,
  createOrg,
  resetDb,
  TEST_DATABASE_URL,
} from "./helpers";

describe.skipIf(!TEST_DATABASE_URL)("docs/48: claim status setting and rejection origin", () => {
  let c: Client;
  let orgA: string;
  let orgB: string;
  let alice: string;
  let bob: string;
  const q = (sql: string, params: unknown[] = []) => c.query(sql, params);
  const code = (msg: Promise<unknown>) =>
    msg.then(
      () => "ok",
      (e: { code?: string }) => e.code ?? "error",
    );

  beforeAll(async () => {
    c = await connect();
    await resetDb(c);
    alice = await createAuthUser(c, "alice@example.test");
    bob = await createAuthUser(c, "bob@example.test");
    orgA = await createOrg(c, "Org A", "org-a", alice);
    orgB = await createOrg(c, "Org B", "org-b", bob);
    await asServiceRole(c, async () => {
      await q("select public.seed_finance_reference($1)", [orgA]);
      await q("select public.seed_finance_reference($1)", [orgB]);
    });
  });
  afterAll(async () => {
    await resetDb(c);
    await c.end();
  });

  it("the starter placeholder codes carry the proposed origin and avoidable flag of their category", async () => {
    const { rows } = await asServiceRole(c, () =>
      q(
        "select category, origin, avoidable from public.fin_ref_denial_codes where org_id = $1 and is_placeholder",
        [orgA],
      ),
    );
    expect(rows.length).toBeGreaterThanOrEqual(8);
    const table = proposal.byCategory as Record<
      string,
      { origin: string | null; avoidable: boolean | null }
    >;
    for (const r of rows)
      expect({ origin: r.origin, avoidable: r.avoidable }).toEqual(table[r.category]);
  });

  it("the SQL proposal equals the shared fixture for every category", async () => {
    for (const [category, want] of Object.entries(proposal.byCategory)) {
      const { rows } = await q("select * from app.fin_denial_origin_proposal($1)", [category]);
      expect(rows[0]).toEqual(want);
    }
  });

  it("a code Finance adds stays not classified until Finance picks a value; unknown words are refused", async () => {
    await asUser(c, alice, async () => {
      await q(
        "insert into public.fin_ref_denial_codes (org_id, code, description, category) values ($1, 'SYN-AUTH-1', 'synthetic', 'authorization')",
        [orgA],
      );
      const { rows } = await q(
        "select origin, avoidable from public.fin_ref_denial_codes where org_id = $1 and code = 'SYN-AUTH-1'",
        [orgA],
      );
      expect(rows[0]).toEqual({ origin: null, avoidable: null });
      await q(
        "update public.fin_ref_denial_codes set origin = 'billing', avoidable = false where org_id = $1 and code = 'SYN-AUTH-1'",
        [orgA],
      );
      expect(
        await code(
          q(
            "update public.fin_ref_denial_codes set origin = 'somewhere' where org_id = $1 and code = 'SYN-AUTH-1'",
            [orgA],
          ),
        ),
      ).toBe("23514");
    });
  });

  it("a member of another organisation cannot read or change the codes", async () => {
    await asUser(c, bob, async () => {
      const { rows } = await q("select code from public.fin_ref_denial_codes where org_id = $1", [
        orgA,
      ]);
      expect(rows).toEqual([]);
      const res = await q(
        "update public.fin_ref_denial_codes set origin = 'payer' where org_id = $1 returning code",
        [orgA],
      );
      expect(res.rowCount).toBe(0);
    });
  });

  it("the take-back setting starts unconfirmed and only the service role writes it", async () => {
    const read = async () =>
      (
        await asServiceRole(c, () =>
          q(
            "select diligence_remitted_nets_takebacks as v from public.fin_ref_finance_settings where org_id = $1",
            [orgA],
          ),
        )
      ).rows[0].v;
    expect(await read()).toBeNull();
    const refused = await asUser(c, alice, () =>
      code(
        q(
          "update public.fin_ref_finance_settings set diligence_remitted_nets_takebacks = true where org_id = $1",
          [orgA],
        ),
      ),
    );
    expect(refused).toBe("42501");
    expect(await read()).toBeNull();
    await asServiceRole(c, () =>
      q(
        "update public.fin_ref_finance_settings set diligence_remitted_nets_takebacks = false where org_id = $1",
        [orgA],
      ),
    );
    expect(await read()).toBe(false);
  });
});
