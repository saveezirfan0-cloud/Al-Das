import "server-only";

import { can } from "@/lib/auth/can";
import type { CurrentMember } from "@/lib/auth/session";
import { readBranchAccess } from "@/lib/branches/access";
import { accessFilterIds, withBranchFilter } from "@/lib/branches/filter";
import { enquiryViewer, visibleEnquiryIds } from "@/lib/enquiries/visibility";
import { recordAccess } from "@/lib/security/access-log";
import type { AdminClient } from "@/lib/supabase/admin";

import {
  mergeResults,
  phoneHint,
  RECORD_SEARCH_LIMIT,
  recordHref,
  type RecordQuery,
  type RecordResult,
} from "./record-search";

/**
 * Ctrl+K record search, the server half (Phase D). Each kind runs only for a member holding its view key, with the
 * same rules as its list page:
 *  - patients: contacts.view; deleted, merged and erased records never show (contacts cross branches by design);
 *  - enquiries: enquiries.view, then the restricted enquiry view and the branch rule (lib/enquiries/visibility.ts);
 *  - tasks: tasks.view and the branch rule (rows with no branch stay visible).
 * Every service-role read filters `deleted_at is null` (soft delete). At most RECORD_SEARCH_LIMIT per kind. The list
 * is logged as a sampled "search" access with counts only; the query text is never logged.
 */
export async function searchRecords(
  admin: AdminClient,
  member: CurrentMember,
  q: RecordQuery,
): Promise<RecordResult[]> {
  const [contacts, enquiries, tasks] = await Promise.all([
    can(member, "contacts.view") ? searchContacts(admin, member.orgId, q) : [],
    can(member, "enquiries.view") ? searchEnquiries(admin, member, q) : [],
    can(member, "tasks.view") ? searchTasks(admin, member, q) : [],
  ]);
  if (contacts.length > 0)
    await recordAccess(admin, member, {
      entity: "contact",
      action: "search",
      detail: { count: contacts.length, via: "quick_search" },
    });
  if (enquiries.length > 0)
    await recordAccess(admin, member, {
      entity: "enquiry",
      action: "search",
      detail: { count: enquiries.length, via: "quick_search" },
    });
  return [...contacts, ...enquiries, ...tasks];
}

async function searchContacts(
  admin: AdminClient,
  orgId: string,
  q: RecordQuery,
): Promise<RecordResult[]> {
  const base = () =>
    admin
      .from("contacts")
      .select("id, full_name, phone_e164")
      .eq("org_id", orgId)
      .is("deleted_at", null)
      .is("merged_into_id", null)
      .is("erased_at", null)
      .limit(RECORD_SEARCH_LIMIT);
  const none = Promise.resolve({ data: [] as ContactRow[], error: null });
  const [exact, byPhone, byName] = await Promise.all([
    q.e164 ? base().eq("phone_e164", q.e164) : none,
    q.digits ? base().ilike("phone_e164", `%${q.digits}%`) : none,
    base().ilike("full_name", q.like).order("full_name"),
  ]);
  for (const r of [exact, byPhone, byName])
    if (r.error) console.error("[record-search] contacts failed", { code: r.error.code });
  return mergeResults([exact.data ?? [], byPhone.data ?? [], byName.data ?? []]).map((c) => ({
    kind: "contact" as const,
    id: c.id,
    label: c.full_name?.trim() || "Unnamed patient",
    hint: phoneHint(c.phone_e164),
    href: recordHref("contact", c.id),
  }));
}

type ContactRow = { id: string; full_name: string | null; phone_e164: string | null };

async function searchEnquiries(
  admin: AdminClient,
  member: CurrentMember,
  q: RecordQuery,
): Promise<RecordResult[]> {
  // read a few more than shown: the visibility rules may hide some of them
  const want = RECORD_SEARCH_LIMIT * 4;
  const base = () =>
    admin
      .from("enquiries")
      .select("id, number, title")
      .eq("org_id", member.orgId)
      .is("deleted_at", null)
      .limit(want);
  const none = Promise.resolve({ data: [] as EnquiryRow[], error: null });
  const [byNumber, byTitle] = await Promise.all([
    q.enquiryNumber !== null ? base().eq("number", q.enquiryNumber) : none,
    base().ilike("title", q.like).order("created_at", { ascending: false }),
  ]);
  for (const r of [byNumber, byTitle])
    if (r.error) console.error("[record-search] enquiries failed", { code: r.error.code });
  const rows = mergeResults([byNumber.data ?? [], byTitle.data ?? []], want);
  if (rows.length === 0) return [];
  const viewer = await enquiryViewer(admin, member);
  const visible = new Set(
    await visibleEnquiryIds(
      admin,
      member.orgId,
      viewer,
      rows.map((r) => r.id),
    ),
  );
  return rows
    .filter((r) => visible.has(r.id))
    .slice(0, RECORD_SEARCH_LIMIT)
    .map((e) => ({
      kind: "enquiry" as const,
      id: e.id,
      label: e.title?.trim() || `Enquiry #${e.number}`,
      hint: `#${e.number}`,
      href: recordHref("enquiry", e.id),
    }));
}

type EnquiryRow = { id: string; number: number; title: string | null };

async function searchTasks(
  admin: AdminClient,
  member: CurrentMember,
  q: RecordQuery,
): Promise<RecordResult[]> {
  // the branch rule (Phase B): every branch the member works in, plus tasks with no branch
  const query = withBranchFilter(
    admin
      .from("tasks")
      .select("id, subject, done")
      .eq("org_id", member.orgId)
      .is("deleted_at", null)
      .ilike("subject", q.like),
    accessFilterIds(readBranchAccess(member)),
  );
  const { data, error } = await query
    .order("done", { ascending: true })
    .order("due_at", { ascending: true })
    .limit(RECORD_SEARCH_LIMIT);
  if (error) {
    console.error("[record-search] tasks failed", { code: error.code });
    return [];
  }
  return (data ?? []).map((t) => ({
    kind: "task" as const,
    id: t.id,
    label: t.subject,
    hint: t.done ? "Done" : "Open",
    href: recordHref("task", t.id),
  }));
}
