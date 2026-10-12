/** Wording and colour for auth_events rows, shared by Settings → Account and the Activity log. Pure. */

export type AuthEventTone = "secondary" | "destructive" | "warning" | "default";

const LABELS: Record<string, { label: string; tone: AuthEventTone }> = {
  sign_in: { label: "Signed in", tone: "secondary" },
  sign_in_failed: { label: "Failed sign-in", tone: "destructive" },
  sign_out: { label: "Signed out", tone: "secondary" },
  sign_out_everywhere: { label: "Signed out everywhere", tone: "warning" },
  password_changed: { label: "Password changed", tone: "warning" },
  mfa_enrolled: { label: "Two-step verification turned on", tone: "warning" },
  mfa_removed: { label: "Two-step verification removed", tone: "warning" },
  mfa_verified: { label: "Two-step code accepted", tone: "secondary" },
  session_revoked: { label: "Other devices signed out", tone: "warning" },
};

export const AUTH_EVENT_TYPES = Object.keys(LABELS);

export function describeAuthEvent(
  type: string,
  method?: string | null,
): { label: string; tone: AuthEventTone } {
  const base = LABELS[type] ?? { label: type.replace(/_/g, " "), tone: "secondary" as const };
  if (type === "sign_in" && method === "magic_link")
    return { ...base, label: "Signed in with an e-mail link" };
  return base;
}
