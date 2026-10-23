import { z } from "zod";

import { enqueue } from "@/lib/jobs/enqueue";
import { registerHandler } from "@/lib/jobs/registry";
import { registerTask } from "@/lib/jobs/tasks";
import { PermanentJobError } from "@/lib/jobs/types";
import { notifyMembersWithPermission } from "@/lib/notifications";
import type { AdminClient } from "@/lib/supabase/admin";
import { formatInTimeZone } from "date-fns-tz";
import { fromZonedTime } from "date-fns-tz";
import { UniteApiError, UniteBreakerOpen, UniteNotConfigured } from "@/lib/unite/sync-client";
import { UniteAuthError } from "@/lib/unite/sync-auth";
import { loadUniteAccount, buildUniteClient } from "@/lib/unite/store";
import {
  readCursor,
  syncAppointments,
  syncDoctors,
  syncPatients,
  touchCursor,
} from "@/lib/unite/sync";
import type { UniteConfig } from "@/lib/unite/config";
import { daysToSettle, finishedDays, mergeSettled, settledOf } from "@/lib/finance/appointment-api";
import { handOverUniteDays, SETTLED_ENTITY } from "@/lib/finance/appointment-api-server";

/** sync_cursors entity of the settle pull's own run log (kept apart from the forward pull's cursor). */
const SETTLE_RUN_ENTITY = "appointments_settle_run";

/**
 * `unite_sync` queue. Messages:
 *   { org_id, entity: 'appointments', clinic_id, mode: 'incremental' | 'nightly' }
 *   { org_id, entity: 'doctors' | 'patients' }
 *
 * pg_cron wakes two tasks that fan these out: `unite_enqueue` (every 15 min during clinic hours)
 * and `unite_nightly`. Each entity is behind its own flag in integration_accounts.config.enabled
 * (all off by default) and the client is read-only; see lib/unite/sync-client.ts.
 */
const message = z.discriminatedUnion("entity", [
  z.object({
    org_id: z.string().uuid(),
    entity: z.literal("appointments"),
    clinic_id: z.string().min(1),
    mode: z.enum(["incremental", "nightly"]).default("incremental"),
  }),
  z.object({ org_id: z.string().uuid(), entity: z.literal("doctors") }),
  z.object({ org_id: z.string().uuid(), entity: z.literal("patients") }),
]);

export type UniteSyncMessage = z.infer<typeof message>;

/** Window as instants: today 00:00 (clinic clock) … end of day + days. */
export function syncWindow(now: Date, timezone: string, days: number): { from: Date; to: Date } {
  const today = formatInTimeZone(now, timezone, "yyyy-MM-dd");
  const from = fromZonedTime(`${today}T00:00:00`, timezone);
  const to = new Date(from.getTime() + days * 86_400_000);
  return { from, to };
}

export async function runUniteSync(
  admin: AdminClient,
  msg: UniteSyncMessage,
  log: {
    info: (m: string, x?: Record<string, unknown>) => void;
    warn: (m: string, x?: Record<string, unknown>) => void;
    error: (m: string, x?: Record<string, unknown>) => void;
  },
  now: Date = new Date(),
  fetchFn?: typeof fetch,
) {
  const built = await buildUniteClient(admin, msg.org_id, { fetchFn });
  if (!built.ok) {
    if (built.reason === "paused" || built.reason === "no_account")
      return { skipped: built.reason };
    throw new PermanentJobError(`Unite is not configured (${built.reason})`);
  }
  const { client, account, breaker } = built;
  if (!account.config.enabled[msg.entity]) return { skipped: "disabled" as const };

  try {
    switch (msg.entity) {
      case "appointments": {
        const days =
          msg.mode === "nightly" ? account.config.horizon_days : account.config.incremental_days;
        const { from, to } = syncWindow(now, account.config.timezone, days);
        const counters = await syncAppointments({
          admin,
          orgId: msg.org_id,
          source: client,
          config: account.config,
          clinicId: msg.clinic_id,
          from,
          to,
          mode: msg.mode,
          log,
          now,
        });
        log.info("unite appointments synced", { ...counters });
        if (msg.mode !== "nightly") return counters;
        const settled = await settleFinishedDays(admin, msg, client, account.config, log, now);
        return { ...counters, settled };
      }
      case "doctors": {
        const counters = await syncDoctors({ admin, orgId: msg.org_id, source: client, log });
        log.info("unite doctors synced", { ...counters });
        return counters;
      }
      case "patients": {
        const counters = await syncPatients({
          admin,
          orgId: msg.org_id,
          source: client,
          config: account.config,
          log,
          now,
        });
        log.info("unite patients synced", { ...counters });
        return counters;
      }
    }
  } catch (e) {
    if (e instanceof UniteBreakerOpen) {
      log.warn("unite circuit is open; skipping");
      return { skipped: "breaker_open" as const };
    }
    if (e instanceof UniteNotConfigured) throw new PermanentJobError(e.message);
    if (e instanceof UniteApiError || e instanceof UniteAuthError) {
      // Tell the admins the moment the breaker trips (not on every skipped run after that).
      if (await breaker.isOpen())
        await notifyMembersWithPermission(admin, msg.org_id, "settings.manage", {
          type: "integration.unite_paused",
          title: "Unite sync paused",
          body: "Unite failed repeatedly, so calls are paused for a few minutes. Check Settings → Unite.",
        });
    }
    throw e;
  }
}

