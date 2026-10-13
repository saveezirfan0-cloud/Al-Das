/**
 * Permission catalogue. Keys are stable identifiers stored in roles.permissions.
 * A role may also hold '*' (everything) or a prefix wildcard like 'portal.*'.
 * Keep this file framework-free: it is shared by server, client and tests.
 */

export type PermissionKey = (typeof PERMISSIONS)[number]["key"];

export const PERMISSION_GROUPS = [
  "Inbox",
  "Contacts",
  "Enquiries & tasks",
  "Appointments",
  "Front desk",
  "Campaigns & templates",
  "Media & documents",
  "Flows",
  "Portal",
  "Clinical",
  "Reports",
  "AI & knowledge base",
  "Finance",
  "Settings",
  "Security & privacy",
] as const;

export type PermissionGroup = (typeof PERMISSION_GROUPS)[number];

export const PERMISSIONS = [
  {
    key: "inbox.view_all",
    group: "Inbox",
    label: "View all conversations",
    description: "See every conversation, not only assigned ones",
  },
  {
    key: "inbox.send",
    group: "Inbox",
    label: "Send messages",
    description: "Reply to patients in the inbox",
  },
  { key: "contacts.view", group: "Contacts", label: "View contacts" },
  { key: "contacts.manage", group: "Contacts", label: "Create and edit contacts" },
  {
    key: "contacts.export",
    group: "Contacts",
    label: "Export contacts",
    description: "Download contact data as CSV",
  },
  { key: "enquiries.view", group: "Enquiries & tasks", label: "View enquiries" },
  { key: "enquiries.manage", group: "Enquiries & tasks", label: "Create and move enquiries" },
  {
    key: "enquiries.export",
    group: "Enquiries & tasks",
    label: "Export enquiries",
    description: "Download enquiry data as CSV",
  },
  {
    key: "enquiries.delete",
    group: "Enquiries & tasks",
    label: "Delete enquiries",
    description: "Delete enquiries, singly or in bulk",
  },
  { key: "tasks.view", group: "Enquiries & tasks", label: "View tasks" },
  { key: "tasks.manage", group: "Enquiries & tasks", label: "Create and complete tasks" },
  { key: "appointments.view", group: "Appointments", label: "View appointments" },
  { key: "appointments.manage", group: "Appointments", label: "Book and change appointments" },
  {
    key: "frontdesk.use",
    group: "Front desk",
    label: "Use the Front desk workspace",
    description:
      "Today board and check-in, waitlist, walk-in registration, household links, end-of-day sheet and handover notes. Bookings, cancellations and messages still need their own permissions.",
  },
  { key: "campaigns.view", group: "Campaigns & templates", label: "View campaigns" },
  { key: "campaigns.create", group: "Campaigns & templates", label: "Create and send campaigns" },
  { key: "templates.manage", group: "Campaigns & templates", label: "Manage WhatsApp templates" },
  {
    key: "campaigns.ai",
    group: "Campaigns & templates",
    label: "Use the Campaign Copilot",
    description:
      "Describe an audience in words and get a validated filter with a count, and get English and Arabic template wording checked against Meta's rules (drafts only, nothing is sent). Also needs the Create and send campaigns permission.",
  },
  {
    key: "media.view",
    group: "Media & documents",
    label: "View the Media Library",
    description:
      "Browse the shared images, PDFs and videos, and pick them for templates, campaigns, quick replies and conversations",
  },
  {
    key: "media.manage",
    group: "Media & documents",
    label: "Upload and organise media",
    description:
      "Upload, rename, tag, move and delete shared library files (never patient documents)",
  },
  {
    key: "documents.view",
    group: "Media & documents",
    label: "View patient documents",
    description:
      "Open referral letters, lab reports, insurance cards and consent forms on a patient. Patient health data: not included in contacts.view.",
  },
  {
    key: "documents.manage",
    group: "Media & documents",
    label: "Upload and delete patient documents",
    description:
      "Add, edit, expire and delete a patient's documents, and see who has opened them. Give this to the front desk and care team only.",
  },
  { key: "flows.manage", group: "Flows", label: "Build and publish flows" },
  {
    key: "flows.ai",
    group: "Flows",
    label: "Use the Flow Copilot",
    description:
      "Describe a bot in words and get an unpublished draft flow, and dry-run a flow with sample messages. An AI draft can never be published until a person has reviewed it. Also needs the Build and publish flows permission.",
  },
  {
    key: "portal.*",
    group: "Portal",
    label: "All portal objects (read + write)",
    description: "Equivalent to portal.<object>.read and .write for every object",
  },
  { key: "portal.*.read", group: "Portal", label: "Read all portal objects" },
  {
    key: "portal.sync_review.write",
    group: "Portal",
    label: "Resolve Sync Review items",
    description: "Link, create or dismiss Unite patients that could not be matched",
  },
  {
    key: "portal.clinical_followups.read",
    group: "Clinical",
    label: "View the Follow-Up Queue",
    description:
      "Clinical follow-ups, feedback and the evaluations behind them (patient health data)",
  },
  {
    key: "portal.clinical_followups.write",
    group: "Clinical",
    label: "Work the Follow-Up Queue",
    description: "Update call outcomes, assign and close follow-ups",
  },
  {
    key: "portal.clinical_visits.read",
    group: "Clinical",
    label: "View clinical visits and prescriptions",
    description: "Vitals, notes and prescriptions synced from Unite (patient health data)",
  },
  {
    key: "portal.clinical_feedback.write",
    group: "Clinical",
    label: "Edit patient feedback records",
  },
  {
    key: "portal.prescription_sequences.write",
    group: "Clinical",
    label: "Edit medication sequences",
  },
  {
    key: "portal.medication_classes.write",
    group: "Clinical",
    label: "Classify medications",
    description: "Antibiotic / steroid / probiotic by Unite code",
  },
  {
    key: "clinical.settings.manage",
    group: "Clinical",
    label: "Sign off clinical settings",
    description:
      "Approve the thresholds the clinical rules use and switch patient-facing clinical messaging on. Give this to the clinical lead, not to everyone.",
  },
  { key: "reports.view", group: "Reports", label: "View reports and dashboards" },
  {
    key: "ads.view",
    group: "Reports",
    label: "View the ad attribution report",
    description:
      "Which Meta ads brought WhatsApp conversations, enquiries and bookings (counts per ad only; no patient is named). Needs the Meta ad attribution integration to be switched on.",
  },
  {
    key: "reports.export",
    group: "Reports",
    label: "Export reports",
    description: "Download report data as CSV",
  },
  {
    key: "ai.use",
    group: "AI & knowledge base",
    label: "Use AI assist in the inbox",
    description: "Summarize, suggest replies and rewrite drafts (drafts only, never auto-sent)",
  },
  {
    key: "ai.insights.view",
    group: "AI & knowledge base",
    label: "View the AI reply-quality report",
    description:
      "The weekly report of AI suggestions accepted, edited and rejected, and the topics patients ask about that the knowledge base does not cover (counts and topics only, no message text)",
  },
  {
    key: "kb.manage",
    group: "AI & knowledge base",
    label: "Manage the knowledge base",
    description: "Add, re-crawl and remove knowledge sources and groups",
  },
  {
    key: "finance.view",
    group: "Finance",
    label: "View finance reports",
    description: "Monthly summary and aggregate finance views (no individual invoices)",
  },
  {
    key: "finance.invoices.view",
    group: "Finance",
    label: "View invoices",
    description: "Invoices, lines, payments and billing exceptions",
  },
  {
    key: "finance.claims.view",
    group: "Finance",
    label: "View insurance claims",
    description: "Claim activities, their history and insurance exceptions",
  },
  {
    key: "finance.claims.import",
    group: "Finance",
    label: "Upload Diligence claim files",
  },
  {
    key: "finance.exceptions.manage",
    group: "Finance",
    label: "Work exceptions",
    description: "Assign, comment on and close finance exceptions you own",
  },
  {
    key: "finance.reference.manage",
    group: "Finance",
    label: "Edit finance reference data",
    description: "Branch map, doctor departments, service categories, rule thresholds",
  },
  {
    key: "finance.capture.manage",
    group: "Finance",
    label: "Data health and capture",
    description: "See capture health, raw batches and admin exceptions",
  },
  {
    key: "finance.preauth.manage",
    group: "Finance",
    label: "Pre-authorisation tracker",
    description: "Record pre-authorisation requests and decisions, and track their expiry",
  },
  {
    key: "finance.eligibility.manage",
    group: "Finance",
    label: "Eligibility checks",
    description: "Record cover checks and see which insurance invoices are not ready to bill",
  },
  {
    key: "finance.denials.manage",
    group: "Finance",
    label: "Denial management",
    description:
      "Work denied claims, keep notes and draft appeal letters (drafts only, never sent by Pulse)",
  },
  {
    key: "finance.remittance.manage",
    group: "Finance",
    label: "Remittance reconciliation",
    description: "Upload payer payment advice, match it to claims and review short payments",
  },
  {
    key: "finance.scorecards.view",
    group: "Finance",
    label: "Payer scorecards",
    description: "Denial rate, days to pay and top denial reasons by payer, doctor and department",
  },
  {
    key: "finance.forecast.view",
    group: "Finance",
    label: "Collections forecast",
    description: "Expected cash by week from the receivables ageing and each payer's history",
  },
  {
    key: "finance.recovery.manage",
    group: "Finance",
    label: "Self-pay recovery reminders",
    description:
      "See overdue self-pay balances and run the WhatsApp reminders (opt-in, approved template only)",
  },
  {
    key: "finance.recovery.approve",
    group: "Finance",
    label: "Approve the tone of recovery reminders",
    description:
      "Review and approve the wording of the template used for self-pay reminders before they can be switched on",
  },
  {
    key: "finance.close.view",
    group: "Finance",
    label: "View month-end close packs",
    description: "Read and download the month-end close pack",
  },
  {
    key: "finance.close.manage",
    group: "Finance",
    label: "Prepare the month-end close",
    description: "Build the close pack for a finished month and withdraw a finance sign-off",
  },
  {
    key: "finance.close.signoff.finance",
    group: "Finance",
    label: "Sign off the close for Finance",
    description: "First of the two sign-offs that lock a month",
  },
  {
    key: "finance.close.signoff.ceo",
    group: "Finance",
    label: "Sign off the close as CEO",
    description:
      "Second sign-off. Locks the month for good; it must be a different person from the finance sign-off",
  },
  {
    key: "finance.cashup.manage",
    group: "Finance",
    label: "End-of-day cash-up",
    description: "Count each branch's takings by payment mode and submit the cash-up",
  },
  {
    key: "finance.revenue.view",
    group: "Finance",
    label: "Revenue views",
    description: "Revenue by doctor, department, branch and service",
  },
  {
    key: "finance.export.run",
    group: "Finance",
    label: "Accounting export",
    description: "Download the one-way accounting journal (CSV) and map accounts",
  },
  {
    key: "finance.payment_links",
    group: "Finance",
    label: "Send payment links",
    description:
      "Ask a patient to pay an invoice by sending a payment link in WhatsApp, and see the status the payment gateway reports. Pulse never marks the invoice as paid in Unite.",
  },
  {
    key: "finance.costs.manage",
    group: "Finance",
    label: "Maintain service costs and overheads",
    description:
      "Upload and edit the service cost table and overhead pools. Does not include revenue detail, profit or doctor compensation.",
  },
  {
    key: "finance.costs.view",
    group: "Finance",
    label: "View service costs and overheads",
    description:
      "Read the cost inputs. Does not include doctor compensation, revenue detail or profit.",
  },
  {
    key: "finance.costs.compensation",
    group: "Finance",
    label: "Doctor compensation",
    description:
      "See and upload doctor compensation. Held separately because it is confidential; grant it only to named people.",
  },
  {
    key: "finance.profit.view",
    group: "Finance",
    label: "Profitability",
    description:
      "See contribution margin and estimated profitability by branch, doctor, department and month. Figures are provisional until Finance approves a month.",
  },
  {
    key: "finance.profit.approve",
    group: "Finance",
    label: "Approve a cost month",
    description:
      "Approve a month's costs so its profit figures stop being provisional, or reopen it. Audited.",
  },
  {
    key: "finance.followup.manage",
    group: "Finance",
    label: "Work insurance follow-ups",
    description:
      "Record what was done about an unpaid insurance claim (payer contacted, payment promised, resubmitted, disputed, write-off proposed) and the next action date. Reading the follow-up list and the receivables report needs View insurance claims. Audited.",
  },
  {
    key: "finance.changes.view",
    group: "Finance",
    label: "View the invoice-change register",
    description:
      "Read the Unite invoice changes Pulse has seen (discounts, cancellations, credit notes, write-offs, reduced amounts, refunds), their review and the unapproved-changes measure, and download them as CSV.",
  },
  {
    key: "finance.changes.review",
    group: "Finance",
    label: "Review invoice changes",
    description:
      "Approve, reject or explain a Unite invoice change with a reason, and bulk-approve small ones up to the amount Finance sets. Needs View the invoice-change register to open the page. Audited.",
  },
  {
    key: "finance.flash.view",
    group: "Finance",
    label: "Daily flash report",
    description:
      "Daily financial summary, month to date and daily sales by branch against target, with doctor rankings",
  },
  {
    key: "finance.targets.manage",
    group: "Finance",
    label: "Revenue targets and reporting lines",
    description:
      "Set the daily revenue, patient and ARPP targets and the reporting lines (branches, Chiro, leased units) used by the flash report. Audited.",
  },
  {
    key: "portal.recall_sends.write",
    group: "Portal",
    label: "Edit recall call-list entries",
    description: "Update follow-up status and booking details on recall sends",
  },
  {
    key: "settings.manage",
    group: "Settings",
    label: "Manage settings, users, roles and teams",
    description: "Full administrative access to Settings and System health",
  },
  {
    key: "integrations.manage",
    group: "Settings",
    label: "Manage integrations",
    description:
      "Store provider credentials, switch integrations on or off (SMS fallback, payment links, calendar feeds) and see their health. Switching on anything that messages patients or takes money needs a typed confirmation. Give this to the administrator only.",
  },
  {
    key: "integrations.calendar",
    group: "Settings",
    label: "Manage doctor calendar feeds",
    description:
      "Create, rotate and revoke the private calendar links for doctors (times and clinic location only, never patient details). The integration itself is switched on by an administrator.",
  },
  {
    key: "security.manage",
    group: "Security & privacy",
    label: "Manage security and access",
    description:
      "Two-step verification rules, access reviews, off-boarding, retention and alert settings. Give this to the administrator who owns access control.",
  },
  {
    key: "privacy.manage",
    group: "Security & privacy",
    label: "Patient data export and erasure",
    description:
      "Raise, approve and carry out patient data export and erasure requests (two people are always required). Give this to the data-protection owner only.",
  },
] as const satisfies ReadonlyArray<{
  key: string;
  group: PermissionGroup;
  label: string;
  description?: string;
}>;

