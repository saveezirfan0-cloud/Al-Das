import Link from "next/link";

import { PageHeader } from "@/components/shell/page-header";
import { Button } from "@/components/ui/button";
import { Card, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { can } from "@/lib/auth/can";
import { requirePerm } from "@/lib/auth/session";
import { canSeeLocation, readBranchAccess } from "@/lib/branches/access";
import { createAdminClient } from "@/lib/supabase/admin";

import { RoomsEditor, type BranchView } from "./rooms-editor";

export const metadata = { title: "Rooms" };
export const dynamic = "force-dynamic";

const NONE = ["00000000-0000-0000-0000-000000000000"];

export default async function RoomsSettingsPage() {
  const member = await requirePerm("rooms.manage");
  const admin = createAdminClient(); // service role AFTER the permission check
  const access = readBranchAccess(member);

  const { data: locations, error } = await admin
    .from("locations")
    .select("id, name")
    .eq("org_id", member.orgId)
    .eq("active", true)
    .order("name");
  if (error) throw new Error("Could not load the branches.");
  const visible = (locations ?? []).filter((l) => canSeeLocation(access, l.id));
  const ids = visible.length > 0 ? visible.map((l) => l.id) : NONE;

  const [{ data: rooms }, { data: specialists }, { data: links }] = await Promise.all([
    admin
      .from("rooms")
      .select("id, location_id, name, kind, monthly_cost, active")
      .eq("org_id", member.orgId)
      .in("location_id", ids)
      .order("name"),
    admin.from("specialists").select("id, name, active").eq("org_id", member.orgId).order("name"),
    admin
      .from("specialist_locations")
      .select("specialist_id, location_id")
      .eq("org_id", member.orgId)
      .in("location_id", ids),
  ]);
  const roomIds = (rooms ?? []).map((r) => r.id);
  const { data: rota } = await admin
    .from("room_rota")
    .select("id, room_id, specialist_id, weekday, start_min, end_min")
    .eq("org_id", member.orgId)
    .in("room_id", roomIds.length > 0 ? roomIds : NONE)
    .order("weekday")
    .order("start_min");

  const doctorName = new Map((specialists ?? []).map((s) => [s.id, s.name]));
  const branches: BranchView[] = visible.map((l) => {
    const atBranch = new Set(
      (links ?? []).filter((x) => x.location_id === l.id).map((x) => x.specialist_id),
    );
    return {
      id: l.id,
      name: l.name,
      doctors: (specialists ?? [])
        .filter((s) => s.active && atBranch.has(s.id))
        .map((s) => ({ id: s.id, name: s.name })),
      rooms: (rooms ?? [])
        .filter((r) => r.location_id === l.id)
        .map((r) => ({
          id: r.id,
          name: r.name,
          kind: r.kind,
          monthlyCost: r.monthly_cost === null ? null : Number(r.monthly_cost),
          active: r.active,
          rota: (rota ?? [])
            .filter((x) => x.room_id === r.id)
            .map((x) => ({
              id: x.id,
              weekday: x.weekday,
              startMin: x.start_min,
              endMin: x.end_min,
              doctor: doctorName.get(x.specialist_id) ?? "Doctor",
              // A doctor later removed from the branch keeps their rota row until someone clears it.
              stale: !atBranch.has(x.specialist_id),
            })),
        })),
    };
  });

  return (
    <div className="flex flex-col gap-6">
      <PageHeader
        title="Rooms"
        description="The rooms of each branch and the weekly rota: which doctor uses which room, on which day and when. Used for room occupancy and revenue per room-hour; bookings are not affected."
      >
        {can(member, "finance.revenue.view") && (
          <Button size="sm" variant="outline" asChild>
            <Link href="/finance/capacity">Open capacity</Link>
          </Button>
        )}
      </PageHeader>
      {branches.length === 0 ? (
        <Card>
          <CardHeader>
            <CardTitle className="text-base">No branches to show</CardTitle>
            <CardDescription>
              Add a branch under Settings, Appointment rules first, or ask an administrator for
              access to a branch.
            </CardDescription>
          </CardHeader>
        </Card>
      ) : (
        <RoomsEditor branches={branches} />
      )}
    </div>
  );
}
