import type { TranscriptMessage } from "@/lib/ai/types";

/**
 * Turns messages into the text a prompt sees. Pure, so it can be tested without a model.
 *
 * Data minimisation (messages are health data): speakers are "Patient" / "Staff" / "Automated",
 * never names; phone numbers and email addresses are masked; media is described, never linked;
 * the transcript is capped by count and characters, newest messages kept.
 */

const EMAIL = /[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi;
// 9+ digits, optionally with + and separators: phone numbers, IDs. Doses and times are far shorter.
const LONG_NUMBER = /\+?\d[\d\s().-]{7,}\d/g;

export function maskContactDetails(text: string): string {
  return text.replace(EMAIL, "[email]").replace(LONG_NUMBER, (m) => (m.replace(/\D/g, "").length >= 9 ? "[number]" : m));
}

const KIND_LABEL: Record<string, string> = {
  image: "[image]",
  video: "[video]",
  audio: "[voice note]",
  document: "[document]",
  sticker: "[sticker]",
  location: "[location shared]",
  contacts: "[contact card]",
  interactive: "[menu reply]",
  button: "[button reply]",
  reaction: "[reaction]",
  template: "[template message]",
  order: "[order]",
  unsupported: "[unsupported message]",
  system: "[system event]",
};

export type TranscriptOptions = {
  maxMessages?: number;
  maxChars?: number;
  maxCharsPerMessage?: number;
  /** Internal staff notes are excluded unless explicitly requested (e.g. staff-facing summaries). */
  includeNotes?: boolean;
};

function speaker(m: TranscriptMessage): string {
  if (m.direction === "in") return "Patient";
  if (m.direction === "note") return "Internal note";
  return m.byStaff === false ? "Automated" : "Staff";
}

function render(m: TranscriptMessage, perMessage: number): string | null {
  const body = m.body?.trim();
  let content: string;
  if (body) {
    const masked = maskContactDetails(body);
    content = masked.length > perMessage ? `${masked.slice(0, perMessage)}…` : masked;
    const label = KIND_LABEL[m.kind];
    if (label && m.kind !== "template") content = `${label} ${content}`;
  } else {
    content = KIND_LABEL[m.kind] ?? "";
  }
  if (!content) return null;
  return `${speaker(m)}: ${content}`;
}

/** Oldest-to-newest transcript of the most recent messages that fit. Returns "" for an empty thread. */
export function buildTranscript(messages: TranscriptMessage[], opts: TranscriptOptions = {}): string {
  const maxMessages = opts.maxMessages ?? 60;
  const maxChars = opts.maxChars ?? 12_000;
  const perMessage = opts.maxCharsPerMessage ?? 1_500;

  const eligible = messages.filter((m) => opts.includeNotes || m.direction !== "note");
  const lines: string[] = [];
  let used = 0;
  for (let i = eligible.length - 1; i >= 0 && lines.length < maxMessages; i--) {
    const line = render(eligible[i], perMessage);
    if (!line) continue;
    if (used + line.length + 1 > maxChars && lines.length > 0) break;
    lines.push(line);
    used += line.length + 1;
  }
  return lines.reverse().join("\n");
}
