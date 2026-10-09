"use client";

import { useMemo, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { AlertTriangle, Loader2, Save, Send } from "lucide-react";
import { toast } from "sonner";

import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Switch } from "@/components/ui/switch";
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
} from "@/components/ui/sheet";
import {
  LIMITS,
  TEMPLATE_CATEGORIES,
  TEMPLATE_LANGUAGES,
  isRtlLanguage,
  reconcileVariables,
  syncExamples,
  toComponents,
  validateBuilder,
  variableIndexes,
  type BuilderState,
  type HeaderDef,
  type MediaFormat,
  type TemplateType,
} from "@/lib/whatsapp/template-builder";
import { isMetaEditable } from "@/lib/whatsapp/template-fields";

import { saveTemplate, submitTemplate } from "./actions";
import {
  BodyEditor,
  ButtonsEditor,
  CardsEditor,
  FieldError,
  SampleUpload,
  type BodyEdit,
} from "./builder-parts";
import type { DrawerInit } from "./drawer-init";
import { PhonePreview } from "./phone-preview";
import { StatusBadge } from "./status-badge";
import type { ChannelOption } from "./types";

const TYPE_LABEL: Record<TemplateType, string> = {
  standard: "Standard text",
  media_interactive: "Media & interactive",
  carousel: "Carousel",
};

const HEADER_OPTIONS = [
  ["NONE", "No header"],
  ["TEXT", "Text"],
  ["IMAGE", "Image"],
  ["VIDEO", "Video"],
  ["DOCUMENT", "Document (PDF)"],
] as const;

function normaliseName(v: string): string {
  return v
    .toLowerCase()
    .replace(/[\s-]+/g, "_")
    .replace(/[^a-z0-9_]/g, "");
}

