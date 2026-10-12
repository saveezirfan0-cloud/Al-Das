/**
 * One-page guides (pure), one per area of the app. The "?" button on every page opens the guide whose `pages`
 * prefix matches the current path. Plain language, no patient data, short enough to read in a minute.
 */
export type Guide = {
  id: string;
  title: string;
  pages: readonly string[];
  purpose: string;
  steps: readonly string[];
  watchOut: readonly string[];
};

export const GUIDES: readonly Guide[] = [
  {
    id: "front-desk",
    title: "Front desk",
    pages: ["/front-desk"],
    purpose: "Run reception from one screen: who is coming, who has arrived, who needs a call.",
    steps: [
      "The Today board lists arrivals by time. Tap Arrived when a patient walks in, then With doctor, Done and Checked out as the visit moves along.",
      "Search for a patient (press / to jump to the box) to see their card: next appointment, last visit, open enquiry and any flags.",
      "Use the card buttons: Book, Move, Cancel, Call (it opens your phone and logs a call task), Location and Running late.",
      "Register a walk-in with N. Ask for the consent tick before you save.",
      "At the end of the shift write a handover note and print the End of day sheet.",
    ],
    watchOut: [
      "Check-in is kept in Pulse only. Unite is never changed from here.",
      "A free-form message only goes out inside 24 hours of the patient's last message; after that a template is needed.",
      "Unconfirmed patients with a failed reminder need a phone call.",
    ],
  },
  {
    id: "inbox",
    title: "Inbox",
    pages: ["/inbox"],
    purpose: "Answer patients on WhatsApp together, without two people replying to the same chat.",
    steps: [
      "Take a conversation with the Take button, or wait for it to be assigned to you.",
      "Type / in the message box to use a quick reply. Names and appointment details fill in for you.",
      "If the 24-hour window has closed, pick a template instead of typing a message.",
      "Use the Patient tab on the right to see the next appointment and any flags without leaving the chat.",
      "Close the conversation when it is finished, with a category if your clinic asks for one.",
    ],
    watchOut: [
      "Never copy patient details into another chat or email.",
      "An internal note is not sent to the patient, but colleagues can read it.",
    ],
  },
  {
    id: "appointments",
    title: "Appointments",
    pages: ["/appointments"],
    purpose: "See and change the diary for every doctor and place.",
    steps: [
      "Choose the day and place, then click a free slot or use New appointment.",
      "Pick the patient, service, doctor and one of the free times shown.",
      "Open an appointment to confirm, move or cancel it. The patient is told if you tick Notify.",
      "Reminders go out on their own; a failed reminder creates a call task.",
    ],
    watchOut: [
      "Appointments that come from Unite are read-only here. Change them in Unite.",
      "If a slot was just taken you will be asked to pick another. That protects against double booking.",
    ],
  },
  {
    id: "contacts",
    title: "Contacts",
    pages: ["/contacts"],
    purpose: "Every patient and enquirer in one searchable list.",
    steps: [
      "Search by name or phone, or build a saved view with filters.",
      "Open a row to edit details, add tags and see the timeline.",
      "Two records for the same person? Use Merge. Two people who share a phone (a parent and child) are linked as a household instead.",
      "The Documents tab (if you have access) keeps referral letters, lab reports, insurance cards and consent forms. Add one with a title, a category and, for an insurance card, its expiry date.",
    ],
    watchOut: [
      "Phone numbers must include the country code if they are not UAE numbers.",
      "Stop marketing means no campaign messages, but appointment messages still go out.",
      "Every time someone opens or downloads a document it is recorded. Open only what you need for the patient in front of you.",
    ],
  },
  {
    id: "tasks",
    title: "Tasks",
    pages: ["/tasks"],
    purpose: "Things somebody has to do: calls, follow-ups, reminders.",
    steps: [
      "Tasks assigned to you are listed first, oldest due date at the top.",
      "Open a task to see the patient and notes. Tick it off when it is done and write the outcome.",
      "A call logged from the Front desk shows up here until you close it.",
    ],
    watchOut: ["Overdue tasks show a red badge in the menu."],
  },
  {
    id: "enquiries",
    title: "Enquiries",
    pages: ["/enquiries"],
    purpose: "Follow a new lead from first message to booked appointment.",
    steps: [
      "Drag a card to the next stage as the conversation moves forward.",
      "Create an enquiry from a conversation with Create enquiry.",
      "Mark it won when the patient books, or lost with a reason.",
    ],
    watchOut: ["The first reply is timed. A breached SLA notifies the team."],
  },
  {
    id: "campaigns",
    title: "Campaigns and templates",
    pages: ["/campaigns", "/templates", "/flows", "/recall"],
    purpose: "Message many patients at once, with an approved template.",
    steps: [
      "Choose or build the audience and look at the count before you go on.",
      "Pick an approved template and use the phone preview to check it.",
      "Send now or schedule. Watch delivery and replies on the campaign page.",
      "Stuck? The Campaign Copilot turns a sentence into an audience with its size, and suggests English and Arabic wording. In Flows, Describe a bot drafts a flow and Dry run tries it with sample messages.",
    ],
    watchOut: [
      "Patients who opted out of marketing are always left out.",
      "Send a small test to your own number first.",
      "AI drafts are never published or sent for you. An AI flow needs your review before it can be published.",
    ],
  },
  {
    id: "media",
    title: "Media Library",
    pages: ["/media"],
    purpose:
      "One shared place for the images, PDFs and videos you use in templates, campaigns, quick replies and conversations.",
    steps: [
      "Upload files, or take a photo on your phone. Pictures are made smaller automatically so they fit WhatsApp's limits.",
      "Put files in folders and add tags so colleagues can find them. Search looks at names and tags.",
      "Open a file to see where it is used. A file used by a live template, campaign or quick reply cannot be deleted.",
      "Pick a file from the library when you build a template header, set up a campaign or send in a conversation.",
    ],
    watchOut: [
      "WhatsApp allows images up to 5 MB, videos up to 16 MB and documents up to 100 MB.",
      "A file marked Not scanned has not been checked for malware, because no scanner is set up yet.",
      "Never put patient documents here. They belong on the patient, in the Documents tab.",
    ],
  },
  {
    id: "reports",
    title: "Reports and dashboards",
    pages: ["/reports", "/dashboard"],
    purpose: "How the clinic is doing, by day, week and team.",
    steps: [
      "The Overview shows today's numbers. Management shows trends.",
      "Change the period at the top. Export needs a separate permission.",
      "AI reply quality (if you have access) shows each Monday how AI suggestions were used and which patient questions the knowledge base could not answer.",
    ],
    watchOut: ["Numbers use the clinic's time zone, not yours."],
  },
  {
    id: "finance",
    title: "Finance",
    pages: ["/finance"],
    purpose: "Invoices, insurance claims and the exceptions that need a person.",
    steps: [
      "Start at the monthly summary, then open exceptions assigned to you.",
      "Upload the claim file from the insurer under Insurance.",
      "Check Data freshness before you trust a number.",
    ],
    watchOut: ["Finance data never shows patient names, only the Unite PIN."],
  },
  {
    id: "finance-workflows",
    title: "Finance workflows",
    pages: [
      "/finance/preauth",
      "/finance/eligibility",
      "/finance/denials",
      "/finance/remittance",
      "/finance/recovery",
      "/finance/close",
      "/finance/cashup",
      "/finance/export",
    ],
    purpose:
      "Pre-authorisations, eligibility, denials, payments received, reminders, the month-end close and the cash-up.",
    steps: [
      "Eligibility lists what is not ready to bill and why. Fix it before the invoice goes out.",
      "Denials: assign each case, write the appeal and send it yourself. Pulse only drafts the letter.",
      "Remittance: upload the payer's file, check the proposed matches, then commit. The original file is deleted.",
      "Month-end close: build the pack, finance signs, then the CEO signs the same version. The month is then locked.",
      "Cash-up: count each branch at the end of the day, submit, and note any difference.",
    ],
    watchOut: [
      "Reminders to patients are off until the tone has been approved and an administrator switches them on.",
      "Every AI-written appeal starts with a DRAFT banner. Read it and check the figures before using it.",
      "A signed month cannot be changed. Withdraw the finance sign-off first if something is wrong.",
    ],
  },
  {
    id: "settings",
    title: "Settings",
    pages: ["/settings"],
    purpose: "Set up people, numbers, rules and security.",
    steps: [
      "Use Ctrl K to jump straight to a setting.",
      "Users and Roles decide who can do what. Give people the smallest role that lets them work.",
      "Front desk, Appointment rules and Training mode are under their own pages.",
    ],
    watchOut: [
      "Changes apply to everyone at once and are written to the Activity log.",
      "Training mode stops all WhatsApp sending for the whole workspace.",
    ],
  },
  {
    id: "notifications",
    title: "Notifications",
    pages: ["/notifications"],
    purpose: "Everything Pulse has told you, in one place.",
    steps: [
      "Filter by type, snooze what can wait, mark the rest read.",
      "Choose how you want to be told under Settings, Notifications.",
    ],
    watchOut: ["Push and e-mail never contain patient names or message text."],
  },
  {
    id: "help",
    title: "Help and training",
    pages: ["/help"],
    purpose: "Videos and guides for your role.",
    steps: [
      "Watch the clips marked for your role first.",
      "Clips not recorded yet show Coming soon; the written guide is always available.",
      "Press ? anywhere for keyboard shortcuts.",
    ],
    watchOut: ["Do not put patient details in feedback."],
  },
];

export const FALLBACK_GUIDE: Guide = {
  id: "general",
  title: "Using Pulse",
  pages: [],
  purpose: "A quick orientation for any page.",
  steps: [
    "Use the menu on the left (or the tabs at the bottom on a phone) to move around.",
    "Press Ctrl K to search for any page or setting.",
    "The bell shows what needs you. Press ? for keyboard shortcuts.",
  ],
  watchOut: ["Patient information is health data. Only open what you need for your work."],
};

export function guideForPath(pathname: string): Guide {
  let best: { guide: Guide; len: number } | null = null;
  for (const guide of GUIDES) {
    for (const p of guide.pages) {
      if ((pathname === p || pathname.startsWith(p + "/")) && (!best || p.length > best.len))
        best = { guide, len: p.length };
    }
  }
  return best?.guide ?? FALLBACK_GUIDE;
}
