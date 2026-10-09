import { beginIdempotent, completeIdempotent, hashRequest, releaseIdempotent } from "@/lib/public-api/idempotency";
import { apiError, json, readJson, validationError } from "@/lib/public-api/http";
import { apiRoute } from "@/lib/public-api/route";
import { sendTemplateSchema, sendTemplateViaApi } from "@/lib/public-api/send-template";
import type { Json } from "@/lib/supabase/types";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * POST /api/public/v1/send-template  (requires the Idempotency-Key header)
 * Queues an approved WhatsApp template to a phone number. 202 = queued, not yet delivered.
 */
export const POST = apiRoute("messages:send_template", async ({ request, admin, ctx }) => {
  const key = request.headers.get("idempotency-key")?.trim();
  if (!key) return apiError(400, "idempotency_key_required", "Send an Idempotency-Key header (any unique string, up to 200 characters) so a retry never sends the message twice.");
  if (key.length > 200) return apiError(400, "invalid_idempotency_key", "Idempotency-Key must be at most 200 characters.");

  const body = await readJson(request);
  if (body === undefined) return apiError(400, "invalid_json", "The request body must be valid JSON.");
  const parsed = sendTemplateSchema.safeParse(body);
  if (!parsed.success) return validationError(parsed.error.issues);

  const begin = await beginIdempotent(admin, { orgId: ctx.orgId, keyId: ctx.keyId, idempotencyKey: key, requestHash: hashRequest(parsed.data) });
  if (begin.state === "replay") return json(begin.body, begin.status, { "Idempotent-Replayed": "true" });
  if (begin.state === "mismatch") return apiError(422, "idempotency_key_reused", "That Idempotency-Key was already used with a different request body.");
  if (begin.state === "in_progress") return apiError(409, "request_in_progress", "A request with this Idempotency-Key is still being processed. Retry shortly.", { headers: { "Retry-After": "2" } });

  try {
    const result = await sendTemplateViaApi(admin, ctx.orgId, parsed.data);
    if (!result.ok) {
      await releaseIdempotent(admin, begin.id); // a failed attempt can be retried with the same key once fixed
      return apiError(result.status, result.code, result.message, { details: result.details });
    }
    await completeIdempotent(admin, begin.id, 202, result.data as unknown as Json);
    return json(result.data, 202);
  } catch (err) {
    await releaseIdempotent(admin, begin.id);
    throw err;
  }
});
