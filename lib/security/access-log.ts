import "server-only";

import type { CurrentMember } from "@/lib/auth/session";
import { bulkExportAlert, offHoursAlert } from "@/lib/security/anomaly";
import { raiseAlert } from "@/lib/security/alerts";
import { shouldLogAccess, type AccessAction } from "@/lib/security/sampling";
import { readSecuritySettings } from "@/lib/security/settings";
import type { AdminClient } from "@/lib/supabase/admin";
import type { Json } from "@/lib/supabase/types";

export type AccessEntity =
  | "contact"
  | "conversation"
  | "finance_claim"
  | "finance_invoice"
  | "document"
  | "enquiry"
  | "appointment"
  | "portal_record"
  | "export"
  | "activity_log";

type Who = Pick<CurrentMember, "orgId" | "userId"> & {
  org: Pick<CurrentMember["org"], "timezone" | "settings">;
};

/**
 * Writes one record_access_log row: who opened which record (id only, never names or contents).
 * Single-record opens and downloads are always logged; list and search screens are sampled
 * (settings.list_sample_rate). A single-record open outside working hours also raises an alert.
 * Never throws and never blocks the page for long: it is one insert.
 */
export async function recordAccess(
  admin: AdminClient,
  who: Who,
  input: {
    entity: AccessEntity;
    entityId?: string | null;
    action: AccessAction;
    detail?: Record<string, Json>;
  },
  random: () => number = Math.random,
): Promise<void> {
  try {
    const settings = readSecuritySettings(who.org.settings);
    if (!shouldLogAccess(input.action, settings.list_sample_rate, random)) return;
    const { error } = await admin.from("record_access_log").insert({
      org_id: who.orgId,
      user_id: who.userId,
      entity: input.entity,
      entity_id: input.entityId ?? null,
      action: input.action,
      sampled: input.action === "list" || input.action === "search",
      detail: input.detail ?? {},
    });
    if (error) {
      console.error("[access-log] insert failed", { entity: input.entity, code: error.code });
      return;
    }
    if (input.action === "view" || input.action === "download") {
      const draft = offHoursAlert(
        {
          userId: who.userId,
          entity: input.entity,
          now: new Date(),
          timeZone: who.org.timezone || "UTC",
        },
        settings,
      );
      if (draft) await raiseAlert(admin, who.orgId, draft);
    }
  } catch (err) {
    console.error("[access-log] recordAccess threw", {
      error: err instanceof Error ? err.name : "unknown",
    });
  }
}

/**
 * Logs an export (always) and raises a bulk-export alert when it is large or one of a burst.
 * `dataset` is a short machine name ("contacts", "report:revenue"); `rows` is the row count.
 */
export async function recordExport(
  admin: AdminClient,
  who: Who,
  input: { dataset: string; rows: number; format?: string },
): Promise<void> {
  try {
    const settings = readSecuritySettings(who.org.settings);
    const now = new Date();
    const { data, error } = await admin
      .from("record_access_log")
      .insert({
        org_id: who.orgId,
        user_id: who.userId,
        entity: "export",
        entity_id: input.dataset.slice(0, 80),
        action: "export",
        sampled: false,
        detail: { rows: input.rows, format: input.format ?? "csv" },
      })
      .select("id")
      .single();
    if (error || !data) {
      console.error("[access-log] export insert failed", { code: error?.code });
      return;
    }
    const since = new Date(now.getTime() - 3_600_000).toISOString();
    const { count } = await admin
      .from("record_access_log")
      .select("id", { count: "exact", head: true })
      .eq("org_id", who.orgId)
      .eq("user_id", who.userId)
      .eq("action", "export")
      .gte("at", since);
    const draft = bulkExportAlert(
      {
        userId: who.userId,
        entity: input.dataset,
        rows: input.rows,
        exportsLastHour: count ?? 1,
        now,
        exportId: String(data.id),
      },
      settings,
    );
    if (draft) await raiseAlert(admin, who.orgId, draft);
  } catch (err) {
    console.error("[access-log] recordExport threw", {
      error: err instanceof Error ? err.name : "unknown",
    });
  }
}
