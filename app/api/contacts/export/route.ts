import { NextResponse } from "next/server";
import { z } from "zod";

import { recordAudit } from "@/lib/audit";
import { can } from "@/lib/auth/can";
import { getCurrentMember } from "@/lib/auth/session";
import { contactsToCsv, type ExportableContact } from "@/lib/contacts/export";
import { fetchContactsByIds, matchingContactIds } from "@/lib/contacts/query";
import { loadContactContext } from "@/lib/contacts/server";
import { combineFilters, isContactViewKey, viewFilter } from "@/lib/contacts/views";
import { filterSchema, type Filter } from "@/lib/filters/ast";
import { checkRateLimit, RATE_RULES, tooManyRequests } from "@/lib/rate-limit";
import { createAdminClient } from "@/lib/supabase/admin";

const bodySchema = z.object({
  scope: z.enum(["current", "all"]).default("current"),
  view: z.string().optional(),
  segmentId: z.string().uuid().nullable().optional(),
  filter: filterSchema.nullable().optional(),
  search: z.string().max(200).nullable().optional(),
});

const MAX_EXPORT = 50_000;
const BATCH = 500;

/** POST /api/contacts/export → text/csv. Requires contacts.export. */
export async function POST(req: Request) {
  const member = await getCurrentMember();
  if (!member) return NextResponse.json({ error: "unauthenticated" }, { status: 401 });
  if (!can(member, "contacts.export"))
    return NextResponse.json({ error: "forbidden" }, { status: 403 });

  const parsed = bodySchema.safeParse(await req.json().catch(() => ({})));
  if (!parsed.success) return NextResponse.json({ error: "invalid body" }, { status: 400 });
  const body = parsed.data;

  const admin = createAdminClient();
  const limited = await checkRateLimit(admin, "contacts-export", member.userId, RATE_RULES.contactsExportPerUser);
  if (!limited.allowed) return tooManyRequests(limited);
  const ctx = await loadContactContext(admin, member.orgId);

  let filter: Filter | null = null;
  let search: string | null = null;
  if (body.scope === "current") {
    const parts: Array<Filter | null> = [];
    if (isContactViewKey(body.view) && body.view !== "all")
      parts.push(viewFilter(body.view, member.userId));
    if (body.segmentId) {
      const { data: seg } = await admin
        .from("segments")
        .select("id, kind, filter")
        .eq("org_id", member.orgId)
        .eq("id", body.segmentId)
        .maybeSingle();
      if (seg?.kind === "static")
        parts.push({
          include: {
            type: "group",
            logic: "and",
            children: [{ type: "condition", field: "segments", op: "has_any", value: [seg.id] }],
          },
        });
      else if (seg) {
        const f = filterSchema.safeParse(seg.filter);
        if (f.success) parts.push(f.data);
      }
    }
    parts.push(body.filter ?? null);
    filter = combineFilters(...parts);
    search = body.search ?? null;
  }

  let ids: string[];
  try {
    ids = await matchingContactIds(
      admin,
      member.orgId,
      ctx.registry,
      filter,
      search,
      member.org.timezone,
      MAX_EXPORT,
    );
  } catch {
    return NextResponse.json({ error: "invalid filter" }, { status: 400 });
  }

  const userName = new Map(ctx.users.map((u) => [u.id, u.label]));
  const rows: ExportableContact[] = [];
  for (let i = 0; i < ids.length; i += BATCH) {
    const batch = ids.slice(i, i + BATCH);
    const [contacts, { data: phones }] = await Promise.all([
      fetchContactsByIds(admin, member.orgId, batch),
      admin.from("contact_phones").select("contact_id, phone_e164").in("contact_id", batch),
    ]);
    const altByContact = new Map<string, string[]>();
    for (const p of phones ?? [])
      altByContact.set(p.contact_id, [...(altByContact.get(p.contact_id) ?? []), p.phone_e164]);
    for (const c of contacts)
      rows.push({
        ...c,
        alternate_phones: altByContact.get(c.id) ?? [],
        owner_name: c.owner_id ? (userName.get(c.owner_id) ?? null) : null,
        assignee_name: c.assignee_id ? (userName.get(c.assignee_id) ?? null) : null,
        tags: c.tags.map((t) => t.name),
      });
  }

  await recordAudit(admin, {
    orgId: member.orgId,
    userId: member.userId,
    action: "contact.exported",
    entity: "contact",
    diff: { scope: body.scope, count: rows.length },
  });

  const csv = contactsToCsv(rows, ctx.customFields);
  return new NextResponse(csv, {
    headers: {
      "Content-Type": "text/csv; charset=utf-8",
      "Content-Disposition": `attachment; filename="contacts-${new Date().toISOString().slice(0, 10)}.csv"`,
      "Cache-Control": "no-store",
    },
  });
}
