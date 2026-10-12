/** What's new panel (pure). Newest first. `id` is stable; the browser remembers the newest id a person has seen. */
export type WhatsNewEntry = { id: string; date: string; title: string; body: string };

export const WHATS_NEW: readonly WhatsNewEntry[] = [
  {
    id: "2026-10-18-integrations",
    date: "2026-10-18",
    title: "Integrations: calendar feeds, SMS fallback and payment links",
    body: "A new Integrations page in Settings. Doctors can subscribe to a private read-only calendar that shows appointment times and the clinic, never patient details. When a WhatsApp reminder cannot be delivered, Pulse can send a short generic text message instead. Finance can send a patient a payment link on WhatsApp and see what the payment gateway reports. All three are off until an administrator switches them on, and System health shows how each is doing.",
  },
  {
    id: "2026-10-17-ai-copilots",
    date: "2026-10-17",
    title: "AI copilots for flows and campaigns",
    body: "Describe a bot in words and get an unpublished draft flow to check, then try it with a dry run that sends nothing. In Campaigns, describe an audience to see how many patients it matches, and get English and Arabic template wording checked against WhatsApp's rules. Messages that sound urgent now alert the team straight away, and a weekly report shows how AI suggestions were used. Everything AI writes is a draft; it is off until an administrator turns AI on.",
  },
  {
    id: "2026-10-16-finance-upgrades",
    date: "2026-10-16",
    title: "Finance and insurance upgrades",
    body: "Track pre-authorisations, see which visits are not ready to bill, work denials with a drafted appeal letter, match the payer's remittance to invoices, and see payer scorecards and a collections forecast. Close the month with a finance and CEO sign-off, count the cash at the end of each day and export to your accounting package. Each part is switched on by its own permission, and patient reminders stay off until approved.",
  },
  {
    id: "2026-10-15-media-library",
    date: "2026-10-15",
    title: "Media Library",
    body: "One shared library of images, PDFs and videos with folders, tags and search. Use a library file as a template header, in a campaign, with a quick reply or straight from a conversation. Pictures are made smaller on upload to fit WhatsApp's limits, and you can see where each file is used before deleting it. Pictures in a conversation now open in a viewer you can swipe through.",
  },
  {
    id: "2026-10-15-patient-documents",
    date: "2026-10-15",
    title: "Patient documents",
    body: "A Documents tab on each patient for referral letters, lab reports, insurance cards and consent forms, with an expiry date and a reminder before an insurance card runs out. Who opened or downloaded a document is recorded. Off until an administrator switches it on in Settings, Patient documents.",
  },
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
