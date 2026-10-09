/** Pure name helpers shared by server code and client components. */
export type NameFields = {
  first_name: string | null;
  last_name: string | null;
  wa_profile_name?: string | null;
  phone_e164?: string | null;
};

export function splitName(full: string | null | undefined): { first: string; last: string } {
  const trimmed = (full ?? "").trim().replace(/\s+/g, " ");
  if (!trimmed) return { first: "", last: "" };
  const idx = trimmed.indexOf(" ");
  if (idx === -1) return { first: trimmed, last: "" };
  return { first: trimmed.slice(0, idx), last: trimmed.slice(idx + 1) };
}

export function contactDisplayName(c: NameFields): string {
  const name = `${c.first_name ?? ""} ${c.last_name ?? ""}`.trim();
  return name || c.wa_profile_name || c.phone_e164 || "Unknown";
}
