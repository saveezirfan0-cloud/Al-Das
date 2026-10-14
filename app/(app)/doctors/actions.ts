"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";

import { recordAudit } from "@/lib/audit";
import { can, canAny } from "@/lib/auth/can";
import { requireMember } from "@/lib/auth/session";
import { canSeeLocation, readBranchAccess } from "@/lib/branches/access";
import { doctorProfileSchema, type DoctorProfileInput } from "@/lib/organisation/doctors";
import { loadDoctorFinanceLink, loadReportDoctors } from "@/lib/organisation/doctor-links-server";
import { loadDoctorDetail } from "@/lib/organisation/server";
import type { DoctorDetail, DoctorFinanceLink } from "@/lib/organisation/types";
import { recordAccess } from "@/lib/security/access-log";
import { createAdminClient, type AdminClient } from "@/lib/supabase/admin";
import type { Json } from "@/lib/supabase/types";

export type ActionResult = { ok: true; message?: string } | { ok: false; error: string };
export type DetailResult = { ok: true; data: DoctorDetail } | { ok: false; error: string };
export type FinanceLinkResult =
  { ok: true; data: DoctorFinanceLink } | { ok: false; error: string };

const EDIT_PERMS = ["settings.manage", "hr.manage"] as const;
/** The finance reference key (the one saveDoctor uses); changing a link also needs settings.manage. */
const FINANCE_REF = "finance.reference.manage";

/** False when the doctor works only in branches the person may not see (a doctor in no branch stays visible). */
async function inVisibleBranch(
  admin: AdminClient,
  member: Awaited<ReturnType<typeof requireMember>>,
  id: string,
): Promise<boolean> {
  const { data: links } = await admin
    .from("specialist_locations")
    .select("location_id")
    .eq("org_id", member.orgId)
    .eq("specialist_id", id);
  const access = readBranchAccess(member);
  const locIds = (links ?? []).map((l) => l.location_id);
  return locIds.length === 0 || locIds.some((l) => canSeeLocation(access, l));
}

/**
 * Edits a doctor's profile and licence fields (specialty, licence number, authority and expiry, extension, short
 * bio). Needs settings.manage or hr.manage, and the doctor must work in a branch the person may see (or in none).
 * Working hours, services and branches stay under Settings, Appointments. Audited with the changed field names
 * only (no values).
 */
export async function updateDoctorProfileAction(
  id: string,
  raw: DoctorProfileInput,
): Promise<ActionResult> {
  const member = await requireMember();
  if (!canAny(member, EDIT_PERMS))
    return { ok: false, error: "You do not have permission to edit doctors." };
  if (!z.string().uuid().safeParse(id).success) return { ok: false, error: "Invalid doctor." };
  const parsed = doctorProfileSchema.safeParse(raw);
  if (!parsed.success)
    return { ok: false, error: parsed.error.issues[0]?.message ?? "Check the fields." };

  const admin = createAdminClient(member.userId);
  const { data: current } = await admin
    .from("specialists")
    .select("id, specialty, licence_number, licence_authority, licence_expires_on, phone_ext, bio")
    .eq("id", id)
    .eq("org_id", member.orgId)
    .maybeSingle();
  if (!current) return { ok: false, error: "This doctor no longer exists." };

  if (!(await inVisibleBranch(admin, member, id)))
    return { ok: false, error: "This doctor works only in branches you cannot see." };

  const next = parsed.data;
  const changed = (Object.keys(next) as Array<keyof typeof next>).filter(
    (k) => (current[k] ?? null) !== (next[k] ?? null),
  );
  if (changed.length === 0) return { ok: true, message: "Nothing to save." };

  const { error } = await admin
    .from("specialists")
    .update(next)
    .eq("id", id)
    .eq("org_id", member.orgId);
  if (error) return { ok: false, error: "Could not save the doctor." };

  await recordAudit(admin, {
    orgId: member.orgId,
    userId: member.userId,
    action: "doctor.profile_updated",
    entity: "specialist",
    entityId: id,
    diff: { fields: changed } as Json,
  });
  revalidatePath("/doctors");
  return { ok: true, message: "Saved." };
}

/**
 * The doctor drawer's linked view: the next five appointments (appointments.view; patients by first name with
 * contacts.view, otherwise initials), this week's shifts and the linked staff record (hr.view). Read-only; follows the
 * branch rule. The appointment list is logged as a list view (ids and counts only).
 */
