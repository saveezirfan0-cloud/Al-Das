/**
 * Waitlist rules (pure): who is offered a freed slot, in what order, how the offer goes out, and how a
 * patient's reply is read. The database function accept_slot_offer() decides who actually gets the slot;
 * nothing here can double-book, it only picks candidates.
 */
import { formatInTimeZone } from "date-fns-tz";

import { serviceWindow } from "@/lib/whatsapp/window";

export type WaitlistEntry = {
  id: string;
  contact_id: string;
  specialist_id: string | null;
  service_id: string | null;
  location_id: string | null;
  /** YYYY-MM-DD, inclusive, clinic time. */
  not_after: string | null;
  created_at: string;
  status: string;
};

export type FreedSlot = {
  specialist_id: string;
  location_id: string;
  /** The service the freed appointment was for; the offer books this (or the entry's own service). */
  service_id: string | null;
  starts_at: string;
  ends_at: string;
};

/** Services a specialist can perform, with their durations, for entries that ask for a different service. */
export type ServiceFit = {
  service_id: string;
  duration_min: number;
  offered_by_specialist: boolean;
};

function slotMinutes(slot: FreedSlot): number {
  return Math.round(
    (new Date(slot.ends_at).getTime() - new Date(slot.starts_at).getTime()) / 60_000,
  );
}

/** Local YYYY-MM-DD of an instant. */
function localDay(iso: string, timezone: string): string {
  return formatInTimeZone(new Date(iso), timezone, "yyyy-MM-dd");
}

/**
 * Which service would be booked for this entry in this slot, or null when the entry does not fit.
 *  - the entry's own service must fit the slot length and be offered by the specialist;
 *  - an entry with no service gets the service of the freed appointment.
 */
export function serviceForEntry(
  entry: Pick<WaitlistEntry, "service_id">,
  slot: Pick<FreedSlot, "service_id" | "starts_at" | "ends_at">,
  fits: readonly ServiceFit[],
): string | null {
  const length = slotMinutes(slot as FreedSlot);
  if (entry.service_id) {
    const fit = fits.find((f) => f.service_id === entry.service_id);
    if (!fit || !fit.offered_by_specialist || fit.duration_min > length) return null;
    return entry.service_id;
  }
  return slot.service_id;
}

export function entryMatchesSlot(
  entry: WaitlistEntry,
  slot: FreedSlot,
  fits: readonly ServiceFit[],
  timezone: string,
): boolean {
  if (entry.status !== "waiting") return false;
  if (entry.specialist_id && entry.specialist_id !== slot.specialist_id) return false;
  if (entry.location_id && entry.location_id !== slot.location_id) return false;
  if (entry.not_after && localDay(slot.starts_at, timezone) > entry.not_after) return false;
  return serviceForEntry(entry, slot, fits) !== null;
}

/**
 * Entries to ask, in order: oldest first; an entry that named this very doctor outranks one that said "any
 * doctor" only when they were added at the same moment (created_at is the queue, as the front desk expects).
 * `alreadyOffered` entries (any outcome) are skipped so a patient is never asked twice for one slot.
 */
export function rankEntries(
  entries: readonly WaitlistEntry[],
  slot: FreedSlot,
  fits: readonly ServiceFit[],
  timezone: string,
  alreadyOffered: ReadonlySet<string> = new Set(),
): WaitlistEntry[] {
  const seenContacts = new Set<string>();
  return entries
    .filter((e) => !alreadyOffered.has(e.id) && entryMatchesSlot(e, slot, fits, timezone))
    .sort((a, b) => {
      const t = new Date(a.created_at).getTime() - new Date(b.created_at).getTime();
      if (t !== 0) return t;
      return Number(!!b.specialist_id) - Number(!!a.specialist_id);
    })
    .filter((e) => {
      // One question per person: a patient waiting for two things is asked once per slot.
      if (seenContacts.has(e.contact_id)) return false;
      seenContacts.add(e.contact_id);
      return true;
    });
}

/** May this slot be offered at all? Not in the past, not sooner than the lead time. */
export function slotOfferable(
  slot: Pick<FreedSlot, "starts_at">,
  now: Date,
  minLeadMin: number,
): boolean {
  return new Date(slot.starts_at).getTime() - now.getTime() >= minLeadMin * 60_000;
}

/** Offer expiry: the TTL, but never later than the slot start. */
export function offerExpiry(now: Date, ttlMin: number, slotStart: Date): Date {
  return new Date(Math.min(now.getTime() + ttlMin * 60_000, slotStart.getTime()));
}

