"use server";

import { z } from "zod";

import { can } from "@/lib/auth/can";
import { requireMember } from "@/lib/auth/session";
import {
  HISTORY_PERMISSION,
  isHistoryTable,
  parseChanges,
  type HistoryEntry,
} from "@/lib/security/history";
import { PORTAL_OBJECTS } from "@/lib/portal/objects";
import { createClient } from "@/lib/supabase/server";

export type HistoryResult =
  | { ok: true; entries: HistoryEntry[]; people: Record<string, string> }
  | { ok: false; error: string };

const input = z.object({ table: z.string().max(63), recordId: z.string().uuid() });
const LIMIT = 100;

/** The permission that lets someone read a table's history: the same one that lets them read the record. */
function permissionFor(table: string): string | null {
  if (!isHistoryTable(table)) return null;
  const fixed = HISTORY_PERMISSION[table];
  if (fixed) return fixed;
  return PORTAL_OBJECTS.find((o) => o.table === table)?.readPerm ?? null;
}

/**
 * Field-level history of one record (appointment, enquiry, task, template, flow or portal record), newest
 * first. Needs the permission to read the record itself; the database policy checks it again.
 */
export async function getRecordHistory(raw: {
  table: string;
  recordId: string;
}): Promise<HistoryResult> {
  const member = await requireMember();
  const parsed = input.safeParse(raw);
  if (!parsed.success) return { ok: false, error: "Invalid input" };
  const perm = permissionFor(parsed.data.table);
  if (!perm || !can(member, perm))
    return { ok: false, error: "You do not have access to this history." };

  const supabase = await createClient(); // RLS: record_history_select
  const { data, error } = await supabase
    .from("record_history")
    .select("id, op, at, actor_id, changes")
    .eq("org_id", member.orgId)
    .eq("table_name", parsed.data.table)
    .eq("record_id", parsed.data.recordId)
    .order("at", { ascending: false })
    .order("id", { ascending: false })
    .limit(LIMIT);
  if (error) return { ok: false, error: "Could not load the history." };

  const actorIds = [
    ...new Set((data ?? []).map((r) => r.actor_id).filter((x): x is string => !!x)),
  ];
  const people: Record<string, string> = {};
  if (actorIds.length) {
    const { data: profiles } = await supabase
      .from("profiles")
      .select("id, first_name, last_name, email")
      .in("id", actorIds);
    for (const p of profiles ?? [])
      people[p.id] = `${p.first_name} ${p.last_name}`.trim() || p.email || "Someone";
  }
  return {
    ok: true,
    people,
    entries: (data ?? []).map((r) => ({
      id: r.id,
      op: r.op as HistoryEntry["op"],
      at: r.at,
      actorId: r.actor_id,
      changes: parseChanges(r.changes),
    })),
  };
}
