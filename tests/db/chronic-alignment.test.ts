/**
 * Phase 21B against plain Postgres: chronic recall aligned with how Airtable really works.
 *   - contact_chronic_conditions refuses a diagnosis that is not flagged chronic, from any source, and
 *     the eligibility view ignores a stored row whose diagnosis is no longer flagged chronic;
 *   - the last-visit date is the later of the latest Pulse visit and Unite's patient-level date
 *     (contacts.unite_last_visit_date), and a patient with no Pulse visit is included; parity with the pure rule;
 *   - an imported send carrying the last-visit date blocks that cycle;
 *   - a booked patient is never on the call list;
 *   - erasure clears the date and a merge carries it to the surviving record;
 *   - chronic_condition_min_visits has its corrected description and is still unsigned.
 * Synthetic people only ("Layla Demo-07", +44 7700 900xxx). Runs with TEST_DATABASE_URL.
 */
import type { Client } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { effectiveLastVisitDate } from "@/lib/clinical/chronic";

import {
  asServiceRole,
  connect,
  createAuthUser,
  createOrg,
  resetDb,
  TEST_DATABASE_URL,
} from "./helpers";

describe.skipIf(!TEST_DATABASE_URL)("chronic recall alignment (21B)", () => {
  let c: Client;
  let org: string;
  const id: Record<string, string> = {};

  const one = async (sql: string, params: unknown[] = []) =>
    (await c.query<{ id: string }>(sql + " returning id", params)).rows[0].id;
  const svc = <T>(fn: () => Promise<T>) => asServiceRole(c, fn);
  const sign = (key: string, value: string) =>
    c.query(
      `update public.clinical_settings set approved_value = $3, sign_off_status = 'approved', signed_by = 'Test Signer', signed_at = current_date
       where org_id = $1 and key = $2`,
      [org, key, value],
    );
  const dateAgo = async (days: number) =>
    String((await c.query("select (current_date - $1::int)::text as d", [days])).rows[0].d);
  const eligibility = async () =>
    (
      await c.query<{
        first_name: string;
        last_visit_date: string;
        days_since_last_visit: number;
        cycle_key: string;
        eligible: boolean;
      }>(
        `select c.first_name, e.last_visit_date::text, e.days_since_last_visit, e.cycle_key, e.eligible
           from public.v_chronic_recall_eligibility e join public.contacts c on c.id = e.contact_id
          where e.org_id = $1 order by c.first_name`,
        [org],
      )
    ).rows;

  beforeAll(async () => {
    c = await connect();
    await resetDb(c);
    const admin = await createAuthUser(c, "admin@example.test");
    org = await createOrg(c, "Org A", "org-a", admin);
    await svc(async () => {
      await c.query("select public.seed_phase8_defaults($1)", [org]);
      await sign("chronic_recall_min_days", "90");
      await sign("recall_followup_workdays", "3");
      const dx = (code: string, chronic: boolean, group: string | null) =>
        one(
          `insert into public.ref_diagnoses (org_id, code, chronic, condition_group_id)
           values ($1, $2, $3, (select id from public.ref_condition_groups where org_id = $1 and key = $4))`,
          [org, code, chronic, group],
        );
      id.htn = await dx("I10", true, "hypertension");
      id.dm = await dx("E11.9", true, "diabetes");
      id.uri = await dx("J06.9", false, null);
      const person = (first: string, phone: string, uniteDaysAgo: number | null) =>
        one(
          `insert into public.contacts (org_id, first_name, last_name, phone_e164, unite_last_visit_date)
           values ($1, $2, 'Synthetic', $3, current_date - $4::int)`,
          [org, first, phone, uniteDaysAgo],
        );
      id.layla = await person("Layla Demo-07", "+447700900007", 100); // no Pulse visit at all
      id.omar = await person("Omar Demo-08", "+447700900008", 40); // Pulse visit 200 days ago, Unite later
      id.sara = await person("Sara Demo-09", "+447700900009", null); // Pulse visit only
      id.noor = await person("Noor Demo-10", "+447700900010", 120); // diagnosis later unflagged
      await c.query(
        "insert into public.visits (org_id, contact_id, external_id, visit_date, source) values ($1, $2, 'SYN-V1', current_date - 200, 'unite'), ($1, $3, 'SYN-V2', current_date - 95, 'unite')",
        [org, id.omar, id.sara],
      );
      for (const [contact, dx] of [
        [id.layla, id.htn],
        [id.omar, id.htn],
        [id.sara, id.dm],
        [id.noor, id.dm],
      ])
        await c.query(
          "insert into public.contact_chronic_conditions (org_id, contact_id, ref_diagnosis_id, source) values ($1, $2, $3, 'airtable')",
          [org, contact, dx],
        );
    });
  });

  afterAll(async () => {
    await c?.end();
  });

  it("refuses a chronic condition whose diagnosis is not flagged chronic, from any source", async () => {
    // (ref_diagnoses.chronic is NOT NULL, so a blank flag cannot be stored; the pure rule covers it)
    for (const source of ["airtable", "manual", "visit_diagnoses"])
      await expect(
        svc(() =>
          c.query(
            "insert into public.contact_chronic_conditions (org_id, contact_id, ref_diagnosis_id, source) values ($1, $2, $3, $4)",
            [org, id.sara, id.uri, source],
          ),
        ),
      ).rejects.toThrow(/not flagged chronic/);
    // nor can an existing row be pointed at one
    await expect(
      svc(() =>
        c.query(
          "update public.contact_chronic_conditions set ref_diagnosis_id = $2 where contact_id = $1",
          [id.sara, id.uri],
        ),
      ),
    ).rejects.toThrow(/not flagged chronic/);
  });

  it("counts days from the later of the Pulse visit and Unite's date, including patients with no Pulse visit", async () => {
    const rows = await svc(eligibility);
    expect(rows.map((r) => [r.first_name, r.days_since_last_visit, r.eligible])).toEqual([
      ["Layla Demo-07", 100, true], // Unite date only
      ["Noor Demo-10", 120, true],
      ["Omar Demo-08", 40, false], // Unite's 40 days beats the 200-day-old Pulse visit
      ["Sara Demo-09", 95, true], // Pulse visit only
    ]);
    // the cycle is the effective last-visit date, as the pure rule computes it
    const stats = (
      await svc(() =>
        c.query<{
          contact_id: string;
          last_visit_date: string;
          pulse_last_visit_date: string | null;
          unite_last_visit_date: string | null;
          visit_count: number;
        }>(
          "select contact_id, last_visit_date::text, pulse_last_visit_date::text, unite_last_visit_date::text, visit_count from public.v_contact_visit_stats where org_id = $1",
          [org],
        ),
      )
    ).rows;
    expect(stats).toHaveLength(4);
    for (const s of stats)
      expect(s.last_visit_date).toBe(
        effectiveLastVisitDate(s.pulse_last_visit_date, s.unite_last_visit_date),
      );
    expect(stats.find((s) => s.contact_id === id.layla)?.visit_count).toBe(0);
    expect(rows.find((r) => r.first_name === "Omar Demo-08")?.cycle_key).toBe(await dateAgo(40));
  });

  it("ignores a stored condition once its diagnosis is no longer flagged chronic", async () => {
    await svc(() =>
      c.query("update public.ref_diagnoses set chronic = false where id = $1", [id.dm]),
    );
    expect((await svc(eligibility)).map((r) => r.first_name)).toEqual([
      "Layla Demo-07",
      "Omar Demo-08",
    ]);
    await svc(() =>
      c.query("update public.ref_diagnoses set chronic = true where id = $1", [id.dm]),
    );
  });

  it("an imported send carrying the last-visit date at send blocks that cycle", async () => {
    const prog = (
      await svc(() =>
        c.query<{ id: string }>(
          "select id from public.recall_programmes where org_id = $1 and key = 'chronic_90d'",
          [org],
        ),
      )
    ).rows[0].id;
    await svc(() =>
      c.query(
        `insert into public.recall_sends (org_id, programme_id, contact_id, cycle_key, status, send_mode, sent_at, last_visit_date_at_send, source)
         values ($1, $2, $3, (current_date - 100)::text, 'sent', 'live', now() - interval '20 days', current_date - 100, 'airtable_import')`,
        [org, prog, id.layla],
      ),
    );
    const layla = (await svc(eligibility)).find((r) => r.first_name === "Layla Demo-07");
    expect(layla?.eligible).toBe(false);
  });

  it("never puts a booked patient on the call list", async () => {
    const prog = (
      await svc(() =>
        c.query<{ id: string }>(
          "select id from public.recall_programmes where org_id = $1 and key = 'chronic_90d'",
          [org],
        ),
      )
    ).rows[0].id;
    const send = (contact: string, booked: boolean) =>
      one(
        `insert into public.recall_sends (org_id, programme_id, contact_id, cycle_key, status, send_mode, sent_at, booked_at)
         values ($1, $2, $3, 'cycle-x', 'sent', 'live', now() - interval '20 days', case when $4 then now() end)`,
        [org, prog, contact, booked],
      );
    const open = await svc(() => send(id.sara, false));
    const booked = await svc(() => send(id.noor, true)); // booked, follow-up status not set
    const callNow = async (sendId: string) =>
      (
        await svc(() =>
          c.query<{ call_now: boolean }>(
            "select call_now from public.v_recall_call_list where recall_send_id = $1",
            [sendId],
          ),
        )
      ).rows[0].call_now;
    expect(await callNow(open)).toBe(true);
    expect(await callNow(booked)).toBe(false);
  });

  it("carries the later Unite date to the surviving record on merge, and erasure clears it", async () => {
    const twin = await svc(() =>
      one(
        "insert into public.contacts (org_id, first_name, last_name, unite_last_visit_date) values ($1, 'Layla Demo-07', 'Twin', current_date - 10)",
        [org],
      ),
    );
    await svc(() =>
      c.query("update public.contacts set merged_into_id = $2 where id = $1", [twin, id.omar]),
    );
    const date = async (contact: string) =>
      (
        await svc(() =>
          c.query<{ d: string | null }>(
            "select unite_last_visit_date::text as d from public.contacts where id = $1",
            [contact],
          ),
        )
      ).rows[0].d;
    expect(await date(id.omar)).toBe(await dateAgo(10));

    await svc(() => c.query("select public.erase_contact($1, $2)", [org, id.omar]));
    expect(await date(id.omar)).toBeNull();
  });

  it("corrects the min-visits description without signing it or changing its value", async () => {
    const { rows } = await svc(() =>
      c.query(
        "select notes, proposed_value, approved_value, sign_off_status from public.clinical_settings where org_id = $1 and key = 'chronic_condition_min_visits'",
        [org],
      ),
    );
    expect(rows[0]).toMatchObject({
      proposed_value: "1",
      approved_value: null,
      sign_off_status: "awaiting",
    });
    expect(rows[0].notes).toMatch(/Update Chronic/);
    expect(rows[0].notes).not.toMatch(/how Unite fills it/);
  });
});
