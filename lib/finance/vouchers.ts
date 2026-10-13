/**
 * Payment vouchers and zero-paper approvals (Phase 20D, pure; unit-tested). The database enforces the same rules in
 * fin_voucher_act / fin_voucher_rule / fin_voucher_canonical (migration 20261024000100); this file mirrors them so pages
 * can say what will happen before anyone clicks, and the two are parity-tested against
 * tests/unit/finance/fixtures/phase20d-vouchers.synthetic.json.
 *
 * Roles (CEO directive "Zero Paper. Full Accountability"): the maker prepares and submits with the backup attached, the
 * Finance Manager verifies (checker), a department head approves Tier 2, the CEO authorises Tier 3, Tier 4 and every
 * special category. Every step is a different person, approvals are bound to the content hash, rejections need remarks.
 */

export const VOUCHER_STATUSES = [
  "draft",
  "submitted",
  "checked",
  "dept_approved",
  "approved",
  "for_tally",
  "paid",
  "rejected",
  "cancelled",
] as const;
export type VoucherStatus = (typeof VOUCHER_STATUSES)[number];

export const SPECIAL_CATEGORIES = ["none", "payroll", "intercompany", "related_party"] as const;
export type SpecialCategory = (typeof SPECIAL_CATEGORIES)[number];

export const PAYMENT_METHODS = ["bank_transfer", "cheque", "card", "cash"] as const;
export type PaymentMethod = (typeof PAYMENT_METHODS)[number];

export const VOUCHER_ACTIONS = [
  "submit",
  "check",
  "approve_dept",
  "approve_ceo",
  "reject",
  "reopen",
  "cancel",
  "pay",
] as const;
export type VoucherAction = (typeof VOUCHER_ACTIONS)[number];

export const STATUS_LABEL: Record<VoucherStatus, string> = {
  draft: "Draft",
  submitted: "Waiting for the Finance Manager",
  checked: "Verified, waiting for approval",
  dept_approved: "Department head approved, waiting for the CEO",
  approved: "Approved",
  for_tally: "Sent to Tally for authorisation",
  paid: "Paid",
  rejected: "Rejected",
  cancelled: "Cancelled",
};

export const SPECIAL_LABEL: Record<SpecialCategory, string> = {
  none: "None",
  payroll: "Payroll",
  intercompany: "Intercompany transfer",
  related_party: "Related party",
};

export const METHOD_LABEL: Record<PaymentMethod, string> = {
  bank_transfer: "Bank transfer",
  cheque: "Cheque",
  card: "Card",
  cash: "Cash",
};

/** Who may open the vouchers page, a voucher, its documents and its certificate. */
export const VOUCHER_READ_PERMS = [
  "finance.payables.view",
  "finance.vouchers.prepare",
  "finance.vouchers.check",
  "finance.vouchers.approve_dept",
  "finance.vouchers.approve_ceo",
  "finance.vouchers.pay",
] as const;

/** The permission each action needs (the reject permission depends on the stage; see rejectPermission). */
export const ACTION_PERMISSION: Record<Exclude<VoucherAction, "reject">, string> = {
  submit: "finance.vouchers.prepare",
  check: "finance.vouchers.check",
  approve_dept: "finance.vouchers.approve_dept",
  approve_ceo: "finance.vouchers.approve_ceo",
  reopen: "finance.vouchers.prepare",
  cancel: "finance.vouchers.prepare",
  pay: "finance.vouchers.pay",
};

/** Error codes the database puts in the HINT, and the sentence a person sees for each. */
export const VOUCHER_ERRORS = {
  not_found: "Voucher not found.",
  month_locked: "The month of this voucher is locked.",
  not_permitted: "You cannot take this step.",
  wrong_status: "The voucher is not at that step any more. Reload the page.",
  same_person:
    "Each step must be a different person: makers cannot verify or approve their own voucher.",
  hash_mismatch: "The voucher changed since you opened it. Reload it and review it again.",
  remarks_required: "Remarks are required (at least 3 characters).",
  no_attachment: "Attach the supporting document first: the backup travels with the voucher.",
  attachment_blocked: "An attachment was blocked by the malware scan.",
  no_rule:
    "No approval rule covers this amount or category. Fix the delegation of authority under Voucher settings.",
  payment_details_required: "Enter the payment date and the bank reference.",
  bulk_not_allowed: "Only Tier 1 vouchers can be verified in bulk.",
  invoice_unavailable: "An invoice is not available (already on another voucher, paid or void).",
  document_unavailable: "An attachment is not available.",
  exported: "This voucher was exported to Tally and cannot change.",
  stale_export: "Something changed while the file was built. Build it again.",
  invalid: "Check the form and try again.",
  unknown_action: "Unknown action.",
} as const;
export type VoucherErrorCode = keyof typeof VOUCHER_ERRORS;

