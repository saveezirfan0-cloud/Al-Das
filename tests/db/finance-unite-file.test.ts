/**
 * Slice A: the saved Unite export as raw batches (file source, unique hash) and the invoice link view.
 * Real fin_apply_invoices / v_fin_invoice_links on a plain Postgres. Synthetic data only.
 */
import type { Client } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { processBatch, type ProcessDeps } from "@/lib/finance/process-batch";

import { rawInvoice } from "../unit/finance/factory";
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

describe.skipIf(!TEST_DATABASE_URL)("Unite file batches and invoice links", () => {
  let c: Client;
  let orgA: string;
  let orgB: string;
  let admin: string;
  let otherAdmin: string;
  let agent: string;

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

  async function batch(
    org: string,
    data: unknown[],
    requestedAt: string,
    source: "api" | "file",
    sha?: string,
  ) {
    const { rows } = await q(
      `insert into public.fin_raw_unite_batches
         (org_id, requested_at, from_date, to_date, count_requested, record_count, payload, payload_sha256, source)
       values ($1, $2, '2026-10-01', '2026-10-01', $3, $3, $4::jsonb, $5, $6) returning id`,
      [
        org,
        requestedAt,
        data.length,
        JSON.stringify({ MessageStatus: "file", Data: data }),
        sha ?? null,
        source,
      ],
    );
    return rows[0].id as string;
  }
  const contact = async (org: string, pin: string, extra = "") =>
    (
      await q(
        `insert into public.contacts (org_id, first_name, last_name, external_id ${extra ? ", " + extra.split("=")[0] : ""})
         values ($1, 'Layla', 'Demo-07', $2 ${extra ? ", " + extra.split("=")[1] : ""}) returning id`,
        [org, pin],
      )
    ).rows[0].id as string;
  const links = (user: string) =>
    asUser(
      c,
      user,
      async () =>
        (
          await q(
            "select inv_display_number, contact_id, appointment_row_id, link_state from public.v_fin_invoice_links order by inv_display_number",
          )
        ).rows,
    );

  beforeAll(async () => {
    c = await connect();
    await resetDb(c);
    admin = await createAuthUser(c, "fu-admin@example.test");
    otherAdmin = await createAuthUser(c, "fu-other@example.test");
    agent = await createAuthUser(c, "fu-agent@example.test");
    orgA = await createOrg(c, "Org A", "org-a", admin);
    orgB = await createOrg(c, "Org B", "org-b", otherAdmin);
    await q(
      "insert into public.memberships (org_id, user_id, role_id) select $1, $2, id from public.roles where org_id = $1 and name = 'Agent'",
      [orgA, agent],
    );
  });
  afterAll(async () => {
    await c.end();
  });

  it("derives link states, follows a merged contact and ignores deleted ones", async () => {
    let ids = { live: "", survivor: "" };
    await svc(async () => {
      const live = await contact(orgA, "TEST-0001");
      const survivor = await contact(orgA, "TEST-SURV");
      const merged = await contact(orgA, "TEST-0002");
      await q("update public.contacts set merged_into_id = $1 where id = $2", [survivor, merged]);
      const gone = await contact(orgA, "TEST-0003");
      await q("update public.contacts set deleted_at = now() where id = $1", [gone]);
      await contact(orgB, "TEST-0001");
      await q(
        "insert into public.appointments (org_id, number, starts_at, ends_at, source, external_id) values ($1, 9001, now(), now() + interval '30 minutes', 'unite', 'APPT-L1')",
        [orgA],
      );
      const b = await batch(
        orgA,
        [
          rawInvoice({
            InvDisplayNumber: "L/1",
            PatientPIN: "TEST-0001",
            AppointmentId: "APPT-L1",
          }),
          rawInvoice({
            InvDisplayNumber: "L/2",
            PatientPIN: "TEST-0001",
            AppointmentId: "APPT-MISSING",
          }),
          rawInvoice({ InvDisplayNumber: "L/3", PatientPIN: "TEST-0001", AppointmentId: "" }),
          rawInvoice({
            InvDisplayNumber: "L/4",
            PatientPIN: "TEST-NOBODY",
            AppointmentId: "APPT-L1",
          }),
          rawInvoice({
            InvDisplayNumber: "L/5",
            PatientPIN: "TEST-0002",
            AppointmentId: "APPT-L1",
          }),
          rawInvoice({ InvDisplayNumber: "L/6", PatientPIN: "TEST-0003", AppointmentId: "" }),
          rawInvoice({ InvDisplayNumber: "L/7", PatientPIN: "", AppointmentId: "" }),
        ],
        "2026-10-01T00:00:00Z",
        "api",
      );
      expect(await processBatch(deps, b)).toMatchObject({ ok: true });
      ids = { live, survivor };
    });
    {
      const { live, survivor } = ids;
      const rows = await links(admin);
      const by = Object.fromEntries(rows.map((r) => [r.inv_display_number, r]));
      expect(by["L/1"]).toMatchObject({ link_state: "linked", contact_id: live });
      expect(by["L/1"].appointment_row_id).not.toBeNull();
      expect(by["L/2"]).toMatchObject({ link_state: "no_appointment", contact_id: live });
      expect(by["L/3"]).toMatchObject({ link_state: "direct", contact_id: live });
      expect(by["L/4"]).toMatchObject({ link_state: "no_patient", contact_id: null });
      expect(by["L/5"]).toMatchObject({ link_state: "linked", contact_id: survivor });
      expect(by["L/6"].link_state).toBe("no_patient");
      expect(by["L/7"].link_state).toBe("no_patient");
    }
  });

  it("shows rows only to a holder of finance.invoices.view, inside their own org", async () => {
    expect((await links(admin)).length).toBe(7);
    expect(await links(agent)).toHaveLength(0);
    expect(await links(otherAdmin)).toHaveLength(0);
  });

  it("keeps file batches unique per org and hash, and the table closed to browsers", async () => {
    await svc(async () => {
      await batch(orgA, [rawInvoice()], "2026-09-01T00:00:00Z", "file", "sha-1");
      await expect(
        batch(orgA, [rawInvoice()], "2026-09-01T00:00:00Z", "file", "sha-1"),
      ).rejects.toThrow(/duplicate key/);
    });
    await svc(async () => {
      await batch(orgB, [rawInvoice()], "2026-09-01T00:00:00Z", "file", "sha-1"); // other org: fine
      await batch(orgA, [rawInvoice()], "2026-09-01T00:00:00Z", "api", "sha-1"); // api rows are not constrained
    });
    await asUser(c, admin, async () => {
      expect(await count(c, "select 1 from public.fin_raw_unite_batches")).toBe(0);
    });
  });

  it("leaves an invoice untouched when an older file chunk arrives after newer API data", async () => {
    await svc(async () => {
      const apiB = await batch(
        orgA,
        [rawInvoice({ InvDisplayNumber: "S/1", PatientPIN: "TEST-API" })],
        "2026-10-10T00:00:00Z",
        "api",
      );
      expect(await processBatch(deps, apiB)).toMatchObject({ ok: true });
      const fileB = await batch(
        orgA,
        [rawInvoice({ InvDisplayNumber: "S/1", PatientPIN: "TEST-FILE" })],
        "2026-10-01T00:00:00Z",
        "file",
        "sha-stale",
      );
      const res = await processBatch(deps, fileB);
      expect(res).toMatchObject({ ok: true, counts: { stale: 1 } });
      const { rows } = await q(
        "select patient_pin, version from public.fin_invoices where org_id = $1 and inv_display_number = 'S/1'",
        [orgA],
      );
      expect(rows[0]).toMatchObject({ patient_pin: "TEST-API", version: 1 });
    });
  });
});
