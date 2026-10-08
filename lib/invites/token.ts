import { createHash, randomBytes } from "node:crypto";

export const INVITE_TTL_DAYS = 7;

/** Raw token for the link (URL-safe) and its sha256 hash for the database. */
export function generateInviteToken(): { token: string; hash: string } {
  const token = randomBytes(32).toString("base64url");
  return { token, hash: hashInviteToken(token) };
}

export function hashInviteToken(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

export function inviteExpiry(from: Date = new Date(), days = INVITE_TTL_DAYS): Date {
  return new Date(from.getTime() + days * 24 * 60 * 60 * 1000);
}

export function inviteUrl(appUrl: string, token: string): string {
  return `${appUrl.replace(/\/$/, "")}/invite/${encodeURIComponent(token)}`;
}

export type InviteState = "valid" | "expired" | "accepted" | "revoked";

export function inviteState(
  invite: { expires_at: string; accepted_at: string | null; revoked_at: string | null },
  now: Date = new Date(),
): InviteState {
  if (invite.revoked_at) return "revoked";
  if (invite.accepted_at) return "accepted";
  if (new Date(invite.expires_at).getTime() <= now.getTime()) return "expired";
  return "valid";
}
