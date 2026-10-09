import Link from "next/link";

import { PageHeader } from "@/components/shell/page-header";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { requirePerm } from "@/lib/auth/session";
import { draftFromComponents, emptyDraft } from "@/lib/templates/builder";
import { galleryItem } from "@/lib/templates/gallery";
import {
  TEMPLATE_PAGE_SIZE,
  TEMPLATE_STATUSES,
  getTemplate,
  listTemplates,
} from "@/lib/templates/queries";
import { createClient } from "@/lib/supabase/server";
import { templateVariables } from "@/lib/whatsapp/templates";
import { cn } from "@/lib/utils";

import { formatShortWhen } from "../campaigns/format";
import { GalleryButton } from "./gallery-button";
import { STATUS_LABEL, templatesHref } from "./format";
import { RowActions } from "./row-actions";
import { SyncButton } from "./sync-button";
import { TemplateBuilder, type BuilderInit } from "./template-builder";

export const metadata = { title: "Templates" };
export const dynamic = "force-dynamic";

type Search = Record<string, string | string[] | undefined>;
const one = (v: string | string[] | undefined) => (Array.isArray(v) ? v[0] : v) ?? "";

const STATUS_VARIANT: Record<
  string,
  "default" | "secondary" | "outline" | "success" | "warning" | "destructive"
> = {
  APPROVED: "success",
  REINSTATED: "success",
  PENDING: "secondary",
  IN_APPEAL: "secondary",
  DRAFT: "outline",
  PAUSED: "warning",
  FLAGGED: "warning",
  LIMIT_EXCEEDED: "warning",
  LOCKED: "warning",
  REJECTED: "destructive",
  DISABLED: "destructive",
};

