import { z } from "zod";

import { serializeContact, updateContact, updateContactSchema } from "@/lib/public-api/contacts";
import { apiError, json, readJson, validationError } from "@/lib/public-api/http";
import { recordAudit } from "@/lib/audit";
import { apiRoute } from "@/lib/public-api/route";
import { hasScope } from "@/lib/public-api/scopes";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const id = z.string().uuid();

/** GET /api/public/v1/contacts/:id */
export const GET = apiRoute("contacts:read", async ({ admin, ctx, params }) => {
  if (!id.safeParse(params.id).success) return apiError(404, "not_found", "Contact not found.");
  const { data } = await admin
    .from("contacts")
    .select("*")
    .eq("id", params.id)
    .eq("org_id", ctx.orgId)
    .is("deleted_at", null)
    .is("merged_into_id", null)
    .maybeSingle();
  if (!data) return apiError(404, "not_found", "Contact not found.");
  return json(serializeContact(data));
});

/** PATCH /api/public/v1/contacts/:id: partial update. */
export const PATCH = apiRoute("contacts:write", async ({ request, admin, ctx, params }) => {
  if (!id.safeParse(params.id).success) return apiError(404, "not_found", "Contact not found.");
  const body = await readJson(request);
  if (body === undefined) return apiError(400, "invalid_json", "The request body must be valid JSON.");
  const parsed = updateContactSchema.safeParse(body);
  if (!parsed.success) return validationError(parsed.error.issues);

  const result = await updateContact(admin, ctx.orgId, params.id, parsed.data);
  if (!result.ok) return apiError(result.status, result.code, result.message);
  await recordAudit(admin, { orgId: ctx.orgId, userId: null, action: "api.contact_updated", entity: "contact", entityId: result.contact.id, diff: { api_key_id: ctx.keyId, fields: Object.keys(parsed.data) } });
  return json(hasScope(ctx.scopes, "contacts:read") ? serializeContact(result.contact) : { id: result.contact.id });
});
