import { LIFECYCLE_STAGES, type LifecycleStage } from "@/lib/contacts/lifecycle";

/** The slice of a Supabase client this helper needs (admin or a member's own client). */
type Reader = {
  from: (table: string) => any; // eslint-disable-line @typescript-eslint/no-explicit-any
};

const CHUNK = 200;

function chunks<T>(xs: T[]): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < xs.length; i += CHUNK) out.push(xs.slice(i, i + CHUNK));
  return out;
}

/**
 * Lifecycle stage per contact, from the derived view v_contact_lifecycle (never stored). Contacts the caller cannot
 * read (RLS on a member's client) are left out of the map. Ids only; nothing about the person is returned.
 * Pass an admin client only after the caller's own permission check.
 */
export async function loadLifecycleStages(
  client: Reader,
  orgId: string,
  contactIds: string[],
): Promise<Map<string, LifecycleStage>> {
  const out = new Map<string, LifecycleStage>();
  for (const ids of chunks([...new Set(contactIds)])) {
    const { data, error } = await client
      .from("v_contact_lifecycle")
      .select("contact_id, stage")
      .eq("org_id", orgId)
      .in("contact_id", ids);
    if (error) throw new Error("lifecycle stages could not be read");
    for (const r of (data ?? []) as Array<{ contact_id: string; stage: string }>) {
      const stage = (LIFECYCLE_STAGES as readonly string[]).includes(r.stage)
        ? (r.stage as LifecycleStage)
        : "unknown";
      out.set(r.contact_id, stage);
    }
  }
  return out;
}

/** Chronic flag: a contact is chronic when it has a row in contact_chronic_conditions. */
export async function loadChronicFlags(
  client: Reader,
  orgId: string,
  contactIds: string[],
): Promise<Set<string>> {
  const out = new Set<string>();
  for (const ids of chunks([...new Set(contactIds)])) {
    const { data, error } = await client
      .from("contact_chronic_conditions")
      .select("contact_id")
      .eq("org_id", orgId)
      .in("contact_id", ids);
    if (error) throw new Error("chronic flags could not be read");
    for (const r of (data ?? []) as Array<{ contact_id: string }>) out.add(r.contact_id);
  }
  return out;
}