export default async function TemplatesPage({ searchParams }: { searchParams: Promise<Search> }) {
  const member = await requirePerm("templates.manage");
  const sp = await searchParams;
  const waba = one(sp.waba);
  const status = one(sp.status) || "all";
  const q = one(sp.q);
  const archived = one(sp.archived) === "1";
  const page = Math.max(1, Number.parseInt(one(sp.page), 10) || 1);
  const editId = one(sp.edit);
  const isNew = one(sp.new) === "1";
  const galleryKey = one(sp.gallery);
  const tz = member.org.timezone;

  const supabase = await createClient();
  const [{ data: channels }, list] = await Promise.all([
    supabase
      .from("channels")
      .select("id, name, waba_id, display_phone, status")
      .eq("org_id", member.orgId)
      .order("created_at"),
    listTemplates(supabase, member.orgId, { waba, status, q, archived, page }),
  ]);
  const activeChannels = (channels ?? []).filter((c) => c.status === "active");
  const wabas = [...new Map((channels ?? []).map((c) => [c.waba_id, c])).entries()].map(
    ([id, c]) => ({
      id,
      label:
        (channels ?? [])
          .filter((x) => x.waba_id === id)
          .map((x) => x.name)
          .join(", ") || c.name,
    }),
  );

  // Builder drawer: editing an existing template, or a new one (optionally from the gallery).
  let init: BuilderInit | null = null;
  if (editId) {
    const t = await getTemplate(supabase, member.orgId, editId);
    if (t) {
      const channelId =
        t.channel_id && activeChannels.some((c) => c.id === t.channel_id)
          ? t.channel_id
          : (activeChannels.find((c) => c.waba_id === t.waba_id)?.id ??
            activeChannels[0]?.id ??
            "");
      init = {
        id: t.id,
        status: t.status,
        submitted: !!t.meta_template_id,
        channelId,
        draft: draftFromComponents(
          { name: t.name, language: t.language, category: t.category, variableMap: t.variable_map },
          t.components,
        ),
        galleryKey: t.gallery_key,
        rejectedReason: t.status === "REJECTED" ? t.rejected_reason : null,
      };
    }
  } else if (isNew) {
    const g = galleryKey ? galleryItem(galleryKey) : undefined;
    init = {
      id: null,
      status: null,
      submitted: false,
      channelId: activeChannels[0]?.id ?? "",
      draft: g ? structuredClone(g.draft) : emptyDraft(),
      galleryKey: g?.key ?? null,
      rejectedReason: null,
    };
  }

  const keep = { waba, status, q, archived: archived ? "1" : "" };
  const closeHref = templatesHref({ ...keep, page });
  const pages = Math.max(1, Math.ceil(list.total / TEMPLATE_PAGE_SIZE));

  return (
    <div className="flex flex-col gap-5">
      <PageHeader
        title="Templates"
        description="WhatsApp message templates: build, submit to Meta for approval, and map their variables."
      >
        <SyncButton />
        <GalleryButton keep={keep} disabled={activeChannels.length === 0} />
      </PageHeader>

      {activeChannels.length === 0 && (
        <p className="text-muted-foreground rounded-xl border border-dashed p-4 text-sm">
          Add a WhatsApp number in{" "}
          <Link href="/settings/channels" className="underline">
            Settings → Channels
          </Link>{" "}
          to build and submit templates.
        </p>
      )}

      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex flex-wrap gap-1">
          {[
            "all",
            ...TEMPLATE_STATUSES.filter((s) =>
              [
                "DRAFT",
                "PENDING",
                "APPROVED",
                "REJECTED",
                "PAUSED",
                "DISABLED",
                "FLAGGED",
              ].includes(s),
            ),
          ].map((s) => (
            <Link
              key={s}
              href={templatesHref({ ...keep, status: s })}
              className={cn(
                "rounded-full border px-2.5 py-1 text-xs",
                status === s ? "bg-primary text-primary-foreground" : "hover:bg-accent",
              )}
            >
              {s === "all" ? "All statuses" : STATUS_LABEL[s]}
            </Link>
          ))}
          <Link
            href={templatesHref({ ...keep, archived: archived ? "" : "1" })}
            className={cn(
              "rounded-full border px-2.5 py-1 text-xs",
              archived ? "bg-primary text-primary-foreground" : "hover:bg-accent",
            )}
          >
            Archived
          </Link>
        </div>
        <div className="flex items-center gap-2">
          {wabas.length > 1 && (
            <div className="flex gap-1">
              <Link
                href={templatesHref({ ...keep, waba: "" })}
                className={cn(
                  "rounded-full border px-2.5 py-1 text-xs",
                  !waba ? "bg-primary text-primary-foreground" : "hover:bg-accent",
                )}
              >
                All numbers
              </Link>
              {wabas.map((w) => (
                <Link
                  key={w.id}
                  href={templatesHref({ ...keep, waba: w.id })}
                  className={cn(
                    "rounded-full border px-2.5 py-1 text-xs",
                    waba === w.id ? "bg-primary text-primary-foreground" : "hover:bg-accent",
                  )}
                >
                  {w.label}
                </Link>
              ))}
            </div>
          )}
          <form action="/templates" className="flex gap-2">
            {status !== "all" && <input type="hidden" name="status" value={status} />}
            {waba && <input type="hidden" name="waba" value={waba} />}
            {archived && <input type="hidden" name="archived" value="1" />}
            <input
              name="q"
              defaultValue={q}
              placeholder="Search templates"
              className="border-input bg-background h-8 w-52 rounded-md border px-2 text-sm"
            />
          </form>
        </div>
      </div>

      {list.rows.length === 0 ? (
        <p className="text-muted-foreground rounded-xl border border-dashed p-10 text-center text-sm">
          {q || status !== "all" || waba || archived
            ? "No templates match."
            : "No templates yet. Sync from Meta or start from the gallery."}
        </p>
      ) : (
        <div className="rounded-xl border">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Template</TableHead>
                <TableHead className="min-w-64">Message</TableHead>
                <TableHead>Category</TableHead>
                <TableHead>Status</TableHead>
                <TableHead>Updated</TableHead>
                <TableHead className="w-12" />
              </TableRow>
            </TableHeader>
            <TableBody>
              {list.rows.map((t) => {
                const vars = templateVariables(t.components);
                return (
                  <TableRow key={t.id}>
                    <TableCell>
                      <Link
                        href={templatesHref({ ...keep, page, edit: t.id })}
                        scroll={false}
                        className="font-medium hover:underline"
                      >
                        {t.name}
                      </Link>
                      <span className="mt-0.5 flex gap-1">
                        <Badge variant="outline">{t.language}</Badge>
                        <Badge variant="outline">{t.type.replace("_", " & ")}</Badge>
                      </span>
                    </TableCell>
                    <TableCell className="max-w-96">
                      <span className="line-clamp-2 text-sm" dir="auto">
                        {t.preview}
                      </span>
                    </TableCell>
                    <TableCell className="text-xs">{t.category.toLowerCase()}</TableCell>
                    <TableCell>
                      <Badge variant={STATUS_VARIANT[t.status] ?? "outline"}>
                        {STATUS_LABEL[t.status] ?? t.status}
                      </Badge>
                      {t.status === "REJECTED" && t.rejected_reason && (
                        <span className="text-muted-foreground mt-0.5 block text-xs">
                          {t.rejected_reason.replace(/_/g, " ").toLowerCase()}
                        </span>
                      )}
                    </TableCell>
                    <TableCell className="text-xs whitespace-nowrap">
                      {formatShortWhen(t.updated_at, tz)}
                    </TableCell>
                    <TableCell>
                      <RowActions
                        id={t.id}
                        editHref={templatesHref({ ...keep, page, edit: t.id })}
                        archived={!!t.archived_at}
                        map={{
                          id: t.id,
                          name: t.name,
                          variables: vars.map((v) => ({ key: v.key, example: v.example })),
                          map: t.variable_map,
                        }}
                      />
                    </TableCell>
                  </TableRow>
                );
              })}
            </TableBody>
          </Table>
        </div>
      )}

      {pages > 1 && (
        <div className="text-muted-foreground flex items-center justify-between text-xs">
          <span>
            Page {page} of {pages} · {list.total.toLocaleString()} templates
          </span>
          <span className="flex gap-2">
            {page > 1 && (
              <Button asChild size="sm" variant="outline">
                <Link href={templatesHref({ ...keep, page: page - 1 })}>Previous</Link>
              </Button>
            )}
            {page < pages && (
              <Button asChild size="sm" variant="outline">
                <Link href={templatesHref({ ...keep, page: page + 1 })}>Next</Link>
              </Button>
            )}
          </span>
        </div>
      )}

      {init && (
        <TemplateBuilder
          key={init.id ?? init.galleryKey ?? "new"}
          channels={activeChannels.map((c) => ({
            id: c.id,
            name: c.name,
            phone: c.display_phone,
            wabaId: c.waba_id,
          }))}
          init={init}
          closeHref={closeHref}
        />
      )}
    </div>
  );
}
