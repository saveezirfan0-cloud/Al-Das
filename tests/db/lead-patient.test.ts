/**
 * Sanoflow lead to Unite patient candidates (docs/45 P4): public.lead_patient_blocks proposes pairs, never merges.
 * Synthetic data only (numbers in the reserved range). Needs TEST_DATABASE_URL.
 */
import type { Client } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { decideLeadMatches } from "@/lib/contacts/lead-match";

import {
  asServiceRole,
  asUser,
  connect,
  createAuthUser,
  createOrg,
  resetDb,
  TEST_DATABASE_URL,
} from "./helpers";

describe.skipIf(!TEST_DATABASE_URL)("Lead to patient candidates (docs/45 P4)", () => {
  let c: Client;
  let org: string;
  let otherOrg: string;
  let owner: string;
  const id: Record<string, string> = {};
  const q = (sql: string, p: unknown[] = []) => c.query(sql, p);
  const contact = async (
    o: string,
    name: [string, string],
    phone: string | null,
    pin: string | null,
    dob: string | null = null,
  ) =>
    (
      await q(
        "insert into public.contacts (org_id, first_name, last_name, phone_e164, external_id, dob) values ($1, $2, $3, $4, $5, $6) returning id::text",
        [o, name[0], name[1], phone, pin, dob],
      )
    ).rows[0].id as string;
  const blocks = (o: string) =>
    asServiceRole(
      c,
      async () =>
        (
          await q(
            "select lead_id::text, patient_id::text, via from public.lead_patient_blocks($1)",
            [o],
          )
        ).rows as Array<{ lead_id: string; patient_id: string; via: string }>,
    );

  beforeAll(async () => {
    c = await connect();
    await resetDb(c);
    owner = await createAuthUser(c, "owner-lp@example.test");
    const stranger = await createAuthUser(c, "stranger-lp@example.test");
    org = await createOrg(c, "Org LP", "org-lp", owner);
    otherOrg = await createOrg(c, "Org LP Other", "org-lp-other", stranger);
    await asServiceRole(c, async () => {
      // Same person: the lead's number has no trunk 0, Unite's does.
      id.leadPhone = await contact(org, ["Layla", "Demo-01"], "+447700900101", null);
      id.patPhone = await contact(
        org,
        ["Layla", "Demo-01"],
        "+4407700900101",
        "10001",
        "1990-03-04",
      );
      // Same two-word name, no phone on the patient.
      id.leadName = await contact(org, ["Omar", "Demo-02"], "+447700900102", null);
      id.patName = await contact(org, ["Demo-02", "Omar"], null, "10002");
      // A one-word name is never a name candidate.
      id.leadOne = await contact(org, ["Lulu", ""], "+447700900103", null);
      id.patOne = await contact(org, ["Lulu", ""], "+447700900104", "10003");
      // Family: guardian lead and dependant patient, linked.
      id.guardian = await contact(org, ["Sara", "Demo-04"], "+447700900105", null);
      id.child = await contact(
        org,
        ["Sara", "Demo-04"],
        "+447700900105".replace("5", "6"),
        "10004",
      );
      await q(
        "insert into public.household_links (org_id, guardian_contact_id, dependant_contact_id, relationship) values ($1, $2, $3, 'child')",
        [org, id.guardian, id.child],
      );
      // Another organisation with the same people.
      await contact(otherOrg, ["Layla", "Demo-01"], "+447700900101", null);
      await contact(otherOrg, ["Layla", "Demo-01"], "+4407700900101", "10001");
      // A soft-deleted lead is ignored.
      id.gone = await contact(org, ["Gone", "Demo-05"], "+447700900107", null);
      await contact(org, ["Gone", "Demo-05"], "+4407700900107", "10005");
      await q("update public.contacts set deleted_at = now() where id = $1", [id.gone]);
    });
  });

  afterAll(async () => {
    await c?.end();
  });

  it("proposes pairs by phone (last nine digits) and by a name of two or more words", async () => {
    const rows = await blocks(org);
    const key = (r: { lead_id: string; patient_id: string; via: string }) =>
      `${r.lead_id}>${r.patient_id}:${r.via}`;
    const got = new Set(rows.map(key));
    expect(got.has(`${id.leadPhone}>${id.patPhone}:phone`)).toBe(true);
    expect(got.has(`${id.leadPhone}>${id.patPhone}:name`)).toBe(true);
    expect(got.has(`${id.leadName}>${id.patName}:name`)).toBe(true); // reordered words
  });

  it("never proposes one-word names, household members, deleted contacts or other organisations", async () => {
    const rows = await blocks(org);
    const leads = new Set(rows.map((r) => r.lead_id));
    expect(leads.has(id.leadOne)).toBe(false);
    expect(leads.has(id.guardian)).toBe(false);
    expect(leads.has(id.gone)).toBe(false);
    const ids = new Set(rows.flatMap((r) => [r.lead_id, r.patient_id]));
    const others = await asServiceRole(c, async () =>
      (await q("select id::text from public.contacts where org_id = $1", [otherOrg])).rows.map(
        (r) => r.id as string,
      ),
    );
    for (const o of others) expect(ids.has(o)).toBe(false);
  });

  it("keeps the function away from browser roles", async () => {
    await expect(
      asUser(c, owner, () => q("select * from public.lead_patient_blocks($1)", [org])),
    ).rejects.toThrow(/permission denied/);
  });

  it("feeds the pure decision: the phone pair is HIGH, the name pair LOW without a date of birth", async () => {
    const rows = await blocks(org);
    const ids = [...new Set(rows.flatMap((r) => [r.lead_id, r.patient_id]))];
    const { rows: people } = await asServiceRole(c, () =>
      q(
        "select id::text, full_name, dob::text, phone_e164, external_id from public.contacts where id = any($1::uuid[])",
        [ids],
      ),
    );
    const out = decideLeadMatches(
      people.map((p) => ({
        id: p.id,
        fullName: p.full_name,
        dob: p.dob,
        phone: p.phone_e164,
        externalId: p.external_id,
      })),
      rows.map((r) => ({ leadId: r.lead_id, patientId: r.patient_id })),
    );
    const byLead = (lead: string) => out.filter((p) => p.leadId === lead);
    expect(byLead(id.leadPhone)[0]!.confidence).toBe("high");
    expect(byLead(id.leadName)[0]!.confidence).toBe("low");
    expect(out.every((p) => !p.ambiguous)).toBe(true);
  });
});
