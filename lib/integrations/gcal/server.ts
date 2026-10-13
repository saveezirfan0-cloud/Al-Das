import "server-only";

import { decryptSecret, encryptSecret } from "@/lib/crypto";
import {
  dbBreakerStore,
  dbCallSink,
  loadAccount,
  readConfig,
  readSecrets,
  type AccountRow,
} from "@/lib/integrations/accounts";
import { redactText } from "@/lib/redact";
import type { AdminClient } from "@/lib/supabase/admin";
import type { Tables } from "@/lib/supabase/types";
import { isTrainingOrg } from "@/lib/training/mode";

import { createGcalClient, type GcalClient } from "./client";
import {
  GCAL_CONNECTIONS_PER_RUN,
  GCAL_LOOKBACK_MS,
  GCAL_MAX_PAGES,
  GCAL_WRITES_PER_CONNECTION,
  gcalBackoffMs,
  readGcalConfig,
  type GcalConfig,
} from "./config";
import {
  buildBusyEvent,
  busyBlocksFromEvents,
  planPush,
  type ApptForSync,
  type GoogleEventLike,
  type LinkForSync,
} from "./event";
import { buildAuthUrl, hashOAuthState, newOAuthState, STATE_TTL_MS, stateDecision } from "./oauth";

/**
 * Google Calendar busy sync (Phase 20e, G7), server side. Everything starts with the integration switch (and refuses a training
 * workspace); every Google call goes through createGcalClient (shared client: host allow-list, timeouts, back-off, breaker, a call
 * log without bodies). Tokens are AES-256-GCM in gcal_connections (service role only).
 */

export type ConnectionRow = Tables<"gcal_connections">;
type Deps = { fetchFn?: typeof fetch; now?: () => Date };

export function buildGcalClient(
  admin: AdminClient,
  account: AccountRow,
  deps: Deps = {},
): GcalClient | null {
  const cfg = readGcalConfig(readConfig(account));
  const secret = readSecrets(account).client_secret;
  if (!cfg.clientId || !secret) return null;
  return createGcalClient({
    clientId: cfg.clientId,
    clientSecret: secret,
    fetchFn: deps.fetchFn,
    sink: dbCallSink(admin, account.org_id),
    breaker: dbBreakerStore(admin, account.org_id, "google_calendar"),
  });
}

export type GateResult = { ok: true; account: AccountRow } | { ok: false; error: string };

/** The integration is on, configured and this is not a training workspace. */
export async function gcalGate(admin: AdminClient, orgId: string): Promise<GateResult> {
  const account = await loadAccount(admin, orgId, "google_calendar");
  if (!account?.enabled)
    return {
      ok: false,
      error:
        "Google Calendar sync is switched off. An administrator can turn it on in Settings, Integrations.",
    };
  if (await isTrainingOrg(admin, orgId))
    return { ok: false, error: "A training workspace cannot connect to Google." };
  if (!readGcalConfig(readConfig(account)).clientId || !readSecrets(account).client_secret)
    return { ok: false, error: "The Google client ID and secret are missing." };
  return { ok: true, account };
}

/** Starts connecting a specialist: stores the state's hash for 10 minutes and returns Google's consent address. */
export async function startConnect(
  admin: AdminClient,
  a: { orgId: string; specialistId: string; userId: string; redirectUri: string; now?: Date },
): Promise<{ ok: true; url: string } | { ok: false; error: string }> {
  const gate = await gcalGate(admin, a.orgId);
  if (!gate.ok) return gate;
  const { data: specialist } = await admin
    .from("specialists")
    .select("id")
    .eq("id", a.specialistId)
    .eq("org_id", a.orgId)
    .eq("active", true)
    .maybeSingle();
  if (!specialist) return { ok: false, error: "Specialist not found." };
  const { state, hash } = newOAuthState();
  const now = a.now ?? new Date();
  const { error } = await admin.from("gcal_oauth_states").insert({
    state_hash: hash,
    org_id: a.orgId,
    specialist_id: a.specialistId,
    user_id: a.userId,
    expires_at: new Date(now.getTime() + STATE_TTL_MS).toISOString(),
  });
  if (error) return { ok: false, error: "Could not start the connection." };
  const cfg = readGcalConfig(readConfig(gate.account));
  return {
    ok: true,
    url: buildAuthUrl({ clientId: cfg.clientId, redirectUri: a.redirectUri, state }),
  };
}