export const PERMISSION_KEYS: ReadonlyArray<string> = PERMISSIONS.map((p) => p.key);

export type RolePreset = {
  name: string;
  description: string;
  permissions: string[];
};

/**
 * Finance & Insurance presets. Also applied to existing orgs with
 * `pnpm finance:seed` (calls the seed_finance_roles RPC). Admin (`*`) already
 * covers everything and is not repeated here.
 */
export const FINANCE_ROLES: readonly RolePreset[] = [
  {
    name: "Finance",
    description: "Finance reports, invoices and reference data. Sees all finance aggregates.",
    permissions: [
      "reports.view",
      "finance.view",
      "finance.invoices.view",
      "finance.claims.view",
      "finance.reference.manage",
      "finance.preauth.manage",
      "finance.denials.manage",
      "finance.remittance.manage",
      "finance.scorecards.view",
      "finance.forecast.view",
      "finance.recovery.manage",
      "finance.recovery.approve",
      "finance.payment_links",
      "finance.close.view",
      "finance.close.manage",
      "finance.close.signoff.finance",
      "finance.cashup.manage",
      "finance.revenue.view",
      "finance.export.run",
      "finance.costs.manage",
      "finance.costs.view",
      "finance.costs.compensation",
      "finance.profit.view",
      "finance.profit.approve",
      "finance.flash.view",
      "finance.targets.manage",
      "finance.followup.manage",
      "finance.changes.view",
      "finance.changes.review",
    ],
  },
  {
    name: "Billing",
    description:
      "Invoices, lines and payments, the billing exception queue, eligibility checks and cash-up.",
    permissions: [
      "finance.invoices.view",
      "finance.exceptions.manage",
      "finance.eligibility.manage",
      "finance.cashup.manage",
      "finance.recovery.manage",
      "finance.payment_links",
    ],
  },
  {
    name: "Insurance",
    description:
      "Uploads Diligence claim files, works the insurance exception queue, pre-authorisations, eligibility, denials, remittance and the follow-up of unpaid claims.",
    permissions: [
      "finance.claims.view",
      "finance.claims.import",
      "finance.exceptions.manage",
      "finance.preauth.manage",
      "finance.eligibility.manage",
      "finance.denials.manage",
      "finance.remittance.manage",
      "finance.scorecards.view",
      "finance.followup.manage",
    ],
  },
  {
    name: "CEO",
    description:
      "Read-only view of every finance report and dashboard, plus the CEO sign-off that locks a month.",
    permissions: [
      "reports.view",
      "finance.view",
      "finance.invoices.view",
      "finance.claims.view",
      "finance.scorecards.view",
      "finance.forecast.view",
      "finance.revenue.view",
      "finance.close.view",
      "finance.close.signoff.ceo",
      "finance.profit.view",
      "finance.flash.view",
      "finance.changes.view",
    ],
  },
  {
    name: "Medical Director",
    description: "Read-only finance reports (doctor and department revenue, denials, scorecards).",
    permissions: [
      "reports.view",
      "finance.view",
      "finance.scorecards.view",
      "finance.revenue.view",
      "finance.flash.view",
    ],
  },
  {
    name: "Cost / Payroll",
    description:
      "Service costs, overheads and (when authorised) doctor compensation. No access to revenue detail or the consolidated P&L.",
    permissions: ["finance.costs.manage", "finance.costs.view", "finance.costs.compensation"],
  },
  {
    name: "Operations",
    description:
      "Owns Unite invoice changes: reviews discounts, cancellations, credit notes, write-offs and refunds in the invoice-change register.",
    permissions: ["finance.changes.view", "finance.changes.review"],
  },
];

