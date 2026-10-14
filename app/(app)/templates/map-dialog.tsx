"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { Loader2 } from "lucide-react";
import { toast } from "sonner";

import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { MediaPicker } from "@/components/media/media-picker";
import { TEMPLATE_HEADER_TYPES, type MediaKind } from "@/lib/media/limits";
import { mediaSource } from "@/lib/media/paths";
import { TEMPLATE_SOURCES } from "@/lib/templates/sources";

import { saveTemplateVariableMap } from "./actions";

export type MapTemplate = {
  id: string;
  name: string;
  /** `kind` marks header media (image/video/document) and URL-button suffixes; carousel cards add `card.N.*` keys. */
  variables: Array<{ key: string; example: string | null; kind?: string }>;
  map: Record<string, string>;
  /** The header media format this template needs, if any (offers the Media Library for `header.media`). */
  headerKind?: MediaKind | null;
};

function mediaKindOf(kind: string | undefined): MediaKind | null {
  return kind === "image" || kind === "video" || kind === "document" ? kind : null;
}

/** A short hint for keys that are not plain text, so the person knows what the value is used for. */
function keyHint(key: string, kind: string | undefined): string | null {
  const card = /^card\.(\d+)\./.exec(key);
  const where = card ? `Card ${Number(card[1]) + 1}: ` : "";
  if (mediaKindOf(kind)) return `${where}header ${kind}`;
  if (kind === "url_suffix") return `${where}end of the button link`;
  if (kind === "copy_code") return `${where}code to copy`;
  if (kind === "catalog_thumbnail")
    return `${where}optional: catalogue item (content ID) shown as the picture`;
  return card ? `${where}text` : null;
}

const NONE = "__none__";
const TEXT = "__text__";
const LIBRARY = "__library__";

function kindOf(value: string | undefined) {
  if (!value) return NONE;
  if (value.startsWith("media:")) return LIBRARY;
  return value.startsWith("text:") ? TEXT : value;
}

export function MapDialog({
  open,
  onOpenChange,
  template,
}: {
  open: boolean;
  onOpenChange: (o: boolean) => void;
  template: MapTemplate;
}) {
  const router = useRouter();
  // Only keys the template still has: a stale entry (for example the code button's old `button.0`) could not be
  // removed here and would make every save fail.
  const [map, setMap] = useState<Record<string, string>>(() =>
    Object.fromEntries(
      Object.entries(template.map).filter(([k]) => template.variables.some((v) => v.key === k)),
    ),
  );
  const [pending, startTransition] = useTransition();
  /** The header-media key the Media Library picker is choosing for (message header or a carousel card). */
  const [pickerFor, setPickerFor] = useState<string | null>(null);
  const kindFor = (key: string): MediaKind | null =>
    mediaKindOf(template.variables.find((v) => v.key === key)?.kind) ??
    (key === "header.media" ? (template.headerKind ?? null) : null);
  const pickerKind = pickerFor ? kindFor(pickerFor) : null;

  function set(key: string, kind: string) {
    if (kind === LIBRARY) {
      setPickerFor(key);
      return;
    }
    setMap((p) => {
      const next = { ...p };
      if (kind === NONE) delete next[key];
      else if (kind === TEXT) next[key] = "text:";
      else next[key] = kind;
      return next;
    });
  }

  function save() {
    startTransition(async () => {
      const r = await saveTemplateVariableMap(template.id, map);
      if (!r.ok) {
        toast.error(r.error);
        return;
      }
      toast.success(r.message ?? "Saved.");
      onOpenChange(false);
      router.refresh();
    });
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>Map variables · {template.name}</DialogTitle>
          <DialogDescription>
            What fills each variable when this template is sent from the inbox, as a reminder or in
            a campaign (a campaign can still override it).
          </DialogDescription>
        </DialogHeader>
        {template.variables.length === 0 ? (
          <p className="text-muted-foreground text-sm">This template has no variables.</p>
        ) : (
          <div className="flex flex-col gap-3">
            {template.variables.map((v) => {
              const kind = kindOf(map[v.key]);
              const hint = keyHint(v.key, v.kind);
              return (
                <div key={v.key} className="grid gap-1.5 sm:grid-cols-[7rem_1fr]">
                  <div>
                    <code className="text-xs break-all">{v.key}</code>
                    {hint && <span className="text-muted-foreground block text-xs">{hint}</span>}
                    {v.example && (
                      <span className="text-muted-foreground block truncate text-xs">
                        e.g. {v.example}
                      </span>
                    )}
                  </div>
                  <div className="flex flex-col gap-1.5">
                    <Select value={kind} onValueChange={(val) => set(v.key, val)}>
                      <SelectTrigger>
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent>
                        <SelectItem value={NONE}>Not mapped</SelectItem>
                        {TEMPLATE_SOURCES.map((s) => (
                          <SelectItem key={s.key} value={s.key}>
                            {s.label}
                          </SelectItem>
                        ))}
                        <SelectItem value={TEXT}>Fixed text…</SelectItem>
                        {kindFor(v.key) && (
                          <SelectItem value={LIBRARY}>
                            {kind === LIBRARY
                              ? "Media Library file (change…)"
                              : "Media Library file…"}
                          </SelectItem>
                        )}
                      </SelectContent>
                    </Select>
                    {kind === LIBRARY && (
                      <span className="text-muted-foreground text-xs">
                        A Media Library file is sent with every message. Change it from the list
                        above.
                      </span>
                    )}
                    {kind === TEXT && (
                      <Input
                        value={map[v.key]?.slice(5) ?? ""}
                        onChange={(e) =>
                          setMap((p) => ({ ...p, [v.key]: `text:${e.target.value}` }))
                        }
                        placeholder="Same text every time"
                      />
                    )}
                  </div>
                </div>
              );
            })}
          </div>
        )}
        {pickerFor && pickerKind && (
          <MediaPicker
            open
            onOpenChange={(o) => !o && setPickerFor(null)}
            kind={pickerKind}
            mimes={TEMPLATE_HEADER_TYPES[pickerKind]}
            title="Choose the header file"
            onPick={(a) => {
              const key = pickerFor;
              setMap((p) => ({ ...p, [key]: mediaSource(a.id) }));
              setPickerFor(null);
            }}
          />
        )}
        <DialogFooter>
          <Button variant="ghost" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button onClick={save} disabled={pending || template.variables.length === 0}>
            {pending && <Loader2 className="animate-spin" />} Save
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
