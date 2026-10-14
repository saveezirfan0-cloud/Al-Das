"use server";

import { z } from "zod";

import { can, canAny } from "@/lib/auth/can";
import { requirePerm } from "@/lib/auth/session";
import {
  HISTORY_PAGE_SIZE,
  mergeHistory,
  parseHistoryCursor,
  type HistoryItem,
} from "@/lib/contacts/history";
import { STATUS_LABELS } from "@/lib/appointments/status";
import { recordAccess } from "@/lib/security/access-log";
import { createAdminClient } from "@/lib/supabase/admin";
import { createClient } from "@/lib/supabase/server";
import { TASK_PRIORITY_LABELS, TASK_STATUS_LABELS, type TaskPriority, type TaskStatus } from "@/lib/tasks/status";

/**
 * Patient 360 (Phase F): the Tasks, Invoices and History tabs of the contact drawer. Every read goes through the
 * member's own client, so RLS applies exactly as on the source pages (tasks: branch and bin; enquiries: restricted
 * enquiry view; appointments: branch; messages: conversation visibility; invoices: finance.invoices.view and the finance
 * access window). Each tab also checks its permission here, and opening one is recorded (ids only).
 */

export type P360Result<T> = { ok: true; data: T } | { ok: false; error: string };

const uuid = z.string().uuid();

function fail(error: string): { ok: false; error: string } {
  return { ok: false, error };
}

// ---------------------------------------------------------------------------
// Tasks tab
// ---------------------------------------------------------------------------

export type ContactTask = {
  id: string;
  subject: string;
  due_at: string;
  status: TaskStatus;
  status_label: string;
  priority: TaskPriority;
  priority_label: string;
  assignee_id: string | null;
  done: boolean;
};

/** The patient's tasks, open ones first (by due time), then the 20 most recently finished. */
export async function listContactTasks(contactId: string): Promise<P360Result<{ rows: ContactTask[] }>> {
  const member = await requirePerm("contacts.view");
  if (!can(member, "tasks.view")) return fail("You don't have access to tasks.");
  if (!uuid.safeParse(contactId).success) return fail("Invalid contact.");
  const supabase = await createClient();
  const cols = "id, subject, due_at, status, priority, assignee_id, done";
  const [open, done] = await Promise.all([
    supabase
      .from("tasks")
      .select(cols)
      .eq("org_id", member.orgId)
      .eq("contact_id", contactId)
      .eq("done", false)
      .order("due_at")
      .limit(50),
    supabase
      .from("tasks")
      .select(cols)
      .eq("org_id", member.orgId)
      .eq("contact_id", contactId)
      .eq("done", true)
      .order("done_at", { ascending: false })
      .limit(20),
  ]);
  if (open.error || done.error) return fail("Could not load the tasks.");
  const rows = [...(open.data ?? []), ...(done.data ?? [])].map((t) => ({
    ...t,
    status: t.status as TaskStatus,
    priority: t.priority as TaskPriority,
    status_label: TASK_STATUS_LABELS[t.status as TaskStatus] ?? t.status,
    priority_label: TASK_PRIORITY_LABELS[t.priority as TaskPriority] ?? t.priority,
  }));
  return { ok: true, data: { rows } };
}

// ---------------------------------------------------------------------------
// Invoices tab (finance.invoices.view; amounts and dates only, linked by the Unite PIN)
// ---------------------------------------------------------------------------

export type ContactInvoice = {
  id: string;
  number: string | null;
  date: string | null;
  net: number | null;
  paid: number | null;
  claimed: number | null;
  void: boolean;
};

export async function listContactInvoices(
  contactId: string,
): Promise<P360Result<{ rows: ContactInvoice[]; linked: boolean }>> {
  const member = await requirePerm("contacts.view");
  // can() also applies the finance access window (docs/36).
  if (!can(member, "finance.invoices.view")) return fail("You don't have access to invoices.");
  if (!uuid.safeParse(contactId).success) return fail("Invalid contact.");
  const supabase = await createClient();
  const { data: contact } = await supabase
    .from("contacts")
    .select("id, external_id")
    .eq("org_id", member.orgId)
    .eq("id", contactId)
    .maybeSingle();
  if (!contact) return fail("Contact not found.");
  const pin = contact.external_id?.trim();
  if (!pin) return { ok: true, data: { rows: [], linked: false } };
  const { data, error } = await supabase
    .from("v_fin_invoice_list")
    .select("id, inv_display_number, transaction_date, net, paid, claimed, is_deleted")
    .eq("org_id", member.orgId)
    .eq("patient_pin", pin)
    .order("transaction_date", { ascending: false })
    .limit(50);
  if (error) return fail("Could not load the invoices.");
  await recordAccess(createAdminClient(), member, {
    entity: "finance_invoice",
    action: "list",
    detail: { rows: (data ?? []).length, source: "patient_360" },
  });
  return {
    ok: true,
    data: {
      linked: true,
      rows: (data ?? [])
        .filter((r): r is typeof r & { id: string } => !!r.id)
        .map((r) => ({
          id: r.id,
          number: r.inv_display_number,
          date: r.transaction_date,
          net: r.net === null ? null : Number(r.net),
          paid: r.paid === null ? null : Number(r.paid),
          claimed: r.claimed === null ? null : Number(r.claimed),
          void: !!r.is_deleted,
        })),
    },
  };
}