/**
 * Completes the connection on Google's callback: the state must be unused, unexpired and started by the same person in the same
 * workspace; the code is exchanged once; the refresh token is stored encrypted. Replaces an earlier connection of the specialist.
 */
export async function finishConnect(
  admin: AdminClient,
  a: {
    orgId: string;
    userId: string;
    state: string;
    code: string;
    redirectUri: string;
    now?: Date;
  },
  deps: Deps = {},
): Promise<{ ok: true; specialistId: string } | { ok: false; error: string }> {
  const now = a.now ?? new Date();
  const hash = hashOAuthState(a.state);
  const { data: row } = await admin
    .from("gcal_oauth_states")
    .select("org_id, user_id, specialist_id, expires_at, used_at")
    .eq("state_hash", hash)
    .maybeSingle();
  const decision = stateDecision(row, { orgId: a.orgId, userId: a.userId }, now);
  if (decision !== "ok" || !row)
    return {
      ok: false,
      error:
        decision === "expired"
          ? "The connection took too long. Start again."
          : "This connection link is not valid. Start again from Pulse.",
    };
  // Claim the state once (a second callback with the same state finds used_at set).
  const { data: claimed } = await admin
    .from("gcal_oauth_states")
    .update({ used_at: now.toISOString() })
    .eq("state_hash", hash)
    .is("used_at", null)
    .select("state_hash");
  if (!claimed?.length) return { ok: false, error: "This connection link was already used." };

  const gate = await gcalGate(admin, a.orgId);
  if (!gate.ok) return gate;
  const client = buildGcalClient(admin, gate.account, deps);
  if (!client) return { ok: false, error: "The Google client ID and secret are missing." };
  const t = await client.exchangeCode(a.code, a.redirectUri);
  if (!t.ok) return { ok: false, error: "Google did not accept the connection. Try again." };
  if (!t.refreshToken) {
    await client.revoke(t.accessToken);
    return {
      ok: false,
      error:
        "Google did not grant offline access. Remove Pulse from the Google account's third-party access and connect again.",
    };
  }
  await revokeExisting(admin, a.orgId, row.specialist_id);
  const { error } = await admin.from("gcal_connections").insert({
    org_id: a.orgId,
    specialist_id: row.specialist_id,
    status: "active",
    refresh_enc: encryptSecret(t.refreshToken),
    access_enc: encryptSecret(t.accessToken),
    access_expires_at: new Date(now.getTime() + (t.expiresIn - 60) * 1000).toISOString(),
    connected_by: a.userId,
    connected_at: now.toISOString(),
    next_sync_at: now.toISOString(),
  });
  if (error) {
    await client.revoke(t.refreshToken);
    return { ok: false, error: "Could not save the connection." };
  }
  return { ok: true, specialistId: row.specialist_id };
}

/** Marks any live connection of the specialist revoked and wipes its tokens (database only; used before a reconnect). */
async function revokeExisting(admin: AdminClient, orgId: string, specialistId: string) {
  await admin
    .from("gcal_connections")
    .update({
      status: "revoked",
      revoked_at: new Date().toISOString(),
      refresh_enc: null,
      access_enc: null,
      access_expires_at: null,
    })
    .eq("org_id", orgId)
    .eq("specialist_id", specialistId)
    .neq("status", "revoked");
}

async function accessToken(
  admin: AdminClient,
  client: GcalClient,
  conn: ConnectionRow,
  now: Date,
): Promise<{ ok: true; token: string } | { ok: false; revoked: boolean; code: string }> {
  if (
    conn.access_enc &&
    conn.access_expires_at &&
    Date.parse(conn.access_expires_at) > now.getTime() + 60_000
  ) {
    try {
      return { ok: true, token: decryptSecret(conn.access_enc) };
    } catch {
      /* fall through to a refresh */
    }
  }
  if (!conn.refresh_enc) return { ok: false, revoked: true, code: "no_refresh_token" };
  let refresh: string;
  try {
    refresh = decryptSecret(conn.refresh_enc);
  } catch {
    return { ok: false, revoked: true, code: "undecryptable" };
  }
  const t = await client.refresh(refresh);
  if (!t.ok) return { ok: false, revoked: t.revoked, code: t.code };
  await admin
    .from("gcal_connections")
    .update({
      access_enc: encryptSecret(t.accessToken),
      access_expires_at: new Date(now.getTime() + (t.expiresIn - 60) * 1000).toISOString(),
      ...(t.refreshToken ? { refresh_enc: encryptSecret(t.refreshToken) } : {}),
    })
    .eq("id", conn.id);
  return { ok: true, token: t.accessToken };
}

