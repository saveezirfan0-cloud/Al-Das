import { z } from "zod";

import { decodeCursor, encodeCursor } from "@/lib/public-api/cursor";
import { serializeEnquiry } from "@/lib/public-api/enquiries";
import { apiError, json, validationError } from "@/lib/public-api/http";
import { apiRoute } from "@/lib/public-api/route";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const listQuery = z.object({
  limit: z.coerce.number().int().min(1).max(200).default(50),
  cursor: z.string().max(500).optional(),
  status: z.enum(["open", "won", "lost", "disqualified"]).optional(),
  pipeline_id: z.string().uuid().optional(),
  stage_id: z.string().uuid().optional(),
  assignee_id: z.string().uuid().optional(),
  contact_id: z.string().uuid().optional(),
  created_since: z.string().datetime({ offset: true }).optional(),
});

/** GET /api/public/v1/enquiries: newest first, cursor-paginated, read-only. */
export const GET = apiRoute("enquiries:read", async ({ request, admin, ctx }) => {
  const parsed = listQuery.safeParse(Object.fromEntries(new URL(request.url).searchParams));
  if (!parsed.success) return validationError(parsed.error.issues);
  const q = parsed.data;
  const cursor = decodeCursor(q.cursor);
  if (q.cursor && !cursor) return apiError(400, "invalid_cursor", "That cursor is not valid.");

  let query = admin
    .from("enquiries")
    .select("*")
    .eq("org_id", ctx.orgId)
    .is("deleted_at", null)
    .order("created_at", { ascending: false })
    .order("id", { ascending: false })
    .limit(q.limit + 1);
  if (q.status) query = query.eq("status", q.status);
  if (q.pipeline_id) query = query.eq("pipeline_id", q.pipeline_id);
  if (q.stage_id) query = query.eq("stage_id", q.stage_id);
  if (q.assignee_id) query = query.eq("assignee_id", q.assignee_id);
  if (q.contact_id) query = query.eq("contact_id", q.contact_id);
  if (q.created_since) query = query.gte("created_at", q.created_since);
  if (cursor) query = query.or(`created_at.lt.${cursor.t},and(created_at.eq.${cursor.t},id.lt.${cursor.id})`);

  const { data, error } = await query;
  if (error) {
    console.error("[public-api] enquiries list failed", { code: error.code });
    return apiError(500, "internal_error", "Something went wrong on our side.");
  }
  const rows = data ?? [];
  const page = rows.slice(0, q.limit);
  const last = page[page.length - 1];
  return json({
    data: page.map(serializeEnquiry),
    next_cursor: rows.length > q.limit && last ? encodeCursor({ t: last.created_at, id: last.id }) : null,
  });
});