export function voucherErrorMessage(hint: string | null | undefined, fallback: string): string {
  return hint && hint in VOUCHER_ERRORS ? VOUCHER_ERRORS[hint as VoucherErrorCode] : fallback;
}

// ---------------------------------------------------------------------------------------------------------------------
// Delegation of authority
// ---------------------------------------------------------------------------------------------------------------------

export type ApprovalTier = {
  code: string;
  label: string;
  specialCategory: Exclude<SpecialCategory, "none"> | null;
  minAmount: number | null;
  maxAmount: number | null;
  needsDeptHead: boolean;
  needsCeo: boolean;
  bulkAllowed: boolean;
  active: boolean;
  description?: string | null;
  sortOrder?: number;
};

export type RequiredApprovals = {
  tier: string;
  label: string;
  /** The Finance Manager always verifies. */
  needsCheck: true;
  needsDept: boolean;
  needsCeo: boolean;
  bulkAllowed: boolean;
};

const cents = (n: number) => Math.round(n * 100);

/**
 * Which approvals a voucher needs. A special category uses its own rule at any amount; otherwise the amount band
 * (min and max inclusive). Fails closed: no rule, or more than one, gives null (the voucher cannot be submitted).
 */
export function requiredApprovals(
  amount: number,
  special: SpecialCategory,
  tiers: readonly ApprovalTier[],
): RequiredApprovals | null {
  const active = tiers.filter((t) => t.active);
  const matches =
    special !== "none"
      ? active.filter((t) => t.specialCategory === special)
      : active.filter(
          (t) =>
            t.specialCategory === null &&
            t.minAmount !== null &&
            cents(t.minAmount) <= cents(amount) &&
            (t.maxAmount === null || cents(amount) <= cents(t.maxAmount)),
        );
  if (matches.length !== 1) return null;
  const t = matches[0];
  return {
    tier: t.code,
    label: t.label,
    needsCheck: true,
    needsDept: t.needsDeptHead,
    needsCeo: t.needsCeo,
    bulkAllowed: t.bulkAllowed,
  };
}

/** Problems with a set of tiers that would make routing fail closed (shown on the settings page). */
export function tierProblems(tiers: readonly ApprovalTier[]): string[] {
  const out: string[] = [];
  const bands = tiers
    .filter((t) => t.active && t.specialCategory === null && t.minAmount !== null)
    .sort((a, b) => (a.minAmount ?? 0) - (b.minAmount ?? 0));
  if (bands.length === 0) out.push("No active amount band: no voucher can be submitted.");
  else {
    if (cents(bands[0].minAmount ?? 0) > 1)
      out.push(`Amounts below ${bands[0].minAmount} are not covered.`);
    for (let i = 1; i < bands.length; i++) {
      const prev = bands[i - 1];
      const cur = bands[i];
      if (prev.maxAmount === null) {
        out.push(
          `${prev.code} has no upper limit but ${cur.code} starts after it: amounts would match twice.`,
        );
        continue;
      }
      const gap = cents(cur.minAmount ?? 0) - cents(prev.maxAmount);
      if (gap > 1)
        out.push(`Amounts between ${prev.maxAmount} and ${cur.minAmount} are not covered.`);
      if (gap < 1)
        out.push(`${prev.code} and ${cur.code} overlap: such amounts cannot be submitted.`);
    }
    if (bands[bands.length - 1].maxAmount !== null)
      out.push(`Amounts above ${bands[bands.length - 1].maxAmount} are not covered.`);
  }
  for (const sp of SPECIAL_CATEGORIES.filter((s) => s !== "none")) {
    const n = tiers.filter((t) => t.active && t.specialCategory === sp).length;
    if (n === 0)
      out.push(
        `No active rule for ${SPECIAL_LABEL[sp].toLowerCase()}: such vouchers cannot be submitted.`,
      );
  }
  for (const t of tiers)
    if (t.active && t.specialCategory !== null && !t.needsCeo)
      out.push(`${t.code}: the directive says special categories always go to the CEO.`);
  return out;
}

