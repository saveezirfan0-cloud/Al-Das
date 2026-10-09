"use client";

import { useMemo, useState, useTransition } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { formatDistanceToNow } from "date-fns";
import {
  Archive,
  ArchiveRestore,
  Copy,
  Library,
  Loader2,
  MoreHorizontal,
  Pencil,
  Plus,
  RefreshCw,
  Search,
  SlidersHorizontal,
  Trash2,
} from "lucide-react";
import { toast } from "sonner";

import { PageHeader } from "@/components/shell/page-header";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Input } from "@/components/ui/input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Switch } from "@/components/ui/switch";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { Label } from "@/components/ui/label";
import { TEMPLATE_LANGUAGES } from "@/lib/whatsapp/template-builder";
import { isMetaEditable, TEMPLATE_STATUSES } from "@/lib/whatsapp/template-fields";
import type { MetaTemplateComponent } from "@/lib/whatsapp/types";

import { archiveTemplate, deleteTemplate, duplicateTemplate, syncTemplates } from "./actions";
import { blankInit, galleryInit, rowInit, type DrawerInit } from "./drawer-init";
import { GalleryDialog } from "./gallery-dialog";
import { CategoryBadge, StatusBadge } from "./status-badge";
import { TemplateDrawer } from "./template-drawer";
import type { TemplateRow, TemplatesBootstrap } from "./types";
import { VariableMapperDialog } from "./variable-mapper-dialog";

const ALL = "__all";

function bodyText(row: TemplateRow): string {
  const body = (row.components as unknown as MetaTemplateComponent[]).find(
    (c) => c.type === "BODY",
  ) as { text?: string } | undefined;
  return body?.text ?? "";
}

