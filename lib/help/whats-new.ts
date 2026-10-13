/** What's new panel (pure). Newest first. `id` is stable; the browser remembers the newest id a person has seen. */
export type WhatsNewEntry = { id: string; date: string; title: string; body: string };

export const WHATS_NEW: readonly WhatsNewEntry[] = [
  {
    id: "2026-11-09-accounting-receivables",
    date: "2026-11-09",
    title: "Accounting: sales invoices, receipts and statements",
    body: "Accounting can now invoice insurers, corporates, tenants and other businesses (patients are still invoiced in Unite). Add the customer, raise a sales invoice with VAT worked out per line, and issue it: it gets its own number and is posted to the ledger. Above the approval limit a second person with the approval permission issues it. Download the tax invoice as PDF, raise a credit note against it or void it. Record what customers pay: Pulse allocates each receipt to the oldest invoice first and you can change it. Receivables ageing shows who owes what and for how long, and each customer's statement downloads as PDF or Excel, with a balance-confirmation letter for the auditors.",
  },
  {
    id: "2026-11-08-chronic-recall-alignment",
    date: "2026-11-08",
    title: "Chronic recall: only chronic diagnoses count",
    body: "Chronic recall now works the way the Airtable recall really did. Only diagnoses flagged Chronic in the Diagnosis list make a patient a chronic patient: the old patient-level list also held every ordinary diagnosis from visits, and those are no longer imported. Days since the last visit count from the later of the last visit in Pulse and the last visit date from Unite, so patients whose visits are not in Pulse yet are included. A patient who has booked no longer appears on the recall call list. The open clinical questions (the 60/90-day prescription filter, once ever or once per visit, consent, and when the call list starts) are listed for the clinical lead and stay as they are until decided. Chronic recall still sends nothing until its settings are signed off.",
  },
  {
    id: "2026-11-08-accounting-ledger",
    date: "2026-11-08",
    title: "Accounting: the general ledger",
    body: "Pulse now has an Accounting module, the first step in replacing Tally. It holds the chart of accounts (Tally's predefined groups plus the clinic's ledgers), journals that one person prepares and another posts, the day book, the general ledger with running balances, a trial balance you can download as Excel, and monthly periods that can be closed and locked. The fiscal year runs July to June. A posted journal never changes; it is corrected by a reversal. New roles: Accountant, Chief Accountant and Auditor (read-only); the Finance Manager can post journals and the CEO can read the reports.",
  },
  {
    id: "2026-11-08-digital-signatures",
    date: "2026-11-08",
    title: "Digital signatures on approval certificates and close packs",
    body: "Once an administrator adds the organisation's certificate under Settings, Integrations, Organisation seal, the payment voucher approval certificate (when the voucher is fully approved) and the month-end close pack PDF (when the month is locked) carry a digital signature in the organisation's name: any PDF reader shows who sealed the file and that it has not changed since. People who verify or approve vouchers or sign the close can also add their own soft certificate (.p12 / .pfx) under Settings, Signing certificate and type its PIN when they approve; their signature is listed on the certificate. The voucher and close pages show whether each signature is valid. Without a certificate everything works as before.",
  },
  {
    id: "2026-11-07-menu-tree",
    date: "2026-11-07",
    title: "A menu that opens up like a tree",
    body: "Finance and Settings now open in the menu on the left: press the arrow next to them to see their sections and pages, and press a section heading or a group heading (Today, Patients and so on) to fold it away. Pulse remembers what you opened on this device; Expand all and Collapse all sit at the top of the menu. When the menu is narrow, point at the Finance or Settings icon (or press it) to pick a page. On a phone the Finance and Settings pages keep their own menu at the top of the page. Ctrl K now finds every Finance page too.",
  },
  {
    id: "2026-11-06-board-pack-controls",
    date: "2026-11-06",
    title: "Board pack: controls and matters needing attention",
    body: "The month-end close pack now carries a one-page control summary for the Board: each bank account's reconciliation and the unexplained bank credits, unpaid supplier invoices by age and the voucher queue, the doctor revenue-share run and what is approved but not paid, unapproved invoice changes, insurance receivables over 90 days, the close timetable and open finance exceptions. A list of matters needing attention is worked out from it, using limits finance sets on the Close timetable page. Both are frozen with the pack and its fingerprint, and appear on the page, in Excel and in the PDF. Packs built earlier say the summary was not captured.",
  },
  {
    id: "2026-11-05-labs-and-referrals",
    date: "2026-11-05",
    title: "Lab and referral reconciliation",
    body: "Finance has a new Labs and referrals page. Upload each lab's, hospital's and radiology provider's monthly file and Pulse checks every test against what Unite billed for the same patient, day and test code: tests done but never billed, tests billed that the lab has no record of, prices that differ from the agreed price and results that came back late. Once reviewed, a second person posts each doctor's share of the cost (including the in-house lab's fixed monthly fee) to the doctor charges used by the revenue share. Patient names in the files are never read.",
  },
  {
    id: "2026-11-04-bank-ai-review",
    date: "2026-11-04",
    title: "AI review of bank reconciliation",
    body: "On an open bank reconciliation, Finance can press Ask AI to review. For each proposed match, missing receipt and unexplained bank credit the AI suggests one of Pulse's own candidates, or no match, with a reason and how sure it is, and writes a short summary marked as a draft. Nothing changes until a person accepts a suggestion; an accepted pair is saved exactly like a match you accept yourself, and the page counts how many suggestions were accepted and rejected. The AI sees ids, amounts, dates and references only, and needs AI switched on for the workspace.",
  },
  {
    id: "2026-11-03-finance-inbox",
    date: "2026-11-03",
    title: "Finance inbox",
    body: "Finance has an inbox for supplier invoices, bank statements and processor reports. Once an administrator switches on the Finance mailbox, attachments e-mailed to the accounts mailbox by the allowed senders arrive there by themselves; paper invoices can be photographed and dropped on the page, several files at once. Label each file, turn an invoice into a supplier invoice with one click, or discard what does not belong. Patient reports keep their own upload pages.",
  },
  {
    id: "2026-11-01-revenue-share",
    date: "2026-11-01",
    title: "Doctor revenue share",
    body: "Finance has a new Doctor revenue share page. Each doctor's contract is kept as an approved rule (share of net revenue, rates per service category, a monthly threshold or minimum guarantee, and which lab and referral charges are deducted). Each month Pulse calculates every payout and shows every step; Finance verifies, the CEO approves, and the accounting and payment references are recorded against it, so anyone can see later exactly how a number was reached. Only Finance and the CEO can see it.",
  },
  {
    id: "2026-10-31-invoice-changes",
    date: "2026-10-31",
    title: "Invoice changes and their approval",
    body: "Finance has a new Invoice changes page: every discount, cancellation, credit note, write-off, reduced amount and refund on a Unite invoice, with the Unite user who made it. Operations and finance record a decision on each (approved, not approved, or no approval needed) with a reason, and can approve small changes together up to a limit finance sets. A line at the top counts the changes still without an approval, with a target of zero, and the list downloads as CSV. Pulse still never changes anything in Unite.",
  },
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
