import "server-only";

import type { AdminClient } from "@/lib/supabase/admin";
import type { Tables } from "@/lib/supabase/types";
import type { InboundIdentity } from "@/lib/whatsapp/parse";

export type ContactRow = Tables<"contacts">;

export type MatchResult = { contact: ContactRow; created: boolean; updated: boolean };

/**
 * CLAUDE.md rule 5: contacts are matched by BSUID and/or E.164 phone. Order:
 *   1. wa_bsuid match (most specific; survives phone changes)
 *   2. phone_e164 match (backfills the BSUID when the webhook carries one)
 *   3. alternate phones (contact_phones)
 *   4. create (source = whatsapp)
 * The profile name is kept as wa_profile_name; it never overwrites first/last name
 * that staff entered.
 */
export async function matchOrCreateContact(
  admin: AdminClient,
  orgId: string,
  identity: InboundIdentity,
  now = new Date(),
): Promise<MatchResult> {
  const { phoneE164, bsuid, profileName } = identity;
  if (!phoneE164 && !bsuid) throw new Error("inbound identity has neither phone nor BSUID");

  let contact: ContactRow | null = null;

  if (bsuid) {
    const { data } = await admin
      .from("contacts")
      .select("*")
      .eq("org_id", orgId)
      .eq("wa_bsuid", bsuid)
      .is("deleted_at", null)
      .maybeSingle();
    contact = data ?? null;
  }
  if (!contact && phoneE164) {
    const { data } = await admin
      .from("contacts")
      .select("*")
      .eq("org_id", orgId)
      .eq("phone_e164", phoneE164)
      .is("deleted_at", null)
      .maybeSingle();
    contact = data ?? null;
  }
  if (!contact && phoneE164) {
    const { data: alt } = await admin
      .from("contact_phones")
      .select("contact_id")
      .eq("org_id", orgId)
      .eq("phone_e164", phoneE164)
      .limit(1)
      .maybeSingle();
    if (alt) {
      const { data } = await admin
        .from("contacts")
        .select("*")
        .eq("id", alt.contact_id)
        .is("deleted_at", null)
        .maybeSingle();
      contact = data ?? null;
    }
  }

  if (!contact) {
    const names = splitName(profileName);
    const { data, error } = await admin
      .from("contacts")
      .insert({
        org_id: orgId,
        first_name: names.first,
        last_name: names.last,
        phone_e164: phoneE164,
        wa_bsuid: bsuid,
        wa_profile_name: profileName,
        source: "whatsapp",
        last_interaction_at: now.toISOString(),
      })
      .select("*")
      .single();
    if (error) {
      // A concurrent webhook may have created it: re-read once.
      if (error.code === "23505") {
        const retry = await matchOrCreateContact(
          admin,
          orgId,
          { ...identity, profileName: null },
          now,
        );
        return { ...retry, created: false };
      }
      throw new Error(`contact insert failed: ${error.message}`);
    }
    return { contact: data, created: true, updated: false };
  }

  const patch: Partial<ContactRow> = { last_interaction_at: now.toISOString() };
  if (bsuid && !contact.wa_bsuid) patch.wa_bsuid = bsuid;
  if (phoneE164 && !contact.phone_e164) patch.phone_e164 = phoneE164;
  if (profileName && profileName !== contact.wa_profile_name) patch.wa_profile_name = profileName;
  if (!contact.first_name && !contact.last_name && profileName) {
    const names = splitName(profileName);
    patch.first_name = names.first;
    patch.last_name = names.last;
  }
  const { data, error } = await admin
    .from("contacts")
    .update(patch)
    .eq("id", contact.id)
    .select("*")
    .single();
  if (error) {
    // Unique collision on backfill (two contacts for the same person): keep the matched row.
    if (error.code === "23505") {
      await admin
        .from("contacts")
        .update({ last_interaction_at: patch.last_interaction_at })
        .eq("id", contact.id);
      return { contact, created: false, updated: false };
    }
    throw new Error(`contact update failed: ${error.message}`);
  }
  return { contact: data, created: false, updated: Object.keys(patch).length > 1 };
}

export function splitName(full: string | null | undefined): { first: string; last: string } {
  const trimmed = (full ?? "").trim().replace(/\s+/g, " ");
  if (!trimmed) return { first: "", last: "" };
  const idx = trimmed.indexOf(" ");
  if (idx === -1) return { first: trimmed, last: "" };
  return { first: trimmed.slice(0, idx), last: trimmed.slice(idx + 1) };
}

export function contactDisplayName(
  c: Pick<ContactRow, "first_name" | "last_name" | "wa_profile_name" | "phone_e164">,
): string {
  const name = `${c.first_name ?? ""} ${c.last_name ?? ""}`.trim();
  return name || c.wa_profile_name || c.phone_e164 || "Unknown";
}

/** Rotates a BSUID after a user_id_update webhook. */
export async function rotateBsuid(
  admin: AdminClient,
  orgId: string,
  oldBsuid: string | null,
  newBsuid: string | null,
  phoneE164: string | null,
): Promise<number> {
  if (!newBsuid) return 0;
  let q = admin
    .from("contacts")
    .update({ wa_bsuid: newBsuid })
    .eq("org_id", orgId)
    .is("deleted_at", null);
  if (oldBsuid) q = q.eq("wa_bsuid", oldBsuid);
  else if (phoneE164) q = q.eq("phone_e164", phoneE164);
  else return 0;
  const { data, error } = await q.select("id");
  if (error) {
    if (error.code === "23505") return 0; // the new BSUID already belongs to another row
    throw new Error(`rotateBsuid: ${error.message}`);
  }
  return data?.length ?? 0;
}
