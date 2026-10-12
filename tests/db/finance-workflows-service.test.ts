/**
 * Phase 18 server code against a real Postgres through PostgREST (nothing leaves the machine; synthetic data only):
 *   - the daily finance_workflows task: pre-authorisation expiry, denial cases and deadlines, self-pay reminders
 *   - self-pay reminders: who is reminded, the guards, idempotence, the queue
 *   - the payment-advice workflow with a workbook built in the test
 *   - the appeal draft service with a fake model
 *   - the month-end pack built from stored data, and the accounting export builder
 * Runs only with TEST_DATABASE_URL, TEST_POSTGREST_URL and TEST_SERVICE_JWT.
 */
import { randomBytes } from "node:crypto";

import { createClient } from "@supabase/supabase-js";
import type { Client } from "pg";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

import type { Llm } from "@/lib/ai/llm";
import { generateAppealDraft } from "@/lib/finance/appeal-server";
import { closePackPdf } from "@/lib/finance/close-pdf";
import { closePackXlsx } from "@/lib/finance/close-xlsx";
import { buildAndStorePack, liveDriftFor, loadCloseByMonth } from "@/lib/finance/close-server";
import { buildAccountingExport } from "@/lib/finance/export-server";
import {
  commitRemittance,
  buildRemittancePreview,
  discardRemittance,
  stageRemittance,
} from "@/lib/finance/remittance-service";
import { runRecovery } from "@/lib/finance/recovery-server";
import { templateWordingHash } from "@/lib/finance/recovery-approval";
import { runFinanceWorkflows } from "@/lib/finance/workflows";
import type { JobLogger } from "@/lib/jobs/types";
import type { AdminClient } from "@/lib/supabase/admin";
import type { Database } from "@/lib/supabase/types";

import {
  asServiceRole,
  connect,
  createAuthUser,
  createOrg,
  resetDb,
  TEST_DATABASE_URL,
} from "./helpers";

const POSTGREST_URL = process.env.TEST_POSTGREST_URL;
const SERVICE_JWT = process.env.TEST_SERVICE_JWT;
const NOW = new Date("2026-10-12T04:00:00Z");
const day = (offset: number) => new Date(Date.UTC(2026, 9, 12 + offset)).toISOString().slice(0, 10);

