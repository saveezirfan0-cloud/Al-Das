/**
 * Other names Unite has used for one finance branch (OQ-162: the clinic rename after 10 Nov 2026). Typed on the
 * Reference data page as one field separated by ";" (clinic names hold spaces and dashes, never ";"). The database
 * trigger `fin_ref_branches_clinic_names_guard` repeats the trimming and refuses a name used by another branch.
 */
export const MAX_CLINIC_ALIASES = 10;
export const MAX_CLINIC_NAME_LENGTH = 200;

export type AliasParse = { ok: true; aliases: string[] } | { ok: false; error: string };

export function parseClinicAliases(text: string, longName: string | null): AliasParse {
  const seen = new Set<string>();
  const aliases: string[] = [];
  for (const raw of text.split(";")) {
    const name = raw.replace(/\s+/g, " ").trim();
    if (!name || name === longName || seen.has(name)) continue;
    if (name.length > MAX_CLINIC_NAME_LENGTH)
      return {
        ok: false,
        error: `A Unite clinic name is at most ${MAX_CLINIC_NAME_LENGTH} characters.`,
      };
    seen.add(name);
    aliases.push(name);
  }
  if (aliases.length > MAX_CLINIC_ALIASES)
    return {
      ok: false,
      error: `A branch has at most ${MAX_CLINIC_ALIASES} other Unite clinic names.`,
    };
  return { ok: true, aliases: aliases.sort() };
}

export const formatClinicAliases = (aliases: readonly string[] | null | undefined) =>
  (aliases ?? []).join("; ");
