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
  "Campaigns & templates",
  "Flows",
  "Portal",
  "Clinical",
  "Reports",
  "AI & knowledge base",
  "Finance",
  "Settings",
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
  { key: "campaigns.view", group: "Campaigns & templates", label: "View campaigns" },
  { key: "campaigns.create", group: "Campaigns & templates", label: "Create and send campaigns" },
  { key: "templates.manage", group: "Campaigns & templates", label: "Manage WhatsApp templates" },
  { key: "flows.manage", group: "Flows", label: "Build and publish flows" },
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
    key: "settings.manage",
    group: "Settings",
    label: "Manage settings, users, roles and teams",
    description: "Full administrative access to Settings and System health",
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
    ],
  },
  {
    name: "Billing",
    description: "Invoices, lines and payments, and the billing exception queue.",
    permissions: ["finance.invoices.view", "finance.exceptions.manage"],
  },
  {
    name: "Insurance",
    description: "Uploads Diligence claim files and works the insurance exception queue.",
    permissions: ["finance.claims.view", "finance.claims.import", "finance.exceptions.manage"],
  },
  {
    name: "CEO",
    description: "Read-only view of every finance report and dashboard.",
    permissions: ["reports.view", "finance.view", "finance.invoices.view", "finance.claims.view"],
  },
  {
    name: "Medical Director",
    description: "Read-only finance reports (doctor and department revenue, denials).",
    permissions: ["reports.view", "finance.view"],
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
      "campaigns.view",
      "campaigns.create",
      "templates.manage",
      "flows.manage",
      "portal.*",
      "reports.view",
      "reports.export",
      "ai.use",
      "kb.manage",
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
      "flows.manage",
      "reports.view",
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