describe.skipIf(!TEST_DATABASE_URL || !POSTGREST_URL || !SERVICE_JWT)(
  "phase 18: finance services",
  () => {
    let c: Client;
    let admin: AdminClient;
    let alice: string;
    let insUser: string;
    let org: string;
    let other: string;
    const logs: unknown[] = [];
    const log = {
      info: (...a: unknown[]) => void logs.push(a),
      warn: (...a: unknown[]) => void logs.push(a),
      error: (...a: unknown[]) => void logs.push(a),
    } as JobLogger;
    const q = (sql: string, params: unknown[] = []) => c.query(sql, params);
    const one = async (sql: string, params: unknown[] = []) =>
      (await q(sql + " returning id::text", params)).rows[0].id as string;
    const svc = <T>(fn: () => Promise<T>) => asServiceRole(c, fn);

    beforeAll(async () => {
      process.env.NEXT_PUBLIC_SUPABASE_URL = POSTGREST_URL;
      process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY = "test-anon";
      process.env.SUPABASE_SERVICE_ROLE_KEY = SERVICE_JWT;
      process.env.JOB_SECRET = "test-job-secret-0123456789";
      process.env.ENCRYPTION_KEY = randomBytes(32).toString("base64");
      process.env.APP_URL = "https://pulse.test";
      c = await connect();
      await resetDb(c);
      alice = await createAuthUser(c, "alice@example.test");
      insUser = await createAuthUser(c, "ins@example.test");
      org = await createOrg(c, "Org A", "org-a", alice);
      other = await createOrg(c, "Org B", "org-b", await createAuthUser(c, "bob@example.test"));
      await svc(async () => {
        await q("update public.orgs set timezone = 'Asia/Dubai' where id = any ($1)", [
          [org, other],
        ]);
        await q(
          "insert into public.roles (org_id, name, description, permissions) values ($1, 'Insurance', '', '[\"finance.preauth.manage\",\"finance.denials.manage\"]'::jsonb)",
          [org],
        );
        await q(
          "insert into public.memberships (org_id, user_id, role_id) select $1, $2, id from public.roles where org_id = $1 and name = 'Insurance'",
          [org, insUser],
        );
      });
      admin = createClient<Database>(POSTGREST_URL!, SERVICE_JWT!, {
        auth: { persistSession: false },
      }) as unknown as AdminClient;
    });
    afterAll(async () => {
      await resetDb(c);
      await c.end();
    });

    describe("daily workflows: pre-authorisations", () => {
      it("marks past approvals expired, reminds once for those inside the window (task + one notification), and links claims", async () => {
        await q("delete from pgmq.q_notifications");
        await svc(async () => {
          const contact = await one(
            "insert into public.contacts (org_id, first_name, last_name, external_id) values ($1, 'Pre', 'Auth', 'PIN-W1')",
            [org],
          );
          const mk = (
            pin: string,
            auth: string,
            status: string,
            exp: string | null,
            contactId: string | null = null,
          ) =>
            q(
              "insert into public.fin_pre_authorisations (org_id, patient_pin, contact_id, payer_id, auth_number, status, expires_on) values ($1, $2, $3, 'PA', $4, $5, $6)",
              [org, pin, contactId, auth, status, exp],
            );
          await mk("PIN-W1", "W-SOON", "approved", day(3), contact);
          await mk("PIN-W2", "W-EDGE", "approved", day(7));
          await mk("PIN-W3", "W-FAR", "approved", day(8));
          await mk("PIN-W4", "W-PAST", "approved", day(-2));
          await q(
            "insert into public.fin_pre_authorisations (org_id, patient_pin, payer_id, status) values ($1, 'PIN-W5', 'PA', 'requested')",
            [org],
          );
          await q(
            "insert into public.ins_claim_activities (org_id, claim_activity_number, invoice_no, cpt_code, payer_id, prior_auth_id, transaction_date) values ($1, 'CA-W-1', 'INV', '1', 'PA', 'W-SOON', '2026-10-01')",
            [org],
          );
        });
        const t1 = await runFinanceWorkflows(admin, log, NOW);
        expect(t1).toMatchObject({
          preauth_expired: 1,
          preauth_reminders: 2,
          preauth_tasks: 2,
          preauth_linked: 1,
        });
        await svc(async () => {
          const rows = (
            await q(
              "select auth_number, status, expiry_notified_at is not null as notified, expiry_task_id is not null as task, claim_activity_id is not null as linked from public.fin_pre_authorisations order by auth_number nulls last",
            )
          ).rows;
          const by = Object.fromEntries(rows.map((r) => [r.auth_number, r]));
          expect(by["W-SOON"]).toMatchObject({
            status: "approved",
            notified: true,
            task: true,
            linked: true,
          });
          expect(by["W-EDGE"]).toMatchObject({ notified: true, task: true });
          expect(by["W-FAR"]).toMatchObject({ notified: false, task: false });
          expect(by["W-PAST"]).toMatchObject({ status: "expired", notified: false });
          // generic, name-free wording
          const tasks = (await q("select subject, contact_id from public.tasks")).rows;
          expect(tasks).toHaveLength(2);
          for (const t of tasks) expect(t.subject).toMatch(/^Pre-authorisation expiring/);
          expect(
            (
              await q(
                "select title, body from public.notifications where type = 'finance.preauth_expiring'",
              )
            ).rows[0],
          ).toMatchObject({ title: "2 pre-authorisations are about to expire" });
          // only the people who manage them hear about it
          expect(
            (
              await q(
                "select user_id from public.notifications where type = 'finance.preauth_expiring'",
              )
            ).rows
              .map((r) => r.user_id)
              .sort(),
          ).toEqual([alice, insUser].sort());
        });
        // a second run (a retry, an overlapping run) reminds nobody again
        const t2 = await runFinanceWorkflows(admin, log, NOW);
        expect(t2).toMatchObject({
          preauth_expired: 0,
          preauth_reminders: 0,
          preauth_tasks: 0,
          preauth_linked: 0,
        });
        expect((await q("select count(*)::int as n from public.tasks")).rows[0].n).toBe(2);
      });

      it("can be switched to no tasks, and a renewed approval (new expiry) is reminded again", async () => {
        await svc(async () => {
          await q("delete from public.tasks");
          await q(
            "update public.fin_ref_finance_settings set preauth_task_enabled = false where org_id = $1",
            [org],
          );
          await q(
            "update public.fin_pre_authorisations set expires_on = $1, expiry_notified_at = null where auth_number = 'W-FAR'",
            [day(2)],
          );
        });
        const t = await runFinanceWorkflows(admin, log, NOW);
        expect(t.preauth_reminders).toBe(1);
        expect(t.preauth_tasks).toBe(0);
      });
    });

    describe("daily workflows: denials", () => {
      it("opens cases from the claims, reminds once as the deadline nears (task for the owner), and recovers a paid claim", async () => {
        await svc(async () => {
          await q("delete from public.tasks");
          await q("delete from public.notifications");
          await q(
            "update public.fin_ref_finance_settings set denial_cases_start_date = '2026-08-01', denial_task_enabled = true where org_id = $1",
            [org],
          );
          const mk = (no: string, remit: string, code: string) =>
            q(
              "insert into public.ins_claim_activities (org_id, claim_activity_number, invoice_no, cpt_code, payer_id, transaction_date, last_remittance_date, net, remitted, rejected, last_denial_code) values ($1, $2, 'INV', '99213', 'PD', '2026-09-01', $3, 100, 50, 50, $4)",
              [org, no, remit, code],
            );
          await mk("CA-D-NEAR", day(-25), "AUTH-001"); // deadline = remit + 20 (AUTH family) = day(-5): overdue
          await mk("CA-D-SOON", day(-12), "AUTH-002"); // day(8): outside a 7-day warning
          await mk("CA-D-LATER", day(-3), "AUTH-003");
        });
        const t1 = await runFinanceWorkflows(admin, log, NOW);
        expect(t1.denial_opened).toBe(3);
        expect(t1.denial_reminders).toBe(1);
        expect(t1.denial_tasks).toBe(1);
        await svc(async () => {
          const rows = (
            await q(
              "select claim_number, deadline_on::text as d, deadline_notified_at is not null as n from public.ins_denial_cases order by claim_number",
            )
          ).rows;
          expect(rows.find((r) => r.claim_number === "CA-D-NEAR")).toMatchObject({ n: true });
          expect(rows.find((r) => r.claim_number === "CA-D-SOON")).toMatchObject({ n: false });
          expect((await q("select subject from public.tasks")).rows[0].subject).toBe(
            "Denied claim: resubmission deadline is close",
          );
          expect(
            (
              await q(
                "select count(*)::int as n from public.notifications where type = 'finance.denial_deadline'",
              )
            ).rows[0].n,
          ).toBe(2);
        });
        const t2 = await runFinanceWorkflows(admin, log, NOW);
        expect(t2).toMatchObject({ denial_opened: 0, denial_reminders: 0 });
        // the claim gets paid: the case is recovered by the next run
        await svc(() =>
          q(
            "update public.ins_claim_activities set rejected = 0 where claim_activity_number = 'CA-D-NEAR'",
          ),
        );
        const t3 = await runFinanceWorkflows(admin, log, NOW);
        expect(t3.denial_recovered).toBe(1);
      });

      it("does nothing for an organisation that has not set the start date", async () => {
        await svc(async () => {
          await q(
            "insert into public.ins_claim_activities (org_id, claim_activity_number, invoice_no, cpt_code, payer_id, transaction_date, last_remittance_date, net, rejected, last_denial_code) values ($1, 'CA-OFF', 'I', '1', 'P', '2026-09-01', '2026-09-20', 10, 10, 'AUTH-1')",
            [other],
          );
        });
        await runFinanceWorkflows(admin, log, NOW);
        expect(
          (
            await q("select count(*)::int as n from public.ins_denial_cases where org_id = $1", [
              other,
            ])
          ).rows[0].n,
        ).toBe(0);
      });
    });

    describe("self-pay reminders", () => {
      let tpl: string;
      let optedIn: string;
      const components = [
        {
          type: "BODY",
          text: "Hello {{1}}, a balance of {{2}} on invoice {{3}} is still open. Reply if you have questions.",
        },
      ];

      const invoice = async (pin: string, no: string, total: number, date: string, paid = 0) => {
        const id = await one(
          "insert into public.fin_invoices (org_id, inv_display_number, transaction_date, patient_pin, branch_code, inv_type, gross, net, total, record_hash) values ($1, $2, $3, $4, 'P', 'SELF PAID', $5, $5, $5, 'h')",
          [org, no, date, pin, total],
        );
        if (paid > 0)
          await q(
            "insert into public.fin_payments (org_id, invoice_id, payment_key, payment_mode, paid, paid_date) values ($1, $2, $3, 'CASH', $4, $5)",
            [org, id, `${no}|1|a`, paid, date],
          );
        return id;
      };
      const contact = (
        first: string,
        pin: string,
        opts: {
          phone?: string | null;
          optIn?: boolean;
          stop?: boolean;
          bsuid?: string | null;
        } = {},
      ) =>
        one(
          "insert into public.contacts (org_id, first_name, last_name, external_id, phone_e164, wa_bsuid, promotions_opt_in, stop_marketing) values ($1, $2, 'Test', $3, $4, $5, $6, $7)",
          [
            org,
            first,
            pin,
            opts.phone === undefined
              ? `+4477009${String(Math.floor(Math.random() * 90000 + 10000))}`
              : opts.phone,
            opts.bsuid ?? null,
            opts.optIn ?? true,
            opts.stop ?? false,
          ],
        );
      const queued = async () =>
        (
          await q(
            "select count(*)::int as n from public.messages where org_id = $1 and direction = 'out' and kind = 'template'",
            [org],
          )
        ).rows[0].n as number;

      beforeAll(async () => {
        await svc(async () => {
          const channel = await one(
            "insert into public.channels (org_id, name, waba_id, phone_number_id, display_phone) values ($1, 'Main', 'waba-r', 'pn-r', '+971 4 000 0000')",
            [org],
          );
          tpl = await one(
            "insert into public.wa_templates (org_id, channel_id, waba_id, name, language, category, status, components) values ($1, $2, 'waba-r', 'balance_reminder', 'en', 'UTILITY', 'APPROVED', $3::jsonb)",
            [org, channel, JSON.stringify(components)],
          );
          optedIn = await contact("Layla", "PIN-R1");
          await invoice("PIN-R1", "R-1", 200, day(-40), 50); // balance 150, 40 days
          await contact("Optout", "PIN-R2", { optIn: false });
          await invoice("PIN-R2", "R-2", 200, day(-40));
          await contact("Stopped", "PIN-R3", { stop: true });
          await invoice("PIN-R3", "R-3", 200, day(-40));
          await contact("Nonumber", "PIN-R4", { phone: null });
          await invoice("PIN-R4", "R-4", 200, day(-40));
          await contact("Recent", "PIN-R5");
          await invoice("PIN-R5", "R-5", 200, day(-3)); // not overdue yet
          await contact("Tiny", "PIN-R6");
          await invoice("PIN-R6", "R-6", 20, day(-40)); // below the minimum balance
          await invoice("PIN-R7", "R-7", 200, day(-40)); // no patient record
        });
      });

      const enable = async (
        over: Partial<{ enabled: boolean; approved: boolean; map: Record<string, string> }> = {},
      ) => {
        await svc(() =>
          q(
            `update public.fin_ref_finance_settings set recovery_enabled = $2, recovery_template_id = $3, recovery_variable_map = $4::jsonb,
             recovery_tone_approved_hash = $5, recovery_tone_approved_at = now(), recovery_gap_days = 14, recovery_max_reminders = 3,
             recovery_min_balance = 50, recovery_min_days_overdue = 14 where org_id = $1`,
            [
              org,
              over.enabled ?? true,
              tpl,
              JSON.stringify(
                over.map ?? {
                  "body.1": "first_name",
                  "body.2": "amount_due",
                  "body.3": "invoice_ref",
                },
              ),
              over.approved === false ? null : templateWordingHash(components as never),
            ],
          ),
        );
      };

      it("sends nothing while switched off, unmapped, unapproved or while the wording changed after approval", async () => {
        await enable({ enabled: false });
        expect(
          (
            await runRecovery(admin, org, {
              actorId: null,
              dryRun: false,
              clinicName: "Demo Clinic",
              now: NOW,
            })
          ).blocked[0],
        ).toMatch(/switched off/);
        await enable({ approved: false });
        expect(
          (
            await runRecovery(admin, org, {
              actorId: null,
              dryRun: false,
              clinicName: "Demo",
              now: NOW,
            })
          ).blocked.join(" "),
        ).toMatch(/approved the wording/);
        await enable({ map: { "body.1": "first_name" } });
        expect(
          (
            await runRecovery(admin, org, {
              actorId: null,
              dryRun: false,
              clinicName: "Demo",
              now: NOW,
            })
          ).blocked.join(" "),
        ).toMatch(/Map every template variable/);
        await svc(() =>
          q("update public.wa_templates set components = $2::jsonb where id = $1", [
            tpl,
            JSON.stringify([{ type: "BODY", text: "Pay {{1}} {{2}} {{3}} now." }]),
          ]),
        );
        await enable({ approved: false });
        await svc(() =>
          q(
            "update public.fin_ref_finance_settings set recovery_tone_approved_hash = $2 where org_id = $1",
            [org, templateWordingHash(components as never)],
          ),
        ); // approved the OLD wording
        expect(
          (
            await runRecovery(admin, org, {
              actorId: null,
              dryRun: false,
              clinicName: "Demo",
              now: NOW,
            })
          ).blocked.join(" "),
        ).toMatch(/changed after finance approved/);
        await svc(() =>
          q("update public.wa_templates set components = $2::jsonb where id = $1", [
            tpl,
            JSON.stringify(components),
          ]),
        );
        expect(await queued()).toBe(0);
      });

      it("a dry run shows what would be sent (invoice and amount only) and sends nothing", async () => {
        await enable();
        const r = await runRecovery(admin, org, {
          actorId: null,
          dryRun: true,
          clinicName: "Demo Clinic",
          now: NOW,
        });
        expect(r.preview).toEqual([
          { invoiceNumber: "R-1", balance: 150, sequence: 1, viaGuardian: false },
        ]);
        expect(r.skipped).toEqual({
          no_opt_in: 1,
          stop_marketing: 1,
          no_whatsapp_id: 1,
          no_patient_record: 1,
        }); // R-5 (too recent) and R-6 (too small) never reach the planner: the SQL filters them out
        expect(JSON.stringify(r)).not.toMatch(/Layla|\+44/);
        expect(await queued()).toBe(0);
      });

      it("queues one template message to the opted-in patient only, with the mapped values", async () => {
        await q("delete from pgmq.q_outbound");
        const r = await runRecovery(admin, org, {
          actorId: alice,
          dryRun: false,
          clinicName: "Demo Clinic",
          now: NOW,
        });
        expect(r).toMatchObject({ ok: true, queued: 1, failed: 0 });
        expect(await queued()).toBe(1);
        const m = (
          await q(
            "select payload, body, status, conversation_id from public.messages where org_id = $1 and kind = 'template'",
            [org],
          )
        ).rows[0];
        expect(m.status).toBe("queued");
        expect(m.payload.send).toMatchObject({
          type: "template",
          template_id: tpl,
          values: { "body.1": "Layla", "body.2": "AED 150.00", "body.3": "R-1" },
        });
        expect(m.body).toContain("Hello Layla");
        expect((await q("select count(*)::int as n from pgmq.q_outbound")).rows[0].n).toBe(1);
        const row = (
          await q(
            "select sequence_no, status, contact_id, balance::float as b, created_by from public.fin_recovery_reminders",
          )
        ).rows[0];
        expect(row).toEqual({
          sequence_no: 1,
          status: "queued",
          contact_id: optedIn,
          b: 150,
          created_by: alice,
        });
        expect(
          (
            await q(
              "select count(*)::int as n from public.timeline_events where type = 'finance.payment_reminder'",
            )
          ).rows[0].n,
        ).toBe(1);
      });

      it("is idempotent: the same batch again (or an overlapping run) sends nothing, and the gap is respected", async () => {
        const r = await runRecovery(admin, org, {
          actorId: null,
          dryRun: false,
          clinicName: "Demo",
          now: NOW,
        });
        expect(r.queued).toBe(0);
        expect(r.skipped.reminded_recently).toBe(1);
        expect(await queued()).toBe(1);
        // 14 days later it is the second reminder; after the third, no more
        const later = new Date(NOW.getTime() + 15 * 86_400_000);
        expect(
          (
            await runRecovery(admin, org, {
              actorId: null,
              dryRun: false,
              clinicName: "Demo",
              now: later,
            })
          ).queued,
        ).toBe(1);
        const later2 = new Date(NOW.getTime() + 30 * 86_400_000);
        expect(
          (
            await runRecovery(admin, org, {
              actorId: null,
              dryRun: false,
              clinicName: "Demo",
              now: later2,
            })
          ).queued,
        ).toBe(1);
        const later3 = new Date(NOW.getTime() + 60 * 86_400_000);
        const last = await runRecovery(admin, org, {
          actorId: null,
          dryRun: false,
          clinicName: "Demo",
          now: later3,
        });
        expect(last.queued).toBe(0);
        expect(last.skipped.max_reminders_reached).toBe(1);
        expect(
          (
            await q(
              "select array_agg(sequence_no order by sequence_no) as s from public.fin_recovery_reminders",
            )
          ).rows[0].s,
        ).toEqual([1, 2, 3]);
      });

      it("honours stop_marketing and withdrawn opt-in the moment they change", async () => {
        await svc(async () => {
          await q("delete from public.fin_recovery_reminders");
          await q("update public.contacts set stop_marketing = true where id = $1", [optedIn]);
        });
        expect(
          (
            await runRecovery(admin, org, {
              actorId: null,
              dryRun: false,
              clinicName: "Demo",
              now: NOW,
            })
          ).queued,
        ).toBe(0);
        await svc(() =>
          q(
            "update public.contacts set stop_marketing = false, promotions_opt_in = false where id = $1",
            [optedIn],
          ),
        );
        expect(
          (
            await runRecovery(admin, org, {
              actorId: null,
              dryRun: false,
              clinicName: "Demo",
              now: NOW,
            })
          ).queued,
        ).toBe(0);
        await svc(() =>
          q("update public.contacts set promotions_opt_in = true where id = $1", [optedIn]),
        );
      });

      it("sends a dependant's reminder to the guardian, whose own opt-in is what counts", async () => {
        await svc(async () => {
          await q("delete from public.fin_recovery_reminders");
          const guardian = await contact("Mum", "PIN-G0", { optIn: true });
          const child = await contact("Omar", "PIN-G1", { phone: null, optIn: false });
          await q(
            "insert into public.household_links (org_id, guardian_contact_id, dependant_contact_id) values ($1, $2, $3)",
            [org, guardian, child],
          );
          await invoice("PIN-G1", "G-1", 300, day(-30));
          await q("update public.contacts set promotions_opt_in = false where id = $1", [optedIn]); // keep the first patient out of this run
        });
        const r = await runRecovery(admin, org, {
          actorId: null,
          dryRun: true,
          clinicName: "Demo",
          now: NOW,
        });
        expect(r.preview).toEqual([
          { invoiceNumber: "G-1", balance: 300, sequence: 1, viaGuardian: true },
        ]);
        await svc(() =>
          q("update public.contacts set promotions_opt_in = false where external_id = 'PIN-G0'"),
        ); // the guardian opts out
        expect(
          (
            await runRecovery(admin, org, {
              actorId: null,
              dryRun: true,
              clinicName: "Demo",
              now: NOW,
            })
          ).preview,
        ).toEqual([]);
      });

      it("a failed attempt is retried with the same sequence number, not skipped for good", async () => {
        await svc(async () => {
          await q("delete from public.fin_recovery_reminders");
          await q("update public.contacts set promotions_opt_in = true where id = $1", [optedIn]);
          await q(
            "update public.contacts set promotions_opt_in = false where external_id = 'PIN-G0'",
          );
          // break the template mapping so sending fails after the slot is claimed
          await q(
            'update public.fin_ref_finance_settings set recovery_variable_map = \'{"body.1":"first_name","body.2":"amount_due","body.3":"invoice_ref"}\'::jsonb where org_id = $1',
            [org],
          );
          await q("update public.channels set status = 'paused' where org_id = $1", [org]);
        });
        const blocked = await runRecovery(admin, org, {
          actorId: null,
          dryRun: false,
          clinicName: "Demo",
          now: NOW,
        });
        expect(blocked.queued).toBe(0);
        expect(blocked.blocked.join(" ")).toMatch(/No active WhatsApp number/);
        await svc(() => q("update public.channels set status = 'active' where org_id = $1", [org]));
        expect(
          (
            await runRecovery(admin, org, {
              actorId: null,
              dryRun: false,
              clinicName: "Demo",
              now: NOW,
            })
          ).queued,
        ).toBe(1);
      });
    });

    describe("payment advice", () => {
      const workbook = async (rows: unknown[][]) => {
        const ExcelJS = (await import("exceljs")).default;
        const wb = new ExcelJS.Workbook();
        const ws = wb.addWorksheet("Remittance");
        for (const r of rows) ws.addRow(r);
        return Buffer.from(await wb.xlsx.writeBuffer());
      };
      const HEAD = [
        "RemittanceID",
        "PaymentDate",
        "PayerID",
        "ClaimActivityNumber",
        "PaidAmount",
        "DeniedAmount",
        "MemberID",
        "PatientName",
      ];
      let claimId: string;

      beforeAll(async () => {
        await svc(async () => {
          claimId = await one(
            "insert into public.ins_claim_activities (org_id, claim_activity_number, invoice_no, cpt_code, payer_id, quantity, net, transaction_date) values ($1, 'CA-ADV-1', 'ADMC/C/ADV1', '99213', 'PAYER-ADV', 1, 200, '2026-09-02')",
            [org],
          );
          await q(
            "insert into public.fin_ref_payer_prices (org_id, payer_id, cpt_code, agreed_price) values ($1, 'PAYER-ADV', '99213', 180)",
            [org],
          );
        });
      });

      it("stages a workbook without its personal columns, previews, commits once, and refuses the same bytes again", async () => {
        const buf = await workbook([
          HEAD,
          ["RM-ADV", "01-10-2026", "PAYER-ADV", "CA-ADV-1", 150, 0, "MEMBER-SECRET", "Test Person"],
          ["RM-ADV", "01-10-2026", "PAYER-ADV", "CA-UNKNOWN", 20, 0, "M2", "P2"],
        ]);
        const staged = await stageRemittance(admin, {
          orgId: org,
          userId: alice,
          fileName: "advice.xlsx",
          buffer: buf,
        });
        expect(staged.status).toBe("staged");
        if (staged.status !== "staged") return;
        expect(staged.header.droppedSensitive).toEqual(
          expect.arrayContaining(["MemberID", "PatientName"]),
        );
        // nothing personal reached the database
        const stagedJson = JSON.stringify(
          (
            await q("select data from public.fin_staged_remittance_lines where file_id = $1", [
              staged.fileId,
            ])
          ).rows,
        );
        expect(stagedJson).not.toMatch(/MEMBER-SECRET|Test Person/);
        const preview = await buildRemittancePreview(admin, org, staged.fileId);
        expect(preview?.summary).toMatchObject({ lines: 2, matched: 1, unmatched: 1, short: 1 });
        expect(
          preview?.attention.find((a) => a.claim_activity_number === "CA-ADV-1"),
        ).toMatchObject({ expected_amount: 180, short_amount: 30 });
        const res = await commitRemittance(admin, {
          orgId: org,
          userId: alice,
          fileId: staged.fileId,
        });
        expect(res).toMatchObject({ lines: 2, duplicatesSkipped: 0 });
        expect(
          (
            await q(
              "select claim_activity_id from public.ins_remittance_lines where claim_activity_number = 'CA-ADV-1'",
            )
          ).rows[0].claim_activity_id,
        ).toBe(claimId);
        // the claim itself is never changed by a remittance
        expect(
          (await q("select remitted from public.ins_claim_activities where id = $1", [claimId]))
            .rows[0].remitted,
        ).toBeNull();
        const again = await stageRemittance(admin, {
          orgId: org,
          userId: alice,
          fileName: "advice.xlsx",
          buffer: buf,
        });
        expect(again.status).toBe("duplicate");
        await expect(
          commitRemittance(admin, { orgId: org, userId: alice, fileId: staged.fileId }),
        ).rejects.toThrow(/cannot be committed|already committed/);
      });

      it("rejects an unreadable or malformed file, and a discarded upload leaves nothing staged", async () => {
        const bad = await stageRemittance(admin, {
          orgId: org,
          userId: alice,
          fileName: "x.xlsx",
          buffer: Buffer.from("PK not really a zip"),
        });
        expect(bad.status).toBe("rejected");
        const noPaid = await stageRemittance(admin, {
          orgId: org,
          userId: alice,
          fileName: "csv.csv",
          buffer: Buffer.from("RemittanceID,ClaimActivityNumber\nRM-1,CA-1\n"),
        });
        expect(noPaid).toMatchObject({ status: "rejected" });
        const ok = await stageRemittance(admin, {
          orgId: org,
          userId: alice,
          fileName: "ok.csv",
          buffer: Buffer.from("RemittanceID,ClaimActivityNumber,PaidAmount\nRM-2,CA-ADV-1,180\n"),
        });
        expect(ok.status).toBe("staged");
        if (ok.status !== "staged") return;
        await discardRemittance(admin, org, ok.fileId);
        expect(
          (
            await q(
              "select count(*)::int as n from public.fin_staged_remittance_lines where file_id = $1",
              [ok.fileId],
            )
          ).rows[0].n,
        ).toBe(0);
        await expect(
          commitRemittance(admin, { orgId: org, userId: alice, fileId: ok.fileId }),
        ).rejects.toThrow(/rejected/);
      });
    });

    describe("appeal drafts", () => {
      let caseId: string;
      const fakeLlm = (text: string): Llm => ({
        model: "fake-model",
        complete: async () => ({
          text,
          inputTokens: 90,
          outputTokens: 40,
          refused: false,
          servedBy: "fake-model",
        }),
      });
      const base = () => ({
        orgId: org,
        orgName: "Demo Clinic",
        userId: alice,
        caseId,
        language: "en" as const,
        today: "2026-10-12",
      });

      beforeAll(async () => {
        caseId = await svc(async () => {
          const claim = await one(
            "insert into public.ins_claim_activities (org_id, claim_activity_number, invoice_no, cpt_code, payer_id, net, rejected, last_denial_code, transaction_date, prior_auth_id) values ($1, 'CA-APP-1', 'ADMC/C/APP1', '99213', 'PAYER-AP', 100, 40, 'AUTH-001', '2026-09-01', 'AUTH-REF-9')",
            [org],
          );
          return one(
            "insert into public.ins_denial_cases (org_id, claim_activity_id, claim_number, invoice_no, cpt_code, payer_id, claim_net, rejected_amount, reason_code, category, denied_on, deadline_on) values ($1, $2, 'CA-APP-1', 'ADMC/C/APP1', '99213', 'PAYER-AP', 100, 40, 'AUTH-001', 'authorization', '2026-09-20', '2026-10-20')",
            [org, claim],
          );
        });
      });

      it("writes the standard template when asked, stored as a DRAFT, with no AI call and no usage row", async () => {
        const res = await generateAppealDraft(admin, {
          ...base(),
          orgSettings: {},
          mode: "template",
        });
        expect(res.ok).toBe(true);
        const row = (
          await q(
            "select kind, status, body, model from public.ins_appeal_drafts where case_id = $1",
            [caseId],
          )
        ).rows[0];
        expect(row).toMatchObject({ kind: "template", status: "draft", model: null });
        expect(row.body.startsWith("DRAFT. NOT SENT.")).toBe(true);
        expect(row.body).toContain("AUTH-REF-9"); // the authorisation reference quoted on the claim
        expect(
          (await q("select count(*)::int as n from public.ai_usage where org_id = $1", [org]))
            .rows[0].n,
        ).toBe(0);
      });

      it("refuses AI while the workspace switch is off, and names the template as the way out", async () => {
        const res = await generateAppealDraft(admin, {
          ...base(),
          orgSettings: {},
          mode: "ai",
          llmFactory: () => {
            throw new Error("must not be called");
          },
        });
        expect(res).toMatchObject({ ok: false });
        if (!res.ok) expect(res.error).toMatch(/turned off/);
      });

      it("uses the model when AI is on, keeps the DRAFT banner, logs usage without any text, and flags a risky letter", async () => {
        const settings = { ai: { enabled: true, rate_limit_per_minute: 10, daily_cap: 100 } };
        const res = await generateAppealDraft(admin, {
          ...base(),
          orgSettings: settings,
          mode: "ai",
          llmFactory: () =>
            fakeLlm(
              "Dear Team,\nThe patient needs 500 mg daily.\n[Clinical justification: to be written by the treating clinician]",
            ),
        });
        expect(res.ok).toBe(true);
        if (!res.ok) return;
        expect(res.data!.kind).toBe("ai");
        expect(res.data!.flags.join(" ")).toMatch(/dose|medication/i);
        const row = (
          await q("select body, model, flags from public.ins_appeal_drafts where id = $1", [
            res.data!.draftId,
          ])
        ).rows[0];
        expect(row.body.startsWith("DRAFT. NOT SENT.")).toBe(true);
        expect(row.model).toBe("fake-model");
        const usage = (
          await q(
            "select feature, status, input_tokens, output_tokens, conversation_id, model from public.ai_usage where org_id = $1",
            [org],
          )
        ).rows;
        expect(usage).toEqual([
          {
            feature: "appeal_draft",
            status: "needs_review",
            input_tokens: 90,
            output_tokens: 40,
            conversation_id: null,
            model: "fake-model",
          },
        ]);
        // usage rows hold no prompt or letter text at all
        expect(JSON.stringify((await q("select * from public.ai_usage")).rows)).not.toMatch(
          /Dear Team|AUTH-001|CA-APP-1/,
        );
      });

      it("honours the per-user limit, and another organisation's case is invisible", async () => {
        const limited = { ai: { enabled: true, rate_limit_per_minute: 1, daily_cap: 100 } };
        await svc(() => q("delete from public.rate_limit_hits"));
        const ok = await generateAppealDraft(admin, {
          ...base(),
          orgSettings: limited,
          mode: "ai",
          llmFactory: () => fakeLlm("[Clinical justification]"),
        });
        const second = await generateAppealDraft(admin, {
          ...base(),
          orgSettings: limited,
          mode: "ai",
          llmFactory: () => fakeLlm("[Clinical justification]"),
        });
        expect(ok.ok).toBe(true);
        expect(second).toMatchObject({ ok: false });
        const foreign = await generateAppealDraft(admin, {
          ...base(),
          orgId: other,
          orgSettings: {},
          mode: "template",
        });
        expect(foreign).toMatchObject({ ok: false, error: "That denial case was not found." });
      });

      it("falls back to the template when the model declines", async () => {
        await svc(() => q("delete from public.rate_limit_hits"));
        const refusing: Llm = {
          model: "fake-model",
          complete: async () => ({
            text: "",
            inputTokens: 5,
            outputTokens: 0,
            refused: true,
            servedBy: "fake-model",
          }),
        };
        const res = await generateAppealDraft(admin, {
          ...base(),
          orgSettings: { ai: { enabled: true } },
          mode: "ai",
          llmFactory: () => refusing,
        });
        expect(res).toMatchObject({
          ok: true,
          data: { kind: "template", notice: "The AI declined, so the standard template was used." },
        });
      });
    });

    describe("month-end pack and accounting export", () => {
      beforeAll(async () => {
        await svc(async () => {
          await q("delete from public.ins_claim_activities where org_id = $1", [org]);
          await q("delete from public.fin_invoices where org_id = $1", [org]);
          await q(
            "insert into public.fin_ref_services (org_id, item_code, service_category, description) values ($1, 'T-CONS', 'Consultation', 'Consultation') on conflict (org_id, item_code) do update set service_category = 'Consultation'",
            [org],
          );
          const inv = await one(
            "insert into public.fin_invoices (org_id, inv_display_number, transaction_date, patient_pin, branch_code, doctor_dha_id, doctor_name, department, inv_type, gross, net, vat, total, record_hash) values ($1, 'M-1', '2026-09-10', 'PIN-M1', 'P', 'DHA-M', 'Dr Fake', 'Dermatology', 'SELF PAID', 100, 100, 5, 105, 'h')",
            [org],
          );
          await q(
            "insert into public.fin_invoice_lines (org_id, invoice_id, line_key, position, item_code, qty, line_gross, line_net, vat) values ($1, $2, 'M-1|T-CONS|1', 1, 'T-CONS', 1, 100, 100, 5)",
            [org, inv],
          );
          await q(
            "insert into public.fin_payments (org_id, invoice_id, payment_key, payment_mode, paid, paid_date) values ($1, $2, 'M-1|1|a', 'CASH', 105, '2026-09-10')",
            [org, inv],
          );
          await q(
            "insert into public.fin_ref_account_map (org_id, kind, key, account_code) values ($1, 'revenue', 'Consultation', '4000'), ($1, 'payment_mode', 'CASH', '1010'), ($1, 'receivable', 'self_pay', '1210'), ($1, 'vat_output', '*', '2200') on conflict do nothing",
            [org],
          );
        });
      });

      it("builds a pack from stored data, signs it twice, and renders both files from the frozen snapshot", async () => {
        const { closeId } = await buildAndStorePack(admin, {
          orgId: org,
          orgName: "Demo Clinic",
          month: "2026-09",
          userId: alice,
          now: NOW,
        });
        const first = await loadCloseByMonth(admin, org, "2026-09");
        expect(first?.status).toBe("built");
        expect(first?.pack?.totals).toMatchObject({
          generated: 100,
          invoices: 1,
          self_pay_collected: 105,
          collected: 105,
          revenue_net: 100,
        });
        expect(first?.pack?.revenue.by_doctor[0]).toMatchObject({
          key: "DHA-M",
          label: "Dr Fake",
          net: 100,
        });
        // sign: finance, then a different person as CEO
        await svc(async () => {
          await q("select public.fin_close_sign_finance($1, $2, $3, $4, null)", [
            org,
            closeId,
            alice,
            first!.hash,
          ]);
          await q("select public.fin_close_sign_ceo($1, $2, $3, $4, null)", [
            org,
            closeId,
            insUser,
            first!.hash,
          ]);
        });
        const locked = await loadCloseByMonth(admin, org, "2026-09");
        expect(locked?.status).toBe("locked");
        const xlsx = await closePackXlsx(locked!.pack!, locked!.sign);
        const pdf = await closePackPdf(locked!.pack!, locked!.sign);
        expect(xlsx.length).toBeGreaterThan(1000);
        expect(pdf.subarray(0, 5).toString()).toBe("%PDF-");
        // a late amendment arrives after the lock: the pack stays as signed and the difference is shown
        await svc(() =>
          q(
            "update public.fin_invoices set net = 130, total = 136.5 where inv_display_number = 'M-1' and org_id = $1",
            [org],
          ),
        );
        await svc(() =>
          q(
            "update public.fin_invoice_lines set line_net = 130 where org_id = $1 and line_key = 'M-1|T-CONS|1'",
            [org],
          ),
        );
        const drift = await liveDriftFor(admin, org, locked!.pack!);
        expect(drift.map((d) => d.metric)).toEqual(
          expect.arrayContaining(["generated", "revenue_net"]),
        );
        expect((await loadCloseByMonth(admin, org, "2026-09"))?.pack?.totals.generated).toBe(100);
        await expect(
          buildAndStorePack(admin, {
            orgId: org,
            orgName: "Demo Clinic",
            month: "2026-09",
            userId: alice,
            now: NOW,
          }),
        ).rejects.toThrow(/cannot be rebuilt/);
      });

      it("builds a balanced accounting export, FINAL only when every month is locked, and refuses while an account is unmapped", async () => {
        await svc(() =>
          q(
            "update public.fin_invoices set net = 100, total = 105 where inv_display_number = 'M-1' and org_id = $1",
            [org],
          ),
        );
        await svc(() =>
          q(
            "update public.fin_invoice_lines set line_net = 100 where org_id = $1 and line_key = 'M-1|T-CONS|1'",
            [org],
          ),
        );
        const b = await buildAccountingExport(admin, org, "2026-09-01", "2026-09-30");
        expect(b.status).toBe("final"); // September is locked
        expect(b.result.ok).toBe(true);
        if (b.result.ok) {
          expect(b.result.debitTotal).toBe(b.result.creditTotal);
          expect(b.result.csv).toContain("FINAL");
          expect(b.result.csv).not.toMatch(/PIN-M1|Dr Fake/);
        }
        const wider = await buildAccountingExport(admin, org, "2026-08-15", "2026-10-05");
        expect(wider.status).toBe("provisional");
        expect(wider.openMonths).toEqual(["2026-08", "2026-10"]);
        await svc(() =>
          q("delete from public.fin_ref_account_map where org_id = $1 and kind = 'vat_output'", [
            org,
          ]),
        );
        const missing = await buildAccountingExport(admin, org, "2026-09-01", "2026-09-30");
        expect(missing.result).toMatchObject({ ok: false });
        expect(missing.needed.filter((n) => !n.mapped)).toEqual([
          { kind: "vat_output", key: "*", mapped: false },
        ]);
      });
    });
  },
);
