/**
 * Phase 19b: the data migrations (new permissions for existing roles) and constraints of the 19b tables that the shared sweeps do not
 * cover. Tenant isolation and the permission matrix for the tables are in integrations-rls.test.ts; the service code is tested in the
 * phase19b-*.test.ts files. Synthetic data only. Needs TEST_DATABASE_URL.
 */
import fs from "node:fs";
import path from "node:path";

import type { Client } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { SYSTEM_ROLES } from "@/lib/auth/permissions";

import {
  asServiceRole,
  connect,
  createAuthUser,
  createOrg,
  resetDb,
  TEST_DATABASE_URL,
} from "./helpers";

describe.skipIf(!TEST_DATABASE_URL)("phase 19b: permissions and constraints", () => {
  let c: Client;
  let org: string;
  const q = (sql: string, params: unknown[] = []) => c.query(sql, params);
  const svc = <T>(fn: () => Promise<T>) => asServiceRole(c, fn);
  const code = (p: Promise<unknown>) =>
    p.then(
      () => null,
      (e: { code?: string }) => e.code ?? "error",
    );

  beforeAll(async () => {
    c = await connect();
    await resetDb(c);
    org = await createOrg(c, "Org A", "org-a", await createAuthUser(c, "alice@example.test"));
  });
  afterAll(async () => {
    await resetDb(c);
    await c.end();
  });

  const migration = (name: string) =>
    fs.readFileSync(path.join(__dirname, "../../supabase/migrations", name), "utf8");
  const grantBlock = (name: string) => {
    const block = /do \$\$\ndeclare\n  g record;[\s\S]*?end \$\$;/.exec(migration(name))?.[0];
    expect(block, `the data-migration block of ${name} was not found`).toBeTruthy();
    return block!;
  };

  it("grants ads.view to the existing Manager and Marketing roles once, idempotently, and matches the code presets", async () => {
    const block = grantBlock("20261019000200_ad_attribution.sql");
    const orgC = await svc(async () => {
      const id = (
        await q("insert into public.orgs (name, slug) values ('Org C', 'org-c') returning id")
      ).rows[0].id as string;
      for (const [name, perms] of Object.entries({
        Manager: ["inbox.send", "reports.view"],
        Marketing: ["campaigns.view"],
        Agent: ["inbox.send"],
        Finance: ["finance.view"],
      }))
        await q(
          "insert into public.roles (org_id, name, description, permissions, is_system) values ($1, $2, '', $3::jsonb, true)",
          [id, name, JSON.stringify(perms)],
        );
      await q(
        "insert into public.roles (org_id, name, description, permissions, is_system) values ($1, 'Custom', 'x', '[\"reports.view\"]'::jsonb, false)",
        [id],
      );
      return id;
    });
    const read = async () =>
      Object.fromEntries(
        (
          await svc(() => q("select name, permissions from public.roles where org_id = $1", [orgC]))
        ).rows.map((r) => [r.name, r.permissions as string[]]),
      );
    await svc(() => q(block));
    const first = await read();
    expect(first.Manager).toContain("ads.view");
    expect(first.Marketing).toContain("ads.view");
    expect(first.Agent).not.toContain("ads.view");
    expect(first.Finance).not.toContain("ads.view");
    expect(first.Custom).toEqual(["reports.view"]);
    await svc(() => q(block));
    expect(await read()).toEqual(first);
    const preset = (n: string) => SYSTEM_ROLES.find((r) => r.name === n)!.permissions;
    expect(preset("Manager")).toContain("ads.view");
    expect(preset("Marketing")).toContain("ads.view");
    expect(preset("Agent")).not.toContain("ads.view");
    expect(preset("Receptionist")).not.toContain("ads.view");
  });

  describe("review requests", () => {
    it("keeps one request per visit and allows only the known statuses", async () => {
      await svc(async () => {
        const contact = (
          await q(
            "insert into public.contacts (org_id, first_name, last_name) values ($1, 'A', 'B') returning id",
            [org],
          )
        ).rows[0].id;
        const appt = (
          await q(
            "insert into public.appointments (org_id, contact_id, starts_at, ends_at, status) values ($1, $2, now(), now() + interval '30 minutes', 'completed') returning id",
            [org, contact],
          )
        ).rows[0].id;
        const ins = (status: string) =>
          q(
            "insert into public.review_requests (org_id, appointment_id, contact_id, status, run_at) values ($1, $2, $3, $4, now())",
            [org, appt, contact, status],
          );
        expect(await code(ins("sent"))).toBe("23514");
        expect(await code(ins("scheduled"))).toBeNull();
        expect(await code(ins("scheduled"))).toBe("23505");
      });
    });

    it("the claim function is service-role only", async () => {
      await q("set role authenticated");
      try {
        expect(
          await code(q("select public.claim_review_request($1, gen_random_uuid(), 90)", [org])),
        ).toBe("42501");
        expect(await code(q("select public.review_request_stats($1, now())", [org]))).toBe("42501");
        expect(await code(q("select public.ad_attribution_report($1, now(), 7)", [org]))).toBe(
          "42501",
        );
      } finally {
        await q("reset role");
      }
    });
  });

  describe("ad attribution", () => {
    it("allows only the three event names and a deterministic event id per workspace", async () => {
      await svc(async () => {
        const attr = (
          await q(
            "insert into public.ad_attributions (org_id, ctwa_clid) values ($1, 'constraint-click') returning id",
            [org],
          )
        ).rows[0].id;
        const ins = (name: string, eventId: string) =>
          q(
            "insert into public.capi_events (org_id, attribution_id, event_name, event_id, event_time) values ($1, $2, $3, $4, now())",
            [org, attr, name, eventId],
          );
        expect(await code(ins("Purchase", "evt-constraint-1"))).toBe("23514");
        expect(await code(ins("Schedule", "short"))).toBe("23514");
        expect(await code(ins("Schedule", "evt-constraint-1"))).toBeNull();
        expect(await code(ins("Schedule", "evt-constraint-1"))).toBe("23505");
        // deleting the click removes its events
        await q("delete from public.ad_attributions where id = $1", [attr]);
        expect(
          (
            await q("select count(*)::int as n from public.capi_events where attribution_id = $1", [
              attr,
            ])
          ).rows[0].n,
        ).toBe(0);
      });
    });
  });
});
