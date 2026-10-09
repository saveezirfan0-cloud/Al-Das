"use client";

import * as React from "react";
import { Loader2 } from "lucide-react";
import { toast } from "sonner";

import { PhonePreview } from "@/components/whatsapp/phone-preview";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { ScrollArea } from "@/components/ui/scroll-area";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  VARIABLE_SOURCES,
  draftToComponents,
  TEMPLATE_LANGUAGES,
} from "@/lib/whatsapp/template-draft";
import { GALLERY } from "@/lib/whatsapp/template-gallery";
import { templateVariables } from "@/lib/whatsapp/templates";

import { duplicateTemplateAction, installStarterTemplates, saveVariableMap } from "./actions";
import type { ChannelOption, TemplateView } from "./types";

const NONE = "__none__";

export function VariableMapperDialog({
  template,
  onClose,
  onChanged,
}: {
  template: TemplateView | null;
  onClose: () => void;
  onChanged: () => void;
}) {
  const [map, setMap] = React.useState<Record<string, string>>({});
  const [busy, setBusy] = React.useState(false);
  React.useEffect(() => setMap(template?.variable_map ?? {}), [template]);
  const vars = template
    ? templateVariables(template.components).filter(
        (v) => v.component === "body" && v.kind === "text",
      )
    : [];

  async function save() {
    if (!template) return;
    setBusy(true);
    const r = await saveVariableMap(template.id, map);
    setBusy(false);
    if (!r.ok) return void toast.error(r.error);
    toast.success("Mapping saved.");
    onChanged();
    onClose();
  }

  return (
    <Dialog open={!!template} onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>Map variables</DialogTitle>
          <DialogDescription>
            Choose what fills each variable when this template is sent from the Inbox, appointment
            reminders or campaigns. Unmapped variables are typed by the sender.
          </DialogDescription>
        </DialogHeader>
        {vars.length === 0 ? (
          <p className="text-muted-foreground text-sm">This template has no variables.</p>
        ) : (
          <div className="space-y-3">
            {vars.map((v) => (
              <div key={v.key} className="grid items-center gap-2 sm:grid-cols-[56px_1fr]">
                <div>
                  <code className="text-xs">{`{{${v.name}}}`}</code>
                  {v.example ? (
                    <div className="text-muted-foreground truncate text-[11px]">{v.example}</div>
                  ) : null}
                </div>
                <Select
                  value={map[v.key] ?? NONE}
                  onValueChange={(val) =>
                    setMap((m) => {
                      const next = { ...m };
                      if (val === NONE) delete next[v.key];
                      else next[v.key] = val;
                      return next;
                    })
                  }
                >
                  <SelectTrigger>
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value={NONE}>Typed by the sender</SelectItem>
                    {VARIABLE_SOURCES.map((s) => (
                      <SelectItem key={s.key} value={s.key}>
                        {s.label}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
            ))}
          </div>
        )}
        <DialogFooter>
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button onClick={save} disabled={busy || vars.length === 0}>
            {busy ? <Loader2 className="size-4 animate-spin" /> : null}Save
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

export function DuplicateDialog({
  template,
  channels,
  onClose,
  onCreated,
}: {
  template: TemplateView | null;
  channels: ChannelOption[];
  onClose: () => void;
  onCreated: (id: string) => void;
}) {
  const [name, setName] = React.useState("");
  const [language, setLanguage] = React.useState("en");
  const [channelId, setChannelId] = React.useState("");
  const [busy, setBusy] = React.useState(false);
  React.useEffect(() => {
    if (!template) return;
    setName(`${template.name}_copy`);
    setLanguage(template.language);
    setChannelId(template.channel_id ?? channels[0]?.id ?? "");
  }, [template, channels]);

  async function go() {
    if (!template) return;
    setBusy(true);
    const r = await duplicateTemplateAction(template.id, { name, language, channelId });
    setBusy(false);
    if (!r.ok) return void toast.error(r.error);
    toast.success("Copied as a draft.");
    onCreated(r.id);
  }

  return (
    <Dialog open={!!template} onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>Duplicate template</DialogTitle>
          <DialogDescription>
            Makes an editable draft. Use it to translate a template, move it to another number, or
            change an approved one without waiting on Meta&apos;s edit limit.
          </DialogDescription>
        </DialogHeader>
        <div className="space-y-3">
          <div className="space-y-1.5">
            <Label>New name</Label>
            <Input
              value={name}
              onChange={(e) => setName(e.target.value.toLowerCase().replace(/[^a-z0-9_]/g, "_"))}
            />
          </div>
          <div className="space-y-1.5">
            <Label>Language</Label>
            <Select value={language} onValueChange={setLanguage}>
              <SelectTrigger>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {TEMPLATE_LANGUAGES.map((l) => (
                  <SelectItem key={l.code} value={l.code}>
                    {l.label}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <div className="space-y-1.5">
            <Label>Number</Label>
            <Select value={channelId} onValueChange={setChannelId}>
              <SelectTrigger>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {channels.map((c) => (
                  <SelectItem key={c.id} value={c.id}>
                    {c.name}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
        </div>
        <DialogFooter>
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button onClick={go} disabled={busy || !name || !channelId}>
            {busy ? <Loader2 className="size-4 animate-spin" /> : null}Duplicate
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

export function GalleryDialog({
  open,
  channels,
  onClose,
  onInstalled,
}: {
  open: boolean;
  channels: ChannelOption[];
  onClose: () => void;
  onInstalled: () => void;
}) {
  const [picked, setPicked] = React.useState<Set<string>>(new Set());
  const [channelId, setChannelId] = React.useState(channels[0]?.id ?? "");
  const [focus, setFocus] = React.useState<string>(GALLERY[0].key);
  const [busy, setBusy] = React.useState(false);
  const preview = GALLERY.find((g) => g.key === focus) ?? GALLERY[0];

  const toggle = (key: string) =>
    setPicked((p) => {
      const n = new Set(p);
      if (n.has(key)) n.delete(key);
      else n.add(key);
      return n;
    });
  const pickLanguage = (lang: "en" | "ar") =>
    setPicked(new Set(GALLERY.filter((g) => g.language === lang).map((g) => g.key)));

  async function install() {
    setBusy(true);
    const r = await installStarterTemplates(channelId, [...picked]);
    setBusy(false);
    if (!r.ok) return void toast.error(r.error);
    toast.success(
      `${r.created} draft${r.created === 1 ? "" : "s"} added${r.skipped ? `, ${r.skipped} already there` : ""}.`,
    );
    setPicked(new Set());
    onInstalled();
    onClose();
  }

  return (
    <Dialog open={open} onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="sm:max-w-4xl">
        <DialogHeader>
          <DialogTitle>Starter templates</DialogTitle>
          <DialogDescription>
            Original clinic wording in English and Arabic. They are added as <strong>drafts</strong>
            ; nothing is sent to Meta until you review and submit. Arabic wording must be checked by
            a native speaker first.
          </DialogDescription>
        </DialogHeader>
        <div className="grid gap-4 md:grid-cols-[1fr_300px]">
          <div className="space-y-3">
            <div className="flex flex-wrap items-center gap-2">
              <Select value={channelId} onValueChange={setChannelId}>
                <SelectTrigger className="w-56">
                  <SelectValue placeholder="Number" />
                </SelectTrigger>
                <SelectContent>
                  {channels.map((c) => (
                    <SelectItem key={c.id} value={c.id}>
                      {c.name}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
              <Button size="sm" variant="outline" onClick={() => pickLanguage("en")}>
                All English
              </Button>
              <Button size="sm" variant="outline" onClick={() => pickLanguage("ar")}>
                All Arabic
              </Button>
              <Button size="sm" variant="ghost" onClick={() => setPicked(new Set())}>
                Clear
              </Button>
            </div>
            <ScrollArea className="h-80 rounded-md border">
              <ul className="divide-y">
                {GALLERY.map((g) => (
                  <li
                    key={g.key}
                    className={`flex items-start gap-2 p-2.5 ${focus === g.key ? "bg-muted/60" : ""}`}
                  >
                    <Checkbox
                      checked={picked.has(g.key)}
                      onCheckedChange={() => toggle(g.key)}
                      aria-label={`Select ${g.title} (${g.language})`}
                      className="mt-0.5"
                    />
                    <button
                      type="button"
                      className="min-w-0 flex-1 text-start"
                      onClick={() => setFocus(g.key)}
                    >
                      <div className="flex items-center gap-1.5 text-sm font-medium">
                        {g.title}
                        <Badge variant="outline" className="uppercase">
                          {g.language}
                        </Badge>
                        <Badge variant={g.draft.category === "MARKETING" ? "warning" : "secondary"}>
                          {g.draft.category.toLowerCase()}
                        </Badge>
                        {!g.reviewed ? <Badge variant="outline">needs review</Badge> : null}
                      </div>
                      <div className="text-muted-foreground truncate text-xs">{g.description}</div>
                    </button>
                  </li>
                ))}
              </ul>
            </ScrollArea>
          </div>
          <PhonePreview
            components={draftToComponents(preview.draft)}
            rtl={preview.language === "ar"}
          />
        </div>
        <DialogFooter>
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button onClick={install} disabled={busy || picked.size === 0 || !channelId}>
            {busy ? <Loader2 className="size-4 animate-spin" /> : null}
            Add {picked.size || ""} as drafts
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
