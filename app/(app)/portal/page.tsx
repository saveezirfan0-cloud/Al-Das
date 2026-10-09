import Link from "next/link";
import { Database } from "lucide-react";

import { PageHeader } from "@/components/shell/page-header";
import { Card, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { can } from "@/lib/auth/can";
import { requireMember } from "@/lib/auth/session";
import { getPortalObject } from "@/lib/portal/objects";
import { canReadObject } from "@/lib/portal/permissions";
import { enabledObjectKeys } from "@/lib/portal/server";
import { createAdminClient } from "@/lib/supabase/admin";

import { PORTAL_SECTIONS } from "./sections";

export const metadata = { title: "Portal" };

export default async function PortalPage() {
  const member = await requireMember();
  const sections = PORTAL_SECTIONS.filter((s) => can(member, s.read));
  const keys = await enabledObjectKeys(createAdminClient(), member.orgId);
  const objects = keys
    .map((k) => getPortalObject(k))
    .filter((o): o is NonNullable<typeof o> => !!o && canReadObject(member, o));

  return (
    <div className="flex flex-col gap-8">
      <PageHeader
        title="Portal"
        description="Operational screens for the back office, plus the reference data and routing configuration rebuilt from Airtable."
      />
      {sections.length === 0 && objects.length === 0 && (
        <p className="text-muted-foreground text-sm">
          You don&apos;t have access to any portal screens yet. Ask an admin for a portal
          permission.
        </p>
      )}
      {sections.length > 0 && (
        <section className="flex flex-col gap-3">
          <h2 className="text-muted-foreground text-xs font-semibold tracking-wide uppercase">
            Operational screens
          </h2>
          <div className="grid gap-4 md:grid-cols-2">
            {sections.map((s) => (
              <Link key={s.href} href={s.href} className="rounded-xl focus-visible:outline-2">
                <Card className="hover:bg-accent/40 h-full transition-colors">
                  <CardHeader>
                    <CardTitle>{s.label}</CardTitle>
                    <CardDescription>{s.description}</CardDescription>
                  </CardHeader>
                </Card>
              </Link>
            ))}
          </div>
        </section>
      )}
      {objects.length > 0 && (
        <section className="flex flex-col gap-3">
          <h2 className="text-muted-foreground text-xs font-semibold tracking-wide uppercase">
            Reference data &amp; configuration
          </h2>
          <div className="grid gap-4 md:grid-cols-2">
            {objects.map((o) => (
              <Link
                key={o.key}
                href={`/portal/${o.key}`}
                className="rounded-xl focus-visible:outline-2"
              >
                <Card className="hover:bg-accent/40 h-full transition-colors">
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
        </section>
      )}
    </div>
  );
}