export type OfferChannel =
  { kind: "text" } | { kind: "template" } | { kind: "blocked"; reason: "no_template" };

/**
 * Free-form text is only allowed inside the 24-hour customer-service window; otherwise the approved offer
 * template is the only legal way to start the conversation. No template and a closed window = blocked.
 */
export function chooseOfferChannel(
  lastInboundAt: string | null,
  hasTemplate: boolean,
  now: Date = new Date(),
): OfferChannel {
  if (serviceWindow({ lastInboundAt, now }).open) return { kind: "text" };
  return hasTemplate ? { kind: "template" } : { kind: "blocked", reason: "no_template" };
}

export type ReplyIntent = "yes" | "no" | "unknown";

const YES = new Set([
  "yes",
  "y",
  "yep",
  "yeah",
  "ok",
  "okay",
  "sure",
  "confirm",
  "book",
  "book it",
  "yes please",
  "نعم",
  "ايوه",
  "أيوه",
  "اي",
  "ايه",
  "تمام",
  "موافق",
  "احجز",
]);
const NO = new Set([
  "no",
  "n",
  "nope",
  "no thanks",
  "no thank you",
  "not now",
  "cancel",
  "لا",
  "لا شكرا",
  "لا شكراً",
  "مو",
]);

function normalise(text: string): string {
  return text
    .normalize("NFKC")
    .toLowerCase()
    .replace(/[ً-ٰٟ]/g, "") // Arabic diacritics
    .replace(/[!.,؟?،"'“”]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

/** Reads a free-text reply or a template button title. Anything long or ambiguous is "unknown". */
export function classifyOfferReply(text: string | null | undefined): ReplyIntent {
  if (!text) return "unknown";
  const t = normalise(text);
  if (!t || t.length > 40) return "unknown";
  if (YES.has(t)) return "yes";
  if (NO.has(t)) return "no";
  return "unknown";
}

/** Button ids/titles on the offer template (the template builder names them "Yes, book it" / "No thanks"). */
export function classifyOfferButton(reply: {
  id?: string | null;
  title?: string | null;
}): ReplyIntent {
  for (const raw of [reply.id, reply.title]) {
    const r = classifyOfferReply(raw);
    if (r !== "unknown") return r;
    const t = normalise(raw ?? "");
    if (/^(yes|book|نعم|احجز)\b/.test(t)) return "yes";
    if (/^(no|not|decline|لا)\b/.test(t)) return "no";
  }
  return "unknown";
}

/** The free-text offer, used inside the 24-hour window. Names the doctor and time, never the patient. */
export function renderOfferText(input: {
  startsAt: Date;
  timezone: string;
  specialist: string | null;
  location: string | null;
  expiresInMin: number;
  language?: string | null;
}): string {
  const when = formatInTimeZone(input.startsAt, input.timezone, "EEEE d MMMM 'at' h:mm a");
  const who = input.specialist?.trim() || "your doctor";
  const where = input.location?.trim();
  if ((input.language ?? "").toLowerCase().startsWith("ar")) {
    const whenAr = formatInTimeZone(input.startsAt, input.timezone, "yyyy-MM-dd HH:mm");
    return `تتوفر الآن مواعيد مع ${who}${where ? ` في ${where}` : ""} بتاريخ ${whenAr}. أرسل "نعم" خلال ${input.expiresInMin} دقيقة لحجز الموعد، أو "لا" إذا لم يناسبك.`;
  }
  return `A place has opened up with ${who}${where ? ` at ${where}` : ""} on ${when}. Reply YES within ${input.expiresInMin} minutes to book it, or NO if it does not suit you.`;
}

/** Plain confirmations sent back after an answer (only ever inside the window the patient just opened). */
export function renderOfferOutcomeText(
  outcome: "booked" | "taken" | "expired",
  language?: string | null,
): string {
  const ar = (language ?? "").toLowerCase().startsWith("ar");
  switch (outcome) {
    case "booked":
      return ar
        ? "تم حجز موعدك. سنرسل لك التفاصيل قريباً."
        : "Done, your appointment is booked. We will send you the details shortly.";
    case "taken":
      return ar
        ? "عذراً، تم حجز هذا الموعد للتو. سنبقيك في قائمة الانتظار ونتواصل معك عند توفر موعد آخر."
        : "Sorry, that place has just been taken. We will keep you on the waiting list and message you when another one opens.";
    case "expired":
      return ar
        ? "انتهت مهلة هذا العرض. سنبقيك في قائمة الانتظار."
        : "That offer has expired. We will keep you on the waiting list.";
  }
}