/**
 * Disconnects a specialist: best effort removes the future "Busy" events Pulse wrote (bounded), revokes the token at Google,
 * clears the mirrored busy blocks and wipes the tokens. Works even when the integration has been switched off (no Google call then).
 */
export async function disconnect(
  admin: AdminClient,
  a: { orgId: string; specialistId: string },
  deps: Deps = {},
): Promise<{ ok: true; removedEvents: number } | { ok: false; error: string }> {
  const { data: conn } = await admin
    .from("gcal_connections")
    .select("*")
    .eq("org_id", a.orgId)
    .eq("specialist_id", a.specialistId)
    .neq("status", "revoked")
    .maybeSingle();
  let removed = 0;
  if (conn) {
    const account = await loadAccount(admin, a.orgId, "google_calendar");
    const client =
      account?.enabled && !(await isTrainingOrg(admin, a.orgId))
        ? buildGcalClient(admin, account, deps)
        : null;
    if (client) {
      const now = (deps.now ?? (() => new Date()))();
      const tok = await accessToken(admin, client, conn, now);
      if (tok.ok) {
        const { data: links } = await admin
          .from("gcal_event_links")
          .select("id, event_id, appointments(ends_at)")
          .eq("connection_id", conn.id)
          .eq("status", "live")
          .limit(GCAL_WRITES_PER_CONNECTION * 5);
        for (const l of links ?? []) {
          const end = l.appointments?.ends_at;
          if (end && Date.parse(end) < now.getTime()) continue; // past events stay as history in the doctor's calendar
          const r = await client.deleteEvent(tok.token, conn.calendar_id, l.event_id);
          if (!r.ok) break;
          removed++;
        }
      }
      if (conn.refresh_enc) {
        try {
          await client.revoke(decryptSecret(conn.refresh_enc));
        } catch {
          /* the token is wiped below either way */
        }
      }
    }
    await admin.from("gcal_event_links").delete().eq("connection_id", conn.id);
    await admin
      .from("gcal_connections")
      .update({
        status: "revoked",
        revoked_at: new Date().toISOString(),
        refresh_enc: null,
        access_enc: null,
        access_expires_at: null,
      })
      .eq("id", conn.id);
  }
  const { error } = await admin.rpc("gcal_clear_busy_blocks", {
    p_org: a.orgId,
    p_specialist: a.specialistId,
  });
  if (error) return { ok: false, error: "Could not remove the busy times." };
  return { ok: true, removedEvents: removed };
}

export type SyncOutcome = {
  pulled: { inserted: number; updated: number; deleted: number } | null;
  pushed: number;
  removed: number;
  failed: number;
  error: string | null;
};

async function fail(
  admin: AdminClient,
  conn: ConnectionRow,
  reason: string,
  revoked: boolean,
  now: Date,
) {
  const failures = conn.consecutive_failures + 1;
  await admin
    .from("gcal_connections")
    .update({
      status: "error",
      last_error: redactText(reason, 160),
      consecutive_failures: failures,
      next_sync_at: new Date(
        now.getTime() + (revoked ? 24 * 60 * 60_000 : gcalBackoffMs(failures)),
      ).toISOString(),
    })
    .eq("id", conn.id);
}

