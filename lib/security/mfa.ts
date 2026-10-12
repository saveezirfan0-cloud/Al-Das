import { permissionMatches } from "@/lib/auth/permissions";

/**
 * Two-step verification policy. Pure, so the middleware decision is unit-tested without Supabase.
 *
 * A role is "sensitive" when it can change settings, touch finance (finance.*), or reach clinical portal
 * data (portal.clinical_*, or a portal wildcard that includes it).
 * The `require_mfa` switch can be set on any role; sensitive roles are the ones the settings page
 * warns about when the switch is off.
 */

const EXACT_SENSITIVE = new Set([
  "settings.manage",
  "security.manage",
  "privacy.manage",
  "clinical.settings.manage",
]);
/** A key that belongs to a clinical portal object, used to test wildcard grants such as portal.*. */
const CLINICAL_PROBE = "portal.clinical_followups.read";

/** True when a granted permission string gives access to something that needs the stronger sign-in. */
export function isSensitivePermission(granted: string): boolean {
  if (granted === "*" || EXACT_SENSITIVE.has(granted)) return true;
  if (granted.startsWith("finance.")) return true;
  if (granted.startsWith("portal.clinical_")) return true;
  // 'portal.*' and 'portal.*.read' reach the clinical portal objects too.
  return permissionMatches(granted, CLINICAL_PROBE);
}

export function isSensitiveRole(permissions: readonly string[]): boolean {
  return permissions.some(isSensitivePermission);
}

export type MfaGateInput = {
  pathname: string;
  /** The role the user holds in the active org has require_mfa = true. */
  required: boolean;
  /** Assurance level of the current session. */
  currentLevel: string | null | undefined;
  /** True when the user has a verified TOTP factor (so aal2 is reachable). */
  hasVerifiedFactor: boolean;
};

export type MfaGateDecision = "allow" | "enroll" | "verify";

/** Paths that must stay reachable while MFA is outstanding: the MFA pages themselves and sign-out. */
const MFA_EXEMPT_PREFIXES = [
  "/mfa",
  "/auth",
  "/login",
  "/_next",
  "/favicon",
  "/manifest.webmanifest",
];

export function isMfaExemptPath(pathname: string): boolean {
  return MFA_EXEMPT_PREFIXES.some((p) => pathname === p || pathname.startsWith(`${p}/`));
}

/**
 * What the middleware should do for a signed-in user.
 *  - Someone who has enrolled a factor is always challenged once per session, whatever their role says:
 *    holding a second factor and not being asked for it would be worse than not having one.
 *  - Someone whose role requires two-step verification and has no factor yet is sent to enrol.
 */
export function mfaGate(input: MfaGateInput): MfaGateDecision {
  if (isMfaExemptPath(input.pathname)) return "allow";
  if (input.currentLevel === "aal2") return "allow";
  if (input.hasVerifiedFactor) return "verify";
  return input.required ? "enroll" : "allow";
}
