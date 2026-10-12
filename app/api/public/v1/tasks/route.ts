import { z } from "zod";

import { decodeCursor, encodeCursor } from "@/lib/public-api/cursor";
import { apiError, json, validationError } from "@/lib/public-api/http";
import { apiRoute } from "@/lib/public-api/route";
import { serializeTask } from "@/lib/public-api/tasks";
import { TASK_TYPES } from "@/lib/tasks/constants";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const listQuery = z.object({
  limit: z.coerce.number().int().min(1).max(200).default(50),
  cursor: z.string().max(500).optional(),
  done: z.enum(["true", "false"]).optional(),
  type: z.enum(TASK_TYPES).optional(),
  assignee_id: z.string().uuid().optional(),
  enquiry_id: z.string().uuid().optional(),
  contact_id: z.string().uuid().optional(),
  due_after: z.string().datetime({ offset: true }).optional(),
  due_before: z.string().datetime({ offset: true }).optional(),
});

/** GET /api/public/v1/tasks: newest first (by creation), cursor-paginated, read-only. */
export const GET = apiRoute("tasks:read", async ({ request, admin, ctx }) => {
  const parsed = listQuery.safeParse(Object.fromEntries(new URL(request.url).searchParams));
  if (!parsed.success) return validationError(parsed.error.issues);
  const q = parsed.data;
  const cursor = decodeCursor(q.cursor);
  if (q.cursor && !cursor) return apiError(400, "invalid_cursor", "That cursor is not valid.");

  let query = admin
    .from("tasks")
    .select("*")
    .eq("org_id", ctx.orgId)
    .order("created_at", { ascending: false })
    .order("id", { ascending: false })
    .limit(q.limit + 1);
  if (q.done) query = query.eq("done", q.done === "true");
  if (q.type) query = query.eq("type", q.type);
  if (q.assignee_id) query = query.eq("assignee_id", q.assignee_id);
  if (q.enquiry_id) query = query.eq("enquiry_id", q.enquiry_id);
  if (q.contact_id) query = query.eq("contact_id", q.contact_id);
  if (q.due_after) query = query.gte("due_at", q.due_after);
  if (q.due_before) query = query.lt("due_at", q.due_before);
  if (cursor)
    query = query.or(`created_at.lt.${cursor.t},and(created_at.eq.${cursor.t},id.lt.${cursor.id})`);

  const { data, error } = await query;
  if (error) {
    console.error("[public-api] tasks list failed", { code: error.code });
    return apiError(500, "internal_error", "Something went wrong on our side.");
  }
  const rows = data ?? [];
  const page = rows.slice(0, q.limit);
  const last = page[page.length - 1];
  return json({
    data: page.map(serializeTask),
    next_cursor:
      rows.length > q.limit && last ? encodeCursor({ t: last.created_at, id: last.id }) : null,
  });
});
