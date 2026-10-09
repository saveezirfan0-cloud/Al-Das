import Link from "next/link";
import { Database } from "lucide-react";

import { PageHeader } from "@/components/shell/page-header";
import { Card, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { requireMember } from "@/lib/auth/session";
import { getPortalObject } from "@/lib/portal/objects";
import { canReadObject } from "@/lib/portal/permissions";
import { enabledObjectKeys } from "@/lib/portal/server";
import { createAdminClient } from "@/lib/supabase/admin";

export const metadata = { title: "Portal" };

export default async function PortalIndexPage() {
  const member = await requireMember();
  const admin = createAdminClient();
  const keys = await enabledObjectKeys(admin, member.orgId);
  const objects = keys
    .map((k) => getPortalObject(k))
    .filter((o): o is NonNullable<typeof o> => !!o && canReadObject(member, o));

  return (
    <div className="flex flex-col gap-6">
      <PageHeader
        title="Portal"
        description="Reference data and operational configuration rebuilt from the Airtable bases."
      />
      {objects.length === 0 ? (
        <p className="text-muted-foreground text-sm">
          You do not have access to any portal objects yet. Ask an administrator to grant
          portal.&lt;object&gt;.read in Settings → Roles.
        </p>
      ) : (
        <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
          {objects.map((o) => (
            <Link key={o.key} href={`/portal/${o.key}`} className="focus-visible:outline-none">
              <Card className="hover:border-primary/50 focus-visible:ring-ring h-full transition-colors">
                <CardHeader>
                  <CardTitle className="flex items-center gap-2">
                    <Database className="text-muted-foreground size-4" /> {o.label}
                  </CardTitle>
                  <CardDescription>{o.description}</CardDescription>
                </CardHeader>
              </Card>
            </Link>
          ))}
        </div>
      )}
    </div>
  );
}
