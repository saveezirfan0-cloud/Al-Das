import "server-only";

import { NextResponse } from "next/server";

/**
 * JSON envelope for every public API response.
 *   success: the resource (or { data, next_cursor } for lists)
 *   failure: { error: { code, message, details? } }  with a stable machine-readable code
 */

export function json(data: unknown, status = 200, headers: Record<string, string> = {}): NextResponse {
  return NextResponse.json(data, { status, headers: { "Cache-Control": "no-store", ...headers } });
}

export function apiError(
  status: number,
  code: string,
  message: string,
  extra: { details?: unknown; headers?: Record<string, string> } = {},
): NextResponse {
  return json({ error: { code, message, ...(extra.details !== undefined ? { details: extra.details } : {}) } }, status, extra.headers);
}

export function validationError(issues: Array<{ path: PropertyKey[]; message: string }>): NextResponse {
  return apiError(422, "validation_failed", issues[0]?.message ?? "Invalid request.", {
    details: issues.slice(0, 10).map((i) => ({ field: i.path.map(String).join("."), message: i.message })),
  });
}

/** Parses a JSON body; returns undefined on malformed JSON so the caller can answer 400. */
export async function readJson(request: Request): Promise<unknown | undefined> {
  const text = await request.text();
  if (text.length > 256 * 1024) return undefined;
  try {
    return text ? JSON.parse(text) : {};
  } catch {
    return undefined;
  }
}
