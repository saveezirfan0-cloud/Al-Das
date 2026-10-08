import { PageHeader } from "@/components/shell/page-header";
import { requirePerm } from "@/lib/auth/session";
import { createAdminClient } from "@/lib/supabase/admin";

import { TagsManager } from "./tags-manager";

export const metadata = { title: "Tags" };

export default async function TagsPage() {
  const member = await requirePerm("contacts.manage");
  const admin = createAdminClient();
  const [{ data: tags }, { data: usage }] = await Promise.all([
    admin.from("tags").select("id, name, color").eq("org_id", member.orgId).eq("scope", "contact").order("name"),
    admin.from("contact_tags").select("tag_id").eq("org_id", member.orgId),
  ]);
  const counts = new Map<string, number>();
  for (const u of usage ?? []) counts.set(u.tag_id, (counts.get(u.tag_id) ?? 0) + 1);

  return (
    <div className="flex flex-col gap-6">
      <PageHeader title="Tags" description="Labels for contacts. Tags can also be created on the fly from the contact drawer and bulk actions." />
      <TagsManager tags={(tags ?? []).map((t) => ({ ...t, count: counts.get(t.id) ?? 0 }))} />
    </div>
  );
}
