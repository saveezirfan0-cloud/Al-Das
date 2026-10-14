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
    id: "clinical-data-quality",
    title: "Clinical data quality",
    pages: ["/portal/data-quality", "/portal/unclassified-medications"],
    purpose:
      "Find the visits and medicines the clinical rules cannot judge yet, so follow-ups and antibiotic check-ins are not missed.",
    steps: [
      "Data quality lists visits with a missing temperature, blood pressure, oxygen or pulse, and visits with no matched patient. Fix the record in Unite; the next sync updates it.",
      "Codes at the bottom are diagnoses Pulse does not know. Add them under Portal, Diagnoses (ICD-10) with the chronic flag; visits are linked the next night.",
      "Unclassified medications lists Unite medicine codes with no class. Choose the class, tick that you checked the drug, then Save.",
      "For an antibiotic, tick 'Probiotics afterwards by default' only if the clinic's rule says so for that drug.",
    ],
    watchOut: [
      "The suggestion beside each medicine is the old automatic guess. It can be wrong; a person always decides.",
      "Classifying a medicine as an antibiotic lets Pulse plan its check-ins. Nothing reaches a patient while clinical messaging is switched off.",
    ],
  },
  {
    id: "clinical-feedback",
    title: "Clinical feedback",
    pages: ["/portal/clinical-feedback"],
    purpose:
      "See what patients answered to clinical check-ins and which answers raised a red flag.",
    steps: [
      "Use 'Needing a person' to see replies the system could not judge on its own.",
      "A red flag means the doctor and the care coordinators were both alerted. The call itself is in the Follow-Up Queue.",
      "Open 'Show reply' only when you need the patient's own words.",
    ],
    watchOut: [
      "Replies are health information. Never copy them into chats, e-mails or tasks.",
      "While the thresholds are not signed off, every reply goes to a person.",
    ],
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
    id: "finance-flash",
    title: "Daily flash",
    pages: ["/finance/flash", "/finance/flash/settings"],
    purpose:
      "The daily financial summary, month to date and daily sales by branch against target, with patient volume, ARPP and doctor rankings, built from Unite invoices.",
    steps: [
      "Pick a day (yesterday by default). Daily summary shows that day; Month to date runs from the 1st to that day.",
      "Daily sales lists every day of the month by branch and compares the month so far with the same days of last month.",
      "Download Excel gives the same figures in the layout of the old sheets, with no formulas to break.",
      "Finance sets the reporting lines (which branch codes or departments make each line) and the daily targets under Targets and lines.",
    ],
    watchOut: [
      "A line called Unassigned means some invoices match no reporting line. Fix the lines rather than the figures.",
      "Month-to-date targets are the daily target times the days elapsed.",
      "Figures are only as recent as the latest Unite data; the date is shown under the day picker.",
    ],
  },
  {
    id: "finance-followup",
    title: "Insurance follow-up and receivables",
    pages: ["/finance/followup", "/finance/receivables"],
    purpose:
      "Chase unpaid insurance claims at 60, 90 and 120 days, see each claim's submissions and resubmissions, and see what each payer owes by age.",
    steps: [
      "Insurance follow-up lists every unpaid claim, oldest first, with the stage it has reached. Filter by stage, payer or branch.",
      "Open a claim to see its submissions (first, second, third) with the amounts claimed and remitted, then record what you did and the next action date.",
      "Once finance sets a start date in Workflow settings, each claim gets one task when it reaches a stage, given to a member of the chosen role.",
      "Receivables by age shows each payer's unpaid amount in the age buckets from Workflow settings. Download it as CSV.",
    ],
    watchOut: [
      "Write no patient names, card or phone numbers in a follow-up note.",
      "Whether a resubmission was a correction (the whole amount re-sent) is worked out from the amounts; Diligence's report does not say.",
      "Insurer payments are confirmed only against the bank statement and the remittance received.",
    ],
  },
  {
    id: "finance-analytics",
    title: "Billing mix and trends",
    pages: ["/finance/analytics"],
    purpose:
      "How each doctor bills (consultation, lab, radiology, procedures; insurance or self-pay) compared with the clinic as a whole, and revenue by week or month next to the same period last year.",
    steps: [
      "Pick the dates (the last twelve months by default) and, if you want, one branch code.",
      "Doctor billing mix shows each doctor's revenue, patients, revenue per patient and the share of each service category, with the category where the doctor differs most from the clinic.",
      "Seasonality shows each month or week against the same one last year; choose Week to see shorter patterns.",
      "Mix CSV and Trend CSV download the same figures, with every category's share.",
    ],
    watchOut: [
      "Unmapped means billed items without a service category. Finance fixes that under Reference data, then the mix is complete.",
      "Last year is only compared when the invoices on record reach back that far.",
      "These are activity measures, not a judgement of clinical quality.",
    ],
  },
  {
    id: "finance-close-timetable",
    title: "Close timetable",
    pages: ["/finance/close/timetable"],
    purpose:
      "The month-end close by working day: each step's owner, trained backup, due day and dependencies, and the close measures (inputs by WD5, close delivered by WD10, open reconciling items, backups).",
    steps: [
      "Pick the month being closed. Its working days are counted in the month after: September's WD5 is the fifth working day of October.",
      "Owners and backups open Update on their step to mark it done or blocked. A blocked step says what it is waiting for.",
      "Overdue steps are highlighted. The last row is the Board pack: it is done when the CEO signs and the month locks.",
      "Finance managers assign owners and backups in the checklist template and set weekends, holidays and the start month under Calendar and settings.",
    ],
    watchOut: [
      "Nothing runs until a start month is set. From then on each month's steps appear on working day 1 and owners get one reminder a day for steps due or late.",
      "A changed due day applies to months whose steps are created afterwards; past months keep the day they were measured against.",
      "Once a month is locked its timetable cannot change.",
    ],
  },
  {
    id: "finance-inbox",
    title: "Finance inbox",
    pages: ["/finance/inbox"],
    purpose:
      "One place for the finance paperwork that arrives: attachments e-mailed to the accounts mailbox by the allowed senders, and files dropped here, such as a photo of a paper invoice that came with goods to a branch.",
    steps: [
      "Drop files on the page or press Choose files: PDF, photos, Excel or CSV. Several at once is fine.",
      "Open a file to read it, then give it a label: supplier invoice, bank statement, processor report or other.",
      "For a supplier invoice press Make a supplier invoice: the invoice form opens with the file already attached. Once saved, the file leaves the inbox and travels with the invoice to its voucher.",
      "Discard anything that is not finance paperwork (a newsletter, a duplicate scan). It is deleted for good.",
    ],
    watchOut: [
      "Never put patient reports here: Diligence files, remittance advice and lab reports with names go on their own upload pages, which delete the original at once.",
      "A file that is already in Pulse is not added twice.",
      "Mail from a sender who is not on the allowed list is dropped; an administrator adds senders under Settings, Integrations, Finance mailbox.",
    ],
  },
  {
    id: "finance-vouchers",
    title: "Payment vouchers and supplier invoices",
    pages: [
      "/finance/vouchers",
      "/finance/vouchers/report",
      "/finance/vouchers/settings",
      "/finance/payables",
      "/finance/suppliers",
      "/finance/tally",
    ],
    purpose:
      "Zero paper: supplier invoices and payment vouchers are kept in Pulse with their documents, and every voucher goes maker, Finance Manager, then the department head or CEO as the delegation of authority requires, before it is paid and exported to Tally.",
    steps: [
      "Add the supplier invoice under Supplier invoices and attach the PDF from the accounts mailbox, or a phone photo of a paper invoice.",
      "Press Pay with a voucher (or New voucher under Payment vouchers). Check the amount, category, branch and narration, attach any other backup, save the draft and submit it.",
      "The Finance Manager verifies it (Tier 1 vouchers can be verified together). Tier 2 then goes to a department head; Tier 3, Tier 4, payroll, intercompany and related-party vouchers go to the CEO, who can approve on a phone.",
      "Anyone who rejects must write remarks; the maker edits the voucher and submits it again.",
      "Once approved, someone other than the maker records the payment date and bank reference, then build the Tally file under Tally export and import it in Tally.",
      "Download the approval certificate from a voucher for the auditors: it lists every step, person, time, remark and the fingerprint of the documents. Once the voucher is fully approved and the organisation seal is on, the certificate is digitally sealed and every download is the same sealed file.",
    ],
    watchOut: [
      "Each step must be a different person: whoever prepared or changed a voucher cannot verify or approve it.",
      "Changing a voucher after it was submitted returns it to draft and clears its approvals.",
      "Nothing dated in a locked month can change its amounts, dates or documents; its invoices can still be paid by a later voucher and exported to Tally.",
      "A voucher for less than its invoices pays the oldest first; an invoice not fully paid stays Part paid with its balance for the next voucher.",
      "The Tally file refuses until every category, supplier, bank and branch is mapped to a Tally ledger (Voucher settings).",
      "With a signing certificate (Settings, Signing certificate), type its PIN when you verify or approve to sign with it; a wrong PIN saves nothing. Leave it blank to approve without a personal signature.",
    ],
  },
  {
    id: "finance-bank",
    title: "Bank reconciliation",
    pages: ["/finance/bank", "/finance/bank/settings"],
    purpose:
      "Proves that every Unite collection reached the bank: card and EPG (T+2), Tabby (T+6 working days), cash deposits and insurers' bulk payments, net of the processors' fees, by bank account and month.",
    steps: [
      "Once, in Accounts and rules: add each bank account (last 4 digits only), a file layout per bank or processor (the header of each column in their export), and for each payment mode its lag in working days, fee % and bank account.",
      "Import the bank statement (and, where you have it, the processor's settlement report) as .csv or .xlsx. The same file twice, or overlapping dates, are refused.",
      "Open the month's reconciliation for an account. Save the automatic matches, then accept or reject each proposed match: the score and its reasons are shown.",
      "Give a reason for every expected receipt that is late and for every bank credit nothing explains, then mark it reviewed. A second person signs it off.",
      "Optional: press Ask AI to review on an open reconciliation. The AI suggests, for each open item, one of Pulse's own candidates (or no match) with a reason, and writes a short summary. Accept or Reject each suggestion; an accepted pair is saved exactly as if you had accepted the proposal yourself. The line above the list shows how many suggestions were accepted and rejected.",
    ],
    watchOut: [
      "A pair is matched automatically only when it is the only candidate on both sides and scores at least the threshold; Pulse never picks between two that fit.",
      "The AI summary is a draft: check it before relying on it. The AI sees ids, amounts, dates, payment modes and references only, never bank descriptions or names, and it cannot change a figure or pair anything itself. It needs the AI review permission and AI switched on for the workspace.",
      "A payment mode is not reconciled until its rule has a bank account, a lag and a fee % (0 when there is no fee).",
      "A locked month cannot be changed, and a signed reconciliation is final.",
    ],
  },
  {
    id: "finance-labs",
    title: "Labs and referrals",
    pages: ["/finance/labs", "/finance/labs/settings"],
    purpose:
      "Checks every lab test and referral on a provider's monthly file against what Unite billed (patient PIN, day and test code) before its cost is charged to the doctor: tests done but not billed, tests billed that the lab has no record of, price differences and late results.",
    steps: [
      "Once, in Providers, tests and layouts: add the in-house lab (its monthly fee and how to share it), each send-out lab, hospital and radiology provider, each provider's tests (expected days and agreed price), and a file layout per provider (the header of each column in their file).",
      "Each month, upload each provider's file (one per branch is fine) for the month of service. Names and ID numbers in the file are never read; the same file twice is refused.",
      "Open the statement: give a reason for every line not matched to Unite and every billed test missing from the lab's file (one reason can cover a whole list), check price differences and late results, then mark it reviewed.",
      "A second person posts it: each doctor's cost becomes a lab or referral charge for the month, deducted in the revenue share.",
    ],
    watchOut: [
      "A line is matched only when it is the only candidate both ways; Pulse never picks between two that fit.",
      "Posting again, or reopening, replaces only this statement's charges. Once the month's revenue share is verified or the month is locked, the charges cannot change.",
      "Unite PINs are shown masked; never type patient details into a note.",
    ],
  },
  {
    id: "finance-invoice-changes",
    title: "Invoice changes",
    pages: ["/finance/invoice-changes"],
    purpose:
      "Review every discount, cancellation, credit note, write-off, reduced amount and refund on a Unite invoice, so no change goes without an approval.",
    steps: [
      "Choose a period. Unreviewed changes come first; the boxes at the top total each kind of change.",
      "Open a change to see the invoice, amount, date and the Unite user who made it, then record Approved, Not approved or No approval needed, with a reason.",
      "Small changes up to the limit finance sets can be approved together with one reason.",
      "The line at the top counts the changes still without an approval since the start date finance sets (target: zero). Download the list as CSV.",
    ],
    watchOut: [
      "Pulse never changes anything in Unite: a review is a record of the decision only.",
      "Changes are worked out from what Unite sends Pulse, so a change made and undone between two deliveries is not seen.",
      "Write no patient names, card or phone numbers in a reason.",
    ],
  },
  {
    id: "finance-revenue-share",
    title: "Doctor revenue share",
    pages: [
      "/finance/revenue-share",
      "/finance/revenue-share/schemes",
      "/finance/revenue-share/charges",
    ],
    purpose:
      "Each doctor's monthly revenue share with a complete trail: the source revenue, the approved rule of their contract, the lab and referral charges, every calculation step, Finance verification, CEO approval, the accounting reference and each payment.",
    steps: [
      "Schemes: add one version per doctor contract (share of net revenue, optional rates per service category, which charges are deducted, an optional monthly threshold and minimum guarantee). The Finance Manager verifies it (never the person who drafted it), then the CEO approves it; an approved version never changes, so a new contract term is a new version.",
      "Doctor charges: enter or upload the month's lab, external referral, consumable and other costs per doctor before working day 7. Re-uploading a corrected file replaces the earlier upload for the same month and kind.",
      "Monthly runs: after the month ends, build the draft and open each doctor to check every step. The Finance Manager verifies (never the person who built it), then the CEO approves.",
      "Record the accounting (Tally) reference, then each doctor's payment date and reference. The trail CSV downloads the whole calculation.",
    ],
    watchOut: [
      "This is doctor compensation: only Finance and the CEO see it.",
      "Verifying freezes the run and the month's charges. Return it to draft (before the CEO approves) to correct something.",
      "A month locked by the month-end close cannot have its charges or draft changed; approve the run before the close.",
      "The page warns when invoices, charges or schemes changed after the draft was built. Rebuild before verifying.",
    ],
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
      "Each sign-off can carry your personal digital signature (type your certificate PIN). The PDF of a locked month is sealed with the organisation certificate when the seal is on; the Sign-off box shows whether each signature is valid.",
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
    id: "document-seal",
    title: "Organisation seal",
    pages: ["/settings/integrations/document_seal"],
    purpose:
      "Digitally seal the final payment voucher approval certificates and the locked month-end close packs with the organisation's certificate, so anyone can check who issued the PDF and that it has not been changed.",
    steps: [
      "Get a certificate issued to the organisation (from a certificate authority, or your IT provider for internal use) and export it with its private key as a .p12 / .pfx file with a password.",
      "Choose the file, type its password and the name to show with the seal, then Save settings. A file that cannot be opened with the password is refused at once.",
      "Check the certificate details shown below (subject, issuer, validity), then type SEAL DOCUMENTS and Switch on.",
      "From then on, a voucher's certificate is sealed when it is fully approved, and a close pack PDF when the month is locked. The sealed file is kept, so every download is the same.",
    ],
    watchOut: [
      "Switch it off at once if the certificate file or its password may have leaked, then replace the certificate.",
      "Renew the certificate before it expires: an expired certificate seals nothing, and documents show 'Not digitally sealed'.",
      "A self-signed certificate seals correctly, but PDF readers will say the signer is not trusted.",
      "The seal is not a UAE qualified electronic signature. Signing happens inside Pulse; nothing is sent anywhere.",
    ],
  },
  {
    id: "signing-certificate",
    title: "Signing certificate",
    pages: ["/settings/signing-certificate"],
    purpose:
      "Add your own soft certificate so you can digitally sign the approvals you give: verifying and approving payment vouchers, and the month-end sign-offs.",
    steps: [
      "Export your certificate with its private key as a .p12 / .pfx file protected by a PIN (at least 4 characters).",
      "Choose the file, type the PIN and press Add my certificate. Pulse reads the certificate and forgets the PIN.",
      "When you verify, approve or sign off, type the PIN in 'Sign with my certificate'. Your signature is listed on the approval certificate and the close pack.",
    ],
    watchOut: [
      "A wrong PIN stops the approval: nothing is saved until you type it correctly or leave the box blank.",
      "A USB token cannot be used by Pulse; keep using it in Tally where required.",
      "Expired certificates are refused. Revoke yours here at once if the file or the PIN may be known to someone else.",
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
    id: "web-chat-setup",
    title: "Website chat",
    pages: ["/settings/integrations/web_chat"],
    purpose:
      "Put a chat button on your own website. Visitors' messages arrive in the Inbox and your replies appear in their browser.",
    steps: [
      "List the websites that may show the chat (host names such as www.example.com, separated by commas), choose the title, colour and welcome text, and save.",
      "Switch on with the typed words.",
      "Give your web developer the line under 'Add the chat to your website'. It goes before </body> on each page of the listed websites.",
      "Open your website, send a test message and answer it from the Inbox (it shows 'Website chat').",
    ],
    watchOut: [
      "Replies are text only: no templates, files or voice notes. There is no 24-hour limit.",
      "A visitor is identified only by a random code kept in their own browser. If they clear it, their next message starts a new chat and a new patient record (merge them if needed).",
      "Visitors are not verified: check who you are talking to before sharing anything personal.",
      "The chat does not work in a training workspace.",
    ],
  },
  {
    id: "meta-messaging-setup",
    title: "Instagram and Messenger",
    pages: ["/settings/integrations/instagram", "/settings/integrations/messenger"],
    purpose:
      "Answer Instagram direct messages and Facebook Messenger conversations from the Inbox.",
    steps: [
      "In your Meta app, connect the Facebook Page (and the Instagram professional account linked to it) and create a long-lived Page access token with the messaging permission.",
      "Enter the Page ID (and the Instagram account ID), the Page token, the app secret and a verify token of your choice, then save and press Test connection.",
      "Switch on with the typed words.",
      "In the Meta app's Webhooks settings, subscribe the Page (or Instagram) object's messages with the webhook address shown on this page and the same verify token.",
      "Send a message to the account from a test profile and answer it from the Inbox.",
    ],
    watchOut: [
      "Meta only allows a reply within 24 hours of the person's last message. After that Pulse refuses the reply; there are no templates on these channels.",
      "Replies are text only. Photos and files people send show as an attachment notice; open the conversation in Instagram or Messenger to see them.",
      "People are matched by the id Meta gives them on your account, never by phone number. Merge records by hand if the same patient also writes on WhatsApp.",
      "Nothing is sent from a training workspace.",
    ],
  },
  {
    id: "google-calendar-setup",
    title: "Google Calendar sync",
    pages: ["/settings/integrations/google_calendar"],
    purpose:
      "Keep a doctor's Google Calendar and Pulse in step: Google busy times block bookings in Pulse, and Pulse appointments show in Google as 'Busy'.",
    steps: [
      "In the Google Cloud console create an OAuth client (web application), add the redirect address shown on this page, and enable the Google Calendar API.",
      "Enter the client ID and secret, choose what to sync and how many days ahead, and save.",
      "Switch on with the typed words.",
      "For each doctor press Connect. The doctor signs in to their own Google account on that screen and allows access.",
      "Within five minutes their busy times appear as blocked time in Pulse and their appointments appear in Google as 'Busy'.",
    ],
    watchOut: [
      "Google receives only the start and end time of each appointment, titled 'Busy': never the patient, service or notes.",
      "Pulse reads only when the doctor is busy, never what their events are. Events marked 'Free' in Google do not block bookings.",
      "Busy times from Google cannot be edited in Pulse; change them in Google. Disconnect removes them and stops the sync.",
      "Unite appointments are never changed by this sync.",
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
      "With Meta ads spend switched on, each ad also shows its spend, impressions and clicks, and the cost per conversation, per enquiry and per booking.",
    ],
    watchOut: [
      "Counts and amounts only: no patient is named here.",
      "The report starts when ad attribution is switched on; earlier conversations are not included.",
      "Spend is Meta's own figure, read once a day for the past few days (Meta's day, in the ad account's time zone), so today's spend is not in it yet.",
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
  {
    id: "accounting",
    title: "Accounting",
    pages: ["/accounting", "/accounting/dashboard"],
    purpose:
      "The general ledger that replaces Tally: every journal, typed in or posted from the finance sub-ledgers, in one double-entry book.",
    steps: [
      "The dashboard shows the current period, journals waiting to be posted and drafts.",
      "Journals are prepared by one person and posted by another; open Journals to work them.",
      "Reports (day book, general ledger, trial balance) read posted journals only.",
    ],
    watchOut: [
      "A posted journal never changes. To correct one, reverse it and post a new one.",
      "The fiscal year runs July to June unless the entity says otherwise.",
    ],
  },
  {
    id: "accounting-journals",
    title: "Journals",
    pages: ["/accounting/journals"],
    purpose:
      "Prepare, check and post manual journals (Journal, Contra, Debit and Credit notes, opening balances), and reverse posted ones.",
    steps: [
      "Press New journal, choose the type and date, write a narration and add a line per account with its debit or credit. More shows the branch, department, cost centre, tax code, doctor, payer and supplier.",
      "Save the draft (it may be unbalanced), then Submit for posting once debits equal credits.",
      "Someone else with the post permission opens it, checks it and presses Post, or Send back with a reason.",
      "Posting gives it its number (for example JV/2026-27/00001). To undo a posted journal, press Reverse with a date and a reason.",
      "For an accrual, set Reverse automatically on: the reversal is posted on that date.",
    ],
    watchOut: [
      "Receivables, payables, bank, cash, VAT, clearing and retained earnings are control accounts: only the sub-ledgers post to them (and opening-balance journals).",
      "A closed period takes postings only from people who manage periods; a locked period, or a month the CEO signed off, takes none.",
      "Never put a patient's name in a narration; card, account and phone numbers are masked.",
    ],
  },
  {
    id: "accounting-chart",
    title: "Chart of accounts, tax codes and cost centres",
    pages: ["/accounting/accounts", "/accounting/tax-codes", "/accounting/cost-centres"],
    purpose:
      "The account tree (Tally's predefined groups and the clinic's ledgers), the UAE VAT codes and the free cost centres.",
    steps: [
      "Add a ledger under the right group: it takes the group's nature (asset, liability, equity, income or expense).",
      "Mark a ledger as a control account when only a sub-ledger should post to it.",
      "Rename freely; deactivate a ledger you no longer use (a ledger with postings is never deleted).",
      "Tax codes: add or edit the VAT codes; the tax adviser decides which service gets which code.",
    ],
    watchOut: [
      "Tally's 28 predefined groups (marked Tally) keep their code, place and nature so the Tally import lands in the right place.",
    ],
  },
  {
    id: "accounting-reports",
    title: "Day book, general ledger and trial balance",
    pages: ["/accounting/day-book", "/accounting/ledger", "/accounting/trial-balance"],
    purpose:
      "Read the books: every posting by day, one account with its running balance, and every balance together.",
    steps: [
      "Day book: choose the dates to see each journal with its lines (a year at most).",
      "General ledger: choose an account or a whole group and the dates; open any number to see its journal.",
      "Trial balance: choose the dates; download it as Excel. It must say Balanced.",
    ],
    watchOut: [
      "Income and expense accounts start again each fiscal year; earlier years' profit shows on one line until the year-end close.",
      "Reversed journals stay in the books next to their reversal, so both show.",
    ],
  },
  {
    id: "accounting-sales",
    title: "Sales invoices, credit notes and customers",
    pages: [
      "/accounting/sales-invoices",
      "/accounting/credit-notes",
      "/accounting/customers",
      "/accounting/receivables-settings",
    ],
    purpose:
      "Tax invoices Pulse issues to insurers, corporates, tenants and other businesses, and the credit notes against them. Patient invoices are issued by Unite, not here.",
    steps: [
      "Customers: add the business with its TRN (blank when not VAT registered), address, credit terms, and for an insurer its payer.",
      "Sales invoices, New invoice: choose the customer, add a line per item with its income account and VAT code, and save the draft.",
      "Open the draft and press Issue: it gets its number (for example SI/2026-27/00001) and is posted to the ledger. Above the approval limit someone else with the journal approval permission presses Approve and issue.",
      "PDF downloads the tax invoice. A customer without a TRN gets a simplified tax invoice up to AED 10,000; everyone else a full one.",
      "To reduce an invoice, open it and press Credit note; to cancel it entirely, press Void (a credit note in full).",
    ],
    watchOut: [
      "VAT is worked out per line and rounded to the fil; the VAT code is never guessed (the tax adviser decides which service is zero-rated or 5%).",
      "Issue a credit note within 14 days of the event (the FTA rule); Pulse warns when it is later.",
      "An issued invoice never changes. Before the ledger start date it is issued but waits: Tally holds the books for that date.",
    ],
  },
  {
    id: "accounting-receivables",
    title: "Receipts, ageing and statements",
    pages: ["/accounting/receipts", "/accounting/receivables-ageing", "/accounting/statements"],
    purpose:
      "Record money received from customers, see who owes what and for how long, and send statements and balance-confirmation letters.",
    steps: [
      "Receipts, New receipt: choose the customer, the date, the amount and the bank or cash account. Pulse allocates it to the oldest open invoice first; change the amounts to allocate by hand. Anything left stays on account.",
      "A receipt by cheque: register the cheque first (Banking, Cheques), then choose it on the receipt. The receipt posts it on the cheque's date, so it is never posted twice; a post-dated cheque's receipt posts on that date.",
      "Open a receipt to change its allocation, or Void it: its journal is reversed and the invoices are open again. A receipt paid by a registered cheque is voided by bouncing or cancelling the cheque.",
      "Receivables ageing shows each customer's open amounts as at a date: current, 1-30, 31-60, 61-90, 91-120 and over 120 days past due.",
      "Statements: choose the customer and dates; download it as PDF or Excel, or a balance-confirmation letter for the auditors.",
    ],
    watchOut: [
      "Insurance remittances are matched in Finance, Remittances, not recorded here.",
      "Only Pulse's own sales invoices are aged here; insurance claims from Unite are aged in Finance.",
    ],
  },
  {
    id: "accounting-assets",
    title: "Fixed assets and depreciation",
    pages: ["/accounting/assets", "/accounting/depreciation"],
    purpose:
      "Keep the fixed asset register and post each month's depreciation, with one person preparing and another posting.",
    steps: [
      "Add an asset with its class (medical, IT, furniture, leasehold improvements, vehicles), cost, in-service date and branch. From a bill, the cost and date come from the supplier invoice.",
      "Depreciation is monthly from the month the asset goes into service, straight line or reducing balance, down to the residual value.",
      "Depreciation: prepare a month to see each asset's charge. Pulse also prepares last month's run itself on the first working day.",
      "Someone else with journal approval posts the run: one journal, depreciation expense against accumulated depreciation by class and branch.",
      "Dispose of an asset with its date and proceeds; Pulse works out the gain or loss and another person posts it.",
      "Download the register at any date, with the 12-month forecast and the schedules, as Excel.",
    ],
    watchOut: [
      "Once depreciation is posted for an asset its cost, life and dates are locked; dispose of it and add it again if they were wrong.",
      "Only the latest month can be prepared again once a later month is posted; it catches up on anything missed.",
      "A run dated before the ledger start date waits ('Waiting for the ledger start date') and can be posted later.",
    ],
  },
  {
    id: "accounting-schedules",
    title: "Prepayments, accruals and deferred revenue",
    pages: ["/accounting/schedules"],
    purpose:
      "Spread a prepaid cost, an accrued cost or income received in advance evenly over the months it belongs to.",
    steps: [
      "Add a schedule: the kind, the two ledgers, the total, the first month and the number of months.",
      "Tick 'reverse' on an accrual that is an estimate: each month's accrual is undone on the 1st of the next month when the real bill arrives.",
      "Prepare the month's releases (Pulse also does it on the first working day); another person with journal approval posts them.",
      "Cancel a schedule to stop further releases; what was released stays in the ledger.",
    ],
    watchOut: [
      "The payment or bill itself is posted with the bill, not here: a schedule only moves the amount month by month.",
      "Leases: enter them as a prepayment or accrual for now. IFRS 16 lease accounting waits for the reporting framework decision (OQ-125).",
    ],
  },
  {
    id: "accounting-close",
    title: "Periods, entities and fiscal years",
    pages: ["/accounting/periods", "/accounting/entities"],
    purpose:
      "Close and lock months, and set up the legal entity, its branches and its fiscal year.",
    steps: [
      "A period is created by the first posting in its month; Add a period creates one ahead of time.",
      "Close a month when its books are done; reopen it if something was missed.",
      "Lock a closed month for good by typing LOCK. Nothing can be posted into it again, by anyone.",
      "Entities: set the TRN, the fiscal year start month and each branch's emirate (for the VAT return).",
    ],
    watchOut: [
      "The fiscal year start cannot change once a fiscal year exists.",
      "Audit adjustments after the year end go into the year's adjustment period (people who manage periods only), so the last month stays closed.",
    ],
  },
  {
    id: "accounting-posting",
    title: "Posting engine: rules, waiting items and the preview",
    pages: ["/accounting/posting-rules", "/accounting/waiting", "/accounting/posting-preview"],
    purpose:
      "Pulse turns Unite invoices and payments, remittances, final denials, supplier bills, paid vouchers, the doctor revenue share, lab statements, cash-ups and card settlements into journals by itself, using the posting rules.",
    steps: [
      "Posting rules: each kind of amount (revenue per service category, VAT code per service category, payment modes, receivables, expenses, bank, ...) points at an account. '*' means any; the most specific rule wins. Not mapped yet lists what the finance records use today and has no rule.",
      "The VAT code of each service category is the tax adviser's decision; an invoice with a category that has none waits instead of guessing.",
      "Waiting to post: every item the engine could not post, with the reason (no rule, no VAT code, closed period, before the ledger start, ...). Fix the reason and it posts on the next run (every 15 minutes), or press Try again.",
      "Ledger start (Entities and fiscal years): the first day Pulse is the book of record. Before it Tally is, and Pulse only previews. Type START to set it.",
      "Posting preview: during the parallel run, what Pulse would post per account and month against the ledger (the Tally mirror). Work the differences down before the ledger start.",
    ],
    watchOut: [
      "Once Pulse has posted, the ledger start cannot be cleared, moved earlier or moved past its first journal: nothing is ever posted twice.",
      "A changed source (an amended Unite invoice) is reversed and posted again; a deleted or reopened one is reversed. Journals never change.",
      "Journals carry ids (an invoice number), amounts and dimensions; never a patient's name or PIN.",
    ],
  },
  {
    id: "accounting-banking",
    title: "Banking and cash",
    pages: ["/accounting/banking"],
    purpose:
      "The books' side of the bank and the cash: each bank account's ledger and position, transfers (Contra), bank charges and interest, petty cash and the cheque register.",
    steps: [
      "Bank accounts: link each bank account (Finance adds them under Bank reconciliation) to its ledger, or create one under Bank Accounts or Bank OD A/c. Type the statement's closing balance for a date to see the books against the bank.",
      "Transfers: money between two bank accounts, cash deposited or withdrawn, or a petty cash top-up. Each posts as a Contra voucher at once.",
      "Bank entries: charges, interest and direct debits or credits. Use Create entry on a statement line nothing explains yet; the line then counts as matched in the bank reconciliation.",
      "Petty cash: one float per branch with its own cash ledger. Record each expense with its receipt; at month end count the cash and save the count; someone else signs it.",
      "Cheques: register cheques we issue (vouchers paid by cheque are listed to register) and cheques we receive. Mark them presented, cleared or bounced; cancel one that was never used. A voucher paid by cheque is posted by its cheque, not again on payment; until its cheque is registered it waits under Waiting to post.",
    ],
    watchOut: [
      "Nothing is edited after it is saved: cancel it (a posted item is reversed) and enter it again.",
      "A post-dated cheque posts on its date (a daily job, or Post what is due). A cheque goes stale six months after its date and its posting is reversed.",
      "A bounced cheque reverses its posting and flags the party; clear the flag with a reason once settled.",
      "An item dated before the ledger starts waits and posts by itself once that date is open.",
      "A patient on a cheque is recorded by the Unite PIN only, never by name.",
    ],
  },
  {
    id: "accounting-statements",
    title: "Financial statements",
    pages: [
      "/accounting/reports/profit-and-loss",
      "/accounting/reports/balance-sheet",
      "/accounting/reports/cash-flow",
      "/accounting/reports/ratios",
      "/accounting/reports/exceptions",
      "/accounting/report-settings",
    ],
    purpose:
      "The profit and loss, balance sheet, cash flow, ratios and exception lists, all read from the posted ledger, with Excel and PDF downloads.",
    steps: [
      "Profit and loss: choose the dates; split the columns by month, branch, department or doctor, or compare with the previous period or the same period last year. Click a ledger to open its general ledger.",
      "Balance sheet: choose the date; this year's profit shows as a line in equity until the year-end close. It must balance; a difference is shown in red.",
      "Cash flow: net profit, non-cash items, working capital, investing and financing, reconciled to the cash and bank ledgers. Set a ledger's class under Chart of accounts, Reporting.",
      "Exceptions: look at these before closing a month (late postings, cash below zero, balances on the wrong side, suspense, large manual journals, missing branch or cost centre).",
      "Excel and PDF hold exactly what the page shows.",
    ],
    watchOut: [
      "Figures are Provisional until every month in the range is closed or locked under Periods.",
      "The adjustment period can be left out with the Adjustment period option, to see the books before audit adjustments.",
    ],
  },
  {
    id: "accounting-budgets",
    title: "Budgets",
    pages: ["/accounting/budgets", "/accounting/reports/budget-vs-actual"],
    purpose:
      "Monthly budgets per income and expense ledger, approved by a second person, and compared with the actuals.",
    steps: [
      "Press New budget, choose the fiscal year and name it.",
      "Type the amounts in the grid and save, or import a CSV (account_code, month as yyyy-mm, amount, and optionally branch_code and department).",
      "Someone else with the post permission (Finance Manager or Chief Accountant) opens it and presses Approve.",
      "Budget against actual: choose the budget, the months and optionally a branch or department. Lines worse than budget by more than the threshold are highlighted.",
    ],
    watchOut: [
      "An approved budget cannot change. Reopen it to edit; it then needs approving again.",
      "Importing a CSV replaces every line of the budget.",
    ],
  },
  {
    id: "accounting-tax",
    title: "VAT return and corporate tax bridge",
    pages: ["/accounting/reports/vat-return", "/accounting/reports/corporate-tax"],
    purpose:
      "Working papers for the tax adviser: the VAT 201 boxes from the tax codes on journal lines, and the bridge from accounting profit to taxable income.",
    steps: [
      "VAT return: pick the tax period. Click a box to see its supporting lines; fix the lines without a tax code before using the figures.",
      "Box 1 splits by the emirate of each line's branch; lines without a branch use the entity's default emirate and are flagged.",
      "VAT settings (tax permission): monthly or quarterly, the month a quarter starts in, and the default emirate.",
      "Corporate tax bridge: tag ledgers (entertainment, fines, donations, other non-deductible, connected persons) under Chart of accounts, Reporting; type any other adjustment on the page.",
    ],
    watchOut: [
      "Pulse never files a VAT or corporate tax return. Enter the reviewed figures in EmaraTax.",
      "Which services are zero-rated or standard-rated is the tax adviser's decision.",
    ],
  },
  {
    id: "accounting-tally-import",
    title: "Tally import",
    pages: ["/accounting/tally-import"],
    purpose:
      "Bring Tally's groups, ledgers, opening balances and the full voucher history into Pulse, matched on Tally's GUID so nothing is ever posted twice.",
    steps: [
      "In TallyPrime, export All Masters and the Day Book as XML (the steps are in the Phase 22I notes) and choose both files here together.",
      "Read the dry run: groups mapped onto Pulse's, new ledgers, the opening trial balance (it must net to zero), vouchers per month and type, and anything refused with its reason.",
      "Press Commit; long histories run in steps and the page keeps going until nothing is left. Importing again only posts what is new or altered in Tally.",
      "Then reconcile the import with Tally's trial balance on the Tally reconciliation page.",
    ],
    watchOut: [
      "Cancelled and optional vouchers are skipped; a voucher altered in Tally is reversed and posted again.",
      "The uploaded files are deleted right after they are read; only their fingerprint is kept.",
    ],
  },
  {
    id: "accounting-opening",
    title: "Opening balances",
    pages: ["/accounting/opening-balances"],
    purpose:
      "Type each account's balance at the opening date when the balances do not come from the Tally import.",
    steps: [
      "Choose the opening date (the day before the first period you will post in).",
      "Enter a debit or a credit for each account; the totals must balance.",
      "Submit for posting. Someone else with the post permission opens the journal and posts it.",
    ],
    watchOut: [
      "Control accounts take opening balances too. A second opening journal adds to the first.",
    ],
  },
  {
    id: "accounting-tally-reconciliation",
    title: "Tally reconciliation",
    pages: ["/accounting/tally-reconciliation"],
    purpose:
      "Prove the import: Pulse's trial balance against Tally's, ledger by ledger, at the import's last date.",
    steps: [
      "In Tally open the Trial Balance at the import's last date, show it detailed (ledgers, not only groups) and export it to Excel.",
      "Choose the import, the same date and the file, and press Compare.",
      "Every difference must be zero. Then lock the imported months if Tally stays the book of record for them.",
    ],
    watchOut: ["Locking is final: nothing can be posted into a locked month again."],
  },
  {
    id: "accounting-tally-bridge",
    title: "Tally bridge",
    pages: ["/accounting/tally-bridge"],
    purpose:
      "Keep TallyPrime in step with Pulse until the ledger start: Pulse's items go to Tally as vouchers and what is entered in Tally comes back into Pulse.",
    steps: [
      "Once: install the connector on the Tally PC as a Windows service, switch on Tally's XML server for this PC only, and create the Pulse voucher types in Tally (Pulse Journal, Pulse Payment, Pulse Receipt, Pulse Contra, Pulse Sales, Pulse Purchase, Pulse Credit Note, Pulse Debit Note) with manual numbering and Prevent duplicates. The Phase 22J notes have every step.",
      "An administrator switches the integration on under Settings, Integrations, Tally bridge (type CONNECT TALLY) and enters the Tally company name.",
      "Here, create a pairing code and type it into the connector on the Tally PC within 30 minutes.",
      "Choose the first date to send, what is sent (only what nobody enters in Tally by hand any more) and switch on push and pull. Start with pull only and check the trial balance card.",
      "Watch the Waiting list: an account without a Tally ledger, or a voucher Tally refused, waits with its reason. Fix it (in Posting rules or in Tally) and press Send again where offered.",
      "At the cut-over set the ledger start under Entities and fiscal years: pushing stops by itself. Switch pulling off once the last Tally adjustments are in, then revoke the connector.",
    ],
    watchOut: [
      "Every voucher carries a Pulse id: sending it again never makes a second one, and a changed item is reversed in Tally and sent again, never edited or deleted.",
      "Items dated before the push-from date are never sent. A Tally voucher dated on or after the ledger start is never copied into Pulse.",
      "Nothing in Tally is ever deleted by the bridge. A voucher deleted in Tally by hand is not noticed by the pull; it shows as drift in the trial balance check.",
    ],
  },
  {
    id: "accounting-year-end",
    title: "Year-end close",
    pages: ["/accounting/year-end"],
    purpose: "Move the year's income and expenses to retained earnings and close the fiscal year.",
    steps: [
      "Choose the year. Close its twelve months (the button does it), post or discard any drafts and close earlier years first.",
      "Press Close the year and type CLOSE: the closing journal goes into the year's adjustment period and the year refuses every posting afterwards.",
      "To correct a closed year, press Re-open with a reason: the closing journal is reversed. Close it again when done.",
    ],
    watchOut: [
      "After the close, the trial balance no longer shows earlier years' profit for that year: it is in retained earnings.",
    ],
  },
];

export const FALLBACK_GUIDE: Guide = {
  id: "general",
  title: "Using Pulse",
  pages: [],
  purpose: "A quick orientation for any page.",
  steps: [
    "Use the menu on the left (or the tabs at the bottom on a phone) to move around.",
    "Finance and Settings open in the menu: press the arrow beside them, or point at the icon when the menu is narrow.",
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
