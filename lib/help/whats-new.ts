/** What's new panel (pure). Newest first. `id` is stable; the browser remembers the newest id a person has seen. */
export type WhatsNewEntry = { id: string; date: string; title: string; body: string };

export const WHATS_NEW: readonly WhatsNewEntry[] = [
  {
    id: "2026-10-14-front-desk",
    date: "2026-10-14",
    title: "Front desk workspace",
    body: "A Today board for reception: arrivals by time, confirmed and unconfirmed patients, check-in steps (Arrived, With doctor, Done, Checked out), no-shows and walk-ins, plus the next free slots for each doctor. Receptionists now land here after signing in.",
  },
  {
    id: "2026-10-14-waitlist",
    date: "2026-10-14",
    title: "Waiting list with slot offers",
    body: "Add a patient to the waiting list for a doctor or service. When an appointment is cancelled, the freed slot can be offered to the list in order over WhatsApp; the first YES within the time limit gets it. Off until an administrator turns it on in Settings, Front desk.",
  },
  {
    id: "2026-10-14-households",
    date: "2026-10-14",
    title: "Families that share a phone",
    body: "Link a child to a parent. Reminders for the child go to the parent's WhatsApp and name the child, and matching no longer treats a child as a duplicate of their parent.",
  },
  {
    id: "2026-10-14-help",
    date: "2026-10-14",
    title: "Help and training",
    body: "A ? button on every page opens the guide and training clip for that page. Press ? for keyboard shortcuts, and use the Feedback button to tell us what to fix.",
  },
  {
    id: "2026-10-13-mobile",
    date: "2026-10-13",
    title: "Pulse on your phone",
    body: "Install Pulse on your phone, get push notifications for your conversations, and use the inbox full screen with swipe actions.",
  },
];

export function newestId(entries: readonly WhatsNewEntry[] = WHATS_NEW): string | null {
  return entries[0]?.id ?? null;
}

/** How many entries are newer than the one the person last saw (all of them when they have seen none). */
export function unseenCount(
  lastSeenId: string | null | undefined,
  entries: readonly WhatsNewEntry[] = WHATS_NEW,
): number {
  if (!lastSeenId) return entries.length;
  const idx = entries.findIndex((e) => e.id === lastSeenId);
  return idx === -1 ? entries.length : idx;
}