/**
 * Nightly settle pull (W2, docs/47): re-reads, in ONE quiet call, the finished days of the last week this clinic has
 * not settled yet (the first night: the week before it), so each day's final statuses reach Finance's appointments vs
 * invoices page. A pull that skipped or failed any record settles nothing. Then every day all clinics have settled is
 * handed to W2. Never reaches further back than a week by itself.
 */
async function settleFinishedDays(
  admin: AdminClient,
  msg: Extract<UniteSyncMessage, { entity: "appointments" }>,
  client: Parameters<typeof syncAppointments>[0]["source"],
  config: UniteConfig,
  log: Parameters<typeof runUniteSync>[2],
  now: Date,
) {
  const settled = settledOf(await readCursor(admin, msg.org_id, SETTLED_ENTITY, msg.clinic_id));
  const days = daysToSettle(now, config.timezone, settled);
  let added: string[] = [];
  if (days.length > 0) {
    const today = formatInTimeZone(now, config.timezone, "yyyy-MM-dd");
    const counters = await syncAppointments({
      admin,
      orgId: msg.org_id,
      source: client,
      config,
      clinicId: msg.clinic_id,
      from: fromZonedTime(`${days[0]}T00:00:00`, config.timezone),
      to: fromZonedTime(`${today}T00:00:00`, config.timezone),
      mode: "settle",
      quiet: true,
      cursorEntity: SETTLE_RUN_ENTITY,
      log,
      now,
    });
    const clean = counters.skipped === 0 && Object.keys(counters.errors).length === 0;
    if (clean) added = days;
    else log.warn("unite settle pull incomplete; days stay unsettled", { days: days.length });
    await touchCursor(admin, msg.org_id, SETTLED_ENTITY, msg.clinic_id, {
      ok: clean,
      cursor: { settled: mergeSettled(settled, added) },
    });
  }
  const handed = await handOverUniteDays(
    admin,
    msg.org_id,
    config.timezone,
    finishedDays(now, config.timezone),
    log,
  );
  return { settled: added.length, handed: handed.imported.length };
}

registerHandler({
  queue: "unite_sync",
  name: "unite.sync",
  batchSize: 5,
  visibilityTimeout: 300,
  maxReads: 3,
  concurrency: "serial", // one Unite call at a time, even across messages
  async handler(raw, ctx) {
    const parsed = message.safeParse(raw);
    if (!parsed.success)
      throw new PermanentJobError(`invalid unite_sync message: ${parsed.error.issues[0]?.message}`);
    await runUniteSync(ctx.admin, parsed.data, ctx.log);
  },
});

/** Messages for every org that has Unite switched on. */
async function fanOut(admin: AdminClient, nightly: boolean) {
  const { data: accounts } = await admin
    .from("integration_accounts")
    .select("org_id, config, status")
    .eq("kind", "unite")
    .eq("status", "active");
  let enqueued = 0;
  for (const a of accounts ?? []) {
    const account = await loadUniteAccount(admin, a.org_id);
    if (!account) continue;
    const enabled = account.config.enabled;
    if (enabled.appointments) {
      const { data: locations } = await admin
        .from("locations")
        .select("external_id")
        .eq("org_id", a.org_id)
        .eq("active", true)
        .not("external_id", "is", null);
      for (const l of locations ?? []) {
        await enqueue("unite_sync", {
          org_id: a.org_id,
          entity: "appointments",
          clinic_id: l.external_id,
          mode: nightly ? "nightly" : "incremental",
        });
        enqueued++;
      }
    }
    if (nightly) {
      if (enabled.doctors) {
        await enqueue("unite_sync", { org_id: a.org_id, entity: "doctors" });
        enqueued++;
      }
      if (enabled.patients) {
        await enqueue("unite_sync", { org_id: a.org_id, entity: "patients" });
        enqueued++;
      }
    }
  }
  return { enqueued };
}

registerTask("unite_enqueue", {
  name: "unite.enqueue",
  run: (admin) => fanOut(admin, false),
});
registerTask("unite_nightly", {
  name: "unite.nightly",
  run: (admin) => fanOut(admin, true),
});
