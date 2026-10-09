import "server-only";

import type { AdminClient } from "@/lib/supabase/admin";

export type ContactOption = { id: string; full_name: string; phone_e164: string | null };

/**
 * Quick contact picker search by name or phone. Two parameterised ilike queries
 * (never a PostgREST .or() string built from user input). Callers check permissions first.
 */
export async function searchContactOptions(
  admin: AdminClient,
  orgId: string,
  q: string,
  limit = 10,
): Promise<ContactOption[] | null> {
  const term = q.trim().slice(0, 100);
  if (term.length < 2) return [];
  const like = `%${term.replace(/[\\%_]/g, (m) => `\\${m}`)}%`;
  const base = () =>
    admin
      .from("contacts")
      .select("id, full_name, phone_e164")
      .eq("org_id", orgId)
      .is("deleted_at", null)
      .limit(limit);
  const digits = term.replace(/\D/g, "");
  const [byName, byPhone] = await Promise.all([
    base().ilike("full_name", like).order("full_name"),
    digits.length >= 3
      ? base().ilike("phone_e164", `%${digits}%`)
      : Promise.resolve({ data: [], error: null }),
  ]);
  if (byName.error || byPhone.error) return null;
  const seen = new Map<string, ContactOption>();
  for (const r of [...(byName.data ?? []), ...(byPhone.data ?? [])])
    seen.set(r.id, { id: r.id, full_name: r.full_name ?? "", phone_e164: r.phone_e164 });
  return [...seen.values()].slice(0, limit);
}