/** Seed roles created with every org (is_system = true). Admin must keep '*'. */
export const SYSTEM_ROLES: readonly RolePreset[] = [
  {
    name: "Admin",
    description: "Full access to everything, including settings and system health.",
    permissions: ["*"],
  },
  {
    name: "Manager",
    description:
      "Runs the clinic day to day: all operational modules and reports, no user/role management.",
    permissions: [
      "inbox.view_all",
      "inbox.send",
      "contacts.view",
      "contacts.manage",
      "contacts.export",
      "enquiries.view",
      "enquiries.manage",
      "enquiries.export",
      "enquiries.delete",
      "tasks.view",
      "tasks.manage",
      "appointments.view",
      "appointments.manage",
      "frontdesk.use",
      "campaigns.view",
      "campaigns.create",
      "templates.manage",
      "media.view",
      "media.manage",
      "documents.view",
      "documents.manage",
      "flows.manage",
      "flows.ai",
      "campaigns.ai",
      "portal.*",
      "reports.view",
      "reports.export",
      "ads.view",
      "ai.use",
      "ai.insights.view",
      "kb.manage",
      "integrations.calendar",
    ],
  },
  {
    name: "Agent",
    description: "Handles patient conversations, enquiries and tasks.",
    permissions: [
      "inbox.send",
      "contacts.view",
      "contacts.manage",
      "enquiries.view",
      "enquiries.manage",
      "tasks.view",
      "tasks.manage",
      "appointments.view",
      "media.view",
      "portal.*.read",
      "ai.use",
    ],
  },
  {
    name: "Receptionist",
    description: "Front desk: bookings, patient details and walk-in enquiries.",
    permissions: [
      "inbox.send",
      "contacts.view",
      "contacts.manage",
      "enquiries.view",
      "enquiries.manage",
      "tasks.view",
      "tasks.manage",
      "appointments.view",
      "appointments.manage",
      "frontdesk.use",
      "media.view",
      "documents.view",
      "documents.manage",
      "portal.*.read",
      "ai.use",
    ],
  },
  {
    name: "Care coordinator",
    description:
      "Works the clinical Follow-Up Queue and patient conversations. Cannot sign off clinical settings.",
    permissions: [
      "inbox.send",
      "contacts.view",
      "contacts.manage",
      "tasks.manage",
      "appointments.view",
      "appointments.manage",
      "media.view",
      "documents.view",
      "documents.manage",
      "portal.*",
    ],
  },
  {
    name: "Marketing",
    description: "Campaigns, templates, flows and reporting.",
    permissions: [
      "inbox.view_all",
      "contacts.view",
      "contacts.export",
      "campaigns.view",
      "campaigns.create",
      "templates.manage",
      "media.view",
      "media.manage",
      "flows.manage",
      "flows.ai",
      "campaigns.ai",
      "reports.view",
      "ads.view",
    ],
  },
  ...FINANCE_ROLES,
];

