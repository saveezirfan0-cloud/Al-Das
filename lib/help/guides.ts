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
      "Close the conversation when it is finished, with a category if your clinic asks for one. In the same box you can create the patient's enquiry or move theirs on (stage, won, or lost with a reason).",
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
      "For a video appointment, open it and press Join video visit (also on the Front desk board). Copy link gives you the address; New link replaces it if it was shared by mistake.",
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
      "Campaigns sent from Sanoflow before the move are under Campaign history (read-only).",
      "Stuck? The Campaign Copilot turns a sentence into an audience with its size, and suggests English and Arabic wording. In Flows, Describe a bot drafts a flow and Dry run tries it with sample messages.",
      "To send the same campaign on a schedule, choose Repeat under When and how; Recurring lists them with play and pause. On Templates, the row menu has Delivery settings (retry, SMS fallback for reminders, time limit) and Performance.",
    ],
    watchOut: [
      "Patients who opted out of marketing are always left out.",
      "An administrator can set a monthly campaign budget. When it is used up, campaigns pause until it is raised.",
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
    id: "integrations",
    title: "Integrations",
    pages: ["/settings/integrations"],
    purpose:
      "Connect Pulse to a text-message provider, a payment gateway and doctors' calendars. Each one is off until an administrator switches it on.",
    steps: [
      "Open an integration, enter its settings and keys, press Save, then Test connection. Keys are stored encrypted and never shown again.",
      "To switch on SMS fallback or payment links, type the confirmation words shown on the page. Both can contact patients.",
      "Calendar feeds: create a feed for a doctor, copy the link at once (it is shown only once) and add it to Outlook, Google or Apple Calendar.",
      "If a link is shared by mistake, Rotate it. The old link stops working immediately.",
      "Google review requests: choose the approved WhatsApp template, map its variables, paste each location's Google review link, save, then switch on with the typed words. Staff can mark a patient 'Do not ask' on the patient's card.",
      "System health shows whether each integration is working.",
    ],
    watchOut: [
      "A calendar feed shows appointment times and the clinic location only, never patient details, but anyone with the link can see them.",
      "Review requests go only to patients who opted in to messages, at most once per person in the period you set, and never depend on how the visit went. Pulse does not contact Google.",
      "SMS is only a fallback for appointment reminders that WhatsApp could not deliver, and each message costs money.",
      "Nothing here ever writes to Unite.",
    ],
  },
  {
    id: "review-requests",
    title: "Google review requests",
    pages: ["/settings/integrations/google_reviews"],
    purpose:
      "Send one WhatsApp message with your Google review link after a completed visit, to patients who agreed to receive messages.",
    steps: [
      "Choose the approved WhatsApp template and map its variables, with one of them set to the review link.",
      "Paste each location's Google review link (g.page, google.com or maps.app.goo.gl) and save.",
      "Set how long to wait after the visit, the sending hours and how often one person may be asked, then save.",
      "Switch on with the typed words. Only visits that finish after that are asked.",
      "To never ask a patient, open the patient and tick 'Do not ask for a Google review'.",
    ],
    watchOut: [
      "Only patients who opted in to messages are asked, and a parent with several children is asked once. Pulse does not contact Google: the link is only text in the message.",
      "Nobody is left out, or sent somewhere else, because of how their visit went: Google does not allow that.",
      "Nothing is sent from a training workspace.",
    ],
  },
  {
    id: "ad-attribution-setup",
    title: "Meta ad attribution",
    pages: ["/settings/integrations/meta_capi"],
    purpose:
      "Record which Meta ad each WhatsApp conversation came from and, if you choose, tell Meta when an ad patient made contact, became an enquiry or booked.",
    steps: [
      "Start in 'Report only'. Switch on with the typed words and the Ad attribution report fills as ad conversations arrive.",
      "To send events, enter the dataset ID and access token from Meta Events Manager, choose 'Report and send events', save and press Test connection.",
      "Use the test event code from Events Manager first and check the events appear in its Test events view, then clear the code.",
      "Leave 'Whose events may be sent' on opt-in unless your administrator has confirmed another basis.",
    ],
    watchOut: [
      "Events carry only the event name, the ad click id and, if you choose, a hashed phone number: never a service, doctor, diagnosis or price.",
      "Patients who asked to stop marketing are never included.",
      "Check Meta's rules for health advertisers before sending events.",
    ],
  },
  {
    id: "video-visits-setup",
    title: "Video visits",
    pages: ["/settings/integrations/telehealth"],
    purpose:
      "Give video appointments a private video link that staff can join and reminders can carry.",
    steps: [
      "Choose a provider: your own meeting service (an address with {token} in it) or Daily.co-style rooms created through the API.",
      "Enter the address or the API key and domain, set how long the room stays open after the visit, save and press Test connection.",
      "Switch on with the typed words, then mark a service as Video under Settings, Appointments (or change a single booking on the appointment).",
      "To put the link in a reminder or confirmation, map a template variable to 'Appointment: video visit link'.",
    ],
    watchOut: [
      "Each appointment gets its own long random link. It stops being given out after the visit and when the appointment is cancelled, missed or moved.",
      "With your own meeting service Pulse cannot end the room itself; with the API option the room expires on its own.",
      "Nothing is recorded, and no patient name or detail is sent to the video service. Nothing is created in a training workspace.",
    ],
  },
  {
    id: "esign-setup",
    title: "E-signature for consent forms",
    pages: ["/settings/integrations/esign"],
    purpose:
      "Send a patient's consent form to an e-signature service and keep the signed copy on the patient.",
    steps: [
      "Switch on patient documents first (Settings, Patient documents).",
      "Enter the provider's API key, leave Test mode on, save and press Test connection.",
      "Give the provider the callback address shown on this page (in its API settings, Event callback).",
      "Switch on with the typed words, send a request to yourself from a patient's Documents tab, sign it and check the signed copy appears.",
      "Then turn Test mode off for real, binding requests.",
    ],
    watchOut: [
      "This shares the form and the signer's name and e-mail address with the provider, which keeps its own copy under its own terms. Your agreement with it and its data location must be approved.",
      "The form must carry the provider's signature tags, or the signer has nowhere to sign.",
      "Nothing is sent from a training workspace. A request that is still waiting can be cancelled from the patient's Documents tab.",
    ],
  },
  {
    id: "ad-report",
    title: "Ad attribution report",
    pages: ["/reports/ads"],
    purpose:
      "See which Meta ads started WhatsApp conversations and how many became enquiries or bookings.",
    steps: [
      "Pick the period. Each row is one ad: its headline, conversations, patients, enquiries and bookings.",
      "A booking counts for an ad when it was made after the click, for the same patient, inside the attribution window.",
      "Events sent to Meta shows how many were sent, are waiting, failed, or were skipped and why.",
    ],
    watchOut: [
      "Counts only: no patient is named here.",
      "The report starts when ad attribution is switched on; earlier conversations are not included.",
    ],
  },
  {
    id: "payment-links",
    title: "Payment links",
    pages: ["/finance/payment-links"],
    purpose: "Ask a patient to pay an invoice by card with a link sent on WhatsApp.",
    steps: [
      "Type the invoice number and press Find. Check the total and whether the invoice has a patient.",
      "Check the amount, tick the box and send. The patient receives an approved WhatsApp message with the link.",
      "Watch the status: sent, paid, expired or cancelled. Cancel a link that should not be paid any more.",
      "A row marked review needs a look in the payment gateway before you reconcile it.",
    ],
    watchOut: [
      "Paid means the payment gateway said so. Pulse does not mark the invoice as paid in Unite: do that in your usual way.",
      "There is one open link per invoice. Refunds are not handled here.",
      "Send a link only when you have been asked to or the patient agreed to pay now.",
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
    id: "routing",
    title: "Teams and routing",
    pages: ["/settings/teams", "/settings/users"],
    purpose:
      "Decide who gets new WhatsApp conversations, what patients hear when nobody is free, and who sees which enquiries.",
    steps: [
      "In Teams, switch on round-robin to share new conversations among the members who are online.",
      "Pick a fallback team: it takes new conversations when nobody in the team is online or everyone is at their limit.",
      "Set office hours and an auto-reply. It is sent once per conversation when a chat arrives outside those hours or while nobody in the team is online.",
      "In Users, open a member's menu, Routing and enquiry view, to limit how many open conversations round-robin gives them and which enquiries they see.",
      "In Settings, Inbox, switch on 'Set people away when idle' so people who walk away stop receiving new chats.",
    ],
    watchOut: [
      "The auto-reply is plain text, so it only goes out inside 24 hours of the patient's message. Keep it short and never promise a time you cannot keep.",
      "A restricted enquiry view also applies to exports and searches. You can still assign more conversations by hand than the limit allows.",
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
