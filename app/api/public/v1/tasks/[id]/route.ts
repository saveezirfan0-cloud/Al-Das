import { z } from "zod";

import { apiError, json } from "@/lib/public-api/http";
import { apiRoute } from "@/lib/public-api/route";
import { serializeTask } from "@/lib/public-api/tasks";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const id = z.string().uuid();

/** GET /api/public/v1/tasks/:id */
export const GET = apiRoute("tasks:read", async ({ admin, ctx, params }) => {
  if (!id.safeParse(params.id).success) return apiError(404, "not_found", "Task not found.");
  const { data } = await admin
    .from("tasks")
    .select("*")
    .eq("id", params.id)
    .eq("org_id", ctx.orgId)
    .maybeSingle();
  if (!data) return apiError(404, "not_found", "Task not found.");
  return json(serializeTask(data));
});