// ---------------------------------------------------------------------------
// History tab: one merged, paged timeline
// ---------------------------------------------------------------------------

const DIRECTION_LABEL: Record<string, string> = {
  in: "Patient wrote",
  out: "Reply sent",
  note: "Internal note on the chat",
};

export async function contactHistory(
  contactId: string,
  cursor: string | null,
): Promise<P360Result<{ items: HistoryItem[]; nextCursor: string | null }>> {
  const member = await requirePerm("contacts.view");
  if (!uuid.safeParse(contactId).success) return fail("Invalid contact.");
  if (cursor && !parseHistoryCursor(cursor)) return fail("Invalid page.");
  const c = parseHistoryCursor(cursor);
  const before = c ? new Date(c.at).toISOString() : null;
  const n = HISTORY_PAGE_SIZE + 1;
  const supabase = await createClient();
  const org = member.orgId;

  const empty = { items: [] as HistoryItem[], full: false };
  const page = <T,>(rows: T[] | null) => ({ rows: rows ?? [], full: (rows ?? []).length >= n });

  const messages = async () => {
    if (!canAny(member, ["inbox.send", "inbox.view_all"])) return empty;
    let q = supabase
      .from("messages")
      .select("id, direction, kind, body, at, conversation_id, conversations!inner(contact_id)")
      .eq("org_id", org)
      .eq("conversations.contact_id", contactId);
    if (before) q = q.lte("at", before);
    const { data } = await q.order("at", { ascending: false }).limit(n);
    const p = page(data);
    return {
      full: p.full,
      items: p.rows.map(
        (m): HistoryItem => ({
          kind: "message",
          id: m.id,
          at: m.at,
          title: DIRECTION_LABEL[m.direction] ?? "Message",
          detail: m.body ? m.body.slice(0, 120) : m.kind,
          href: `/inbox?c=${m.conversation_id}`,
        }),
      ),
    };
  };

  const appointments = async () => {
    if (!can(member, "appointments.view")) return empty;
    let q = supabase
      .from("appointments")
      .select("id, number, starts_at, status")
      .eq("org_id", org)
      .eq("contact_id", contactId);
    if (before) q = q.lte("starts_at", before);
    const { data } = await q.order("starts_at", { ascending: false }).limit(n);
    const p = page(data);
    return {
      full: p.full,
      items: p.rows.map(
        (a): HistoryItem => ({
          kind: "appointment",
          id: a.id,
          at: a.starts_at,
          title: `Appointment #${a.number}`,
          detail: STATUS_LABELS[a.status as keyof typeof STATUS_LABELS] ?? a.status,
          href: `/appointments?appointment=${a.id}`,
        }),
      ),
    };
  };

  const enquiries = async () => {
    if (!can(member, "enquiries.view")) return empty;
    let q = supabase
      .from("enquiries")
      .select("id, number, title, status, created_at")
      .eq("org_id", org)
      .eq("contact_id", contactId);
    if (before) q = q.lte("created_at", before);
    const { data } = await q.order("created_at", { ascending: false }).limit(n);
    const p = page(data);
    return {
      full: p.full,
      items: p.rows.map(
        (e): HistoryItem => ({
          kind: "enquiry",
          id: e.id,
          at: e.created_at,
          title: `Enquiry #${e.number}: ${e.title}`,
          detail: e.status,
          href: `/enquiries?pipeline=all&scope=all&mode=table&enquiry=${e.id}`,
        }),
      ),
    };
  };

  const tasks = async () => {
    if (!can(member, "tasks.view")) return empty;
    let q = supabase
      .from("tasks")
      .select("id, subject, status, created_at")
      .eq("org_id", org)
      .eq("contact_id", contactId);
    if (before) q = q.lte("created_at", before);
    const { data } = await q.order("created_at", { ascending: false }).limit(n);
    const p = page(data);
    return {
      full: p.full,
      items: p.rows.map(
        (t): HistoryItem => ({
          kind: "task",
          id: t.id,
          at: t.created_at,
          title: `Task: ${t.subject}`,
          detail: TASK_STATUS_LABELS[t.status as TaskStatus] ?? t.status,
          href: `/tasks?task=${t.id}`,
        }),
      ),
    };
  };

  const notes = async () => {
    let q = supabase
      .from("timeline_events")
      .select("id, payload, at")
      .eq("org_id", org)
      .eq("contact_id", contactId)
      .eq("type", "note");
    if (before) q = q.lte("at", before);
    const { data } = await q.order("at", { ascending: false }).limit(n);
    const p = page(data);
    return {
      full: p.full,
      items: p.rows.map((e): HistoryItem => {
        const text =
          e.payload && typeof e.payload === "object" && !Array.isArray(e.payload)
            ? (e.payload as Record<string, unknown>).text
            : null;
        return {
          kind: "note",
          id: e.id,
          at: e.at,
          title: "Note",
          detail: typeof text === "string" ? text.slice(0, 200) : null,
        };
      }),
    };
  };

  const sources = await Promise.all([messages(), appointments(), enquiries(), tasks(), notes()]);
  const merged = mergeHistory(sources, HISTORY_PAGE_SIZE, cursor);
  if (!cursor)
    await recordAccess(createAdminClient(), member, {
      entity: "contact",
      entityId: contactId,
      action: "view",
      detail: { tab: "history" },
    });
  return { ok: true, data: merged };
}
