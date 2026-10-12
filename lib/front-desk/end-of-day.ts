/**
 * End of day sheet (pure helpers). The sheet answers four questions before the desk goes home: who is still
 * unconfirmed for tomorrow, whose message did we not answer, which calls are still open, and what failed to send.
 */
import { reminderHint, type BoardAppointment } from "@/lib/front-desk/board";

/** An open or waiting conversation whose last message came from the patient is waiting for us. */
export function isUnanswered(c: {
  status: string;
  last_message_direction: string | null;
}): boolean {
  return c.status !== "closed" && c.last_message_direction === "in";
}

/** Tomorrow's bookings that still need a yes: not cancelled, not confirmed. */
export function needsConfirmation(a: Pick<BoardAppointment, "status">): boolean {
  return a.status === "awaiting";
}

export type CallAdvice = "call" | "waiting_reply" | "not_sent_yet";

/** Tomorrow's list in the order a person works through it: the ones to ring first, then by time. */
export function sortUnconfirmed<
  T extends Pick<BoardAppointment, "status" | "reminder" | "starts_at">,
>(rows: readonly T[]): Array<T & { advice: CallAdvice }> {
  const rank: Record<CallAdvice, number> = { call: 0, not_sent_yet: 1, waiting_reply: 2 };
  return rows
    .filter(needsConfirmation)
    .map((r) => {
      const hint = reminderHint(r);
      return { ...r, advice: (hint === "none" ? "waiting_reply" : hint) as CallAdvice };
    })
    .sort(
      (a, b) =>
        rank[a.advice] - rank[b.advice] ||
        new Date(a.starts_at).getTime() - new Date(b.starts_at).getTime(),
    );
}

export const ADVICE_LABEL: Record<CallAdvice, string> = {
  call: "Call them",
  not_sent_yet: "Reminder not sent yet",
  waiting_reply: "Reminder sent, no reply",
};

/** One line per section for the printed header, e.g. "3 to confirm · 2 unanswered · 1 open call · 0 failed". */
export function sheetSummary(counts: {
  unconfirmed: number;
  unanswered: number;
  openCalls: number;
  failed: number;
}): string {
  const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;
  return [
    `${counts.unconfirmed} to confirm`,
    `${counts.unanswered} unanswered`,
    plural(counts.openCalls, "open call"),
    `${counts.failed} failed`,
  ].join(" · ");
}
