/** API key scopes. Kept free of Node imports so client components (Settings → API keys) can use them. */

export const API_KEY_SCOPES = ["contacts:read", "contacts:write", "appointments:read", "enquiries:read", "messages:send_template"] as const;
export type ApiKeyScope = (typeof API_KEY_SCOPES)[number];

export const SCOPE_LABELS: Record<ApiKeyScope, { label: string; description: string }> = {
  "contacts:read": { label: "Read contacts", description: "List and fetch patient contacts" },
  "contacts:write": { label: "Write contacts", description: "Create and update contacts (never overrides a marketing opt-out)" },
  "appointments:read": { label: "Read appointments", description: "List and fetch appointments (times, status, location, specialist; no clinical notes)" },
  "enquiries:read": { label: "Read enquiries", description: "List and fetch enquiries (stage, status, owner, linked contact; no titles or notes)" },
  "messages:send_template": { label: "Send template messages", description: "Queue approved WhatsApp templates to a phone number" },
};

export function isApiKeyScope(value: string): value is ApiKeyScope {
  return (API_KEY_SCOPES as readonly string[]).includes(value);
}

export function hasScope(scopes: readonly string[], scope: ApiKeyScope): boolean {
  return scopes.includes(scope);
}
