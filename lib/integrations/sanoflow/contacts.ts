/**
 * Sanoflow contact writes that Make does around its sends (docs/49 D9, D11; owner decision 22 Oct 2026). Pure.
 *
 *   D9  appointment reminder refused with "Invalid channel details." -> contacts/list by phone -> for a contact found,
 *       v1 contacts/add (first and last word of the patient's name, phone) -> send the template again once.
 *   D11 after a Live recall send: birthday -> contacts/list by Sanoflow contact id, contacts/edit with the contact's tags
 *       plus 3590 and the patient's first and last name; chronic -> contacts/list by phone, contacts/edit with the tags plus
 *       4654 and label 1800, names left as Sanoflow has them.
 *
 * Shapes come from Make's live blueprints (docs/audit/make-raw); Sanoflow's answers are unconfirmed, so parsing is tolerant
 * and anything unreadable counts as "no contact".
 */
import type { OutboundContext } from "@/lib/inbox/send";

export type SanoflowContact = {
  contactId: number;
  firstName: string;
  lastName: string;
  tagIds: number[];
};

export type { OutboundContext };
export type RecallTagProgramme = "birthday" | "chronic_90d";

type Json = Record<string, unknown>;

function asObject(v: unknown): Json | null {
  return v && typeof v === "object" && !Array.isArray(v) ? (v as Json) : null;
}

function asId(v: unknown): number | null {
  const n = typeof v === "number" ? v : typeof v === "string" && v.trim() ? Number(v) : NaN;
  return Number.isSafeInteger(n) && n > 0 ? n : null;
}

function asText(v: unknown): string {
  return typeof v === "string" ? v.trim().slice(0, 100) : "";
}

/** Reads messages.payload.context; anything unrecognised is null (no extra behaviour). */
export function readOutboundContext(payload: unknown): OutboundContext | null {
  const c = asObject(asObject(payload)?.context);
  if (!c) return null;
  if (c.kind === "appointment_reminder") return { kind: "appointment_reminder" };
  if (c.kind === "recall" && (c.programme === "birthday" || c.programme === "chronic_90d"))
    return { kind: "recall", programme: c.programme, live: c.live === true };
  return null;
}

/**
 * The contacts in a contacts/list answer. Make reads `data.contact_list.data` of its HTTP module, where `data` is the body,
 * so the list is at body.contact_list.data; a body wrapped once more in `data` is accepted too. Rows without a contact id
 * are skipped, as Make's iterator filter does.
 */
export function parseContactList(json: unknown): SanoflowContact[] {
  const body = asObject(json);
  const list =
    asObject(body?.contact_list)?.data ?? asObject(asObject(body?.data)?.contact_list)?.data;
  if (!Array.isArray(list)) return [];
  const out: SanoflowContact[] = [];
  for (const raw of list.slice(0, 50)) {
    const o = asObject(raw);
    const id = asId(o?.contact_id);
    if (!o || id === null) continue;
    const tags = Array.isArray(o.tags) ? o.tags : [];
    out.push({
      contactId: id,
      firstName: asText(o.first_name),
      lastName: asText(o.last_name),
      tagIds: tags
        .map((t) => asId(asObject(t)?.tag_id ?? t))
        .filter((t): t is number => t !== null),
    });
  }
  return out;
}

/** The contact id a contacts/add answer carries (`contact_id` or `id`, top level or under `data`), or null. */
export function readAddedContactId(json: unknown): number | null {
  for (const o of [asObject(json), asObject(asObject(json)?.data)]) {
    if (!o) continue;
    for (const k of ["contact_id", "contactId", "id"]) {
      const id = asId(o[k]);
      if (id !== null) return id;
    }
  }
  return null;
}

/** The contact's tags plus one: Make's `ifempty(existing + ", " + id; id)`, without adding the id twice. */
export function mergeTags(existing: readonly number[], add: number): number[] {
  const out = [...new Set(existing)];
  if (!out.includes(add)) out.push(add);
  return out;
}

/**
 * First and last word of a full name, as Make's contacts/add uses (`first(split(name; " "))`, `last(split(...))`): a one-word
 * name gives the same word twice; a blank name gives blanks.
 */
export function firstLastWord(fullName: string | null | undefined): {
  first: string;
  last: string;
} {
  const words = (fullName ?? "").trim().split(/\s+/).filter(Boolean);
  if (words.length === 0) return { first: "", last: "" };
  return { first: words[0]!.slice(0, 60), last: words[words.length - 1]!.slice(0, 60) };
}

/** The full name Make passed to contacts/add (Unite's full name); Pulse's full name, else first + last. */
export function contactFullName(c: {
  full_name?: string | null;
  first_name?: string | null;
  last_name?: string | null;
}): string {
  const full = (c.full_name ?? "").trim();
  if (full) return full;
  return [c.first_name, c.last_name]
    .map((s) => (s ?? "").trim())
    .filter(Boolean)
    .join(" ");
}

/** D9 applies only to an appointment reminder that Sanoflow refused with "Invalid channel details." (never ambiguous). */
export function shouldRecoverInvalidChannel(
  context: OutboundContext | null,
  failure: { invalidChannel: boolean; ambiguous: boolean },
): boolean {
  return context?.kind === "appointment_reminder" && failure.invalidChannel && !failure.ambiguous;
}

/** D11 applies after a successful Live recall send, with tagging switched on. Test sends never tag. */
export function shouldTagAfterSend(
  context: OutboundContext | null,
  config: { tagContacts: boolean },
): context is { kind: "recall"; programme: RecallTagProgramme; live: true } {
  return context?.kind === "recall" && context.live && config.tagContacts;
}

export type ContactEdit = {
  contactId: number;
  firstName: string;
  lastName: string;
  tags: number[];
  label?: number;
};

/**
 * The contacts/edit calls for one Live recall send. Birthday: tag added and the names written from Pulse, as Make writes
 * Airtable's First and Last Name (a blank Pulse name keeps Sanoflow's, so a name is never wiped). Chronic: tag added, label
 * set, names echoed back unchanged.
 */
export function planContactEdits(
  programme: RecallTagProgramme,
  found: readonly SanoflowContact[],
  pulse: { first_name?: string | null; last_name?: string | null },
  ids: { birthdayTagId: number; chronicTagId: number; chronicLabelId: number },
): ContactEdit[] {
  return found.map((f) =>
    programme === "birthday"
      ? {
          contactId: f.contactId,
          firstName: (pulse.first_name ?? "").trim() || f.firstName,
          lastName: (pulse.last_name ?? "").trim() || f.lastName,
          tags: mergeTags(f.tagIds, ids.birthdayTagId),
        }
      : {
          contactId: f.contactId,
          firstName: f.firstName,
          lastName: f.lastName,
          tags: mergeTags(f.tagIds, ids.chronicTagId),
          label: ids.chronicLabelId,
        },
  );
}

/** True when an answer's `message` says Sanoflow does not know the number's channel (Make's reminder error filter). */
export function answerSaysInvalidChannel(json: unknown): boolean {
  const top = asObject(json);
  const messages = [top?.message, asObject(top?.error)?.message, asObject(top?.data)?.message];
  return messages.some((m) => typeof m === "string" && /invalid channel details/i.test(m));
}
