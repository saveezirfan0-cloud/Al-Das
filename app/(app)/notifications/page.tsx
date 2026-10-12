import Link from "next/link";
import { Settings } from "lucide-react";

import { PageHeader } from "@/components/shell/page-header";
import { Button } from "@/components/ui/button";
import { requireMember } from "@/lib/auth/session";
import { applyCentreFilters } from "@/lib/notify/centre-query";
import { CATEGORY_LABELS, type NotificationCategory } from "@/lib/notify/events";
import { createClient } from "@/lib/supabase/server";

import { NotificationCentre, type CentreItem } from "./notification-centre";

export const metadata = { title: "Notification centre" };

const PAGE_SIZE = 50;
const STATUSES = ["all", "unread", "snoozed"] as const;
type Status = (typeof STATUSES)[number];

export default async function NotificationsPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const member = await requireMember();
  const sp = await searchParams;
  const one = (k: string) => (Array.isArray(sp[k]) ? sp[k]![0] : (sp[k] as string | undefined));
  const category =
    (Object.keys(CATEGORY_LABELS) as NotificationCategory[]).find((c) => c === one("category")) ??
    null;
  const status: Status = STATUSES.find((s) => s === one("status")) ?? "all";
  const limit = Math.min(500, Math.max(PAGE_SIZE, Number(one("limit")) || PAGE_SIZE));

  const supabase = await createClient(); // own notifications only (RLS)
  const nowIso = new Date().toISOString();
  let q = supabase
    .from("notifications")
    .select("id, type, title, body, payload, read_at, created_at, snoozed_until")
    .eq("org_id", member.orgId)
    .eq("user_id", member.userId)
    .order("created_at", { ascending: false })
    .limit(limit + 1);

  q = applyCentreFilters(q, { status, category, nowIso });

  const { data, error } = await q;
  const rows = data ?? [];
  const items: CentreItem[] = rows.slice(0, limit).map((n) => ({
    id: n.id,
    type: n.type,
    title: n.title,
    body: n.body,
    payload: n.payload,
    read_at: n.read_at,
    created_at: n.created_at,
    snoozed_until: n.snoozed_until,
  }));

  return (
    <div className="flex flex-col gap-4">
      <PageHeader
        title="Notification centre"
        description="Everything Pulse has told you, with filters and snooze."
      >
        <Button asChild variant="outline" size="sm">
          <Link href="/settings/notifications">
            <Settings /> Notification settings
          </Link>
        </Button>
      </PageHeader>
      {error && (
        <p className="text-destructive text-sm" role="alert">
          Could not load notifications.
        </p>
      )}
      <NotificationCentre
        items={items}
        category={category}
        status={status}
        hasMore={rows.length > limit}
        nextLimit={limit + PAGE_SIZE}
      />
    </div>
  );
}
