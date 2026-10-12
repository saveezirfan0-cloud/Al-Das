/**
 * Phone matching that knows families share numbers (pure).
 *
 * A phone number alone used to identify a patient. In a household the mother's number is also the number of her
 * children, so an incoming Unite patient "Omar, born 2019" arriving on the mother's number must not be treated as
 * the mother. This module compares the incoming person with each contact that holds the number (the guardian and
 * the guardian's dependants) and decides: a match, a shared phone for a human to resolve, or an ordinary phone match.
 *
 * Evidence is only ever used to REFUSE a match, never to invent one: with nothing to compare (a bare phone number,
 * a WhatsApp contact with no name) the behaviour is unchanged.
 */

export type IncomingPerson = {
  externalId?: string | null;
  fullName?: string | null;
  dob?: string | null;
};

export type PhoneCandidate = {
  id: string;
  fullName: string | null;
  dob: string | null;
  externalId: string | null;
  /** True for a dependant found through a household link (the number is the guardian's). */
  dependant: boolean;
};

export type Likeness = "same" | "different" | "unknown";

const clean = (v: string | null | undefined) => (v ?? "").trim();

/** Lower-cased, diacritic-free name tokens; Arabic and Latin both work. */
export function nameTokens(name: string | null | undefined): string[] {
  return clean(name)
    .normalize("NFKD")
    .replace(/[̀-ًͯ-ٰٟ]/g, "")
    .toLowerCase()
    .split(/[^\p{L}\p{N}]+/u)
    .filter(Boolean);
}

export function comparePerson(incoming: IncomingPerson, cand: PhoneCandidate): Likeness {
  const inPin = clean(incoming.externalId);
  const cPin = clean(cand.externalId);
  if (inPin && cPin) return inPin === cPin ? "same" : "different";

  const inDob = clean(incoming.dob);
  const cDob = clean(cand.dob);
  const inTokens = nameTokens(incoming.fullName);
  const cTokens = nameTokens(cand.fullName);

  if (inDob && cDob && inDob !== cDob) return "different";

  if (inTokens.length && cTokens.length) {
    const sameName = inTokens.join(" ") === cTokens.join(" ");
    if (sameName) return inDob && cDob ? "same" : "unknown";
    // Same date of birth but a different name is a twin or a spelling variant: a person should look.
    if (inDob && cDob) return "unknown";
    // A different first name is a different person (the same surname is just family), but only against a
    // contact the clinic has actually identified (a PIN or a birth date). A bare WhatsApp contact's name is
    // often a nickname ("Lulu"), which proves nothing.
    if (inTokens[0] !== cTokens[0] && (cDob || cPin)) return "different";
  }
  return "unknown";
}

export type PhoneDecision =
  | { kind: "match"; id: string; dependant: boolean }
  | { kind: "ambiguous"; ids: string[]; reason: "shared_phone" | "multiple" };

/**
 * Decide among the contacts that hold a phone number.
 *  - exactly one "same" wins, even when others hold the number;
 *  - otherwise the candidates that are not "different" are the possible people: one = match, several = ambiguous;
 *  - if every candidate is "different", the number is shared with someone else: ambiguous, never a match.
 */
export function decidePhoneMatch(
  incoming: IncomingPerson,
  candidates: readonly PhoneCandidate[],
): PhoneDecision | null {
  if (candidates.length === 0) return null;
  const scored = candidates.map((c) => ({ c, likeness: comparePerson(incoming, c) }));
  const same = scored.filter((s) => s.likeness === "same");
  if (same.length === 1) return { kind: "match", id: same[0].c.id, dependant: same[0].c.dependant };
  if (same.length > 1)
    return { kind: "ambiguous", ids: same.map((s) => s.c.id), reason: "multiple" };

  const possible = scored.filter((s) => s.likeness === "unknown");
  if (possible.length === 1) {
    return { kind: "match", id: possible[0].c.id, dependant: possible[0].c.dependant };
  }
  if (possible.length > 1)
    return { kind: "ambiguous", ids: possible.map((s) => s.c.id), reason: "multiple" };
  return { kind: "ambiguous", ids: scored.map((s) => s.c.id), reason: "shared_phone" };
}
