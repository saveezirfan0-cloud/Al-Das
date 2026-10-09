import Link from "next/link";

import { PageHeader } from "@/components/shell/page-header";
import { Card, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { can } from "@/lib/auth/can";
import { requireMember } from "@/lib/auth/session";

import { PORTAL_SECTIONS } from "./sections";

export const metadata = { title: "Portal" };

export default async function PortalPage() {
  const member = await requireMember();
  const sections = PORTAL_SECTIONS.filter((s) => can(member, s.read));
  return (
    <div className="flex flex-col gap-6">
      <PageHeader
        title="Portal"
        description="Operational screens for the back office: sync reviews and clinical follow-ups."
      />
      {sections.length === 0 ? (
        <p className="text-muted-foreground text-sm">
          You don&apos;t have access to any portal screens yet. Ask an admin for a portal
          permission.
        </p>
      ) : (
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
      )}
    </div>
  );
}
