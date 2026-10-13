/** What's new panel (pure). Newest first. `id` is stable; the browser remembers the newest id a person has seen. */
export type WhatsNewEntry = { id: string; date: string; title: string; body: string };

export const WHATS_NEW: readonly WhatsNewEntry[] = [
  {
    id: "2026-10-22-channels-calendar",
    date: "2026-10-22",
    title: "Website chat, Instagram, Messenger and Google Calendar",
    body: "Patients can now write to the clinic from a chat button on your website, on Instagram or on Messenger, and the messages arrive in the Inbox like WhatsApp chats (text replies only; Instagram and Messenger allow replies for 24 hours after the patient's last message). Doctors can connect their Google Calendar: their appointments appear there as private Busy times with no patient details, and time they are busy in Google can no longer be booked. Each is off until an administrator switches it on in Settings, Integrations.",
  },
  {
    id: "2026-10-21-templates-campaigns",
    date: "2026-10-21",
    title: "Template delivery settings, recurring campaigns and closing with an enquiry",
    body: "Each template can now retry a failed message, give up after a time limit, and turn the reminder text-message fallback off; its row menu also shows delivery, read, reply and click rates. Carousel templates can be sent. Campaigns can repeat on a schedule from a segment, and an administrator can set a monthly message budget that pauses campaigns when it is used up. Closing a conversation can create or update the patient's enquiry in the same step.",
  },
  {
    id: "2026-10-21-routing-booking",
    date: "2026-10-21",
    title: "Smarter routing and booking rules",
    body: "Teams can have a fallback team, office hours and an automatic reply, and each person can have a limit on open conversations. People who go idle are shown as away and stop receiving new chats. Managers can limit someone to their own or their team's enquiries. Services can have preparation and clean-up time and take several patients at once, and specialists can have their own slot length and weekly blocks such as lunch. New reports cover time to close, cohorts and the status log.",
  },
  {
    id: "2026-10-21-flows",
    date: "2026-10-21",
    title: "More flow building blocks",
    body: "Flows can now create and update enquiries, add tasks, write portal records and book appointments. New starts: any new message in an open conversation, a WhatsApp form reply, the 24-hour window about to close, and a patient joining a segment with a drip flow. Questions can check the answer (number, phone, e-mail, date or a pattern), ask again and save straight to a patient field. New steps send a payment link, record an ad event, set a label and sort a message by its intent.",
  },
  {
    id: "2026-10-20-sanoflow-move",
    date: "2026-10-20",
    title: "Ready for the move from Sanoflow",
    body: "Enquiries now have tags, set from the enquiry drawer and usable in filters. Marking an enquiry lost or disqualified offers the reasons set under Settings, Enquiries, and you can still write your own. Campaigns sent from Sanoflow can be seen under Campaigns, Campaign history (read-only). Portal, Sync review also lists Sanoflow records that need a person, which you can link or dismiss. Appointments brought over from Sanoflow get no reminders until an administrator turns them on in Settings, Appointments.",
  },
  {
    id: "2026-10-19-e-signature",
    date: "2026-10-19",
    title: "E-signature for consent forms",
    body: "From a patient's Documents tab, send a consent form (a PDF) to an e-signature service. The signer gets an e-mail, signs, and the signed copy is stored on the patient as a new consent document; you are told when it is signed, declined or expired, and can cancel a request that is still waiting. The service receives the form and the signer's name and e-mail address, so it needs an administrator's typed confirmation in Settings, Integrations, and patient documents must be on.",
  },
  {
    id: "2026-10-19-video-visits",
    date: "2026-10-19",
    title: "Video visits",
    body: "Mark a service (or a single booking) as a video visit and each appointment gets its own private video link. Staff press Join on the appointment or the Front desk board, and reminders and confirmations can carry the link through a new template variable. The link stops working after the visit and when the appointment is cancelled, missed or moved; nothing is recorded and no patient detail goes to the video service. Off until an administrator switches it on in Settings, Integrations.",
  },
  {
    id: "2026-10-19-ad-attribution",
    date: "2026-10-19",
    title: "Meta ad attribution",
    body: "A new Ad attribution report shows which Meta ads started WhatsApp conversations and how many became enquiries or bookings. Pulse can also tell Meta when an ad patient made contact, became an enquiry or booked, using only the event name and the ad click id, never a service, doctor or diagnosis. It starts in report-only mode, sends events only for patients who opted in, and is off until an administrator switches it on in Settings, Integrations.",
  },
  {
    id: "2026-10-19-review-requests",
    date: "2026-10-19",
    title: "Google review requests",
    body: "After a completed visit, Pulse can send one WhatsApp message with your clinic's Google review link, a couple of hours later and only during the hours you choose. Only patients who opted in to messages are asked, at most once in the period you set, and nobody is left out because of how their visit went. Staff can mark a patient 'Do not ask' on the patient's card. Off until an administrator switches it on in Settings, Integrations.",
  },
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
