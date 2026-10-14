import { can, canAny, ForbiddenError } from "@/lib/auth/can";
import { requireMember } from "@/lib/auth/session";
import { canSeeLocation, readBranchAccess } from "@/lib/branches/access";
import { branchView } from "@/lib/branches/server";
import { weekDays, weekStart, weekWindow } from "@/lib/organisation/rota";
import { loadBranchShifts, loadBranches, loadStaff, todayWindow } from "@/lib/organisation/server";
import { createAdminClient } from "@/lib/supabase/admin";

import { RotaGrid } from "./rota-grid";

export const metadata = { title: "Rota" };
export const dynamic = "force-dynamic";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

/**
 * The rota (Phase C): one branch, one week; rows are people, columns are days. Readable with hr.view or
 * appointments.view (the desk needs to know who is on); hr.manage adds, moves and removes shifts. The branch follows
 * the switcher (never one the person may not see); overlaps are refused by the database.
 */
export default async function RotaPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const member = await requireMember();
  if (!canAny(member, ["hr.view", "appointments.view"])) throw new ForbiddenError("hr.view");
  const sp = await searchParams;
  const one = (k: string) => (typeof sp[k] === "string" ? (sp[k] as string) : undefined);

  const admin = createAdminClient();
  const access = readBranchAccess(member);
  const [{ allowed }, { data: org }] = await Promise.all([
    loadBranches(admin, member.orgId, access),
    admin.from("orgs").select("timezone").eq("id", member.orgId).single(),
  ]);
  const view = await branchView(
    member,
    allowed.map((b) => b.id),
  );
  const asked = one("branch");
  const branchId =
    asked &&
    UUID_RE.test(asked) &&
    allowed.some((b) => b.id === asked) &&
    canSeeLocation(access, asked)
      ? asked
      : (view.current ?? allowed[0]?.id ?? null);
  const branch = allowed.find((b) => b.id === branchId) ?? null;
  const timezone = branch?.timezone ?? org?.timezone ?? "Asia/Dubai";
  const today = todayWindow(timezone).today;
  const askedWeek = one("week");
  const monday = weekStart(askedWeek && DATE_RE.test(askedWeek) ? askedWeek : today) ?? today;
  const window = weekWindow(monday, timezone);

  const hrView = can(member, "hr.view");
  const shifts =
    branch && window ? await loadBranchShifts(admin, member.orgId, branch.id, window) : [];
  // People: with hr.view, everyone whose home is this branch plus anyone with a shift here; otherwise only the people
  // on shift (the rota itself names them).
  const visibleStaff = hrView ? await loadStaff(admin, member.orgId, access) : [];
  const onShift = new Set(shifts.map((s) => s.staffMemberId));
  const missing = [...onShift].filter((id) => !visibleStaff.some((s) => s.id === id));
  let extra: Array<{ id: string; full_name: string; job_title: string | null }> = [];
  if (missing.length) {
    const { data } = await admin
      .from("staff_members")
      .select("id, full_name, job_title")
      .eq("org_id", member.orgId)
      .in("id", missing);
    extra = data ?? [];
  }
  const people = [
    ...visibleStaff
      .filter((s) => onShift.has(s.id) || (branch && s.homeLocationId === branch.id))
      .map((s) => ({ id: s.id, name: s.fullName, title: s.jobTitle })),
    ...extra.map((s) => ({ id: s.id, name: s.full_name, title: s.job_title })),
  ].sort((a, b) => a.name.localeCompare(b.name));

  return (
    <RotaGrid
      branches={allowed}
      branchId={branch?.id ?? null}
      timezone={timezone}
      monday={monday}
      days={weekDays(monday)}
      today={today}
      shifts={shifts}
      people={people}
      staffOptions={visibleStaff.map((s) => ({ value: s.id, label: s.fullName }))}
      canManage={can(member, "hr.manage")}
      canStaff={hrView}
    />
  );
}
