import { createHash } from "node:crypto";

/**
 * Quarterly access review, pure logic. The server gathers the facts (members, roles, last activity, API
 * keys); this module turns them into the review snapshot, classifies dormancy and produces the
 * signature. No I/O.
 */

export type ReviewDecision = "keep" | "revoke" | null;

export type ReviewUser = {
  userId: string;
  membershipId: string;
  name: string;
  email: string;
  roleName: string;
  rolePermissions: readonly string[];
  status: "active" | "suspended";
  /** Latest of: sign-in event, session activity, presence update. Null when we have never seen them. */
  lastActiveAt: string | null;
  joinedAt: string;
  apiKeys: Array<{ id: string; name: string; prefix: string; lastUsedAt: string | null }>;
  mfaRequired: boolean;
};

export type ReviewEntry = ReviewUser & {
  dormant: boolean;
  /** Whole days since the last activity (or since joining when never seen). */
  idleDays: number;
  fullAccess: boolean;
  decision: ReviewDecision;
};

export const DEFAULT_DORMANT_DAYS = 30;

/** "2026-Q4" for a date (UTC calendar quarter). */
export function quarterOf(date: Date): string {
  return `${date.getUTCFullYear()}-Q${Math.floor(date.getUTCMonth() / 3) + 1}`;
}

export function isValidPeriod(period: string): boolean {
  return /^[0-9]{4}-Q[1-4]$/.test(period);
}

/** Days between two instants, rounded down, never negative. */
export function daysBetween(from: Date, to: Date): number {
  return Math.max(0, Math.floor((to.getTime() - from.getTime()) / 86_400_000));
}

export function classifyUser(
  user: ReviewUser,
  now: Date,
  dormantDays = DEFAULT_DORMANT_DAYS,
): ReviewEntry {
  const reference = user.lastActiveAt ?? user.joinedAt;
  const idleDays = daysBetween(new Date(reference), now);
  return {
    ...user,
    idleDays,
    // Someone who joined a few days ago and has not signed in yet is not "dormant"; idleDays counts from joining.
    dormant: user.status === "active" && idleDays >= dormantDays,
    fullAccess: user.rolePermissions.includes("*"),
    decision: null,
  };
}

export function buildSnapshot(
  users: readonly ReviewUser[],
  now: Date,
  dormantDays = DEFAULT_DORMANT_DAYS,
): ReviewEntry[] {
  return users
    .map((u) => classifyUser(u, now, dormantDays))
    .sort((a, b) => Number(b.dormant) - Number(a.dormant) || a.name.localeCompare(b.name));
}

/** Every active user needs an explicit keep/revoke before the review can be signed. */
export function undecided(snapshot: readonly ReviewEntry[]): ReviewEntry[] {
  return snapshot.filter((e) => e.status === "active" && e.decision === null);
}

export type AttestationCheck = { ok: true } | { ok: false; error: string };

/** The signer types their own full name; it must match the profile name (case-insensitive) or e-mail. */
export function checkAttestation(input: {
  typedName: string;
  signerName: string;
  signerEmail: string;
  snapshot: readonly ReviewEntry[];
  confirmed: boolean;
}): AttestationCheck {
  if (!input.confirmed)
    return { ok: false, error: "Tick the box to confirm you reviewed every user." };
  const typed = input.typedName.trim().toLowerCase().replace(/\s+/g, " ");
  const name = input.signerName.trim().toLowerCase().replace(/\s+/g, " ");
  const email = input.signerEmail.trim().toLowerCase();
  if (!typed || (typed !== name && typed !== email)) {
    return {
      ok: false,
      error: "Type your full name exactly as it appears on your profile to sign.",
    };
  }
  const open = undecided(input.snapshot);
  if (open.length > 0) {
    return {
      ok: false,
      error: `${open.length} user${open.length === 1 ? " has" : "s have"} no decision yet.`,
    };
  }
  return { ok: true };
}

/** SHA-256 over the canonical review content, the signer and the time. Anyone can recompute it. */
export function reviewSignature(input: {
  orgId: string;
  period: string;
  snapshot: readonly ReviewEntry[];
  signerId: string;
  attestedAt: string;
}): string {
  const canonical = JSON.stringify({
    org: input.orgId,
    period: input.period,
    signer: input.signerId,
    at: input.attestedAt,
    users: input.snapshot
      .map((e) => ({
        u: e.userId,
        r: e.roleName,
        s: e.status,
        d: e.decision,
        k: e.apiKeys.map((k) => k.id).sort(),
      }))
      .sort((a, b) => a.u.localeCompare(b.u)),
  });
  return createHash("sha256").update(canonical).digest("hex");
}

/** Latest of several optional ISO timestamps. */
export function latestOf(...times: Array<string | null | undefined>): string | null {
  let best: string | null = null;
  for (const t of times) {
    if (!t) continue;
    if (best === null || new Date(t).getTime() > new Date(best).getTime()) best = t;
  }
  return best;
}