export function TemplateDrawer({
  init,
  open,
  onOpenChange,
  channels,
}: {
  init: DrawerInit;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  channels: ChannelOption[];
}) {
  // The parent remounts this component (via key) for every template it opens.
  const router = useRouter();
  const [state, setState] = useState<BuilderState>(init.state);
  const [varMap, setVarMap] = useState<Record<string, string>>(init.variableMap);
  const [channelId, setChannelId] = useState(init.channelId || channels[0]?.id || "");
  const [id, setId] = useState(init.id);
  const [attempted, setAttempted] = useState(false);
  const [pending, start] = useTransition();

  const submitted = !!init.metaId;
  const status = init.status;
  const inReview = submitted && !!status && !isMetaEditable(status);
  const readOnly = init.unsupported.length > 0 || inReview;
  const rtl = isRtlLanguage(state.language);
  const isAuth = state.category === "AUTHENTICATION";

  const all = useMemo(() => validateBuilder(state), [state]);
  const shown = attempted ? all : all.filter((i) => i.level === "draft" && i.path !== "name");
  const components = useMemo(() => toComponents(state), [state]);

  const set = (patch: Partial<BuilderState>) => setState((s) => ({ ...s, ...patch }));

  function setType(type: TemplateType) {
    setState((s) => {
      if (type === "carousel")
        return {
          ...s,
          type,
          header: { format: "NONE" },
          footer: "",
          buttons: [],
          cards: s.cards.length
            ? s.cards
            : [1, 2].map(() => ({
                format: "IMAGE" as const,
                handle: "",
                body: "",
                examples: [],
                buttons: [{ type: "QUICK_REPLY" as const, text: "" }],
              })),
        };
      return { ...s, type, cards: [] };
    });
  }

  function setCategory(category: BuilderState["category"]) {
    setState((s) => ({
      ...s,
      category,
      type: category === "AUTHENTICATION" ? "standard" : s.type,
    }));
  }

  function editBody(edit: BodyEdit) {
    const rec = reconcileVariables(state.body, edit.text, state.examples, varMap, "body");
    const examples = [...rec.examples];
    const map = { ...rec.varMap };
    if (edit.inserted) {
      const pos = variableIndexes(edit.text).indexOf(edit.inserted.index);
      if (pos >= 0) {
        if (!examples[pos]) examples[pos] = edit.inserted.example;
        if (edit.inserted.field) map[`body.${pos + 1}`] = edit.inserted.field;
      }
    }
    setVarMap(map);
    set({ body: rec.text, examples });
  }

  function setHeaderFormat(format: HeaderDef["format"]) {
    setState((s) => {
      const media = format !== "NONE" && format !== "TEXT";
      const header: HeaderDef =
        format === "NONE"
          ? { format }
          : format === "TEXT"
            ? { format, text: "", example: "" }
            : { format: format as MediaFormat, handle: "" };
      return {
        ...s,
        header,
        type: media && s.type === "standard" ? "media_interactive" : s.type,
      };
    });
  }

  function run(mode: "save" | "submit") {
    setAttempted(true);
    if (mode === "save" && all.some((i) => i.level === "draft")) {
      toast.error(all.find((i) => i.level === "draft")?.message ?? "Fix the highlighted fields.");
      return;
    }
    if (mode === "submit" && all.length) {
      toast.error(`${all.length} thing${all.length === 1 ? "" : "s"} to fix before submitting.`);
      return;
    }
    if (!channelId) {
      toast.error("Choose a WhatsApp number.");
      return;
    }
    start(async () => {
      const input = {
        id: id ?? undefined,
        channel_id: channelId,
        state,
        gallery_key: init.galleryKey ?? undefined,
        variable_map: varMap,
      };
      const r = mode === "save" ? await saveTemplate(input) : await submitTemplate(input);
      if (!r.ok) {
        if (r.id) setId(r.id);
        toast.error(r.error);
        router.refresh();
        return;
      }
      setId(r.id);
      toast.success(r.message ?? "Done.");
      router.refresh();
      if (mode === "submit") onOpenChange(false);
    });
  }

  const header = state.header;
  const mediaHeader = header.format !== "NONE" && header.format !== "TEXT";
  const channel = channels.find((c) => c.id === channelId);

  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent className="w-full gap-0 p-0 sm:max-w-6xl">
        <SheetHeader className="border-b">
          <SheetTitle className="flex items-center gap-2">
            {id ? "Edit template" : "New template"}
            {status && <StatusBadge status={status} />}
          </SheetTitle>
          <SheetDescription>
            Build the message, preview it as the patient will see it, then send it to Meta for
            review.
          </SheetDescription>
        </SheetHeader>

        <div className="flex min-h-0 min-w-0 flex-1 flex-col overflow-y-auto lg:flex-row lg:overflow-hidden">
          <div className="flex min-w-0 flex-col gap-5 p-4 lg:flex-1 lg:overflow-y-auto">
            {init.rejectedReason && (
              <Alert variant="destructive">
                <AlertTriangle />
                <AlertTitle>Rejected by Meta</AlertTitle>
                <AlertDescription>{init.rejectedReason}</AlertDescription>
              </Alert>
            )}
            {init.submitError && (
              <Alert variant="destructive">
                <AlertTriangle />
                <AlertTitle>Last submission failed</AlertTitle>
                <AlertDescription>{init.submitError}</AlertDescription>
              </Alert>
            )}
            {init.unsupported.length > 0 && (
              <Alert>
                <AlertTriangle />
                <AlertTitle>Read-only</AlertTitle>
                <AlertDescription>
                  This template uses {init.unsupported.join(", ")}, which the builder cannot edit
                  without losing it. Edit it in Meta Business Manager, then sync.
                </AlertDescription>
              </Alert>
            )}
            {inReview && (
              <Alert>
                <AlertTitle>In review</AlertTitle>
                <AlertDescription>
                  Meta does not allow edits while a template is {status?.toLowerCase()}.
                </AlertDescription>
              </Alert>
            )}
            {init.needs.length > 0 && !submitted && (
              <Alert>
                <AlertTitle>Finish the starter template</AlertTitle>
                <AlertDescription>
                  Before submitting, add{" "}
                  {init.needs
                    .map((n) =>
                      n === "media"
                        ? "a sample file"
                        : n === "phone"
                          ? "your clinic number"
                          : "your real link",
                    )
                    .join(", ")}
                  .
                </AlertDescription>
              </Alert>
            )}

            <section className="grid gap-4 sm:grid-cols-2" aria-label="Basics">
              <div className="sm:col-span-2">
                <Label htmlFor="tpl-name">Name</Label>
                <Input
                  id="tpl-name"
                  value={state.name}
                  disabled={readOnly || submitted}
                  dir="ltr"
                  maxLength={LIMITS.nameMax}
                  placeholder="appointment_reminder"
                  onChange={(e) => set({ name: normaliseName(e.target.value) })}
                />
                <p className="text-muted-foreground mt-1 text-xs">
                  Lowercase letters, numbers and underscores. Cannot change after submission.
                </p>
                <FieldError issues={shown} path="name" />
              </div>
              <div>
                <Label>Category</Label>
                <Select
                  value={state.category}
                  disabled={readOnly || (submitted && status !== "REJECTED")}
                  onValueChange={(v) => setCategory(v as BuilderState["category"])}
                >
                  <SelectTrigger className="w-full" aria-label="Category">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {TEMPLATE_CATEGORIES.map((c) => (
                      <SelectItem key={c} value={c}>
                        {c.charAt(0) + c.slice(1).toLowerCase()}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
                <p className="text-muted-foreground mt-1 text-xs">
                  Meta may re-categorise on review.
                </p>
              </div>
              <div>
                <Label>Language</Label>
                <Select
                  value={state.language}
                  disabled={readOnly || submitted}
                  onValueChange={(v) => set({ language: v })}
                >
                  <SelectTrigger className="w-full" aria-label="Language">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {TEMPLATE_LANGUAGES.map((l) => (
                      <SelectItem key={l.code} value={l.code}>
                        {l.label}
                      </SelectItem>
                    ))}
                    {!TEMPLATE_LANGUAGES.some((l) => l.code === state.language) && (
                      <SelectItem value={state.language}>{state.language}</SelectItem>
                    )}
                  </SelectContent>
                </Select>
              </div>
              <div>
                <Label>WhatsApp number</Label>
                <Select
                  value={channelId}
                  disabled={readOnly || submitted}
                  onValueChange={setChannelId}
                >
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
              {!isAuth && (
                <div>
                  <Label>Type</Label>
                  <Select
                    value={state.type}
                    disabled={readOnly}
                    onValueChange={(v) => setType(v as TemplateType)}
                  >
                    <SelectTrigger className="w-full" aria-label="Template type">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      {(Object.keys(TYPE_LABEL) as TemplateType[]).map((t) => (
                        <SelectItem key={t} value={t}>
                          {TYPE_LABEL[t]}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </div>
              )}
            </section>

            {isAuth ? (
              <section className="flex flex-col gap-4" aria-label="One-time code">
                <p className="text-muted-foreground text-sm">
                  Authentication templates have a fixed message set by Meta: a verification code
                  with a copy button. Only these options can change.
                </p>
                <div className="flex items-center gap-3">
                  <Switch
                    id="tpl-sec"
                    checked={state.auth.securityRecommendation}
                    disabled={readOnly}
                    onCheckedChange={(v) =>
                      set({ auth: { ...state.auth, securityRecommendation: v } })
                    }
                  />
                  <Label htmlFor="tpl-sec">Add “do not share this code” advice</Label>
                </div>
                <div className="grid gap-4 sm:grid-cols-2">
                  <div>
                    <Label htmlFor="tpl-exp">Code expires after (minutes)</Label>
                    <Input
                      id="tpl-exp"
                      type="number"
                      min={1}
                      max={90}
                      disabled={readOnly}
                      value={state.auth.expiryMinutes ?? ""}
                      onChange={(e) =>
                        set({
                          auth: {
                            ...state.auth,
                            expiryMinutes: e.target.value ? Number(e.target.value) : null,
                          },
                        })
                      }
                    />
                    <FieldError issues={shown} path="auth.expiryMinutes" />
                  </div>
                  <div>
                    <Label htmlFor="tpl-btn">Button text</Label>
                    <Input
                      id="tpl-btn"
                      value={state.auth.buttonText}
                      disabled={readOnly}
                      maxLength={LIMITS.buttonTextMax}
                      onChange={(e) => set({ auth: { ...state.auth, buttonText: e.target.value } })}
                    />
                    <FieldError issues={shown} path="auth.buttonText" />
                  </div>
                </div>
              </section>
            ) : (
              <>
                {state.type !== "carousel" && (
                  <section className="flex flex-col gap-3" aria-label="Header">
                    <div className="grid gap-4 sm:grid-cols-2">
                      <div>
                        <Label>Header</Label>
                        <Select
                          value={header.format}
                          disabled={readOnly}
                          onValueChange={(v) => setHeaderFormat(v as HeaderDef["format"])}
                        >
                          <SelectTrigger className="w-full" aria-label="Header type">
                            <SelectValue />
                          </SelectTrigger>
                          <SelectContent>
                            {HEADER_OPTIONS.map(([v, label]) => (
                              <SelectItem key={v} value={v}>
                                {label}
                              </SelectItem>
                            ))}
                          </SelectContent>
                        </Select>
                      </div>
                    </div>
                    {header.format === "TEXT" && (
                      <div>
                        <div className="flex items-center justify-between">
                          <Label htmlFor="tpl-header">Header text</Label>
                          <span className="text-muted-foreground text-xs tabular-nums">
                            {header.text.length}/{LIMITS.headerTextMax}
                          </span>
                        </div>
                        <div className="flex gap-2">
                          <Input
                            id="tpl-header"
                            dir={rtl ? "rtl" : "ltr"}
                            value={header.text}
                            disabled={readOnly}
                            onChange={(e) => set({ header: { ...header, text: e.target.value } })}
                          />
                          <Button
                            type="button"
                            variant="outline"
                            disabled={readOnly || variableIndexes(header.text).length > 0}
                            onClick={() =>
                              set({ header: { ...header, text: `${header.text} {{1}}`.trim() } })
                            }
                          >
                            + {"{{1}}"}
                          </Button>
                        </div>
                        {variableIndexes(header.text).length > 0 && (
                          <Input
                            className="mt-2"
                            aria-label="Header example"
                            dir={rtl ? "rtl" : "ltr"}
                            placeholder="Example value for {{1}}"
                            value={header.example}
                            disabled={readOnly}
                            onChange={(e) =>
                              set({ header: { ...header, example: e.target.value } })
                            }
                          />
                        )}
                        <FieldError issues={shown} path="header" />
                      </div>
                    )}
                    {mediaHeader && (
                      <div>
                        <SampleUpload
                          channelId={channelId}
                          kind="header"
                          format={header.format as MediaFormat}
                          hasSample={!!(header as { handle: string }).handle}
                          fileName={(header as { fileName?: string }).fileName}
                          disabled={readOnly}
                          onUploaded={(s) =>
                            set({
                              header: {
                                format: header.format as MediaFormat,
                                handle: s.handle,
                                mediaPath: s.path,
                                fileName: s.fileName,
                              },
                            })
                          }
                        />
                        <FieldError issues={shown} path="header" />
                      </div>
                    )}
                  </section>
                )}

                <section aria-label="Body">
                  <BodyEditor
                    label={state.type === "carousel" ? "Message above the cards" : "Body"}
                    value={state.body}
                    examples={syncExamples(state.body, state.examples)}
                    language={state.language}
                    max={LIMITS.bodyMax}
                    disabled={readOnly}
                    placeholder={
                      rtl
                        ? "اكتب نص الرسالة. اضغط @ لإضافة متغير."
                        : "Write the message. Press @ to add a variable."
                    }
                    onEdit={editBody}
                    onExamples={(examples) => set({ examples })}
                    issues={shown}
                    path="body"
                  />
                </section>

                {state.type !== "carousel" && (
                  <section aria-label="Footer">
                    <div className="flex items-center justify-between">
                      <Label htmlFor="tpl-footer">Footer (optional)</Label>
                      <span className="text-muted-foreground text-xs tabular-nums">
                        {state.footer.length}/{LIMITS.footerMax}
                      </span>
                    </div>
                    <Input
                      id="tpl-footer"
                      dir={rtl ? "rtl" : "ltr"}
                      value={state.footer}
                      disabled={readOnly}
                      onChange={(e) => set({ footer: e.target.value })}
                    />
                    <FieldError issues={shown} path="footer" />
                  </section>
                )}

                {state.type === "media_interactive" && (
                  <section className="flex flex-col gap-2" aria-label="Buttons">
                    <Label>Buttons</Label>
                    <ButtonsEditor
                      buttons={state.buttons}
                      onChange={(buttons) => set({ buttons })}
                      max={LIMITS.buttonsMax}
                      allowCopyCode
                      disabled={readOnly}
                      issues={shown}
                      path="buttons"
                      language={state.language}
                    />
                  </section>
                )}
                {state.type === "standard" && (
                  <p className="text-muted-foreground text-xs">
                    Need buttons or a media header? Choose “Media &amp; interactive” as the type.
                  </p>
                )}

                {state.type === "carousel" && (
                  <section className="flex flex-col gap-2" aria-label="Cards">
                    <Label>Cards</Label>
                    <CardsEditor
                      cards={state.cards}
                      onChange={(cards) => set({ cards })}
                      channelId={channelId}
                      language={state.language}
                      disabled={readOnly}
                      issues={shown}
                    />
                  </section>
                )}
              </>
            )}

            {attempted && all.length > 0 && (
              <Alert variant="destructive">
                <AlertTriangle />
                <AlertTitle>
                  {all.length} thing{all.length === 1 ? "" : "s"} to fix before submitting
                </AlertTitle>
                <AlertDescription>
                  <ul className="list-disc ps-4">
                    {all.slice(0, 6).map((i, k) => (
                      <li key={k}>{i.message}</li>
                    ))}
                  </ul>
                </AlertDescription>
              </Alert>
            )}
          </div>

          <aside className="bg-muted/40 flex flex-col items-center gap-3 border-t p-4 lg:w-[360px] lg:shrink-0 lg:overflow-y-auto lg:border-s lg:border-t-0">
            <h3 className="text-sm font-medium">Live preview</h3>
            <PhonePreview components={components} language={state.language} />
            <p className="text-muted-foreground max-w-[300px] text-center text-xs">
              Variables show their example values. {channel ? `Sending from ${channel.name}.` : ""}
            </p>
          </aside>
        </div>

        <div className="flex flex-wrap items-center justify-end gap-2 border-t p-4">
          <Button variant="ghost" onClick={() => onOpenChange(false)} disabled={pending}>
            Cancel
          </Button>
          {!submitted && (
            <Button variant="outline" onClick={() => run("save")} disabled={pending || readOnly}>
              {pending ? <Loader2 className="animate-spin" /> : <Save />} Save draft
            </Button>
          )}
          <Button onClick={() => run("submit")} disabled={pending || readOnly}>
            {pending ? <Loader2 className="animate-spin" /> : <Send />}
            {submitted ? "Submit changes" : "Submit to Meta"}
          </Button>
        </div>
      </SheetContent>
    </Sheet>
  );
}
