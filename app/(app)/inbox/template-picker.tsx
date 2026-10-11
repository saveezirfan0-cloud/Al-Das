"use client";

import { useMemo, useState, useTransition } from "react";
import { Loader2, Search } from "lucide-react";
import { toast } from "sonner";

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
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { ScrollArea } from "@/components/ui/scroll-area";
import { PhonePreview } from "@/components/phone-preview/phone-preview";
import { renderTemplatePreview, templateVariables } from "@/lib/whatsapp/templates";
import { cn } from "@/lib/utils";

import { sendTemplateMessage } from "./actions";
import type { ConversationDetail, TemplateInfo } from "./types";

/** Default variable values from the contact, driven by the template's variable_map ("body.1" → "contact.first_name"). */
function defaults(t: TemplateInfo, c: ConversationDetail): Record<string, string> {
  const source: Record<string, string> = {
    "contact.first_name": c.contact.first_name || c.contact.wa_profile_name?.split(" ")[0] || "",
    "contact.last_name": c.contact.last_name,
    "contact.name":
      `${c.contact.first_name} ${c.contact.last_name}`.trim() || c.contact.wa_profile_name || "",
    "contact.phone": c.contact.phone_e164 ?? "",
  };
  const out: Record<string, string> = {};
  for (const v of templateVariables(t.components)) {
    const mapped = t.variable_map[v.key];
    if (mapped && mapped in source && source[mapped]) out[v.key] = source[mapped];
  }
  return out;
}

export function TemplatePicker({
  open,
  onOpenChange,
  conversation,
  templates,
}: {
  open: boolean;
  onOpenChange: (o: boolean) => void;
  conversation: ConversationDetail;
  templates: TemplateInfo[];
}) {
  const [search, setSearch] = useState("");
  const [picked, setPicked] = useState<TemplateInfo | null>(null);
  const [values, setValues] = useState<Record<string, string>>({});
  const [pending, startTransition] = useTransition();

  const list = useMemo(() => {
    const q = search.toLowerCase();
    return templates
      .filter((t) => !conversation.contact.stop_marketing || t.category !== "MARKETING")
      .filter((t) => !q || t.name.includes(q) || t.language.includes(q));
  }, [templates, search, conversation.contact.stop_marketing]);

  const vars = picked ? templateVariables(picked.components) : [];
  const preview = picked ? renderTemplatePreview(picked.components, values) : null;

  function pick(t: TemplateInfo) {
    setPicked(t);
    setValues(defaults(t, conversation));
  }

  function send() {
    if (!picked) return;
    startTransition(async () => {
      const r = await sendTemplateMessage({
        conversation_id: conversation.id,
        template_id: picked.id,
        values,
      });
      if (!r.ok) {
        toast.error(r.error);
        return;
      }
      toast.success("Template queued.");
      onOpenChange(false);
      setPicked(null);
    });
  }

  return (
    <Dialog
      open={open}
      onOpenChange={(o) => {
        onOpenChange(o);
        if (!o) setPicked(null);
      }}
    >
      <DialogContent className="sm:max-w-3xl">
        <DialogHeader>
          <DialogTitle>Send a template</DialogTitle>
          <DialogDescription>
            Approved WhatsApp templates. Required outside the 24-hour window.
          </DialogDescription>
        </DialogHeader>
        <div className="grid gap-4 md:grid-cols-[1fr_1.2fr]">
          <div className="flex flex-col gap-2">
            <div className="relative">
              <Search className="text-muted-foreground pointer-events-none absolute top-1/2 left-2 size-4 -translate-y-1/2" />
              <Input
                value={search}
                onChange={(e) => setSearch(e.target.value)}
                placeholder="Search templates"
                className="pl-8"
              />
            </div>
            <ScrollArea className="h-72 rounded-md border">
              {list.length === 0 ? (
                <p className="text-muted-foreground p-4 text-sm">
                  No approved templates. Sync them from Settings → Channels.
                </p>
              ) : (
                <ul className="divide-y">
                  {list.map((t) => (
                    <li key={t.id}>
                      <button
                        type="button"
                        onClick={() => pick(t)}
                        className={cn(
                          "hover:bg-accent flex w-full flex-col gap-0.5 px-3 py-2 text-left",
                          picked?.id === t.id && "bg-accent",
                        )}
                      >
                        <span className="text-sm font-medium">{t.name}</span>
                        <span className="flex gap-1">
                          <Badge variant="outline">{t.language}</Badge>
                          <Badge variant="outline">{t.category}</Badge>
                        </span>
                      </button>
                    </li>
                  ))}
                </ul>
              )}
            </ScrollArea>
          </div>
          <div className="flex flex-col gap-3">
            {!picked ? (
              <p className="text-muted-foreground text-sm">
                Pick a template to fill its variables and preview it.
              </p>
            ) : (
              <>
                {vars.length > 0 && (
                  <div className="grid gap-2">
                    {vars.map((v) => (
                      <div key={v.key} className="grid gap-1">
                        <Label htmlFor={`v-${v.key}`} className="text-xs">
                          {v.key}{" "}
                          {v.kind !== "text" && (
                            <span className="text-muted-foreground">
                              (
                              {v.kind === "url_suffix"
                                ? "URL suffix"
                                : v.kind === "copy_code"
                                  ? "code"
                                  : `${v.kind} id or URL`}
                              )
                            </span>
                          )}
                        </Label>
                        <Input
                          id={`v-${v.key}`}
                          value={values[v.key] ?? ""}
                          onChange={(e) => setValues((p) => ({ ...p, [v.key]: e.target.value }))}
                          placeholder={v.example ?? ""}
                        />
                      </div>
                    ))}
                  </div>
                )}
                <PhonePreview preview={preview} />
              </>
            )}
          </div>
        </div>
        <DialogFooter>
          <Button variant="ghost" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button
            onClick={send}
            disabled={!picked || pending || (preview?.missing.length ?? 0) > 0}
          >
            {pending && <Loader2 className="animate-spin" />} Send template
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
