import "server-only";

import { withBranchFilter } from "@/lib/branches/filter";
import { isUnanswered, sortUnconfirmed } from "@/lib/front-desk/end-of-day";
import { loadBoardRows, shiftDate, localDayRange } from "@/lib/front-desk/server";
import { redactText } from "@/lib/redact";
import type { AdminClient } from "@/lib/supabase/admin";

export type EndOfDayData = {
  date: string;
  tomorrow: string;
  unconfirmed: Array<{
    id: string;
    starts_at: string;
    patient_name: string;
    phone: string | null;
    specialist_name: string | null;
    advice: "call" | "waiting_reply" | "not_sent_yet";
  }>;
  unanswered: Array<{
    id: string;
    contact_name: string;
    last_message_at: string | null;
    assignee: string | null;
  }>;
  openCalls: Array<{
    id: string;
    subject: string;
    due_at: string;
    contact_name: string | null;
    assignee: string | null;
  }>;
  failed: Array<{
    id: string;
    at: string;
    contact_name: string;
    error_code: number | null;
    error: string | null;
  }>;
  notes: Array<{ id: string; body: string; created_at: string; author: string | null }>;
};

const name = (p: { first_name: string; last_name: string } | null | undefined) =>
  p ? `${p.first_name} ${p.last_name}`.trim() || null : null;

/** Everything on the printed sheet. Ids, names and times only; no message text is ever read. */
export async function loadEndOfDay(
  admin: AdminClient,
  orgId: string,
  timezone: string,
  today: string,
  /** Phase B: the member's branch filter (branchView().filterIds); tomorrow's list and the notes keep to it. */
  branchIds: readonly string[] | null = null,
): Promise<EndOfDayData> {
  const tomorrow = shiftDate(today, 1);
  const todayRange = localDayRange(today, timezone);

  const [tomorrowRows, convs, calls, failed, notes] = await Promise.all([
    loadBoardRows(admin, orgId, timezone, tomorrow, null, branchIds),
    admin
      .from("conversations")
      .select(
        "id, status, last_message_at, last_message_direction, contacts(full_name), profiles:profiles!conversations_assignee_user_id_fkey(first_name, last_name)",
      )
      .eq("org_id", orgId)
      .neq("status", "closed")
      .eq("last_message_direction", "in")
      .order("last_message_at")
      .limit(60),
    // Phase B: open call tasks keep to the branch filter too (tasks.location_id).
    withBranchFilter(
      admin
        .from("tasks")
        .select(
          "id, subject, due_at, contacts(full_name), profiles:profiles!tasks_assignee_id_fkey(first_name, last_name)",
        )
        .eq("org_id", orgId)
        .eq("type", "call")
        .eq("done", false)
        .is("deleted_at", null),
      branchIds,
    )
      .order("due_at")
      .limit(60),
    admin
      .from("messages")
      .select("id, at, error_code, error_message, conversations(contacts(full_name))")
      .eq("org_id", orgId)
      .eq("direction", "out")
      .eq("status", "failed")
      .gte("at", todayRange.gte)
      .order("at", { ascending: false })
      .limit(60),
    withBranchFilter(
      admin
        .from("handover_notes")
        .select(
          "id, body, created_at, profiles:profiles!handover_notes_created_by_fkey(first_name, last_name)",
        )
        .eq("org_id", orgId)
        .is("resolved_at", null),
      branchIds,
    )
      .order("created_at", { ascending: false })
      .limit(20),
  ]);

  return {
    date: today,
    tomorrow,
    unconfirmed: sortUnconfirmed(tomorrowRows).map((r) => ({
      id: r.id,
      starts_at: r.starts_at,
      patient_name: r.patient_name,
      phone: r.phone,
      specialist_name: r.specialist_name,
      advice: r.advice,
    })),
    unanswered: (
      (convs.data ?? []) as unknown as Array<{
        id: string;
        status: string;
        last_message_at: string | null;
        last_message_direction: string | null;
        contacts: { full_name: string | null } | null;
        profiles: { first_name: string; last_name: string } | null;
      }>
    )
      .filter(isUnanswered)
      .map((c) => ({
        id: c.id,
        contact_name: c.contacts?.full_name || "Unnamed patient",
        last_message_at: c.last_message_at,
        assignee: name(c.profiles),
      })),
    openCalls: (
      (calls.data ?? []) as unknown as Array<{
        id: string;
        subject: string;
        due_at: string;
        contacts: { full_name: string | null } | null;
        profiles: { first_name: string; last_name: string } | null;
      }>
    ).map((t) => ({
      id: t.id,
      subject: t.subject,
      due_at: t.due_at,
      contact_name: t.contacts?.full_name ?? null,
      assignee: name(t.profiles),
    })),
    failed: (
      (failed.data ?? []) as unknown as Array<{
        id: string;
        at: string;
        error_code: number | null;
        error_message: string | null;
        conversations: { contacts: { full_name: string | null } | null } | null;
      }>
    ).map((m) => ({
      id: m.id,
      at: m.at,
      contact_name: m.conversations?.contacts?.full_name || "Unnamed patient",
      error_code: m.error_code,
      error: m.error_message ? redactText(m.error_message, 120) : null,
    })),
    notes: (
      (notes.data ?? []) as unknown as Array<{
        id: string;
        body: string;
        created_at: string;
        profiles: { first_name: string; last_name: string } | null;
      }>
    ).map((n) => ({ id: n.id, body: n.body, created_at: n.created_at, author: name(n.profiles) })),
  };
}