// ---------------------------------------------------------------------------------------------------------------------
// The state machine (mirror of fin_voucher_act; same order of checks)
// ---------------------------------------------------------------------------------------------------------------------

export type VoucherMachineState = {
  status: VoucherStatus;
  route: "pulse" | "tally" | null;
  needsDept: boolean;
  needsCeo: boolean;
  bulkAllowed: boolean;
  tier: string | null;
  /** Everyone who created, edited, submitted or reopened the voucher. */
  makers: readonly string[];
  checkedBy: string | null;
  deptBy: string | null;
  ceoBy: string | null;
  /** The hash stored at submission (null in draft). */
  contentHash: string | null;
  /** The hash of the voucher as it is now (recomputed by the database at every step). */
  currentHash: string;
  locked: boolean;
  exported: boolean;
  documents: number;
  blockedDocuments: number;
};

export type VoucherContext = {
  actor: string;
  /** Does the actor hold this permission? */
  can: (permission: string) => boolean;
  hash?: string | null;
  remarks?: string | null;
  approvalMode: "pulse" | "tally";
  /** requiredApprovals() for the voucher as it is now (used by submit). */
  rule: RequiredApprovals | null;
  /** True when the payment date falls in a locked month. */
  paymentLocked?: boolean;
  payment?: { date: string | null; reference: string | null } | null;
};

export type TransitionResult =
  { ok: true; state: VoucherMachineState } | { ok: false; code: VoucherErrorCode };

const remarksOk = (r: string | null | undefined) => (r ?? "").trim().length >= 3;

/** Which permission rejecting a voucher at its current stage needs (null when it cannot be rejected). */
export function rejectPermission(
  s: Pick<VoucherMachineState, "status" | "needsDept">,
): string | null {
  if (s.status === "submitted") return "finance.vouchers.check";
  if (s.status === "checked")
    return s.needsDept ? "finance.vouchers.approve_dept" : "finance.vouchers.approve_ceo";
  if (s.status === "dept_approved") return "finance.vouchers.approve_ceo";
  return null;
}

