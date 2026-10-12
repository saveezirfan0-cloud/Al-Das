/**
 * Reads claims from a Supabase access token WITHOUT verifying it. Only use on a token the server has
 * just received from Supabase Auth itself (sign-in / code exchange), to learn the session id and the
 * assurance level. Never use it to decide who someone is.
 */

export type TokenClaims = { sessionId: string | null; aal: "aal1" | "aal2" | null };

export function readTokenClaims(accessToken: string | null | undefined): TokenClaims {
  const empty: TokenClaims = { sessionId: null, aal: null };
  if (!accessToken) return empty;
  const parts = accessToken.split(".");
  if (parts.length !== 3) return empty;
  try {
    const json = Buffer.from(parts[1].replace(/-/g, "+").replace(/_/g, "/"), "base64").toString(
      "utf8",
    );
    const claims = JSON.parse(json) as { session_id?: unknown; aal?: unknown };
    return {
      sessionId:
        typeof claims.session_id === "string" && claims.session_id.length <= 100
          ? claims.session_id
          : null,
      aal: claims.aal === "aal1" || claims.aal === "aal2" ? claims.aal : null,
    };
  } catch {
    return empty;
  }
}
