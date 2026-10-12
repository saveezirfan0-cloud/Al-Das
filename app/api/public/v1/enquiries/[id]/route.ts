import { z } from "zod";

import { auditApiRead } from "@/lib/public-api/audit-read";
import { serializeEnquiry } from "@/lib/public-api/enquiries";
import { apiError, json } from "@/lib/public-api/http";
import { apiRoute } from "@/lib/public-api/route";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const id = z.string().uuid();

/** GET /api/public/v1/enquiries/:id */
export const GET = apiRoute("enquiries:read", async ({ admin, ctx, params }) => {
  if (!id.safeParse(params.id).success) return apiError(404, "not_found", "Enquiry not found.");
  const { data } = await admin.from("enquiries").select("*").eq("id", params.id).eq("org_id", ctx.orgId).is("deleted_at", null).maybeSingle();
  if (!data) return apiError(404, "not_found", "Enquiry not found.");
  await auditApiRead(admin, ctx, "enquiries", 1);
  return json(serializeEnquiry(data));
});
