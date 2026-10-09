"use client";

import * as React from "react";
import { useRouter } from "next/navigation";
import {
  Archive,
  ArchiveRestore,
  Copy,
  Eye,
  Loader2,
  MoreHorizontal,
  Pencil,
  Plus,
  RefreshCw,
  Search,
  Sparkles,
  Trash2,
  Variable,
} from "lucide-react";
import { toast } from "sonner";

import { PageHeader } from "@/components/shell/page-header";
import { Badge } from "@/components/ui/badge";
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
import { STATUS_LABEL } from "@/lib/templates/rules";
import { TEMPLATE_LANGUAGES } from "@/lib/whatsapp/template-draft";

import { archiveTemplate, deleteTemplateAction, syncTemplates } from "./actions";
import { StatusBadge, QualityDot } from "./status-badge";
import { DuplicateDialog, GalleryDialog, VariableMapperDialog } from "./template-dialogs";
import { TemplateDrawer } from "./template-drawer";
import type { TemplatesBootstrap, TemplateView } from "./types";

const ALL = "__all__";

type Confirm = { kind: "archive" | "delete"; template: TemplateView; message?: string } | null;

export function TemplatesWorkspace({ bootstrap }: { bootstrap: TemplatesBootstrap }) {
  const { templates, channels, canManage, uploadsEnabled } = bootstrap;
  const router = useRouter();
  const refresh = React.useCallback(() => router.refresh(), [router]);

  const [q, setQ] = React.useState("");
  const [channel, setChannel] = React.useState(ALL);
  const [status, setStatus] = React.useState(ALL);
  const [category, setCategory] = React.useState(ALL);
  const [language, setLanguage] = React.useState(ALL);
  const [showArchived, setShowArchived] = React.useState(false);

  const [editing, setEditing] = React.useState<{
    template: TemplateView | null;
    key: number;
  } | null>(null);
  const [mapping, setMapping] = React.useState<TemplateView | null>(null);
  const [duplicating, setDuplicating] = React.useState<TemplateView | null>(null);
  const [gallery, setGallery] = React.useState(false);
  const [confirm, setConfirm] = React.useState<Confirm>(null);
  const [busy, setBusy] = React.useState<string | null>(null);

  const channelName = React.useMemo(() => new Map(channels.map((c) => [c.id, c])), [channels]);
  const rows = React.useMemo(() => {
    const needle = q.trim().toLowerCase();
    return templates.filter((t) => {
      if (!showArchived && (t.archived_at || t.status === "DELETED")) return false;
      if (channel !== ALL && t.channel_id !== channel) return false;
      if (status !== ALL && t.status !== status) return false;
      if (category !== ALL && t.category !== category) return false;
      if (language !== ALL && t.language !== language) return false;
      if (needle && !t.name.toLowerCase().includes(needle)) return false;
      return true;
    });
  }, [templates, q, channel, status, category, language, showArchived]);

  const statuses = React.useMemo(
    () => [...new Set(templates.map((t) => t.status))].sort(),
    [templates],
  );

  async function sync() {
    const targets =
      channel !== ALL ? [channel] : channels.filter((c) => c.status === "active").map((c) => c.id);
    if (targets.length === 0) return void toast.error("No active WhatsApp number to sync.");
    setBusy("sync");
    let synced = 0;
    let failed = 0;
    for (const id of targets) {
      const r = await syncTemplates(id);
      if (r.ok) synced += r.synced;
      else {
        failed++;
        toast.error(r.error);
      }
    }
    setBusy(null);
    if (failed < targets.length)
      toast.success(`Synced ${synced} template${synced === 1 ? "" : "s"} from Meta.`);
    refresh();
  }

  async function runConfirmed(c: NonNullable<Confirm>) {
    setBusy(c.kind);
    const r =
      c.kind === "archive"
        ? await archiveTemplate(c.template.id, true, true)
        : await deleteTemplateAction(c.template.id, true);
    setBusy(null);
    if (!r.ok) return void toast.error(r.error);
    toast.success(c.kind === "archive" ? "Archived." : "Deleted.");
    setConfirm(null);
    refresh();
  }

  async function archive(t: TemplateView, archived: boolean) {
    setBusy(t.id);
    const r = await archiveTemplate(t.id, archived);
    setBusy(null);
    if (r.ok) {
      toast.success(archived ? "Archived." : "Restored.");
      refresh();
    } else if (r.confirm) setConfirm({ kind: "archive", template: t, message: r.error });
    else toast.error(r.error);
  }

  async function remove(t: TemplateView) {
    setBusy(t.id);
    const r = await deleteTemplateAction(t.id);
    setBusy(null);
    if (r.ok) {
      toast.success("Deleted.");
      refresh();
    } else if (r.confirm) setConfirm({ kind: "delete", template: t, message: r.error });
    else setConfirm({ kind: "delete", template: t, message: undefined });
    if (!r.ok && !r.confirm) toast.error(r.error);
  }

  const open = (t: TemplateView | null) => setEditing({ template: t, key: Date.now() });

  return (
    <div className="space-y-4">
      <PageHeader
        title="Templates"
        description="WhatsApp message templates. Meta reviews each one before it can be sent outside the 24-hour window."
      >
        {canManage ? (
          <>
            <Button
              variant="outline"
              onClick={() => setGallery(true)}
              disabled={channels.length === 0}
            >
              <Sparkles className="size-4" />
              Starter templates
            </Button>
            <Button
              variant="outline"
              onClick={sync}
              disabled={busy === "sync" || channels.length === 0}
            >
              {busy === "sync" ? (
                <Loader2 className="size-4 animate-spin" />
              ) : (
                <RefreshCw className="size-4" />
              )}
              Sync from Meta
            </Button>
            <Button onClick={() => open(null)} disabled={channels.length === 0}>
              <Plus className="size-4" />
              New template
            </Button>
          </>
        ) : null}
      </PageHeader>

      {channels.length === 0 ? (
        <p className="text-muted-foreground rounded-md border border-dashed p-6 text-center text-sm">
          Connect a WhatsApp number in Settings → Channels first. Templates belong to a number.
        </p>
      ) : null}

      <div className="flex flex-wrap items-center gap-2">
        <div className="relative">
          <Search className="text-muted-foreground absolute start-2.5 top-2.5 size-4" />
          <Input
            className="w-56 ps-8"
            placeholder="Search by name"
            value={q}
            onChange={(e) => setQ(e.target.value)}
          />
        </div>
        <Select value={channel} onValueChange={setChannel}>
          <SelectTrigger className="w-44">
            <SelectValue placeholder="Number" />
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
          <SelectTrigger className="w-40">
            <SelectValue placeholder="Status" />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value={ALL}>Any status</SelectItem>
            {statuses.map((s) => (
              <SelectItem key={s} value={s}>
                {STATUS_LABEL[s] ?? s}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        <Select value={category} onValueChange={setCategory}>
          <SelectTrigger className="w-40">
            <SelectValue placeholder="Category" />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value={ALL}>Any category</SelectItem>
            {["MARKETING", "UTILITY", "AUTHENTICATION"].map((c) => (
              <SelectItem key={c} value={c}>
                {c.charAt(0) + c.slice(1).toLowerCase()}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        <Select value={language} onValueChange={setLanguage}>
          <SelectTrigger className="w-36">
            <SelectValue placeholder="Language" />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value={ALL}>Any language</SelectItem>
            {TEMPLATE_LANGUAGES.map((l) => (
              <SelectItem key={l.code} value={l.code}>
                {l.label}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        <label className="text-muted-foreground ms-auto flex items-center gap-2 text-sm">
          <Switch checked={showArchived} onCheckedChange={setShowArchived} />
          Show archived
        </label>
      </div>

      <div className="rounded-md border">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Name</TableHead>
              <TableHead>Language</TableHead>
              <TableHead>Category</TableHead>
              <TableHead>Number</TableHead>
              <TableHead>Status</TableHead>
              <TableHead>Updated</TableHead>
              <TableHead className="w-10" />
            </TableRow>
          </TableHeader>
          <TableBody>
            {rows.length === 0 ? (
              <TableRow>
                <TableCell colSpan={7} className="text-muted-foreground h-24 text-center">
                  {templates.length === 0
                    ? "No templates yet. Sync from Meta, add the starter templates, or create one."
                    : "No templates match these filters."}
                </TableCell>
              </TableRow>
            ) : (
              rows.map((t) => (
                <TableRow key={t.id} className="cursor-pointer" onClick={() => open(t)}>
                  <TableCell>
                    <div className="font-medium">{t.name}</div>
                    <div className="flex flex-wrap gap-1 pt-0.5">
                      {t.source === "gallery" ? <Badge variant="outline">starter</Badge> : null}
                      {t.needs_review ? <Badge variant="warning">needs review</Badge> : null}
                      {t.internal_key ? (
                        <Badge variant="outline">clinical · {t.clinical_approval}</Badge>
                      ) : null}
                    </div>
                  </TableCell>
                  <TableCell className="uppercase">{t.language}</TableCell>
                  <TableCell className="capitalize">{t.category.toLowerCase()}</TableCell>
                  <TableCell>
                    {(t.channel_id && channelName.get(t.channel_id)?.name) || "—"}
                  </TableCell>
                  <TableCell>
                    <div className="flex items-center gap-1.5">
                      <StatusBadge
                        status={t.status}
                        archived={!!t.archived_at && t.status !== "DELETED"}
                      />
                      <QualityDot quality={t.quality} />
                    </div>
                    {t.status === "REJECTED" && t.rejected_reason ? (
                      <div className="text-destructive pt-0.5 text-xs">
                        {t.rejected_reason.replaceAll("_", " ").toLowerCase()}
                      </div>
                    ) : null}
                    {t.last_error && t.status === "DRAFT" ? (
                      <div className="text-destructive pt-0.5 text-xs">Last submit failed</div>
                    ) : null}
                  </TableCell>
                  <TableCell className="text-muted-foreground text-xs">
                    {new Date(t.updated_at).toLocaleDateString()}
                  </TableCell>
                  <TableCell onClick={(e) => e.stopPropagation()}>
                    <DropdownMenu>
                      <DropdownMenuTrigger asChild>
                        <Button
                          variant="ghost"
                          size="icon"
                          className="size-8"
                          aria-label={`Actions for ${t.name}`}
                          disabled={busy === t.id}
                        >
                          {busy === t.id ? (
                            <Loader2 className="size-4 animate-spin" />
                          ) : (
                            <MoreHorizontal className="size-4" />
                          )}
                        </Button>
                      </DropdownMenuTrigger>
                      <DropdownMenuContent align="end">
                        <DropdownMenuItem onSelect={() => open(t)}>
                          {canManage ? <Pencil className="size-4" /> : <Eye className="size-4" />}
                          {canManage ? "Edit" : "View"}
                        </DropdownMenuItem>
                        {canManage ? (
                          <>
                            <DropdownMenuItem onSelect={() => setMapping(t)}>
                              <Variable className="size-4" />
                              Map variables
                            </DropdownMenuItem>
                            <DropdownMenuItem onSelect={() => setDuplicating(t)}>
                              <Copy className="size-4" />
                              Duplicate
                            </DropdownMenuItem>
                            <DropdownMenuSeparator />
                            {t.archived_at ? (
                              <DropdownMenuItem onSelect={() => archive(t, false)}>
                                <ArchiveRestore className="size-4" />
                                Unarchive
                              </DropdownMenuItem>
                            ) : (
                              <DropdownMenuItem onSelect={() => archive(t, true)}>
                                <Archive className="size-4" />
                                Archive
                              </DropdownMenuItem>
                            )}
                            <DropdownMenuItem variant="destructive" onSelect={() => remove(t)}>
                              <Trash2 className="size-4" />
                              Delete
                            </DropdownMenuItem>
                          </>
                        ) : null}
                      </DropdownMenuContent>
                    </DropdownMenu>
                  </TableCell>
                </TableRow>
              ))
            )}
          </TableBody>
        </Table>
      </div>
      <p className="text-muted-foreground text-xs">
        {rows.length} of {templates.length} templates
      </p>

      {editing ? (
        <TemplateDrawer
          key={editing.key}
          open
          template={editing.template}
          channels={channels}
          canManage={canManage}
          uploadsEnabled={uploadsEnabled}
          onClose={() => setEditing(null)}
          onChanged={refresh}
        />
      ) : null}
      <VariableMapperDialog
        template={mapping}
        onClose={() => setMapping(null)}
        onChanged={refresh}
      />
      <DuplicateDialog
        template={duplicating}
        channels={channels}
        onClose={() => setDuplicating(null)}
        onCreated={() => {
          setDuplicating(null);
          refresh();
        }}
      />
      <GalleryDialog
        open={gallery}
        channels={channels}
        onClose={() => setGallery(false)}
        onInstalled={refresh}
      />

      <Dialog open={!!confirm} onOpenChange={(o) => !o && setConfirm(null)}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>
              {confirm?.kind === "delete" ? "Delete template?" : "Archive template?"}
            </DialogTitle>
            <DialogDescription>
              {confirm?.message ?? "This could not be completed."}
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="ghost" onClick={() => setConfirm(null)}>
              Cancel
            </Button>
            {confirm?.message ? (
              <Button
                variant="destructive"
                disabled={busy !== null}
                onClick={() => confirm && runConfirmed(confirm)}
              >
                {busy ? <Loader2 className="size-4 animate-spin" /> : null}
                {confirm.kind === "delete" ? "Delete anyway" : "Archive anyway"}
              </Button>
            ) : null}
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