/** One connection: pull busy times in (complete reads only), then write appointments out (bounded). Never throws. */
export async function syncConnection(
  admin: AdminClient,
  conn: ConnectionRow,
  account: AccountRow,
  cfg: GcalConfig,
  timeZone: string,
  deps: Deps = {},
): Promise<SyncOutcome> {
  const now = (deps.now ?? (() => new Date()))();
  const out: SyncOutcome = { pulled: null, pushed: 0, removed: 0, failed: 0, error: null };
  const client = buildGcalClient(admin, account, deps);
  if (!client) {
    out.error = "not_configured";
    return out;
  }
  const tok = await accessToken(admin, client, conn, now);
  if (!tok.ok) {
    await fail(
      admin,
      conn,
      tok.revoked
        ? "Google access was withdrawn. Connect the calendar again."
        : `token refresh failed ${tok.code}`,
      tok.revoked,
      now,
    );
    out.error = tok.code;
    return out;
  }
  const from = new Date(now.getTime() - GCAL_LOOKBACK_MS);
  const to = new Date(now.getTime() + cfg.windowDays * 24 * 60 * 60_000);

  // IN
  if (cfg.pullBusy) {
    const items: GoogleEventLike[] = [];
    let page: string | null | undefined;
    let complete = false;
    for (let i = 0; i < GCAL_MAX_PAGES; i++) {
      const r = await client.listEvents(tok.token, conn.calendar_id, from, to, page ?? undefined);
      if (!r.ok) {
        await fail(admin, conn, `reading the calendar failed ${r.code}`, false, now);
        out.error = r.code;
        return out;
      }
      items.push(...r.items);
      page = r.nextPageToken;
      if (!page) {
        complete = true;
        break;
      }
    }
    if (complete) {
      const blocks = busyBlocksFromEvents(items, timeZone);
      const { data, error } = await admin.rpc("gcal_apply_busy_blocks", {
        p_org: conn.org_id,
        p_specialist: conn.specialist_id,
        p_from: from.toISOString(),
        p_to: to.toISOString(),
        p_blocks: blocks,
      });
      if (error) throw new Error(`gcal_apply_busy_blocks failed (${error.code})`);
      out.pulled = data as SyncOutcome["pulled"];
    }
  } else {
    await admin.rpc("gcal_clear_busy_blocks", {
      p_org: conn.org_id,
      p_specialist: conn.specialist_id,
    });
  }

  // OUT
  const { data: links } = await admin
    .from("gcal_event_links")
    .select("appointment_id, event_id, synced_hash, status")
    .eq("connection_id", conn.id)
    .eq("status", "live");
  const linkRows: LinkForSync[] = (links ?? []).map((l) => ({
    appointmentId: l.appointment_id,
    eventId: l.event_id,
    syncedHash: l.synced_hash,
    status: l.status === "deleted" ? "deleted" : "live",
  }));
  const linkedIds = linkRows.map((l) => l.appointmentId).filter((x): x is string => !!x);
  const [{ data: inWindow }, { data: linked }] = await Promise.all([
    admin
      .from("appointments")
      .select("id, specialist_id, starts_at, ends_at, status")
      .eq("org_id", conn.org_id)
      .eq("specialist_id", conn.specialist_id)
      .lt("starts_at", to.toISOString())
      .gt("ends_at", from.toISOString())
      .order("starts_at")
      .limit(1000),
    linkedIds.length
      ? admin
          .from("appointments")
          .select("id, specialist_id, starts_at, ends_at, status")
          .eq("org_id", conn.org_id)
          .in("id", linkedIds.slice(0, 1000))
      : Promise.resolve({ data: [] as never[] }),
  ]);
  const appts = new Map<string, ApptForSync>();
  for (const x of [...(inWindow ?? []), ...(linked ?? [])])
    appts.set(x.id, {
      id: x.id,
      specialistId: x.specialist_id,
      startsAt: x.starts_at,
      endsAt: x.ends_at,
      status: x.status,
    });
  const plan = planPush({
    orgId: conn.org_id,
    specialistId: conn.specialist_id,
    window: { from, to },
    appointments: [...appts.values()],
    links: linkRows,
    enabled: cfg.pushAppointments,
  });

  let writes = 0;
  for (const r of plan.remove) {
    if (writes++ >= GCAL_WRITES_PER_CONNECTION) break;
    const res = await client.deleteEvent(tok.token, conn.calendar_id, r.eventId);
    if (!res.ok) {
      out.failed++;
      if (res.auth || res.retryable) break;
      continue;
    }
    await admin
      .from("gcal_event_links")
      .update({ status: "deleted", last_synced_at: now.toISOString() })
      .eq("connection_id", conn.id)
      .eq("event_id", r.eventId);
    out.removed++;
  }
  for (const u of plan.upsert) {
    if (writes++ >= GCAL_WRITES_PER_CONNECTION) break;
    const event = buildBusyEvent({ startsAt: u.startsAt, endsAt: u.endsAt });
    let res = u.known
      ? await client.updateEvent(tok.token, conn.calendar_id, u.eventId, event)
      : await client.insertEvent(tok.token, conn.calendar_id, u.eventId, event);
    // Not known but already there (an earlier answer was lost), or known but deleted in Google: write it the other way.
    if (res.ok && "exists" in res && res.exists)
      res = await client.updateEvent(tok.token, conn.calendar_id, u.eventId, event);
    else if (!res.ok && res.gone)
      res = await client.insertEvent(tok.token, conn.calendar_id, u.eventId, event);
    if (!res.ok) {
      out.failed++;
      if (res.auth || res.retryable) break;
      continue;
    }
    // A link moved from 'deleted' back to live, or a new one.
    await admin.from("gcal_event_links").upsert(
      {
        org_id: conn.org_id,
        connection_id: conn.id,
        appointment_id: u.appointmentId,
        event_id: u.eventId,
        synced_hash: u.hash,
        status: "live",
        last_synced_at: now.toISOString(),
      },
      { onConflict: "connection_id,event_id" },
    );
    out.pushed++;
  }

  const backlog = writes > GCAL_WRITES_PER_CONNECTION;
  await admin
    .from("gcal_connections")
    .update({
      status: out.failed > 0 ? "error" : "active",
      last_error: out.failed > 0 ? `${out.failed} calendar write(s) failed` : null,
      consecutive_failures: out.failed > 0 ? conn.consecutive_failures + 1 : 0,
      last_pull_at: out.pulled ? now.toISOString() : conn.last_pull_at,
      last_push_at: now.toISOString(),
      // Work left over (or nothing wrong): come back on the next run; after failures, back off.
      next_sync_at: new Date(
        now.getTime() +
          (out.failed > 0
            ? gcalBackoffMs(conn.consecutive_failures + 1)
            : backlog
              ? 0
              : 4 * 60_000),
      ).toISOString(),
    })
    .eq("id", conn.id);
  return out;
}