export function voucherTransition(
  s: VoucherMachineState,
  action: VoucherAction,
  ctx: VoucherContext,
): TransitionResult {
  const fail = (code: VoucherErrorCode): TransitionResult => ({ ok: false, code });
  const ok = (patch: Partial<VoucherMachineState>): TransitionResult => ({
    ok: true,
    state: { ...s, ...patch },
  });
  if (s.locked) return fail("month_locked");
  const isMaker = s.makers.includes(ctx.actor);
  const hashOk = ctx.hash === s.contentHash && s.currentHash === s.contentHash;

  switch (action) {
    case "submit": {
      if (!ctx.can(ACTION_PERMISSION.submit)) return fail("not_permitted");
      if (s.status !== "draft" && s.status !== "rejected") return fail("wrong_status");
      if (s.documents === 0) return fail("no_attachment");
      if (s.blockedDocuments > 0) return fail("attachment_blocked");
      const makers = s.makers.includes(ctx.actor) ? s.makers : [...s.makers, ctx.actor];
      if (ctx.approvalMode === "tally")
        return ok({
          status: "for_tally",
          route: "tally",
          tier: null,
          needsDept: false,
          needsCeo: false,
          bulkAllowed: false,
          contentHash: s.currentHash,
          makers,
        });
      if (!ctx.rule) return fail("no_rule");
      return ok({
        status: "submitted",
        route: "pulse",
        tier: ctx.rule.tier,
        needsDept: ctx.rule.needsDept,
        needsCeo: ctx.rule.needsCeo,
        bulkAllowed: ctx.rule.bulkAllowed,
        contentHash: s.currentHash,
        makers,
      });
    }
    case "check": {
      if (!ctx.can(ACTION_PERMISSION.check)) return fail("not_permitted");
      if (s.status !== "submitted") return fail("wrong_status");
      if (isMaker) return fail("same_person");
      if (!hashOk) return fail("hash_mismatch");
      return ok({
        status: s.needsDept || s.needsCeo ? "checked" : "approved",
        checkedBy: ctx.actor,
      });
    }
    case "approve_dept": {
      if (!ctx.can(ACTION_PERMISSION.approve_dept)) return fail("not_permitted");
      if (s.status !== "checked" || !s.needsDept) return fail("wrong_status");
      if (isMaker || ctx.actor === s.checkedBy) return fail("same_person");
      if (!hashOk) return fail("hash_mismatch");
      return ok({ status: s.needsCeo ? "dept_approved" : "approved", deptBy: ctx.actor });
    }
    case "approve_ceo": {
      if (!ctx.can(ACTION_PERMISSION.approve_ceo)) return fail("not_permitted");
      if (!s.needsCeo || s.status !== (s.needsDept ? "dept_approved" : "checked"))
        return fail("wrong_status");
      if (isMaker || ctx.actor === s.checkedBy || ctx.actor === s.deptBy)
        return fail("same_person");
      if (!hashOk) return fail("hash_mismatch");
      return ok({ status: "approved", ceoBy: ctx.actor });
    }
    case "reject": {
      const perm = rejectPermission(s);
      if (!perm) return fail("wrong_status");
      if (!ctx.can(perm)) return fail("not_permitted");
      if (!remarksOk(ctx.remarks)) return fail("remarks_required");
      if (isMaker) return fail("same_person");
      return ok({ status: "rejected", checkedBy: null, deptBy: null, ceoBy: null });
    }
    case "reopen": {
      if (!ctx.can(ACTION_PERMISSION.reopen)) return fail("not_permitted");
      if (s.status !== "rejected") return fail("wrong_status");
      return ok({
        status: "draft",
        route: null,
        tier: null,
        needsDept: false,
        needsCeo: false,
        bulkAllowed: false,
        contentHash: null,
        makers: s.makers.includes(ctx.actor) ? s.makers : [...s.makers, ctx.actor],
      });
    }
    case "cancel": {
      if (!ctx.can(ACTION_PERMISSION.cancel)) return fail("not_permitted");
      if (!["draft", "rejected", "for_tally"].includes(s.status) || s.exported)
        return fail("wrong_status");
      if (!remarksOk(ctx.remarks)) return fail("remarks_required");
      return ok({ status: "cancelled" });
    }
    case "pay": {
      if (!ctx.can(ACTION_PERMISSION.pay)) return fail("not_permitted");
      if (s.status !== "approved" && s.status !== "for_tally") return fail("wrong_status");
      const ref = (ctx.payment?.reference ?? "").trim();
      if (!ctx.payment?.date || ref === "" || ref.length > 60)
        return fail("payment_details_required");
      if (!hashOk) return fail("hash_mismatch");
      if (ctx.paymentLocked) return fail("month_locked");
      return ok({ status: "paid" });
    }
  }
}

/**
 * What saving an edit does to the machine state (mirror of fin_voucher_save on an existing voucher): back to draft,
 * approvals and the stored hash cleared, the editor becomes a maker. Refused for paid, cancelled or exported vouchers.
 */
export function voucherEdited(
  s: VoucherMachineState,
  actor: string,
  newHash: string,
): TransitionResult {
  if (s.locked) return { ok: false, code: "month_locked" };
  if (s.status === "paid" || s.status === "cancelled" || s.exported)
    return { ok: false, code: "wrong_status" };
  return {
    ok: true,
    state: {
      ...s,
      status: "draft",
      route: null,
      tier: null,
      needsDept: false,
      needsCeo: false,
      bulkAllowed: false,
      contentHash: null,
      currentHash: newHash,
      checkedBy: null,
      deptBy: null,
      ceoBy: null,
      makers: s.makers.includes(actor) ? s.makers : [...s.makers, actor],
    },
  };
}

/** The next step a voucher waits for, and the permission that takes it (for queues, tabs and notifications). */
export function waitingFor(s: Pick<VoucherMachineState, "status" | "needsDept" | "needsCeo">): {
  step: "check" | "approve_dept" | "approve_ceo" | "pay" | null;
  permission: string | null;
} {
  if (s.status === "submitted") return { step: "check", permission: ACTION_PERMISSION.check };
  if (s.status === "checked" && s.needsDept)
    return { step: "approve_dept", permission: ACTION_PERMISSION.approve_dept };
  if ((s.status === "checked" && !s.needsDept && s.needsCeo) || s.status === "dept_approved")
    return { step: "approve_ceo", permission: ACTION_PERMISSION.approve_ceo };
  if (s.status === "approved" || s.status === "for_tally")
    return { step: "pay", permission: ACTION_PERMISSION.pay };
  return { step: null, permission: null };
}

