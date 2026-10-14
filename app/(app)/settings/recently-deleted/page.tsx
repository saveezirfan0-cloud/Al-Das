import Link from "next/link";

import { PageHeader } from "@/components/shell/page-header";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { assertCan, can } from "@/lib/auth/can";
import { requireMember } from "@/lib/auth/session";
import { recordAccess } from "@/lib/security/access-log";
import { canOpenRecentlyDeleted, readRestoreWindowDays } from "@/lib/soft-delete/rules";
import {
  DELETED_PAGE_SIZE,
  listDeletedItems,
  restorableEntities,
} from "@/lib/soft-delete/server";
import { createAdminClient } from "@/lib/supabase/admin";

import { DeletedItemsTable, RestoreWindowForm } from "./recently-deleted";

export const metadata = { title: "Recently deleted" };
export const dynamic = "force-dynamic";

export default async function RecentlyDeletedPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const member = await requireMember();
  const sp = await searchParams;
  const rawFrom = Number(typeof sp.from === "string" ? sp.from : 0);
  const from = Number.isInteger(rawFrom) && rawFrom > 0 ? Math.min(rawFrom, 1_000_000) : 0;
  // Anyone who can restore one kind of record (its own manage permission), or set the window.
  if (!canOpenRecentlyDeleted(member)) assertCan(member, "contacts.manage");
  const admin = createAdminClient();
  const windowDays = readRestoreWindowDays(member.org.settings);
  const kinds = restorableEntities(member);
  const { items, hasMore } = await listDeletedItems(admin, member, windowDays, { offset: from });
  if (items.some((i) => i.entity === "contact"))
    await recordAccess(admin, member, { entity: "contact", action: "list" });

  const tz = member.org.timezone || "UTC";
  const rows = items.map((i) => ({
    ...i,
    deletedAtLabel: new Date(i.deletedAt).toLocaleString("en-GB", {
      timeZone: tz,
      dateStyle: "medium",
      timeStyle: "short",
    }),
  }));

  return (
    <div className="flex flex-col gap-6">
      <PageHeader
        title="Recently deleted"
        description={`Deleted patients, enquiries, tasks and website entry points stay here for ${windowDays} day${windowDays === 1 ? "" : "s"}, then they are removed for good overnight. You see the kinds of record you are allowed to manage.`}
      />
      {kinds.length > 0 && <DeletedItemsTable key={from} rows={rows} />}
      {kinds.length > 0 && (from > 0 || hasMore) && (
        <nav aria-label="Pages of deleted items" className="flex flex-wrap items-center gap-2">
          {from > 0 && (
            <Button asChild variant="outline" size="sm">
              <Link href={`/settings/recently-deleted?from=${Math.max(0, from - DELETED_PAGE_SIZE)}`}>
                Newer items
              </Link>
            </Button>
          )}
          {hasMore && (
            <Button asChild variant="outline" size="sm">
              <Link href={`/settings/recently-deleted?from=${from + DELETED_PAGE_SIZE}`}>
                Older items
              </Link>
            </Button>
          )}
          <span className="text-muted-foreground text-xs">
            Showing {from + 1} to {from + rows.length}
          </span>
        </nav>
      )}
      {can(member, "security.manage") && <RestoreWindowForm initial={windowDays} />}
      <Card>
        <CardHeader>
          <CardTitle>What &ldquo;removed for good&rdquo; means</CardTitle>
          <CardDescription>
            Tasks, enquiries and website entry points are deleted from the database when their time
            runs out; an enquiry&apos;s tasks and timeline entries are kept. A contact stays hidden
            but can no longer be restored, because conversations, appointments and clinical records
            still point at it. To remove a patient&apos;s details, use Patient data requests
            (erasure, approved by a second administrator).
          </CardDescription>
        </CardHeader>
        <CardContent className="text-muted-foreground text-sm">
          A patient cannot be restored while another patient record uses the same phone number,
          WhatsApp account or Unite PIN, and a task or enquiry cannot be restored while its patient
          is still in this list.
        </CardContent>
      </Card>
    </div>
  );
}
