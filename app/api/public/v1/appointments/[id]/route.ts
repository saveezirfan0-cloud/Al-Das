import { z } from "zod";

import { serializeAppointment } from "@/lib/public-api/appointments";
import { apiError, json } from "@/lib/public-api/http";
import { apiRoute } from "@/lib/public-api/route";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const id = z.string().uuid();

/** GET /api/public/v1/appointments/:id */
export const GET = apiRoute("appointments:read", async ({ admin, ctx, params }) => {
  if (!id.safeParse(params.id).success) return apiError(404, "not_found", "Appointment not found.");
  const { data } = await admin.from("appointments").select("*").eq("id", params.id).eq("org_id", ctx.orgId).maybeSingle();
  if (!data) return apiError(404, "not_found", "Appointment not found.");
  return json(serializeAppointment(data));
});
