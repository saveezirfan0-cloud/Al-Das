"use server";

import { z } from "zod";

import { can } from "@/lib/auth/can";
import { requireMember } from "@/lib/auth/session";
import { checkRateLimit, RATE_RULES } from "@/lib/rate-limit";
import { parseRecordQuery, type RecordResult } from "@/lib/shell/record-search";
import { searchRecords } from "@/lib/shell/record-search-server";
import { createAdminClient } from "@/lib/supabase/admin";

const input = z.string().max(500);

export type RecordSearchResult =
  { ok: true; results: RecordResult[] } | { ok: false; error: string };

/**
 * Ctrl+K record search (Phase D): patients, enquiries and tasks the member may open, at most five of each. Read-only.
 * Each kind needs its own view key (checked again inside searchRecords with the list pages' visibility rules). Rate
 * limited per person. The query text is never logged.
 */
export async function searchRecordsAction(query: unknown): Promise<RecordSearchResult> {
  const member = await requireMember();
  if (!can(member, "contacts.view") && !can(member, "enquiries.view") && !can(member, "tasks.view"))
    return { ok: true, results: [] };
  const parsed = input.safeParse(query);
  if (!parsed.success) return { ok: true, results: [] };
  const q = parseRecordQuery(parsed.data);
  if (!q) return { ok: true, results: [] };
  const admin = createAdminClient(); // service role AFTER the permission checks; reads only
  const limit = await checkRateLimit(
    admin,
    "record-search",
    member.userId,
    RATE_RULES.recordSearchPerUser,
  );
  if (!limit.allowed) return { ok: false, error: "Searching too fast. Wait a moment." };
  try {
    return { ok: true, results: await searchRecords(admin, member, q) };
  } catch (e) {
    console.error("[record-search] failed", { error: e instanceof Error ? e.name : "unknown" });
    return { ok: false, error: "Could not search records." };
  }
}