// ---------------------------------------------------------------------------------------------------------------------
// Numbering and labels (the content hash is in voucher-hash.ts, which needs node:crypto and stays on the server)
// ---------------------------------------------------------------------------------------------------------------------

/** PV-2026-0001; more than 9,999 in a year simply grows (PV-2026-10000). */
export function formatVoucherNumber(year: number, n: number): string {
  if (!Number.isInteger(year) || !Number.isInteger(n) || n < 1)
    throw new Error("invalid voucher number");
  return `PV-${year}-${String(n).padStart(4, "0")}`;
}

export const VOUCHER_NO_RE = /^PV-\d{4}-\d{4,}$/;

// ---------------------------------------------------------------------------------------------------------------------
// Status and exception reports
// ---------------------------------------------------------------------------------------------------------------------

export type VoucherReportRow = {
  id: string;
  voucherNo: string;
  voucherDate: string;
  payeeName: string;
  supplierId: string | null;
  amount: number;
  status: VoucherStatus;
  special: SpecialCategory;
  tier: string | null;
  submittedAt: string | null;
  approvedAt: string | null;
  rejectedAt: string | null;
  rejectionRemarks: string | null;
  /** Sum of the linked supplier invoices' totals (null when none are linked). */
  invoicesTotal: number | null;
};

export type ReportSettings = {
  duplicateWindowDays: number;
  mismatchTolerance: number;
  largeAmount: number;
};

export type UnusualFlag =
  "invoice_mismatch" | "possible_duplicate" | "no_invoice_large" | "special";

export const UNUSUAL_LABEL: Record<UnusualFlag, string> = {
  invoice_mismatch: "Amount differs from the linked invoices",
  possible_duplicate: "Same payee and amount within the duplicate window",
  no_invoice_large: "Large amount with no supplier invoice linked",
  special: "Special category (payroll, intercompany, related party)",
};

const dayNo = (d: string) => Math.floor(Date.parse(`${d.slice(0, 10)}T00:00:00Z`) / 86_400_000);

/** Unusual-transaction flags for each voucher (cancelled ones are ignored). Thresholds come from the settings. */
export function unusualFlags(
  rows: readonly VoucherReportRow[],
  settings: ReportSettings,
): Map<string, UnusualFlag[]> {
  const live = rows.filter((r) => r.status !== "cancelled");
  const out = new Map<string, UnusualFlag[]>();
  const add = (id: string, f: UnusualFlag) => out.set(id, [...(out.get(id) ?? []), f]);
  for (const r of live) {
    if (
      r.invoicesTotal !== null &&
      Math.abs(r.amount - r.invoicesTotal) > settings.mismatchTolerance
    )
      add(r.id, "invoice_mismatch");
    if (r.invoicesTotal === null && r.amount >= settings.largeAmount) add(r.id, "no_invoice_large");
    if (r.special !== "none") add(r.id, "special");
    const dup = live.some(
      (o) =>
        o.id !== r.id &&
        o.payeeName.trim().toLowerCase() === r.payeeName.trim().toLowerCase() &&
        cents(o.amount) === cents(r.amount) &&
        Math.abs(dayNo(o.voucherDate) - dayNo(r.voucherDate)) <= settings.duplicateWindowDays,
    );
    if (dup) add(r.id, "possible_duplicate");
  }
  return out;
}

export type VoucherReport = {
  pending: Array<{ status: VoucherStatus; count: number; amount: number }>;
  approved: { count: number; amount: number };
  paid: { count: number; amount: number };
  rejected: { count: number; amount: number };
  /** Average hours from submission to final approval, over vouchers approved in the period; null with none. */
  averageApprovalHours: number | null;
  byTier: Array<{
    tier: string;
    count: number;
    amount: number;
    averageApprovalHours: number | null;
  }>;
  special: VoucherReportRow[];
  rejectedRows: VoucherReportRow[];
  unusual: Array<{ row: VoucherReportRow; flags: UnusualFlag[] }>;
};