/**
 * The gcal_sync task (pg_cron every 5 minutes). For each workspace with the integration ON (and not training) the due connections
 * are synced, at most GCAL_CONNECTIONS_PER_RUN per run. A workspace whose integration is OFF makes no Google call; its mirrored
 * busy blocks are removed so stale Google times never block bookings.
 */
export async function sweepGcal(admin: AdminClient, deps: Deps = {}) {
  const now = (deps.now ?? (() => new Date()))();
  const { data: due } = await admin
    .from("gcal_connections")
    .select("*")
    .neq("status", "revoked")
    .lte("next_sync_at", now.toISOString())
    .order("next_sync_at")
    .limit(GCAL_CONNECTIONS_PER_RUN);
  const result = { connections: 0, pushed: 0, removed: 0, failed: 0, skipped_off: 0 };
  const accounts = new Map<string, { account: AccountRow | null; tz: string; training: boolean }>();
  for (const conn of due ?? []) {
    let entry = accounts.get(conn.org_id);
    if (!entry) {
      const [account, { data: org }] = await Promise.all([
        loadAccount(admin, conn.org_id, "google_calendar"),
        admin.from("orgs").select("timezone, is_training").eq("id", conn.org_id).maybeSingle(),
      ]);
      entry = { account, tz: org?.timezone || "Asia/Dubai", training: org?.is_training === true };
      accounts.set(conn.org_id, entry);
    }
    if (!entry.account?.enabled || entry.training) {
      await admin.rpc("gcal_clear_busy_blocks", {
        p_org: conn.org_id,
        p_specialist: conn.specialist_id,
      });
      await admin
        .from("gcal_connections")
        .update({ next_sync_at: new Date(now.getTime() + 60 * 60_000).toISOString() })
        .eq("id", conn.id);
      result.skipped_off++;
      continue;
    }
    try {
      const r = await syncConnection(
        admin,
        conn,
        entry.account,
        readGcalConfig(readConfig(entry.account)),
        entry.tz,
        deps,
      );
      result.connections++;
      result.pushed += r.pushed;
      result.removed += r.removed;
      result.failed += r.failed + (r.error ? 1 : 0);
    } catch (err) {
      result.failed++;
      await fail(admin, conn, redactText(err, 120), false, now);
    }
  }
  return result;
}

/** Switching the integration off: every mirrored Google busy block of the workspace goes at once (no Google call). */
export async function clearAllBusyBlocks(admin: AdminClient, orgId: string): Promise<void> {
  const { data } = await admin
    .from("gcal_connections")
    .select("specialist_id")
    .eq("org_id", orgId)
    .neq("status", "revoked");
  for (const c of data ?? [])
    await admin.rpc("gcal_clear_busy_blocks", { p_org: orgId, p_specialist: c.specialist_id });
}

/** Status of each specialist's connection for the settings page (no token, no Google account detail). */
export async function listConnections(admin: AdminClient, orgId: string) {
  const { data } = await admin
    .from("gcal_connections")
    .select("specialist_id, status, connected_at, last_pull_at, last_push_at, last_error")
    .eq("org_id", orgId)
    .neq("status", "revoked");
  return data ?? [];
}
