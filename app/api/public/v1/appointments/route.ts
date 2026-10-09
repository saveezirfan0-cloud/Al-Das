import { z } from "zod";

import { serializeAppointment } from "@/lib/public-api/appointments";
import { decodeCursor, encodeCursor } from "@/lib/public-api/cursor";
import { apiError, json, validationError } from "@/lib/public-api/http";
import { apiRoute } from "@/lib/public-api/route";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const STATUSES = ["awaiting", "confirmed", "cancelled", "completed", "no_show"] as const;

const listQuery = z.object({
  limit: z.coerce.number().int().min(1).max(200).default(50),
  cursor: z.string().max(500).optional(),
  status: z.enum(STATUSES).optional(),
  contact_id: z.string().uuid().optional(),
  location_id: z.string().uuid().optional(),
  specialist_id: z.string().uuid().optional(),
  starts_after: z.string().datetime({ offset: true }).optional(),
  starts_before: z.string().datetime({ offset: true }).optional(),
});

/** GET /api/public/v1/appointments: newest first (by creation), cursor-paginated, read-only. */
export const GET = apiRoute("appointments:read", async ({ request, admin, ctx }) => {
  const parsed = listQuery.safeParse(Object.fromEntries(new URL(request.url).searchParams));
  if (!parsed.success) return validationError(parsed.error.issues);
  const q = parsed.data;
  const cursor = decodeCursor(q.cursor);
  if (q.cursor && !cursor) return apiError(400, "invalid_cursor", "That cursor is not valid.");

  let query = admin
    .from("appointments")
    .select("*")
    .eq("org_id", ctx.orgId)
    .order("created_at", { ascending: false })
    .order("id", { ascending: false })
    .limit(q.limit + 1);
  if (q.status) query = query.eq("status", q.status);
  if (q.contact_id) query = query.eq("contact_id", q.contact_id);
  if (q.location_id) query = query.eq("location_id", q.location_id);
  if (q.specialist_id) query = query.eq("specialist_id", q.specialist_id);
  if (q.starts_after) query = query.gte("starts_at", q.starts_after);
  if (q.starts_before) query = query.lt("starts_at", q.starts_before);
  if (cursor) query = query.or(`created_at.lt.${cursor.t},and(created_at.eq.${cursor.t},id.lt.${cursor.id})`);

  const { data, error } = await query;
  if (error) {
    console.error("[public-api] appointments list failed", { code: error.code });
    return apiError(500, "internal_error", "Something went wrong on our side.");
  }
  const rows = data ?? [];
  const page = rows.slice(0, q.limit);
  const last = page[page.length - 1];
  return json({
    data: page.map(serializeAppointment),
    next_cursor: rows.length > q.limit && last ? encodeCursor({ t: last.created_at, id: last.id }) : null,
  });
});
