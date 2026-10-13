/** What's new panel (pure). Newest first. `id` is stable; the browser remembers the newest id a person has seen. */
export type WhatsNewEntry = { id: string; date: string; title: string; body: string };

export const WHATS_NEW: readonly WhatsNewEntry[] = [
  {
    id: "2026-10-30-billing-mix",
    date: "2026-10-30",
    title: "Billing mix and trends",
    body: "Finance has a new Billing mix and trends page. For each doctor it shows revenue, patients, revenue per patient, how the bills split between consultation, lab, radiology, procedures and other services, and how much is insurance or self-pay, next to the clinic as a whole. A seasonality view puts each month or week beside the same one last year. Finance, the CEO and the Medical Director can open it and download both tables.",
  },
  {
    id: "2026-10-29-close-timetable",
    date: "2026-10-29",
    title: "Close timetable",
    body: "Finance has a Close timetable for the month-end close by working day: inputs by WD5, revenue shares and Tally by WD7, draft accounts by WD8 and the final pack by WD10. Each step has an owner, a trained backup and its dependencies; owners mark their steps done or blocked and get a reminder when one is due. Close measures show inputs on time, whether each month closed by WD10, open reconciling items and steps without a backup.",
  },
  {
    id: "2026-10-28-bank-reconciliation",
    date: "2026-10-28",
    title: "Bank reconciliation",
    body: "Finance can now import bank statements and processor settlement reports and check every Unite collection against the bank: card and EPG after 2 working days, Tabby after 6, cash deposits and insurers' payments, net of the expected fees. Pulse proposes matches with a score and its reasons, matches automatically only when there is a single clear candidate, ages anything not received, and asks for a reason before the month's reconciliation is reviewed and signed by a second person.",
  },
  {
    id: "2026-10-27-clinical-data-quality",
    date: "2026-10-27",
    title: "Clinical data quality, medicines and reminder reports",
    body: "Three new Portal screens: Data quality (visits with missing vitals or no matched patient, and unknown diagnosis codes), Unclassified medications (choose the class of a Unite medicine code; the old automatic guess is shown as a hint only) and Clinical feedback (patient replies, red flags and who was told). Reports gain Appointment reminders per doctor, Recall performance and Clinical operations, and the Management dashboard shows reminders, this week's recall and the follow-up load. Chronic conditions can now come from visit diagnoses once the clinical lead signs off the rule; clinical messages to patients stay off.",
  },
  {
    id: "2026-10-26-insurance-follow-up",
    date: "2026-10-26",
    title: "Insurance follow-up and receivables by age",
    body: "Finance has a new Insurance follow-up page: every unpaid insurance claim, oldest first, with the 60, 90 or 120-day stage it has reached, its last resubmission and the last follow-up. Open a claim to see its first, second and third submissions with the amounts, and record what you did and when to act next. Once finance sets a start date, Pulse creates one task per claim at each stage. A Receivables by age report shows what each payer owes in age buckets you choose, and downloads as CSV.",
  },
  {
    id: "2026-10-24-payment-vouchers",
    date: "2026-10-24",
    title: "Payment vouchers, supplier invoices and Tally export",
    body: "Finance now keeps suppliers, supplier invoices and payment vouchers in Pulse with their documents attached, so nothing needs printing. A voucher goes from its maker to the Finance Manager, then to a department head or the CEO as the delegation of authority requires; every step is a different person, rejections need remarks, and the CEO can approve on a phone. Each voucher has an approval certificate, the Voucher report shows what is pending, approved and rejected and how long approval takes, and approved items export to TallyPrime as an import file.",
  },
  {
    id: "2026-10-23-daily-flash",
    date: "2026-10-23",
    title: "Daily flash report",
    body: "Finance now has a Daily flash page: net revenue, patient volume and ARPP against target, revenue by branch, the top doctors, and a daily sales grid for the month next to the same days of last month. Chiro and leased units are reported on their own lines. Finance sets the targets and lines; the CEO and Medical Director can read it, and it downloads as Excel in the familiar layout.",
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
