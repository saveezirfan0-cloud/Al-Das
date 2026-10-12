import "server-only";

import { permissionMatches } from "@/lib/auth/permissions";
import { serverEnv } from "@/lib/env";
import { enqueue } from "@/lib/jobs/enqueue";
import {
  dispatchNotification,
  type DispatchDeps,
  type DispatchResult,
  type NotifyInput,
  type RecipientContext,
} from "@/lib/notify/dispatch";
import type { PrefRow } from "@/lib/notify/preferences";
import type { AdminClient } from "@/lib/supabase/admin";

/** Supabase-backed dependencies for dispatchNotification. Service role: callers have already run can(). */
export function dbDispatchDeps(admin: AdminClient): DispatchDeps {
  return {
    now: () => new Date(),
    appUrl: serverEnv().APP_URL,
    async loadContext(orgId, userIds) {
      const [{ data: org }, { data: members }, { data: prefs }] = await Promise.all([
        admin.from("orgs").select("timezone").eq("id", orgId).maybeSingle(),
        admin
          .from("memberships")
          .select("user_id")
          .eq("org_id", orgId)
          .eq("status", "active")
          .in("user_id", userIds),
        admin
          .from("notification_preferences")
          .select("user_id, event, channel, enabled, quiet_start, quiet_end")
          .eq("org_id", orgId)
          .in("user_id", userIds),
      ]);
      const active = (members ?? []).map((m) => m.user_id);
      const { data: profiles } = active.length
        ? await admin.from("profiles").select("id, email, timezone").in("id", active)
        : { data: [] };
      const byUser = new Map<string, PrefRow[]>();
      for (const p of prefs ?? []) {
        const list = byUser.get(p.user_id) ?? [];
        list.push({
          event: p.event,
          channel: p.channel,
          enabled: p.enabled,
          quiet_start: p.quiet_start,
          quiet_end: p.quiet_end,
        });
        byUser.set(p.user_id, list);
      }
      const recipients = new Map<string, RecipientContext>();
      for (const id of active) {
        const profile = (profiles ?? []).find((p) => p.id === id);
        recipients.set(id, {
          email: profile?.email ?? null,
          timezone: profile?.timezone ?? null,
          prefs: byUser.get(id) ?? [],
        });
      }
      return { orgTimezone: org?.timezone ?? "UTC", recipients };
    },
    async insertInApp(rows) {
      const { error } = await admin.from("notifications").insert(rows);
      if (error)
        console.error("[notify] in-app insert failed", { code: error.code, rows: rows.length });
    },
    async enqueueEmail(job) {
      await enqueue("notifications", job);
    },
    async enqueuePush(job) {
      await enqueue("notifications", job);
    },
  };
}

/** Notify people according to their preferences. Never throws: a notification problem must not break the action. */
export async function notify(
  admin: AdminClient,
  input: NotifyInput,
): Promise<DispatchResult | null> {
  try {
    return await dispatchNotification(dbDispatchDeps(admin), input);
  } catch (err) {
    console.error("[notify] dispatch failed", {
      event: input.event,
      error: err instanceof Error ? err.name : "unknown",
    });
    return null;
  }
}

/** Active members of an org holding a permission (service role; for fan-out such as failed reminders). */
export async function memberIdsWithPermission(
  admin: AdminClient,
  orgId: string,
  permission: string,
): Promise<string[]> {
  const { data } = await admin
    .from("memberships")
    .select("user_id, roles(permissions)")
    .eq("org_id", orgId)
    .eq("status", "active");
  return (data ?? [])
    .filter((m) => {
      const perms = (m.roles?.permissions as unknown[]) ?? [];
      return perms.some((p) => typeof p === "string" && permissionMatches(p, permission));
    })
    .map((m) => m.user_id);
}
