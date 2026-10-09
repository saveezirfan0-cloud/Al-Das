"use client";

import { useMemo, useState, useTransition } from "react";
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
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Switch } from "@/components/ui/switch";
import { MAPPABLE_FIELDS } from "@/lib/whatsapp/template-fields";
import { templateVariables } from "@/lib/whatsapp/templates";
import type { MetaTemplateComponent } from "@/lib/whatsapp/types";

import { saveTemplateSettings } from "./actions";
import type { TemplateRow } from "./types";

const NONE = "__none";

function describe(key: string): string {
  const card = key.match(/^card\.(\d+)\.(.*)$/);
  const base = card ? card[2] : key;
  const prefix = card ? `Card ${Number(card[1]) + 1} · ` : "";
  const [part, name] = base.split(".");
  if (part === "body") return `${prefix}Body {{${name}}}`;
  if (part === "header") return `${prefix}Header {{${name}}}`;
  if (part === "button") return `${prefix}Button ${Number(name) + 1} link`;
  return `${prefix}${base}`;
}

/** Maps template variables to contact fields (used by the inbox picker and campaigns) and per-template settings. */
export function VariableMapperDialog({
  template,
  open,
  onOpenChange,
}: {
  template: TemplateRow;
  open: boolean;
  onOpenChange: (o: boolean) => void;
}) {
  const router = useRouter();
  const [pending, start] = useTransition();
  const vars = useMemo(
    () =>
      templateVariables(template.components as unknown as MetaTemplateComponent[]).filter(
        (v) => v.kind === "text" || v.kind === "url_suffix",
      ),
    [template.components],
  );
  const [map, setMap] = useState<Record<string, string>>(
    (template.variable_map ?? {}) as Record<string, string>,
  );
  const [retry, setRetry] = useState(template.retry_on_fail);

  function save() {
    start(async () => {
      const r = await saveTemplateSettings(template.id, {
        variable_map: map,
        retry_on_fail: retry,
      });
      if (!r.ok) {
        toast.error(r.error);
        return;
      }
      toast.success("Saved.");
      router.refresh();
      onOpenChange(false);
    });
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>Map variables · {template.name}</DialogTitle>
          <DialogDescription>
            Choose which contact detail fills each variable. The inbox template picker and campaigns
            use this as the default; anything unmapped is typed at send time.
          </DialogDescription>
        </DialogHeader>
        <div className="flex max-h-[50vh] flex-col gap-3 overflow-y-auto pe-1">
          {vars.length === 0 && (
            <p className="text-muted-foreground text-sm">This template has no text variables.</p>
          )}
          {vars.map((v) => (
            <div key={v.key} className="grid grid-cols-[1fr_1.2fr] items-center gap-3">
              <div className="min-w-0">
                <Label className="block truncate">{describe(v.key)}</Label>
                {v.example && (
                  <span className="text-muted-foreground block truncate text-xs">
                    e.g. {v.example}
                  </span>
                )}
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
                <SelectTrigger className="w-full" aria-label={`Field for ${describe(v.key)}`}>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value={NONE}>Type at send time</SelectItem>
                  {MAPPABLE_FIELDS.map((f) => (
                    <SelectItem key={f.key} value={f.key}>
                      {f.label}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
          ))}
        </div>
        <div className="flex items-start gap-3 rounded-md border p-3">
          <Switch id="retry" checked={retry} onCheckedChange={setRetry} />
          <div>
            <Label htmlFor="retry">Retry on temporary failure</Label>
            <p className="text-muted-foreground text-xs">
              Campaign sends of this template are retried when WhatsApp reports a temporary error.
            </p>
          </div>
        </div>
        <DialogFooter>
          <Button variant="ghost" onClick={() => onOpenChange(false)} disabled={pending}>
            Cancel
          </Button>
          <Button onClick={save} disabled={pending}>
            {pending && <Loader2 className="animate-spin" />} Save
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
