import Link from "next/link";

import { PageHeader } from "@/components/shell/page-header";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent } from "@/components/ui/card";
import { requirePerm } from "@/lib/auth/session";
import {
  GROUP_ORDER,
  STATE_LABEL,
  STATE_ORDER,
  buildRows,
  summarise,
  type MigrationState,
} from "@/lib/migration/status";
import { loadMigrationFacts } from "@/lib/migration/status-server";
import { createAdminClient } from "@/lib/supabase/admin";

export const metadata = { title: "Migration status" };
export const dynamic = "force-dynamic";

const VARIANT: Record<MigrationState, "outline" | "secondary" | "success" | "warning"> = {
  not_started: "outline",
  imported: "secondary",
  native: "success",
  parallel_run: "warning",
  retired: "success",
};

export default async function MigrationStatusPage() {
  const member = await requirePerm("settings.manage");
  const facts = await loadMigrationFacts(createAdminClient(), member.orgId);
  const rows = buildRows(facts);
  const summary = summarise(rows);

  return (
    <div className="flex flex-col gap-6">
      <PageHeader
        title="Migration status"
        description="Every Airtable table and Make scenario, what replaces it in Pulse, and how far along it is. Read only: the state comes from what has actually been imported or recorded, never from this page."
      />

      <div className="grid grid-cols-2 gap-3 sm:grid-cols-5">
        {STATE_ORDER.map((s) => (
          <Card key={s}>
            <CardContent className="flex flex-col gap-1 p-4">
              <span className="text-2xl font-semibold tabular-nums">{summary[s]}</span>
              <Badge variant={VARIANT[s]}>{STATE_LABEL[s]}</Badge>
            </CardContent>
          </Card>
        ))}
      </div>

      {GROUP_ORDER.map((group) => {
        const groupRows = rows.filter((r) => r.group === group);
        if (groupRows.length === 0) return null;
        return (
          <section key={group} className="flex flex-col gap-2">
            <h2 className="text-base font-semibold">{group}</h2>
            <div className="overflow-x-auto rounded-md border">
              <table className="w-full min-w-[40rem] text-sm">
                <thead className="bg-muted/50 text-left text-xs text-muted-foreground">
                  <tr>
                    <th scope="col" className="px-3 py-2 font-medium">Today</th>
                    <th scope="col" className="px-3 py-2 font-medium">In Pulse</th>
                    <th scope="col" className="px-3 py-2 font-medium">State</th>
                    <th scope="col" className="px-3 py-2 font-medium">Last known</th>
                  </tr>
                </thead>
                <tbody>
                  {groupRows.map((r) => (
                    <tr key={r.id} className="border-t align-top">
                      <td className="px-3 py-2">{r.name}</td>
                      <td className="px-3 py-2">
                        {r.href ? (
                          <Link href={r.href} className="text-primary underline-offset-2 hover:underline">
                            {r.pulse}
                          </Link>
                        ) : (
                          r.pulse
                        )}
                        {r.note ? <p className="mt-0.5 text-xs text-muted-foreground">{r.note}</p> : null}
                      </td>
                      <td className="px-3 py-2">
                        <Badge variant={VARIANT[r.state]}>{STATE_LABEL[r.state]}</Badge>
                      </td>
                      <td className="px-3 py-2 text-muted-foreground">{r.detail ?? "Nothing recorded"}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </section>
        );
      })}
    </div>
  );
}