export function TemplatesWorkspace({ bootstrap }: { bootstrap: TemplatesBootstrap }) {
  const { rows, channels, lastSyncedAt, hasMetaAppId } = bootstrap;
  const router = useRouter();
  const [pending, start] = useTransition();

  const [search, setSearch] = useState("");
  const [channel, setChannel] = useState(ALL);
  const [status, setStatus] = useState(ALL);
  const [category, setCategory] = useState(ALL);
  const [language, setLanguage] = useState(ALL);
  const [showArchived, setShowArchived] = useState(false);

  const [drawer, setDrawer] = useState<DrawerInit | null>(null);
  const [drawerOpen, setDrawerOpen] = useState(false);
  const [gallery, setGallery] = useState(false);
  const [mapRow, setMapRow] = useState<TemplateRow | null>(null);
  const [deleteRow, setDeleteRow] = useState<TemplateRow | null>(null);

  const channelName = useMemo(() => new Map(channels.map((c) => [c.id, c.name])), [channels]);

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase();
    return rows.filter((r) => {
      if (!showArchived && r.archived_at) return false;
      if (showArchived && !r.archived_at) return false;
      if (channel !== ALL && r.channel_id !== channel) return false;
      if (status !== ALL && r.status !== status) return false;
      if (category !== ALL && r.category !== category) return false;
      if (language !== ALL && r.language !== language) return false;
      if (q && !r.name.includes(q) && !bodyText(r).toLowerCase().includes(q)) return false;
      return true;
    });
  }, [rows, search, channel, status, category, language, showArchived]);

  function openInit(init: DrawerInit) {
    setDrawer(init);
    setDrawerOpen(true);
  }

  function run(fn: () => Promise<{ ok: boolean; message?: string; error?: string }>) {
    start(async () => {
      const r = await fn();
      if (r.ok) toast.success(r.message ?? "Done.");
      else toast.error(r.error ?? "Something went wrong.");
      router.refresh();
    });
  }

  const noChannels = channels.length === 0;
  const defaultChannel = channels[0]?.id ?? "";

  return (
    <div className="flex flex-col gap-4 p-4 md:p-6">
      <PageHeader
        title="Templates"
        description="WhatsApp message templates: build, submit to Meta and keep in sync."
      >
        <Button
          variant="outline"
          disabled={pending || noChannels}
          onClick={() => run(() => syncTemplates())}
        >
          {pending ? <Loader2 className="animate-spin" /> : <RefreshCw />} Sync templates
        </Button>
        <Button variant="outline" disabled={noChannels} onClick={() => setGallery(true)}>
          <Library /> Gallery
        </Button>
        <Button disabled={noChannels} onClick={() => openInit(blankInit(defaultChannel))}>
          <Plus /> New template
        </Button>
      </PageHeader>

      {noChannels && (
        <Alert>
          <AlertTitle>Connect a WhatsApp number first</AlertTitle>
          <AlertDescription>
            Templates belong to a WhatsApp Business account.{" "}
            <Link href="/settings/channels" className="underline">
              Add a number in Settings → Channels
            </Link>
            .
          </AlertDescription>
        </Alert>
      )}

      {!noChannels && !hasMetaAppId && (
        <Alert>
          <AlertTitle>Media samples need META_APP_ID</AlertTitle>
          <AlertDescription>
            Text templates work as they are. To upload header images, videos or PDFs, set the{" "}
            <code>META_APP_ID</code> environment variable (Meta app → Settings → Basic).
          </AlertDescription>
        </Alert>
      )}

      <div className="flex flex-wrap items-end gap-3">
        <div className="relative min-w-52 flex-1">
          <Search
            className="text-muted-foreground pointer-events-none absolute start-2 top-1/2 size-4 -translate-y-1/2"
            aria-hidden
          />
          <Input
            aria-label="Search templates"
            className="ps-8"
            placeholder="Search by name or text"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
          />
        </div>
        <Select value={channel} onValueChange={setChannel}>
          <SelectTrigger className="w-44" aria-label="Number filter">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value={ALL}>All numbers</SelectItem>
            {channels.map((c) => (
              <SelectItem key={c.id} value={c.id}>
                {c.name}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        <Select value={status} onValueChange={setStatus}>
          <SelectTrigger className="w-44" aria-label="Status filter">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value={ALL}>All statuses</SelectItem>
            {TEMPLATE_STATUSES.map((s) => (
              <SelectItem key={s.value} value={s.value}>
                {s.label}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        <Select value={category} onValueChange={setCategory}>
          <SelectTrigger className="w-40" aria-label="Category filter">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value={ALL}>All categories</SelectItem>
            <SelectItem value="UTILITY">Utility</SelectItem>
            <SelectItem value="MARKETING">Marketing</SelectItem>
            <SelectItem value="AUTHENTICATION">Authentication</SelectItem>
          </SelectContent>
        </Select>
        <Select value={language} onValueChange={setLanguage}>
          <SelectTrigger className="w-36" aria-label="Language filter">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value={ALL}>All languages</SelectItem>
            {TEMPLATE_LANGUAGES.map((l) => (
              <SelectItem key={l.code} value={l.code}>
                {l.label}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        <div className="flex items-center gap-2 pb-2">
          <Switch id="archived" checked={showArchived} onCheckedChange={setShowArchived} />
          <Label htmlFor="archived">Archived</Label>
        </div>
      </div>

      <p className="text-muted-foreground text-xs">
        {filtered.length} template{filtered.length === 1 ? "" : "s"}
        {" · "}
        {lastSyncedAt
          ? `last synced ${formatDistanceToNow(new Date(lastSyncedAt), { addSuffix: true })}`
          : "not synced yet"}
        {" · nightly sync at 02:00 UTC"}
      </p>

      <div className="overflow-x-auto rounded-md border">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Template</TableHead>
              <TableHead>Number</TableHead>
              <TableHead>Category</TableHead>
              <TableHead>Status</TableHead>
              <TableHead>Quality</TableHead>
              <TableHead>Updated</TableHead>
              <TableHead className="w-10" />
            </TableRow>
          </TableHeader>
          <TableBody>
            {filtered.length === 0 && (
              <TableRow>
                <TableCell colSpan={7} className="text-muted-foreground py-10 text-center">
                  {rows.length === 0
                    ? "No templates yet. Start from the gallery or sync the ones already on your WhatsApp account."
                    : "No templates match these filters."}
                </TableCell>
              </TableRow>
            )}
            {filtered.map((r) => {
              const editable = !r.meta_template_id || isMetaEditable(r.status);
              return (
                <TableRow key={r.id}>
                  <TableCell className="max-w-72">
                    <button
                      type="button"
                      className="text-start hover:underline"
                      onClick={() => openInit(rowInit(r))}
                    >
                      <span className="block truncate font-medium">{r.name}</span>
                    </button>
                    <span className="text-muted-foreground block truncate text-xs">
                      {r.language.toUpperCase()} · {r.type.replace("_", " & ")}
                      {bodyText(r) ? ` · ${bodyText(r)}` : ""}
                    </span>
                    {(r.rejected_reason || r.submit_error) && (
                      <span className="text-destructive block truncate text-xs">
                        {r.rejected_reason || r.submit_error}
                      </span>
                    )}
                  </TableCell>
                  <TableCell>{(r.channel_id && channelName.get(r.channel_id)) || "—"}</TableCell>
                  <TableCell>
                    <CategoryBadge category={r.category} />
                  </TableCell>
                  <TableCell>
                    <StatusBadge status={r.status} archived={!!r.archived_at} />
                  </TableCell>
                  <TableCell className="text-muted-foreground text-sm">
                    {r.quality ? r.quality.toLowerCase() : "—"}
                  </TableCell>
                  <TableCell className="text-muted-foreground text-sm whitespace-nowrap">
                    {formatDistanceToNow(new Date(r.updated_at), { addSuffix: true })}
                  </TableCell>
                  <TableCell>
                    <DropdownMenu>
                      <DropdownMenuTrigger asChild>
                        <Button
                          variant="ghost"
                          size="icon-sm"
                          aria-label={`Actions for ${r.name}`}
                          disabled={pending}
                        >
                          <MoreHorizontal />
                        </Button>
                      </DropdownMenuTrigger>
                      <DropdownMenuContent align="end" className="w-48">
                        <DropdownMenuItem onSelect={() => openInit(rowInit(r))}>
                          <Pencil /> {editable ? "Edit" : "View"}
                        </DropdownMenuItem>
                        <DropdownMenuItem onSelect={() => setMapRow(r)}>
                          <SlidersHorizontal /> Map variables
                        </DropdownMenuItem>
                        <DropdownMenuItem onSelect={() => run(() => duplicateTemplate(r.id))}>
                          <Copy /> Duplicate
                        </DropdownMenuItem>
                        <DropdownMenuItem
                          onSelect={() => run(() => archiveTemplate(r.id, !r.archived_at))}
                        >
                          {r.archived_at ? <ArchiveRestore /> : <Archive />}
                          {r.archived_at ? "Unarchive" : "Archive"}
                        </DropdownMenuItem>
                        <DropdownMenuSeparator />
                        <DropdownMenuItem variant="destructive" onSelect={() => setDeleteRow(r)}>
                          <Trash2 /> Delete
                        </DropdownMenuItem>
                      </DropdownMenuContent>
                    </DropdownMenu>
                  </TableCell>
                </TableRow>
              );
            })}
          </TableBody>
        </Table>
      </div>

      {drawer && (
        <TemplateDrawer
          key={drawer.key}
          init={drawer}
          open={drawerOpen}
          onOpenChange={setDrawerOpen}
          channels={channels}
        />
      )}

      <GalleryDialog
        open={gallery}
        onOpenChange={setGallery}
        channels={channels}
        onUse={(g, lang, channelId) => {
          setGallery(false);
          openInit(galleryInit(g, lang, channelId));
        }}
      />

      {mapRow && (
        <VariableMapperDialog
          key={mapRow.id}
          template={mapRow}
          open
          onOpenChange={(o) => !o && setMapRow(null)}
        />
      )}

      <Dialog open={!!deleteRow} onOpenChange={(o) => !o && setDeleteRow(null)}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Delete “{deleteRow?.name}”?</DialogTitle>
            <DialogDescription>
              {deleteRow?.meta_template_id
                ? `This deletes the ${deleteRow.language.toUpperCase()} version from your WhatsApp account at Meta. Messages already sent are not affected. It cannot be undone.`
                : "This draft will be removed."}
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="ghost" onClick={() => setDeleteRow(null)}>
              Cancel
            </Button>
            <Button
              variant="destructive"
              disabled={pending}
              onClick={() => {
                const id = deleteRow?.id;
                setDeleteRow(null);
                if (id) run(() => deleteTemplate(id));
              }}
            >
              Delete
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
