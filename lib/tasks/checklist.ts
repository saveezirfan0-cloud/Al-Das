/**
 * Daily opening / closing checklists per branch (Phase F). Pure: the editor's lines, the template's times and the
 * progress shown on a task. The database repeats the line rule (app.task_checklist_lines_valid) and generates the
 * day's task (public.task_generate_checklists, idempotent per template and local day).
 */

export const CHECKLIST_KINDS = ["opening", "closing", "other"] as const;
export type ChecklistKind = (typeof CHECKLIST_KINDS)[number];

export const CHECKLIST_KIND_LABELS: Record<ChecklistKind, string> = {
  opening: "Opening",
  closing: "Closing",
  other: "Other",
};

export const MAX_CHECKLIST_LINES = 50;
export const MAX_LINE_LENGTH = 200;

/** One line per item from a text box: trimmed, blanks and bullet marks dropped, duplicates kept once. */
export function parseChecklistLines(text: string): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const raw of text.split(/\r?\n/)) {
    const line = raw
      .replace(/^\s*(?:[-*•]|\d+[.)]|\[\s?[xX]?\s?\])\s*/, "")
      .trim();
    if (!line) continue;
    const key = line.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(line);
  }
  return out;
}

export function checklistLinesProblem(lines: readonly string[]): string | null {
  if (lines.length === 0) return "Add at least one item.";
  if (lines.length > MAX_CHECKLIST_LINES) return `Keep it to ${MAX_CHECKLIST_LINES} items.`;
  if (lines.some((l) => l.length > MAX_LINE_LENGTH))
    return `Keep each item under ${MAX_LINE_LENGTH} characters.`;
  return null;
}

const TIME = /^([01]\d|2[0-3]):([0-5]\d)(?::00)?$/;

/** "HH:MM" (or "HH:MM:00" from the database) → "HH:MM", else null. */
export function normaliseTime(v: string | null | undefined): string | null {
  const m = TIME.exec((v ?? "").trim());
  return m ? `${m[1]}:${m[2]}` : null;
}

/** The task is generated at `generateAt` and due at `dueTime`, both local; due must not be before generation. */
export function templateTimesProblem(generateAt: string, dueTime: string): string | null {
  const g = normaliseTime(generateAt);
  const d = normaliseTime(dueTime);
  if (!g || !d) return "Use a time like 06:30.";
  if (d < g) return "The due time must be after the time the list is made.";
  return null;
}

/** "3 of 5" progress of a task's checklist. */
export function checklistProgress(items: ReadonlyArray<{ done: boolean }>): {
  done: number;
  total: number;
  complete: boolean;
} {
  const done = items.filter((i) => i.done).length;
  return { done, total: items.length, complete: items.length > 0 && done === items.length };
}
