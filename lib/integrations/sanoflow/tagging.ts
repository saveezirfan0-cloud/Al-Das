import "server-only";

import { loadAccount } from "@/lib/integrations/accounts";
import type { AdminClient } from "@/lib/supabase/admin";

import type { SanoflowClient } from "./client";
import { readSanoflowConfig, sanoflowPhone, type SanoflowConfig } from "./config";
import { planContactEdits, type RecallTagProgramme, type SanoflowContact } from "./contacts";
import { buildSanoflowClientFor } from "./server";

export type TagJob = { orgId: string; contactId: string; programme: RecallTagProgramme };

/** A short outcome word for the job log: never a name, number or id from Sanoflow. */
export type TagOutcome =
  | "switched_off"
  | "no_key"
  | "tagging_off"
  | "no_contact"
  | "no_sanoflow_contact"
  | "not_found"
  | "tagged"
  | "partly_tagged"
  | "failed";

/**
 * Writes Make's Sanoflow tags after a Live recall send (docs/49 D11, owner decision 22 Oct 2026), queued by the Sanoflow sender
 * (deliver.ts) on the sanoflow_tags queue:
 *
 *   birthday    the patient's Sanoflow contact id(s) from external_refs (none: skipped, as Make skips patients without a
 *               Sanoflow Contact Id) -> contacts/list by id -> contacts/edit with the tags plus 3590 and Pulse's first and
 *               last name (Make writes Airtable's names).
 *   chronic_90d contacts/list by the patient's phone -> contacts/edit with the tags plus 4654, label 1800, names unchanged.
 *
 * Best effort: a failed call is counted, never retried and never touches the message. The switch, the key and the
 * tag_contacts setting are read again here.
 */
export async function processSanoflowTagJob(
  admin: AdminClient,
  job: TagJob,
  deps: { fetchFn?: typeof fetch; client?: SanoflowClient; config?: SanoflowConfig } = {},
): Promise<TagOutcome> {
  let client = deps.client ?? null;
  let config = deps.config ?? readSanoflowConfig({});
  if (!client) {
    const account = await loadAccount(admin, job.orgId, "sanoflow");
    if (!account?.enabled) return "switched_off";
    const built = buildSanoflowClientFor(admin, account, deps.fetchFn);
    if (!built) return "no_key";
    client = built.client;
    config = built.config;
  }
  if (!config.tagContacts) return "tagging_off";

  const { data: contact } = await admin
    .from("contacts")
    .select("id, first_name, last_name, phone_e164")
    .eq("id", job.contactId)
    .eq("org_id", job.orgId)
    .is("deleted_at", null)
    .maybeSingle();
  if (!contact) return "no_contact";

  const found: SanoflowContact[] = [];
  if (job.programme === "birthday") {
    const { data: refs } = await admin
      .from("external_refs")
      .select("external_id")
      .eq("org_id", job.orgId)
      .eq("source", "sanoflow")
      .eq("entity", "contact")
      .eq("local_table", "contacts")
      .eq("local_id", contact.id)
      .limit(5);
    const ids = (refs ?? [])
      .map((r) => Number(r.external_id))
      .filter((n) => Number.isSafeInteger(n) && n > 0);
    if (ids.length === 0) return "no_sanoflow_contact";
    for (const id of ids) {
      const r = await client.contactsList({ contactId: id });
      if (!r.ok) return "failed";
      found.push(...r.value.filter((f) => f.contactId === id));
    }
  } else {
    const phone = sanoflowPhone(contact.phone_e164, config.phoneFormat);
    if (!phone) return "no_contact";
    const r = await client.contactsList({ phone });
    if (!r.ok) return "failed";
    found.push(...r.value.slice(0, 5));
  }
  if (found.length === 0) return "not_found";

  const edits = planContactEdits(job.programme, found, contact, config);
  let ok = 0;
  for (const edit of edits) {
    const r = await client.contactsEdit(edit);
    if (r.ok) ok++;
  }
  return ok === edits.length ? "tagged" : ok > 0 ? "partly_tagged" : "failed";
}
