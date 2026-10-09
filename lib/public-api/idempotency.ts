import "server-only";

import { createHash } from "node:crypto";

import type { Json } from "@/lib/supabase/types";
import type { AdminClient } from "@/lib/supabase/admin";

/**
 * Idempotency-Key support for POSTs that cause side effects (sending a message).
 *   same key + same body   → the first response is replayed, nothing is sent twice
 *   same key + other body  → 422 (a key is bound to one request)
 *   same key while the first is still running → 409
 * Only successful responses are kept; a failed attempt releases the key so it can be retried.
 */

export function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value && typeof value === "object") {
    const o = value as Record<string, unknown>;
    return `{${Object.keys(o).sort().map((k) => `${JSON.stringify(k)}:${canonicalJson(o[k])}`).join(",")}}`;
  }
  return JSON.stringify(value) ?? "null";
}

export function hashRequest(value: unknown): string {
  return createHash("sha256").update(canonicalJson(value)).digest("hex");
}

export type Begin =
  | { state: "proceed"; id: string }
  | { state: "replay"; status: number; body: Json }
  | { state: "mismatch" }
  | { state: "in_progress" };

export async function beginIdempotent(
  admin: AdminClient,
  input: { orgId: string; keyId: string; idempotencyKey: string; requestHash: string },
): Promise<Begin> {
  const { data, error } = await admin
    .from("api_idempotency")
    .insert({ org_id: input.orgId, api_key_id: input.keyId, idempotency_key: input.idempotencyKey, request_hash: input.requestHash })
    .select("id")
    .single();
  if (!error) return { state: "proceed", id: data.id };
  if (error.code !== "23505") throw new Error(`idempotency insert failed (${error.code ?? "unknown"})`);

  const { data: existing } = await admin
    .from("api_idempotency")
    .select("id, request_hash, response_status, response")
    .eq("api_key_id", input.keyId)
    .eq("idempotency_key", input.idempotencyKey)
    .maybeSingle();
  if (!existing) return { state: "in_progress" }; // deleted between the two statements: ask the caller to retry
  if (existing.request_hash !== input.requestHash) return { state: "mismatch" };
  if (existing.response_status === null) return { state: "in_progress" };
  return { state: "replay", status: existing.response_status, body: existing.response as Json };
}

export async function completeIdempotent(admin: AdminClient, id: string, status: number, body: Json): Promise<void> {
  await admin.from("api_idempotency").update({ response_status: status, response: body }).eq("id", id);
}

export async function releaseIdempotent(admin: AdminClient, id: string): Promise<void> {
  await admin.from("api_idempotency").delete().eq("id", id);
}
