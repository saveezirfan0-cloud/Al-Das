/**
 * @mentions in internal comments. The composer inserts `@[Display Name](user_id)`;
 * we store the plain `@Display Name` text and a mentions row per user.
 */
const MENTION = /@\[([^\]]{1,80})\]\(([0-9a-fA-F-]{36})\)/g;

export type ParsedMentions = { text: string; userIds: string[] };

export function parseMentions(input: string): ParsedMentions {
  const ids = new Set<string>();
  const text = input.replace(MENTION, (_m, name: string, id: string) => {
    ids.add(id.toLowerCase());
    return `@${name}`;
  });
  return { text, userIds: [...ids] };
}

/** Matches `@que` style prefixes while typing, for the picker. Returns the query or null. */
export function mentionQueryAtCaret(
  text: string,
  caret: number,
): { query: string; start: number } | null {
  const before = text.slice(0, caret);
  const at = before.lastIndexOf("@");
  if (at === -1) return null;
  if (at > 0 && !/\s/.test(before[at - 1])) return null;
  const query = before.slice(at + 1);
  if (/[\s\]\(]/.test(query)) return null;
  return { query, start: at };
}