/**
 * Does a granted permission string cover the requested one?
 *  - '*' covers everything
 *  - exact match
 *  - 'portal.*' covers 'portal.claims.read' (any depth)
 *  - 'portal.*.read' covers 'portal.claims.read' (one segment wildcard)
 */
export function permissionMatches(granted: string, requested: string): boolean {
  if (granted === "*" || granted === requested) return true;
  const g = granted.split(".");
  const r = requested.split(".");
  for (let i = 0; i < g.length; i++) {
    if (g[i] === "*") {
      if (i === g.length - 1) return r.length >= g.length; // trailing wildcard: any depth
      if (r[i] === undefined) return false;
      continue;
    }
    if (g[i] !== r[i]) return false;
  }
  return g.length === r.length;
}

/** Per-object portal keys a role may hold: portal.<object>.read | portal.<object>.write. */
export const PORTAL_OBJECT_PERMISSION_RE = /^portal\.[a-z][a-z0-9_]{0,48}\.(read|write)$/;

/**
 * Is this a key a role may hold? Catalogue keys, '*', and the per-object portal keys
 * (portal.<object>.read | portal.<object>.write) generated from the portal registry.
 */
export function isAssignablePermission(key: string): boolean {
  return key === "*" || PERMISSION_KEYS.includes(key) || PORTAL_OBJECT_PERMISSION_RE.test(key);
}
