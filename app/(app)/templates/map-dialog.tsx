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
  variables: Array<{ key: string; example: string | null }>;
  map: Record<string, string>;
  /** The header media format this template needs, if any (offers the Media Library for `header.media`). */
  headerKind?: MediaKind | null;
};

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
  const [map, setMap] = useState<Record<string, string>>(template.map);
  const [pending, startTransition] = useTransition();
  const [pickerOpen, setPickerOpen] = useState(false);

  function set(key: string, kind: string) {
    if (kind === LIBRARY) {
      setPickerOpen(true);
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
              return (
                <div key={v.key} className="grid gap-1.5 sm:grid-cols-[7rem_1fr]">
                  <div>
                    <code className="text-xs">{v.key}</code>
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
                        {v.key === "header.media" && template.headerKind && (
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
        {template.headerKind && (
          <MediaPicker
            open={pickerOpen}
            onOpenChange={setPickerOpen}
            kind={template.headerKind}
            mimes={TEMPLATE_HEADER_TYPES[template.headerKind]}
            title="Choose the header file"
            onPick={(a) => setMap((p) => ({ ...p, "header.media": mediaSource(a.id) }))}
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
