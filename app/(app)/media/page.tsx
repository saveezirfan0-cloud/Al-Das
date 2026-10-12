import { PageHeader } from "@/components/shell/page-header";
import { can, canAny, ForbiddenError } from "@/lib/auth/can";
import { requireMember } from "@/lib/auth/session";
import { listLibraryAssets } from "@/lib/media/library";
import { scannerLabel } from "@/lib/media/server";
import { createAdminClient } from "@/lib/supabase/admin";

import { MediaLibrary } from "./media-library";

export const metadata = { title: "Media Library" };
export const dynamic = "force-dynamic";

type Search = Record<string, string | string[] | undefined>;
const one = (v: string | string[] | undefined) => (Array.isArray(v) ? v[0] : v) ?? "";
const PAGE = 48;

export default async function MediaPage({ searchParams }: { searchParams: Promise<Search> }) {
  const member = await requireMember();
  if (!canAny(member, ["media.view", "media.manage"])) throw new ForbiddenError("media.view");
  const sp = await searchParams;
  const folder = one(sp.folder);
  const kind = one(sp.kind);
  const tag = one(sp.tag);
  const q = one(sp.q);
  const page = Math.max(1, Number(one(sp.page)) || 1);

  const admin = createAdminClient();
  const [list, { data: folders }, { data: tagRows }, { data: sizes }] = await Promise.all([
    listLibraryAssets(admin, member.orgId, {
      folder: /^[0-9a-f-]{36}$/i.test(folder) ? folder : folder === "none" ? "none" : null,
      kind: kind === "image" || kind === "video" || kind === "document" ? kind : null,
      tag,
      q,
      limit: PAGE,
      offset: (page - 1) * PAGE,
    }),
    admin.from("media_folders").select("id, name").eq("org_id", member.orgId).order("name"),
    admin
      .from("media_assets")
      .select("tags")
      .eq("org_id", member.orgId)
      .eq("status", "ready")
      .limit(1000),
    admin
      .from("media_assets")
      .select("size_bytes")
      .eq("org_id", member.orgId)
      .eq("status", "ready")
      .limit(5000),
  ]);
  const allTags = [...new Set((tagRows ?? []).flatMap((r) => r.tags))].sort().slice(0, 60);
  const totalBytes = (sizes ?? []).reduce((n, r) => n + r.size_bytes, 0);

  return (
    <div className="flex flex-col gap-4">
      <PageHeader
        title="Media Library"
        description="Images, PDFs and videos the team shares: template headers, campaigns, quick replies and conversations. Patient documents live on the patient, not here."
      />
      <MediaLibrary
        assets={list.assets}
        total={list.total}
        page={page}
        pageSize={PAGE}
        folders={folders ?? []}
        tags={allTags}
        filters={{ folder, kind, tag, q }}
        canManage={can(member, "media.manage")}
        scanner={scannerLabel()}
        totalBytes={totalBytes}
      />
    </div>
  );
}