export async function loadDoctorDetailAction(id: string): Promise<DetailResult> {
  const member = await requireMember();
  if (!canAny(member, ["appointments.view", "hr.view"]))
    return { ok: false, error: "You do not have permission to see doctors." };
  if (!z.string().uuid().safeParse(id).success) return { ok: false, error: "Invalid doctor." };
  const admin = createAdminClient();
  const detail = await loadDoctorDetail(admin, member.orgId, id, readBranchAccess(member), {
    timezone: member.org.timezone || "Asia/Dubai",
    appointments: can(member, "appointments.view"),
    contacts: can(member, "contacts.view"),
    hr: can(member, "hr.view"),
  });
  if (!detail) return { ok: false, error: "This doctor no longer exists." };
  if (detail.upcoming?.length)
    await recordAccess(admin, member, {
      entity: "appointment",
      action: "list",
      detail: { page: "doctors", count: detail.upcoming.length },
    });
  return { ok: true, data: detail };
}

/**
 * The drawer's Finance link: the finance doctor (DHA id) and Unite report name this doctor is linked to, with
 * suggestions (lib/organisation/doctor-links.ts). Needs finance.reference.manage; follows the branch rule.
 */
export async function loadDoctorFinanceLinkAction(id: string): Promise<FinanceLinkResult> {
  const member = await requireMember();
  if (!can(member, FINANCE_REF))
    return { ok: false, error: "You do not have permission to see finance links." };
  if (!z.string().uuid().safeParse(id).success) return { ok: false, error: "Invalid doctor." };
  const admin = createAdminClient(); // service role AFTER the permission check
  if (!(await inVisibleBranch(admin, member, id)))
    return { ok: false, error: "This doctor works only in branches you cannot see." };
  const data = await loadDoctorFinanceLink(admin, member.orgId, id).catch(() => null);
  if (!data) return { ok: false, error: "Could not load the finance link." };
  return { ok: true, data };
}

const linkSchema = z.object({
  kind: z.enum(["finance", "report"]),
  value: z.string().trim().min(1).max(200).nullable(),
});

/**
 * Sets or clears one link of a doctor: `finance` (fin_ref_doctors.dha_id) or `report` (a Unite report doctor key).
 * Needs settings.manage AND finance.reference.manage, and the doctor in a branch the person may see. The target must
 * exist; a finance doctor or report name belongs to one diary doctor at most (unique per org). Audited with ids and
 * codes only: the DHA ids, and for the report link only whether it was set, changed or cleared (the key is a name).
 */
export async function saveDoctorFinanceLinkAction(
  id: string,
  raw: { kind: "finance" | "report"; value: string | null },
): Promise<ActionResult> {
  const member = await requireMember();
  if (!can(member, "settings.manage") || !can(member, FINANCE_REF))
    return { ok: false, error: "You do not have permission to change finance links." };
  if (!z.string().uuid().safeParse(id).success) return { ok: false, error: "Invalid doctor." };
  const parsed = linkSchema.safeParse(raw);
  if (!parsed.success) return { ok: false, error: "Choose a doctor to link." };
  const { kind, value } = parsed.data;

  const admin = createAdminClient(member.userId);
  const { data: current } = await admin
    .from("specialists")
    .select("id, dha_id, report_doctor_key")
    .eq("id", id)
    .eq("org_id", member.orgId)
    .maybeSingle();
  if (!current) return { ok: false, error: "This doctor no longer exists." };
  if (!(await inVisibleBranch(admin, member, id)))
    return { ok: false, error: "This doctor works only in branches you cannot see." };
  const before = kind === "finance" ? current.dha_id : current.report_doctor_key;
  if (before === value) return { ok: true, message: "Nothing to change." };

  if (value !== null) {
    const exists =
      kind === "finance"
        ? !!(
            await admin
              .from("fin_ref_doctors")
              .select("dha_id")
              .eq("org_id", member.orgId)
              .eq("dha_id", value)
              .maybeSingle()
          ).data
        : (await loadReportDoctors(admin, member.orgId).catch(() => [])).some(
            (r) => r.key === value,
          );
    if (!exists)
      return {
        ok: false,
        error:
          kind === "finance"
            ? "That doctor is not in the finance reference."
            : "That name is not in the Unite report.",
      };
  }

  const { error } = await admin
    .from("specialists")
    .update(kind === "finance" ? { dha_id: value } : { report_doctor_key: value })
    .eq("id", id)
    .eq("org_id", member.orgId);
  if (error?.code === "23505")
    return { ok: false, error: "That one is already linked to another doctor." };
  if (error) return { ok: false, error: "Could not save the link." };

  await recordAudit(admin, {
    orgId: member.orgId,
    userId: member.userId,
    action: value === null ? "doctor.finance_link_cleared" : "doctor.finance_link_set",
    entity: "specialist",
    entityId: id,
    diff: (kind === "finance"
      ? { link: "finance", from: before, to: value }
      : {
          link: "report",
          change: value === null ? "cleared" : before === null ? "set" : "changed",
        }) as Json,
  });
  revalidatePath("/doctors");
  return { ok: true, message: value === null ? "Link cleared." : "Linked." };
}
