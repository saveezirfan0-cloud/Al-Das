import "server-only";

import { can, type MemberLike } from "@/lib/auth/can";
import { enquiryViewer, visibleEnquiryIds } from "@/lib/enquiries/visibility";
import {
  daysLeft,
  ENTITY_RULES,
  readRestoreWindowDays,
  SOFT_DELETE_ENTITIES,
  type SoftDeleteEntity,
} from "@/lib/soft-delete/rules";
import type { AdminClient } from "@/lib/supabase/admin";

/**
 * Soft delete with a restore window (docs/35_SOFT_DELETE_NOTES.md). Server code only, always after can(): the database
 * functions are service-role only and take the org explicitly. The caller writes the audit row.
 */

/** Moves records to the bin. Returns the ids actually moved (already deleted, erased or other-org ids are skipped). */
export async function softDelete(
  admin: AdminClient,
  args: { orgId: string; userId: string | null; entity: SoftDeleteEntity; ids: string[] },
): Promise<string[]> {
  if (args.ids.length === 0) return [];
  const { data, error } = await admin.rpc("soft_delete_records", {
    p_org: args.orgId,
    p_entity: args.entity,
    p_ids: args.ids,
    p_actor: args.userId ?? undefined,
  });
  if (error) throw new Error(`soft_delete_records failed (${error.code ?? "unknown"})`);
  return (data ?? []) as string[];
}

export async function loadRestoreWindowDays(admin: AdminClient, orgId: string): Promise<number> {
  const { data } = await admin.from("orgs").select("settings").eq("id", orgId).maybeSingle();
  return readRestoreWindowDays(data?.settings);
}

/** The kinds of deleted record this member may see and restore (the record's own manage permission). */
export function restorableEntities(member: MemberLike): SoftDeleteEntity[] {
  return SOFT_DELETE_ENTITIES.filter((e) => can(member, ENTITY_RULES[e].restorePerm));
}

export type DeletedItemView = {
  entity: SoftDeleteEntity;
  recordId: string;
  title: string;
  deletedBy: string | null;
  deletedAt: string;
  daysLeft: number;
};

const LIST_LIMIT = 300;

/**
 * The bin as this member may see it: only kinds they can restore, enquiries only inside their enquiry view, newest first.
 * Titles come from the record itself; nothing here is logged.
 */
export async function listDeletedItems(
  admin: AdminClient,
  member: MemberLike & { enquiryScope?: string | null },
  windowDays: number,
  now: Date = new Date(),
): Promise<DeletedItemView[]> {
  const kinds = restorableEntities(member);
  if (kinds.length === 0) return [];
  const { data: items, error } = await admin
    .from("deleted_items")
    .select("entity, record_id, deleted_by, deleted_at")
    .eq("org_id", member.orgId)
    .in("entity", kinds)
    .order("deleted_at", { ascending: false })
    .limit(LIST_LIMIT);
  if (error) throw new Error(`deleted_items read failed (${error.code ?? "unknown"})`);
  const rows = (items ?? []).filter((r) =>
    (SOFT_DELETE_ENTITIES as readonly string[]).includes(r.entity),
  );
  const idsOf = (e: SoftDeleteEntity) => rows.filter((r) => r.entity === e).map((r) => r.record_id);

  const titles = new Map<string, string>();
  const key = (e: string, id: string) => `${e}:${id}`;

  const contactIds = idsOf("contact");
  if (contactIds.length) {
    const { data } = await admin
      .from("contacts")
      .select("id, full_name")
      .eq("org_id", member.orgId)
      .in("id", contactIds);
    for (const c of data ?? []) titles.set(key("contact", c.id), c.full_name || "Unnamed contact");
  }

  let enquiryIds = idsOf("enquiry");
  if (enquiryIds.length) {
    enquiryIds = await visibleEnquiryIds(
      admin,
      member.orgId,
      await enquiryViewer(admin, member),
      enquiryIds,
    );
    if (enquiryIds.length) {
      const { data } = await admin
        .from("enquiries")
        .select("id, number, title")
        .eq("org_id", member.orgId)
        .in("id", enquiryIds);
      for (const e of data ?? [])
        titles.set(key("enquiry", e.id), `#${e.number} ${e.title || "Untitled enquiry"}`.trim());
    }
  }

  const taskIds = idsOf("task");
  if (taskIds.length) {
    const { data } = await admin
      .from("tasks")
      .select("id, subject")
      .eq("org_id", member.orgId)
      .in("id", taskIds);
    for (const t of data ?? []) titles.set(key("task", t.id), t.subject || "Untitled task");
  }

  const entryIds = idsOf("website_entry_point");
  if (entryIds.length) {
    const { data } = await admin
      .from("website_entry_points")
      .select("id, section, source_key")
      .eq("org_id", member.orgId)
      .in("id", entryIds);
    for (const w of data ?? [])
      titles.set(key("website_entry_point", w.id), `${w.section}: ${w.source_key}`);
  }

  const people = new Map<string, string>();
  const by = [...new Set(rows.map((r) => r.deleted_by).filter((x): x is string => !!x))];
  if (by.length) {
    const { data } = await admin.from("profiles").select("id, first_name, last_name").in("id", by);
    for (const p of data ?? [])
      people.set(p.id, `${p.first_name ?? ""} ${p.last_name ?? ""}`.trim() || "A team member");
  }

  const out: DeletedItemView[] = [];
  for (const r of rows) {
    // No title means the record is gone or (enquiries) outside this member's view: not listed.
    const title = titles.get(key(r.entity, r.record_id));
    if (title === undefined) continue;
    out.push({
      entity: r.entity as SoftDeleteEntity,
      recordId: r.record_id,
      title,
      deletedBy: r.deleted_by ? (people.get(r.deleted_by) ?? "A former member") : null,
      deletedAt: r.deleted_at,
      daysLeft: daysLeft(r.deleted_at, windowDays, now),
    });
  }
  return out;
}
