/**
 * Where a signed-in person lands (pure, Phase D; docs/34 §3 "Home"). One rule for every role:
 *  - Receptionist → Front desk; Doctor → My day; Agent → Inbox; HR → Staff;
 *  - Finance roles → their Finance landing (holders of a report key get the Reports hub, Phase G; there is no finance
 *    work-queue page yet); accounting roles → their Accounting landing;
 *  - CEO and Manager → the Management dashboard;
 *  - everyone else → the dashboard.
 * A role that lacks the permission its page needs falls back to the dashboard rather than a page it cannot open.
 * (lib/front-desk/landing.ts is the older Receptionist/Doctor-only version; this one replaces it.)
 */
import { accountingLanding } from "@/lib/accounting/nav";
import { can, canAny, type MemberLike } from "@/lib/auth/can";
import { financeLanding } from "@/lib/finance/nav";

export const DEFAULT_LANDING_PATH = "/dashboard";
export const MANAGEMENT_PATH = "/dashboard/management";

/** Finance & Insurance presets (lib/auth/permissions.ts FINANCE_ROLES); the CEO gets here only without reports.view. */
const FINANCE_ROLE_NAMES = new Set([
  "ceo",
  "finance",
  "finance manager",
  "revenue & collections",
  "costs & expenses",
  "billing",
  "insurance",
  "medical director",
  "cost / payroll",
  "department head",
  "operations",
]);
const ACCOUNTING_ROLE_NAMES = new Set(["accountant", "chief accountant", "auditor"]);

export type LandingMember = Pick<MemberLike, "status" | "permissions" | "restrictedAreas"> & {
  roleName?: string;
};

export function landingPathFor(member: LandingMember): string {
  const m = member as MemberLike;
  const role = (member.roleName ?? "").trim().toLowerCase();
  if (role === "receptionist" && can(m, "frontdesk.use")) return "/front-desk";
  if (role === "doctor" && can(m, "appointments.view")) return "/my-day";
  if (role === "agent" && canAny(m, ["inbox.send", "inbox.view_all"])) return "/inbox";
  if (role === "hr" && can(m, "hr.view")) return "/staff";
  if ((role === "ceo" || role === "manager") && can(m, "reports.view")) return MANAGEMENT_PATH;
  if (FINANCE_ROLE_NAMES.has(role)) return financeLanding(m) ?? DEFAULT_LANDING_PATH;
  if (ACCOUNTING_ROLE_NAMES.has(role)) return accountingLanding(m) ?? DEFAULT_LANDING_PATH;
  return DEFAULT_LANDING_PATH;
}
