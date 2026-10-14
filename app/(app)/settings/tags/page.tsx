import Link from "next/link";

import { PageHeader } from "@/components/shell/page-header";
import { can, assertCan } from "@/lib/auth/can";
import { requireMember } from "@/lib/auth/session";
import { createAdminClient } from "@/lib/supabase/admin";
import { cn } from "@/lib/utils";

import { TagsManager } from "./tags-manager";

export const metadata = { title: "Tags" };

const SCOPES = [
  { key: "contact", label: "Contact tags", perm: "contacts.manage", usage: "contact_tags" },
  { key: "enquiry", label: "Enquiry tags", perm: "enquiries.manage", usage: "enquiry_tags" },
  { key: "portal", label: "Portal tags", perm: "portal.tags.manage", usage: "portal_record_tags" },
] as const;

const DESCRIPTIONS: Record<(typeof SCOPES)[number]["key"], string> = {
  contact:
    "Labels for contacts. Tags can also be created on the fly from the contact drawer and bulk actions.",
  enquiry: "Labels for enquiries. They can also be created on the fly from the enquiry drawer.",
  portal:
    "Labels for portal records (diagnoses, medications, items, website entry points). Anyone who can edit a portal object can add them to its records.",
};

export default async function TagsPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const member = await requireMember();
  const sp = await searchParams;
  const allowed = SCOPES.filter((s) => can(member, s.perm));
  const scope = allowed.find((s) => s.key === sp.scope) ?? allowed[0] ?? SCOPES[0];
  assertCan(member, scope.perm);
  const admin = createAdminClient();
  const [{ data: tags }, { data: usage }] = await Promise.all([
    admin
      .from("tags")
      .select("id, name, color")
      .eq("org_id", member.orgId)
      .eq("scope", scope.key)
      .order("name"),
    admin.from(scope.usage).select("tag_id").eq("org_id", member.orgId),
  ]);
  const counts = new Map<string, number>();
  for (const u of usage ?? []) counts.set(u.tag_id, (counts.get(u.tag_id) ?? 0) + 1);

  return (
    <div className="flex flex-col gap-6">
      <PageHeader title="Tags" description={DESCRIPTIONS[scope.key]} />
      {allowed.length > 1 && (
        <div className="flex gap-1">
          {allowed.map((s) => (
            <Link
              key={s.key}
              href={`/settings/tags?scope=${s.key}`}
              className={cn(
                "rounded-md px-3 py-1.5 text-sm",
                s.key === scope.key
                  ? "bg-accent font-medium"
                  : "text-muted-foreground hover:bg-accent/50",
              )}
            >
              {s.label}
            </Link>
          ))}
        </div>
      )}
      <TagsManager
        key={scope.key}
        scope={scope.key}
        tags={(tags ?? []).map((t) => ({ ...t, count: counts.get(t.id) ?? 0 }))}
      />
    </div>
  );
}