const PENDING: VoucherStatus[] = ["draft", "submitted", "checked", "dept_approved", "for_tally"];

/** Status and exception report for the vouchers dated in a period. */
export function voucherReport(
  rows: readonly VoucherReportRow[],
  settings: ReportSettings,
): VoucherReport {
  const sum = (xs: readonly VoucherReportRow[]) => ({
    count: xs.length,
    amount: Math.round(xs.reduce((a, r) => a + r.amount, 0) * 100) / 100,
  });
  const hours = (r: VoucherReportRow) =>
    r.submittedAt && r.approvedAt
      ? (Date.parse(r.approvedAt) - Date.parse(r.submittedAt)) / 3_600_000
      : null;
  const avg = (xs: readonly VoucherReportRow[]) => {
    const h = xs.map(hours).filter((x): x is number => x !== null && x >= 0);
    return h.length ? Math.round((h.reduce((a, b) => a + b, 0) / h.length) * 10) / 10 : null;
  };
  const approvedish = rows.filter((r) => r.status === "approved" || r.status === "paid");
  const tiers = [...new Set(rows.map((r) => r.tier).filter((t): t is string => !!t))].sort();
  const flags = unusualFlags(rows, settings);
  return {
    pending: PENDING.map((status) => ({ status, ...sum(rows.filter((r) => r.status === status)) })),
    approved: sum(rows.filter((r) => r.status === "approved")),
    paid: sum(rows.filter((r) => r.status === "paid")),
    rejected: sum(rows.filter((r) => r.status === "rejected")),
    averageApprovalHours: avg(approvedish),
    byTier: tiers.map((tier) => {
      const xs = rows.filter((r) => r.tier === tier && r.status !== "cancelled");
      return {
        tier,
        ...sum(xs),
        averageApprovalHours: avg(xs.filter((r) => approvedish.includes(r))),
      };
    }),
    special: rows.filter((r) => r.special !== "none" && r.status !== "cancelled"),
    rejectedRows: rows.filter(
      (r) => r.status === "rejected" || (r.rejectedAt !== null && r.status !== "cancelled"),
    ),
    unusual: rows.filter((r) => flags.has(r.id)).map((row) => ({ row, flags: flags.get(row.id)! })),
  };
}

/** The tabs of the vouchers page and which statuses each shows. */
export const VOUCHER_TABS = {
  drafts: { label: "Drafts", statuses: ["draft"] },
  check: { label: "To verify", statuses: ["submitted"] },
  approve: { label: "To approve", statuses: ["checked", "dept_approved"] },
  approved: { label: "Approved", statuses: ["approved", "for_tally"] },
  paid: { label: "Paid", statuses: ["paid"] },
  rejected: { label: "Rejected", statuses: ["rejected", "cancelled"] },
} as const satisfies Record<string, { label: string; statuses: readonly VoucherStatus[] }>;
export type VoucherTab = keyof typeof VOUCHER_TABS;

export function isVoucherTab(v: unknown): v is VoucherTab {
  return typeof v === "string" && v in VOUCHER_TABS;
}

export const EVENT_LABEL: Record<string, string> = {
  created: "Created",
  edited: "Edited",
  returned_to_draft: "Edited after submission (approvals cleared)",
  submitted: "Submitted by the maker",
  sent_to_tally: "Sent to Tally for authorisation",
  checked: "Verified by the Finance Manager",
  dept_approved: "Approved by the department head",
  ceo_approved: "Authorised by the CEO",
  rejected: "Rejected",
  reopened: "Reopened",
  cancelled: "Cancelled",
  paid: "Payment recorded",
  exported: "Exported to Tally",
};

/** "T2: Maker > Finance Manager > Department head", or how a Tally-mode voucher is approved. */
export function approvalRoute(c: {
  route: "pulse" | "tally" | null;
  tier: string | null;
  needsDept: boolean;
  needsCeo: boolean;
}): string {
  if (c.route === "tally") return "Authorised in Tally (approval mode: Tally)";
  if (!c.route) return "Not submitted";
  const steps = ["Maker", "Finance Manager"];
  if (c.needsDept) steps.push("Department head");
  if (c.needsCeo) steps.push("CEO");
  return `${c.tier ?? "?"}: ${steps.join(" > ")}`;
}
