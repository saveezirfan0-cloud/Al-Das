import { z } from "zod";

import { createContactSchema, serializeContact, upsertContact } from "@/lib/public-api/contacts";
import { decodeCursor, encodeCursor } from "@/lib/public-api/cursor";
import { apiError, json, readJson, validationError } from "@/lib/public-api/http";
import { apiRoute } from "@/lib/public-api/route";
import { toE164 } from "@/lib/whatsapp/phone";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const listQuery = z.object({
  limit: z.coerce.number().int().min(1).max(200).default(50),
  cursor: z.string().max(500).optional(),
  phone: z.string().max(32).optional(),
  email: z.string().max(254).optional(),
  external_id: z.string().max(100).optional(),
  updated_since: z.string().datetime({ offset: true }).optional(),
});

/** Escapes LIKE wildcards so an email filter is an exact, case-insensitive match. */
const likeEscape = (s: string) => s.replace(/[\\%_]/g, (c) => `\\${c}`);

/** GET /api/public/v1/contacts: newest first, cursor-paginated. */
export const GET = apiRoute("contacts:read", async ({ request, admin, ctx }) => {
  const url = new URL(request.url);
  const parsed = listQuery.safeParse(Object.fromEntries(url.searchParams));
  if (!parsed.success) return validationError(parsed.error.issues);
  const q = parsed.data;

  let phone: string | null = null;
  if (q.phone) {
    phone = toE164(q.phone);
    if (!phone) return apiError(422, "invalid_phone", "That phone number is not valid.");
  }
  const cursor = decodeCursor(q.cursor);
  if (q.cursor && !cursor) return apiError(400, "invalid_cursor", "That cursor is not valid.");

  let query = admin
    .from("contacts")
    .select("*")
    .eq("org_id", ctx.orgId)
    .is("deleted_at", null)
    .is("merged_into_id", null)
    .order("created_at", { ascending: false })
    .order("id", { ascending: false })
    .limit(q.limit + 1);
  if (phone) query = query.eq("phone_e164", phone);
  if (q.email) query = query.ilike("email", likeEscape(q.email));
  if (q.external_id) query = query.eq("external_id", q.external_id);
  if (q.updated_since) query = query.gte("updated_at", q.updated_since);
  if (cursor) query = query.or(`created_at.lt.${cursor.t},and(created_at.eq.${cursor.t},id.lt.${cursor.id})`);

  const { data, error } = await query;
  if (error) {
    console.error("[public-api] contacts list failed", { code: error.code });
    return apiError(500, "internal_error", "Something went wrong on our side.");
  }
  const rows = data ?? [];
  const page = rows.slice(0, q.limit);
  const last = page[page.length - 1];
  return json({
    data: page.map(serializeContact),
    next_cursor: rows.length > q.limit && last ? encodeCursor({ t: last.created_at, id: last.id }) : null,
  });
});

/** POST /api/public/v1/contacts: create, or update the contact that already owns this phone. */
export const POST = apiRoute("contacts:write", async ({ request, admin, ctx }) => {
  const body = await readJson(request);
  if (body === undefined) return apiError(400, "invalid_json", "The request body must be valid JSON.");
  const parsed = createContactSchema.safeParse(body);
  if (!parsed.success) return validationError(parsed.error.issues);

  const result = await upsertContact(admin, ctx.orgId, parsed.data);
  if (!result.ok) return apiError(result.status, result.code, result.message);
  return json(serializeContact(result.contact), result.created ? 201 : 200);
});
