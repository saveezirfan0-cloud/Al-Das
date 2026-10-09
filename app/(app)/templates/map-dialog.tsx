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
import { TEMPLATE_SOURCES } from "@/lib/templates/sources";

import { saveTemplateVariableMap } from "./actions";

export type MapTemplate = {
  id: string;
  name: string;
  variables: Array<{ key: string; example: string | null }>;
  map: Record<string, string>;
};

const NONE = "__none__";
const TEXT = "__text__";

function kindOf(value: string | undefined) {
  if (!value) return NONE;
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

  function set(key: string, kind: string) {
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
                      </SelectContent>
                    </Select>
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
