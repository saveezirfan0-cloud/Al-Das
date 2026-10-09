/**
 * What the read-only sync client needs from Unite authentication.
 *
 * The token itself is issued and cached by the shared token manager in `lib/unite/auth.ts` (the same
 * one the Finance capture uses, so both modules share one set of credentials and one token cache).
 * This file only holds the small pieces specific to the sync client.
 */
export { UniteAuthError } from "@/lib/unite/auth";

export type UniteEnvelope = {
  Data?: unknown;
  Status?: string;
  Message?: string;
};

export function isTokenProblem(message: string | undefined): boolean {
  return /token (has )?expired|invalid token|unauthori[sz]ed/i.test(message ?? "");
}

/** A source of access tokens. `force` re-issues one after the vendor rejected the current token. */
export interface TokenSource {
  getToken(opts?: { force?: boolean; stale?: string }): Promise<string>;
}
export type UniteAuth = TokenSource;
