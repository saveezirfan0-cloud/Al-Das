"use client";

import { useMemo, useState } from "react";

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
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { cn } from "@/lib/utils";
import { toComponents } from "@/lib/whatsapp/template-builder";
import {
  GALLERY,
  GALLERY_USE_CASES,
  USE_CASE_LABELS,
  galleryState,
  type GalleryTemplate,
} from "@/lib/whatsapp/template-gallery";

import { CategoryBadge } from "./status-badge";
import { PhonePreview } from "./phone-preview";
import type { ChannelOption } from "./types";

const ALL = "__all";

/** Browse the starter library (EN / AR), preview it, and start a draft from it. */
export function GalleryDialog({
  open,
  onOpenChange,
  channels,
  onUse,
}: {
  open: boolean;
  onOpenChange: (o: boolean) => void;
  channels: ChannelOption[];
  onUse: (g: GalleryTemplate, lang: "en" | "ar", channelId: string) => void;
}) {
  const [category, setCategory] = useState(ALL);
  const [useCase, setUseCase] = useState(ALL);
  const [lang, setLang] = useState<"en" | "ar">("en");
  const [picked, setPicked] = useState<string>(GALLERY[0].key);
  const [channelId, setChannelId] = useState(channels[0]?.id ?? "");

  const list = useMemo(
    () =>
      GALLERY.filter((g) => category === ALL || g.category === category).filter(
        (g) => useCase === ALL || g.useCase === useCase,
      ),
    [category, useCase],
  );
  const current = list.find((g) => g.key === picked) ?? list[0];
  const components = useMemo(
    () => (current ? toComponents(galleryState(current, lang)) : []),
    [current, lang],
  );

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-5xl">
        <DialogHeader>
          <DialogTitle>Starter gallery</DialogTitle>
          <DialogDescription>
            Original clinic templates in English and Arabic. Pick one, adjust it, then submit it to
            Meta. Arabic wording should be read by a native speaker on your team before sending.
          </DialogDescription>
        </DialogHeader>

        <div className="flex flex-wrap items-end gap-3">
          <div>
            <Label className="text-xs">Category</Label>
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
          </div>
          <div>
            <Label className="text-xs">Use case</Label>
            <Select value={useCase} onValueChange={setUseCase}>
              <SelectTrigger className="w-48" aria-label="Use case filter">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value={ALL}>All use cases</SelectItem>
                {GALLERY_USE_CASES.map((u) => (
                  <SelectItem key={u} value={u}>
                    {USE_CASE_LABELS[u]}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <div role="group" aria-label="Language" className="flex gap-1">
            {(["en", "ar"] as const).map((l) => (
              <Button
                key={l}
                type="button"
                size="sm"
                variant={lang === l ? "default" : "outline"}
                onClick={() => setLang(l)}
              >
                {l === "en" ? "English" : "العربية"}
              </Button>
            ))}
          </div>
        </div>

        <div className="grid min-h-0 gap-4 md:grid-cols-[1fr_340px]">
          <ul className="grid max-h-[50vh] content-start gap-2 overflow-y-auto pe-1 sm:grid-cols-2">
            {list.length === 0 && (
              <li className="text-muted-foreground p-3 text-sm">No templates match.</li>
            )}
            {list.map((g) => (
              <li key={g.key}>
                <button
                  type="button"
                  onClick={() => setPicked(g.key)}
                  aria-pressed={current?.key === g.key}
                  className={cn(
                    "hover:bg-accent flex h-full w-full flex-col gap-1.5 rounded-md border p-3 text-start",
                    current?.key === g.key && "border-primary ring-primary/30 ring-2",
                  )}
                >
                  <span className="text-sm font-medium" dir={lang === "ar" ? "rtl" : "ltr"}>
                    {g.title[lang]}
                  </span>
                  <span className="text-muted-foreground text-xs">{g.summary}</span>
                  <span className="mt-auto flex flex-wrap gap-1 pt-1">
                    <CategoryBadge category={g.category} />
                    <Badge variant="secondary">{USE_CASE_LABELS[g.useCase]}</Badge>
                  </span>
                </button>
              </li>
            ))}
          </ul>
          <div className="bg-muted/40 rounded-md p-3">
            {current ? (
              <PhonePreview components={components} language={lang} />
            ) : (
              <p className="text-muted-foreground text-sm">Select a template to preview it.</p>
            )}
          </div>
        </div>

        <DialogFooter className="items-end gap-3 sm:justify-between">
          <div className="w-full sm:w-72">
            <Label className="text-xs">WhatsApp number</Label>
            <Select value={channelId} onValueChange={setChannelId}>
              <SelectTrigger className="w-full" aria-label="WhatsApp number">
                <SelectValue placeholder="Choose a number" />
              </SelectTrigger>
              <SelectContent>
                {channels.map((c) => (
                  <SelectItem key={c.id} value={c.id}>
                    {c.name}
                    {c.display_phone ? ` · ${c.display_phone}` : ""}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <div className="flex gap-2">
            <Button variant="ghost" onClick={() => onOpenChange(false)}>
              Cancel
            </Button>
            <Button
              disabled={!current || !channelId}
              onClick={() => current && onUse(current, lang, channelId)}
            >
              Use this template
            </Button>
          </div>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
