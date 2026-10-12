import { PageHeader } from "@/components/shell/page-header";
import { can } from "@/lib/auth/can";
import { requirePerm } from "@/lib/auth/session";
import { loadBoardRows, loadNextFreeSlots, shiftDate, todayIn } from "@/lib/front-desk/server";
import { readFrontDeskSettings } from "@/lib/front-desk/settings";
import { recordAccess } from "@/lib/security/access-log";
import { createAdminClient } from "@/lib/supabase/admin";

import { loadDeskOptions } from "@/lib/front-desk/options";

import { FrontDeskWorkspace } from "./front-desk-workspace";
import type { DeskCan, DeskData, NoteRow, WaitlistRow } from "./types";

export const metadata = { title: "Front desk" };

const DATE = /^\d{4}-\d{2}-\d{2}$/;

export default async function FrontDeskPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const member = await requirePerm("frontdesk.use");
  if (!can(member, "appointments.view")) {
    return (
      <div className="flex flex-col gap-4">
        <PageHeader title="Front desk" />
        <p className="text-muted-foreground rounded-xl border border-dashed p-10 text-center text-sm">
          The Front desk needs permission to view appointments. Ask an administrator.
        </p>
      </div>
    );
  }

  const params = await searchParams;
  const admin = createAdminClient();
  const tz = member.org.timezone || "Asia/Dubai";
  const today = todayIn(tz);
  const requested = typeof params.date === "string" && DATE.test(params.date) ? params.date : today;
  const date =
    requested > shiftDate(today, 14) || requested < shiftDate(today, -14) ? today : requested;
  const settings = readFrontDeskSettings(member.org.settings);

  const [rows, slots, waitRes, notesRes, options] = await Promise.all([
    loadBoardRows(admin, member.orgId, tz, date),
    loadNextFreeSlots(admin, member.orgId, {
      today: date,
      durationMin: settings.next_slot_minutes,
    }),
    admin
      .from("waitlist_entries")
      .select(
        "id, contact_id, not_after, notes, created_at, contacts(full_name), specialists(name), services(name), locations(name), slot_offers(status, starts_at, expires_at)",
      )
      .eq("org_id", member.orgId)
      .eq("status", "waiting")
      .order("created_at")
      .limit(200),
    admin
      .from("handover_notes")
      .select(
        "id, body, pinned, created_at, resolved_at, profiles:profiles!handover_notes_created_by_fkey(first_name, last_name)",
      )
      .eq("org_id", member.orgId)
      .gte("created_at", new Date(Date.now() - 7 * 24 * 3600_000).toISOString())
      .order("pinned", { ascending: false })
      .order("created_at", { ascending: false })
      .limit(60),
    loadDeskOptions(admin, member.orgId, tz),
  ]);

  await recordAccess(admin, member, {
    entity: "appointment",
    action: "list",
    detail: { rows: rows.length, screen: "front_desk" },
  });

  const waitlist: WaitlistRow[] = (
    (waitRes.data ?? []) as unknown as Array<{
      id: string;
      contact_id: string;
      not_after: string | null;
      notes: string | null;
      created_at: string;
      contacts: { full_name: string | null } | null;
      specialists: { name: string } | null;
      services: { name: string } | null;
      locations: { name: string } | null;
      slot_offers: Array<{ status: string; starts_at: string; expires_at: string }>;
    }>
  ).map((w) => {
    const live = (w.slot_offers ?? []).find(
      (o) => o.status === "pending" && new Date(o.expires_at).getTime() > Date.now(),
    );
    return {
      id: w.id,
      contact_id: w.contact_id,
      patient_name: w.contacts?.full_name || "Unnamed patient",
      specialist_name: w.specialists?.name ?? null,
      service_name: w.services?.name ?? null,
      location_name: w.locations?.name ?? null,
      not_after: w.not_after,
      notes: w.notes,
      created_at: w.created_at,
      offer: live ? { starts_at: live.starts_at, expires_at: live.expires_at } : null,
    };
  });

  const notes: NoteRow[] = (
    (notesRes.data ?? []) as unknown as Array<{
      id: string;
      body: string;
      pinned: boolean;
      created_at: string;
      resolved_at: string | null;
      profiles: { first_name: string; last_name: string } | null;
    }>
  ).map((n) => ({
    id: n.id,
    body: n.body,
    pinned: n.pinned,
    created_at: n.created_at,
    resolved_at: n.resolved_at,
    author: n.profiles ? `${n.profiles.first_name} ${n.profiles.last_name}`.trim() || null : null,
  }));

  const deskCan: DeskCan = {
    appointments: can(member, "appointments.manage"),
    contacts: can(member, "contacts.manage"),
    tasks: can(member, "tasks.manage"),
    send: can(member, "inbox.send"),
  };

  const data: DeskData = {
    date,
    today,
    rows,
    slots,
    waitlist,
    notes,
    lateGraceMin: settings.late_grace_minutes,
    offersEnabled: settings.offers_enabled,
  };

  return <FrontDeskWorkspace data={data} options={options} can={deskCan} />;
}
