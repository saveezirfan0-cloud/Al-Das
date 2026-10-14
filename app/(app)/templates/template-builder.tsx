"use client";

import { useMemo, useRef, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import {
  AtSign,
  Bold,
  Code,
  Images,
  Italic,
  Loader2,
  Plus,
  Send,
  Strikethrough,
  Trash2,
  TriangleAlert,
  Upload,
} from "lucide-react";
import { toast } from "sonner";

import { useConfirm } from "@/components/shell/confirm-dialog";
import { MediaPicker } from "@/components/media/media-picker";
import { PhonePreview } from "@/components/phone-preview/phone-preview";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
} from "@/components/ui/sheet";
import { Textarea } from "@/components/ui/textarea";
import { RecordHistoryButton } from "@/components/history/record-history";
import {
  AUTH_DEFAULT_BUTTON,
  LIMITS,
  TEMPLATE_CATEGORIES,
  TEMPLATE_LANGUAGES,
  alignExamples,
  applyFormat,
  convertParameterFormat,
  defaultAuth,
  insertVariable,
  pruneDraft,
  storedComponents,
  usesNamedParams,
  validateDraft,
  variableNumbers,
  type AuthSettings,
  type DraftButton,
  type DraftCard,
  type TemplateDraft,
} from "@/lib/templates/builder";
import { insertNamedVariable, suggestParamName, variableNames } from "@/lib/templates/named-params";
import { TEMPLATE_HEADER_TYPES } from "@/lib/media/limits";
import { mediaSource } from "@/lib/media/paths";
import { TEMPLATE_SOURCES, sampleFor } from "@/lib/templates/sources";
import { renderTemplatePreview } from "@/lib/whatsapp/templates";
import { cn } from "@/lib/utils";

import {
  saveTemplateDraft,
  submitTemplate,
  uploadHeaderSample,
  uploadHeaderSampleFromLibrary,
} from "./actions";
import { STATUS_LABEL } from "./format";

export type BuilderChannel = { id: string; name: string; phone: string | null; wabaId: string };

export type BuilderInit = {
  id: string | null;
  status: string | null;
  /** Submitted to Meta at some point: name and language are locked. */
  submitted: boolean;
  channelId: string;
  draft: TemplateDraft;
  galleryKey: string | null;
  rejectedReason: string | null;
};

const NONE = "__none__";
const TEXT_SRC = "__text__";

const CATEGORY_LABEL: Record<TemplateDraft["category"], string> = {
  MARKETING: "Marketing",
  UTILITY: "Utility",
  AUTHENTICATION: "Authentication (one-time code)",
};

const CATEGORY_HINT: Record<TemplateDraft["category"], string> = {
  MARKETING: "Promotions, news and offers. Needs the patient's opt-in.",
  UTILITY: "Transactional: bookings, reminders, billing, follow-ups they asked for.",
  AUTHENTICATION:
    "A one-time code with a copy button. Meta writes the wording; you choose the options below.",
};

function Field({
  label,
  hint,
  children,
  className,
}: {
  label: string;
  hint?: string;
  children: React.ReactNode;
  className?: string;
}) {
  return (
    <div className={cn("grid gap-1.5", className)}>
      <Label>{label}</Label>
      {children}
      {hint && <p className="text-muted-foreground text-xs">{hint}</p>}
    </div>
  );
}

function Counter({ value, max }: { value: number; max: number }) {
  return (
    <span
      className={cn(
        "text-xs tabular-nums",
        value > max ? "text-destructive" : "text-muted-foreground",
      )}
    >
      {value}/{max}
    </span>
  );
}

function ButtonEditor({
  buttons,
  onChange,
  allowCopyCode,
  allowCatalog = false,
}: {
  buttons: DraftButton[];
  onChange: (b: DraftButton[]) => void;
  allowCopyCode: boolean;
  /** Marketing templates only: a single button that opens the product catalogue. */
  allowCatalog?: boolean;
}) {
  const update = (i: number, patch: Partial<DraftButton>) =>
    onChange(buttons.map((b, j) => (j === i ? ({ ...b, ...patch } as DraftButton) : b)));
  return (
    <div className="flex flex-col gap-2">
      {buttons.map((b, i) => (
        <div key={i} className="grid gap-2 rounded-md border p-2 sm:grid-cols-[7rem_1fr_auto]">
          <Badge variant="outline" className="h-6 self-center justify-self-start">
            {b.type === "QUICK_REPLY"
              ? "Quick reply"
              : b.type === "URL"
                ? "Link"
                : b.type === "PHONE_NUMBER"
                  ? "Call"
                  : b.type === "CATALOG"
                    ? "Catalogue"
                    : "Copy code"}
          </Badge>
          <div className="grid gap-2 sm:grid-cols-2">
            {b.type !== "COPY_CODE" && (
              <div className="grid gap-1">
                <Input
                  value={b.text}
                  onChange={(e) => update(i, { text: e.target.value })}
                  placeholder="Button text"
                  aria-label="Button text"
                />
                <Counter value={b.text.length} max={LIMITS.buttonText} />
              </div>
            )}
            {b.type === "URL" && (
              <>
                <Input
                  value={b.url}
                  onChange={(e) => update(i, { url: e.target.value })}
                  placeholder="https://… (end with {{1}} for a dynamic link)"
                  aria-label="Link"
                />
                {/\{\{\s*1\s*\}\}/.test(b.url) && (
                  <Input
                    value={b.example ?? ""}
                    onChange={(e) => update(i, { example: e.target.value })}
                    placeholder="Example for {{1}}"
                    aria-label="Link example"
                  />
                )}
              </>
            )}
            {b.type === "PHONE_NUMBER" && (
              <Input
                value={b.phone_number}
                onChange={(e) => update(i, { phone_number: e.target.value })}
                placeholder="+97143000000"
                aria-label="Phone number"
              />
            )}
            {b.type === "COPY_CODE" && (
              <Input
                value={b.example}
                onChange={(e) => update(i, { example: e.target.value })}
                placeholder="Example code, e.g. WELCOME10"
                aria-label="Example code"
              />
            )}
          </div>
          <Button
            type="button"
            variant="ghost"
            size="icon"
            aria-label="Remove button"
            onClick={() => onChange(buttons.filter((_, j) => j !== i))}
          >
            <Trash2 />
          </Button>
        </div>
      ))}
      <div className="flex flex-wrap gap-2">
        <Button
          type="button"
          size="sm"
          variant="outline"
          onClick={() => onChange([...buttons, { type: "QUICK_REPLY", text: "" }])}
        >
          <Plus /> Quick reply
        </Button>
        <Button
          type="button"
          size="sm"
          variant="outline"
          onClick={() => onChange([...buttons, { type: "URL", text: "", url: "https://" }])}
        >
          <Plus /> Link
        </Button>
        <Button
          type="button"
          size="sm"
          variant="outline"
          onClick={() =>
            onChange([...buttons, { type: "PHONE_NUMBER", text: "", phone_number: "" }])
          }
        >
          <Plus /> Call
        </Button>
        {allowCopyCode && (
          <Button
            type="button"
            size="sm"
            variant="outline"
            onClick={() => onChange([...buttons, { type: "COPY_CODE", example: "" }])}
          >
            <Plus /> Copy code
          </Button>
        )}
        {allowCatalog && (
          <Button
            type="button"
            size="sm"
            variant="outline"
            onClick={() => onChange([...buttons, { type: "CATALOG", text: "View catalog" }])}
          >
            <Plus /> Catalogue
          </Button>
        )}
      </div>
    </div>
  );
}

export function TemplateBuilder({
  channels,
  init,
  closeHref,
}: {
  channels: BuilderChannel[];
  init: BuilderInit;
  closeHref: string;
}) {
  const [ask, askDialog] = useConfirm();
  const router = useRouter();
  const [draft, setDraft] = useState<TemplateDraft>(init.draft);
  const [channelId, setChannelId] = useState(init.channelId);
  const [id, setId] = useState(init.id);
  const [saving, startSave] = useTransition();
  const [submitting, startSubmit] = useTransition();
  const [uploading, setUploading] = useState<string | null>(null);
  const [pickerOpen, setPickerOpen] = useState(false);
  const [atMenu, setAtMenu] = useState<{ at: number } | null>(null);
  const bodyRef = useRef<HTMLTextAreaElement>(null);
  const isRtl = draft.language.startsWith("ar");

  const patch = (p: Partial<TemplateDraft>) => setDraft((d) => ({ ...d, ...p }));
  const { errors, warnings } = useMemo(() => validateDraft(draft), [draft]);
  const named = usesNamedParams(draft);
  const isAuth = draft.category === "AUTHENTICATION";
  const auth = draft.auth ?? defaultAuth();
  const components = useMemo(() => storedComponents(draft), [draft]);
  const preview = useMemo(() => {
    const values: Record<string, string> = {};
    if (named) {
      for (const n of variableNames(draft.body))
        values[`body.${n}`] = draft.namedExamples?.[n] || `{{${n}}}`;
      const hn = draft.header.kind === "text" ? variableNames(draft.header.text)[0] : undefined;
      if (hn && draft.header.kind === "text" && draft.header.example)
        values[`header.${hn}`] = draft.header.example;
    } else {
      draft.bodyExamples.forEach((e, i) => (values[`body.${i + 1}`] = e || `{{${i + 1}}}`));
      if (draft.header.kind === "text" && draft.header.example)
        values["header.1"] = draft.header.example;
    }
    return renderTemplatePreview(components, values);
  }, [components, named, draft.bodyExamples, draft.namedExamples, draft.body, draft.header]);

  const bodyVars = named ? [] : variableNumbers(draft.body);
  const bodyNames = named ? variableNames(draft.body) : [];
  const setAuth = (p: Partial<AuthSettings>) => patch({ auth: { ...auth, ...p } });
  const locked = init.submitted;
  const editable =
    !init.status || ["DRAFT", "APPROVED", "REJECTED", "PAUSED"].includes(init.status);

  function setBody(text: string, caret?: number) {
    const examples = alignExamples(text, draft.bodyExamples, "");
    patch({ body: text, bodyExamples: examples });
    if (caret !== undefined)
      requestAnimationFrame(() => {
        bodyRef.current?.focus();
        bodyRef.current?.setSelectionRange(caret, caret);
      });
  }

  function onBodyChange(e: React.ChangeEvent<HTMLTextAreaElement>) {
    const text = e.target.value;
    const caret = e.target.selectionStart ?? text.length;
    setBody(text);
    // Typing "@" offers the dynamic fields.
    setAtMenu(text[caret - 1] === "@" ? { at: caret - 1 } : null);
  }

  function addVariable(source: string, at?: { at: number; replace: number }) {
    const el = bodyRef.current;
    const pos = at?.at ?? el?.selectionStart ?? draft.body.length;
    if (named) {
      const name = suggestParamName(
        source === TEXT_SRC ? undefined : source,
        variableNames(draft.body),
      );
      const r = insertNamedVariable(draft.body, pos, name, at?.replace ?? 0);
      setDraft((d) => ({
        ...d,
        body: r.text,
        namedExamples: { ...d.namedExamples, [name]: sampleFor(source) ?? "" },
        variableMap:
          source === TEXT_SRC ? d.variableMap : { ...d.variableMap, [`body.${name}`]: source },
      }));
      setAtMenu(null);
      requestAnimationFrame(() => {
        el?.focus();
        el?.setSelectionRange(r.caret, r.caret);
      });
      return;
    }
    const r = insertVariable(draft.body, pos, at?.replace ?? 0);
    const sample = sampleFor(source) ?? "";
    const examples = alignExamples(r.text, draft.bodyExamples, "");
    examples[r.number - 1] = sample;
    setDraft((d) => ({
      ...d,
      body: r.text,
      bodyExamples: examples,
      variableMap:
        source === TEXT_SRC ? d.variableMap : { ...d.variableMap, [`body.${r.number}`]: source },
    }));
    setAtMenu(null);
    requestAnimationFrame(() => {
      el?.focus();
      el?.setSelectionRange(r.caret, r.caret);
    });
  }

  function format(mark: "*" | "_" | "~" | "```") {
    const el = bodyRef.current;
    if (!el) return;
    const r = applyFormat(draft.body, el.selectionStart, el.selectionEnd, mark);
    patch({ body: r.text });
    requestAnimationFrame(() => {
      el.focus();
      el.setSelectionRange(r.start, r.end);
    });
  }

  async function upload(
    file: File | undefined,
    apply: (r: { handle: string; name: string; format: "IMAGE" | "VIDEO" | "DOCUMENT" }) => void,
    key: string,
  ) {
    if (!file) return;
    setUploading(key);
    const fd = new FormData();
    fd.set("file", file);
    fd.set("channel_id", channelId);
    const r = await uploadHeaderSample(fd);
    setUploading(null);
    if (!r.ok) {
      toast.error(r.error);
      return;
    }
    apply(r.data);
    toast.success("Sample uploaded.");
  }

  /** A Media Library file as the header: Meta gets it as the sample, and the template remembers it as its media. */
  async function pickHeaderFromLibrary(assetId: string) {
    if (!mediaHeader) return;
    setUploading("header");
    const r = await uploadHeaderSampleFromLibrary({
      asset_id: assetId,
      channel_id: channelId,
      format: mediaHeader.format,
    });
    setUploading(null);
    if (!r.ok || !r.data) {
      toast.error(r.ok ? "Could not use that file." : r.error);
      return;
    }
    const data = r.data;
    setDraft((d) => ({
      ...d,
      header: { kind: "media", format: data.format, handle: data.handle, sampleName: data.name },
      variableMap: { ...d.variableMap, "header.media": mediaSource(assetId) },
    }));
    toast.success("Library file set as the header.");
  }

  /** Drops mapping/examples for variables that are no longer in the text. */
  const clean = pruneDraft;

  function save() {
    startSave(async () => {
      const r = await saveTemplateDraft({
        id: id ?? undefined,
        channel_id: channelId,
        draft: clean(draft),
        gallery_key: init.galleryKey ?? undefined,
      });
      if (!r.ok) {
        toast.error(r.error);
        return;
      }
      setId(r.data.id);
      toast.success(r.message ?? "Draft saved.");
      router.refresh();
    });
  }

  async function submit() {
    if (errors.length) return;
    if (
      !(await ask(
        "Send this template to Meta for review? Meta usually answers within minutes, sometimes up to 24 hours.",
      ))
    )
      return;
    startSubmit(async () => {
      const r = await submitTemplate({
        id: id ?? undefined,
        channel_id: channelId,
        draft: clean(draft),
        gallery_key: init.galleryKey ?? undefined,
      });
      if (!r.ok) {
        toast.error(r.error);
        return;
      }
      toast.success(r.message ?? "Submitted.");
      router.push(closeHref);
      router.refresh();
    });
  }

  const mediaHeader = draft.header.kind === "media" ? draft.header : null;
  const usesLibrary = !!draft.variableMap["header.media"]?.startsWith("media:");
  const issueFor = (prefix: string) =>
    errors.filter((e) => e.path === prefix || e.path.startsWith(`${prefix}.`));

  return (
    <Sheet open onOpenChange={(o) => !o && router.push(closeHref)}>
      <SheetContent className="w-full overflow-y-auto sm:max-w-6xl">
        <SheetHeader>
          <SheetTitle className="flex items-center gap-2">
            {id ? "Edit template" : "New template"}
            {init.status && (
              <Badge variant="outline">{STATUS_LABEL[init.status] ?? init.status}</Badge>
            )}
          </SheetTitle>
          <SheetDescription>
            {locked
              ? "Name and language are fixed once a template has been submitted. Saving changes sends it back to Meta for review."
              : "Build the message, preview it, then submit it to Meta for approval."}
          </SheetDescription>
          {id && (
            <div>
              <RecordHistoryButton table="wa_templates" recordId={id} />
            </div>
          )}
        </SheetHeader>

        <div className="grid gap-6 px-4 pb-6 lg:grid-cols-[1fr_20rem]">
          <div className="flex flex-col gap-5">
            {init.rejectedReason && (
              <p className="flex gap-2 rounded-md border border-red-300 bg-red-50 p-3 text-sm text-red-900 dark:border-red-800 dark:bg-red-950 dark:text-red-100">
                <TriangleAlert className="mt-0.5 size-4 shrink-0" />
                <span>
                  <strong>Meta rejected this template:</strong>{" "}
                  {init.rejectedReason.replace(/_/g, " ").toLowerCase()}. Edit it and submit again.
                </span>
              </p>
            )}

            <div className="grid gap-4 sm:grid-cols-2">
              <Field label="Template name" hint="Lowercase letters, numbers and underscores.">
                <Input
                  value={draft.name}
                  disabled={locked}
                  maxLength={LIMITS.name}
                  onChange={(e) =>
                    patch({
                      name: e.target.value
                        .toLowerCase()
                        .replace(/\s+/g, "_")
                        .replace(/[^a-z0-9_]/g, ""),
                    })
                  }
                  placeholder="appointment_reminder"
                  aria-invalid={issueFor("name").length > 0}
                />
                {issueFor("name")[0] && (
                  <p className="text-destructive text-xs">{issueFor("name")[0].message}</p>
                )}
              </Field>
              <Field label="WhatsApp number">
                <Select value={channelId} onValueChange={setChannelId} disabled={locked}>
                  <SelectTrigger>
                    <SelectValue placeholder="Choose a number" />
                  </SelectTrigger>
                  <SelectContent>
                    {channels.map((c) => (
                      <SelectItem key={c.id} value={c.id}>
                        {c.name}
                        {c.phone ? ` · ${c.phone}` : ""}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </Field>
              <Field label="Category" hint={CATEGORY_HINT[draft.category]}>
                <Select
                  value={draft.category}
                  onValueChange={(v) => {
                    const category = v as TemplateDraft["category"];
                    if (category === "AUTHENTICATION")
                      patch({
                        category,
                        auth: draft.auth ?? defaultAuth(),
                        ...(draft.type === "carousel"
                          ? { type: "standard" as const, cards: [] }
                          : {}),
                      });
                    else patch({ category });
                  }}
                  disabled={locked && init.draft.category === "AUTHENTICATION"}
                >
                  <SelectTrigger>
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {TEMPLATE_CATEGORIES.map((c) => (
                      <SelectItem key={c} value={c} disabled={locked && c === "AUTHENTICATION"}>
                        {CATEGORY_LABEL[c]}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </Field>
              <Field label="Language">
                <Select
                  value={draft.language}
                  onValueChange={(v) => patch({ language: v })}
                  disabled={locked}
                >
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
              </Field>
              {!isAuth && (
                <Field label="Template type">
                  <Select
                    value={draft.type}
                    onValueChange={(v) => {
                      const type = v as TemplateDraft["type"];
                      patch({
                        type,
                        ...(type === "carousel"
                          ? {
                              header: { kind: "none" as const },
                              buttons: [],
                              cards: draft.cards.length ? draft.cards : [newCard(), newCard()],
                            }
                          : { cards: [] }),
                      });
                    }}
                  >
                    <SelectTrigger>
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="standard">Standard text</SelectItem>
                      <SelectItem value="media_interactive">
                        Media &amp; interactive (image, video, document, buttons)
                      </SelectItem>
                      <SelectItem value="carousel">Carousel (swipeable cards)</SelectItem>
                    </SelectContent>
                  </Select>
                </Field>
              )}
              {!isAuth && (
                <Field
                  label="Variables"
                  hint={
                    locked
                      ? "Fixed once the template has been submitted."
                      : named
                        ? "Named, e.g. {{first_name}}: lower-case letters, digits and underscores."
                        : "Numbered: {{1}}, {{2}}, … in order."
                  }
                >
                  <Select
                    value={named ? "named" : "positional"}
                    onValueChange={(v) =>
                      setDraft((d) => convertParameterFormat(d, v as "positional" | "named"))
                    }
                    disabled={locked || (draft.type === "carousel" && !named)}
                  >
                    <SelectTrigger aria-label="Variable style">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="positional">Numbered ({"{{1}}"})</SelectItem>
                      <SelectItem value="named">Named ({"{{first_name}}"})</SelectItem>
                    </SelectContent>
                  </Select>
                </Field>
              )}
            </div>

            {isAuth && (
              <section
                className="grid gap-4 rounded-lg border p-3"
                aria-label="One-time code options"
              >
                <p className="text-muted-foreground text-xs">
                  Meta writes the message in the template&apos;s language: the code, an optional
                  security note and an optional expiry line, with a button that copies the code.
                  Pulse never creates or sends codes by itself; whatever sends this template
                  supplies the code.
                </p>
                <div className="flex items-center gap-2">
                  <Checkbox
                    id="t-auth-sec"
                    checked={auth.securityRecommendation}
                    onCheckedChange={(c) => setAuth({ securityRecommendation: c === true })}
                  />
                  <Label htmlFor="t-auth-sec">
                    Add the &quot;keep this code private&quot; note
                  </Label>
                </div>
                <div className="grid gap-4 sm:grid-cols-2">
                  <Field
                    label="Code expires after (minutes)"
                    hint={`Optional, ${LIMITS.authExpiryMin} to ${LIMITS.authExpiryMax}. Leave empty for no expiry line.`}
                  >
                    <Input
                      type="number"
                      inputMode="numeric"
                      min={LIMITS.authExpiryMin}
                      max={LIMITS.authExpiryMax}
                      value={auth.codeExpiryMinutes ?? ""}
                      onChange={(e) => {
                        const n = e.target.value === "" ? null : Number(e.target.value);
                        setAuth({
                          codeExpiryMinutes: n === null || Number.isNaN(n) ? null : Math.trunc(n),
                        });
                      }}
                      aria-label="Code expires after (minutes)"
                      aria-invalid={issueFor("auth.codeExpiryMinutes").length > 0}
                    />
                  </Field>
                  <Field label="Copy button text">
                    <div className="grid gap-1">
                      <Input
                        value={auth.buttonText}
                        onChange={(e) => setAuth({ buttonText: e.target.value })}
                        placeholder={AUTH_DEFAULT_BUTTON}
                        dir={isRtl ? "rtl" : "ltr"}
                        aria-label="Copy button text"
                        aria-invalid={issueFor("auth.buttonText").length > 0}
                      />
                      <Counter value={auth.buttonText.length} max={LIMITS.buttonText} />
                    </div>
                  </Field>
                </div>
              </section>
            )}

            {draft.type !== "carousel" && !isAuth && (
              <section className="grid gap-3 rounded-lg border p-3">
                <Field label="Header (optional)">
                  <Select
                    value={draft.header.kind === "media" ? draft.header.format : draft.header.kind}
                    onValueChange={(v) => {
                      if (v === "none") patch({ header: { kind: "none" } });
                      else if (v === "text") patch({ header: { kind: "text", text: "" } });
                      else
                        patch({
                          type: "media_interactive",
                          header: { kind: "media", format: v as "IMAGE" | "VIDEO" | "DOCUMENT" },
                        });
                    }}
                  >
                    <SelectTrigger className="max-w-xs">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="none">No header</SelectItem>
                      <SelectItem value="text">Text</SelectItem>
                      <SelectItem value="IMAGE">Image</SelectItem>
                      <SelectItem value="VIDEO">Video</SelectItem>
                      <SelectItem value="DOCUMENT">Document</SelectItem>
                    </SelectContent>
                  </Select>
                </Field>
                {draft.header.kind === "text" && (
                  <div className="grid gap-2 sm:grid-cols-2">
                    <div className="grid gap-1">
                      <Input
                        value={draft.header.text}
                        onChange={(e) =>
                          patch({
                            header: {
                              ...draft.header,
                              text: e.target.value,
                            } as TemplateDraft["header"],
                          })
                        }
                        placeholder="Header text"
                        dir={isRtl ? "rtl" : "ltr"}
                      />
                      <Counter value={draft.header.text.length} max={LIMITS.headerText} />
                    </div>
                    {(named
                      ? variableNames(draft.header.text).length > 0
                      : variableNumbers(draft.header.text).length > 0) && (
                      <Input
                        aria-label="Header variable example"
                        value={draft.header.example ?? ""}
                        onChange={(e) =>
                          patch({
                            header: {
                              ...draft.header,
                              example: e.target.value,
                            } as TemplateDraft["header"],
                          })
                        }
                        placeholder={
                          named
                            ? `Example for {{${variableNames(draft.header.text)[0]}}}`
                            : "Example for {{1}}"
                        }
                      />
                    )}
                  </div>
                )}
                {mediaHeader && (
                  <div className="flex flex-wrap items-center gap-2">
                    <label className="inline-flex">
                      <input
                        type="file"
                        className="hidden"
                        accept={
                          mediaHeader.format === "IMAGE"
                            ? "image/jpeg,image/png"
                            : mediaHeader.format === "VIDEO"
                              ? "video/mp4"
                              : "application/pdf"
                        }
                        onChange={(e) =>
                          upload(
                            e.target.files?.[0],
                            (r) =>
                              setDraft((d) => {
                                // A device sample replaces a library file as the example Meta reviews.
                                const { "header.media": _lib, ...rest } = d.variableMap;
                                return {
                                  ...d,
                                  header: {
                                    kind: "media",
                                    format: mediaHeader.format,
                                    handle: r.handle,
                                    sampleName: r.name,
                                  },
                                  variableMap: _lib?.startsWith("media:") ? rest : d.variableMap,
                                };
                              }),
                            "header",
                          )
                        }
                      />
                      <span className="border-input hover:bg-accent inline-flex h-8 cursor-pointer items-center gap-1.5 rounded-md border px-3 text-sm">
                        {uploading === "header" ? (
                          <Loader2 className="size-4 animate-spin" />
                        ) : (
                          <Upload className="size-4" />
                        )}
                        {mediaHeader.handle
                          ? "Replace sample"
                          : `Upload sample ${mediaHeader.format.toLowerCase()}`}
                      </span>
                    </label>
                    {!locked && (
                      <Button
                        type="button"
                        variant="outline"
                        size="sm"
                        disabled={!channelId || uploading === "header"}
                        onClick={() => setPickerOpen(true)}
                      >
                        <Images className="size-4" /> Choose from the library
                      </Button>
                    )}
                    <span className="text-muted-foreground text-xs">
                      {mediaHeader.handle
                        ? usesLibrary
                          ? `${mediaHeader.sampleName ?? "Library file"} (Media Library, sent with every message)`
                          : (mediaHeader.sampleName ?? "Sample uploaded")
                        : "Meta needs an example file to review. Each message sends its own file."}
                    </span>
                    <MediaPicker
                      open={pickerOpen}
                      onOpenChange={setPickerOpen}
                      kind={mediaHeader.format.toLowerCase() as "image" | "video" | "document"}
                      mimes={
                        TEMPLATE_HEADER_TYPES[
                          mediaHeader.format.toLowerCase() as "image" | "video" | "document"
                        ]
                      }
                      title="Choose the header file"
                      onPick={(a) => void pickHeaderFromLibrary(a.id)}
                    />
                  </div>
                )}
              </section>
            )}

            {!isAuth && (
              <section className="grid gap-2">
                <div className="flex items-center justify-between">
                  <Label htmlFor="t-body">Body</Label>
                  <Counter value={draft.body.length} max={LIMITS.body} />
                </div>
                <div className="flex flex-wrap gap-1">
                  <Button
                    type="button"
                    size="icon"
                    variant="outline"
                    aria-label="Bold"
                    onClick={() => format("*")}
                  >
                    <Bold />
                  </Button>
                  <Button
                    type="button"
                    size="icon"
                    variant="outline"
                    aria-label="Italic"
                    onClick={() => format("_")}
                  >
                    <Italic />
                  </Button>
                  <Button
                    type="button"
                    size="icon"
                    variant="outline"
                    aria-label="Strikethrough"
                    onClick={() => format("~")}
                  >
                    <Strikethrough />
                  </Button>
                  <Button
                    type="button"
                    size="icon"
                    variant="outline"
                    aria-label="Monospace"
                    onClick={() => format("```")}
                  >
                    <Code />
                  </Button>
                  <Button
                    type="button"
                    size="sm"
                    variant="outline"
                    onClick={() => setAtMenu({ at: -1 })}
                  >
                    <AtSign /> Insert variable
                  </Button>
                </div>
                <div className="relative">
                  <Textarea
                    id="t-body"
                    ref={bodyRef}
                    rows={7}
                    value={draft.body}
                    onChange={onBodyChange}
                    onKeyDown={(e) => e.key === "Escape" && setAtMenu(null)}
                    dir={isRtl ? "rtl" : "ltr"}
                    placeholder={
                      named
                        ? "Hello {{first_name}}, … — type @ to insert a field"
                        : "Hello {{1}}, … — type @ to insert a field"
                    }
                    aria-invalid={issueFor("body").length > 0}
                  />
                  {atMenu && (
                    <ul className="bg-popover absolute z-10 mt-1 max-h-56 w-64 overflow-auto rounded-md border p-1 text-sm shadow-md">
                      {TEMPLATE_SOURCES.map((s) => (
                        <li key={s.key}>
                          <button
                            type="button"
                            className="hover:bg-accent w-full rounded px-2 py-1 text-left"
                            onClick={() =>
                              addVariable(
                                s.key,
                                atMenu.at >= 0 ? { at: atMenu.at, replace: 1 } : undefined,
                              )
                            }
                          >
                            {s.label}
                          </button>
                        </li>
                      ))}
                      <li>
                        <button
                          type="button"
                          className="hover:bg-accent w-full rounded px-2 py-1 text-left"
                          onClick={() =>
                            addVariable(
                              TEXT_SRC,
                              atMenu.at >= 0 ? { at: atMenu.at, replace: 1 } : undefined,
                            )
                          }
                        >
                          Other (fill in when sending)
                        </button>
                      </li>
                    </ul>
                  )}
                </div>
                {issueFor("body").map((e, i) => (
                  <p key={i} className="text-destructive text-xs">
                    {e.message}
                  </p>
                ))}

                {bodyVars.length > 0 && (
                  <div className="grid gap-2 rounded-md border p-3">
                    <p className="text-muted-foreground text-xs">
                      Meta needs an example for each variable. The mapping says what fills it when
                      the template is sent.
                    </p>
                    {bodyVars.map((n) => {
                      const key = `body.${n}`;
                      const src = draft.variableMap[key];
                      return (
                        <div key={n} className="grid gap-2 sm:grid-cols-[3.5rem_1fr_1fr]">
                          <code className="self-center text-xs">{`{{${n}}}`}</code>
                          <Input
                            value={draft.bodyExamples[n - 1] ?? ""}
                            onChange={(e) => {
                              const ex = [...alignExamples(draft.body, draft.bodyExamples, "")];
                              ex[n - 1] = e.target.value;
                              patch({ bodyExamples: ex });
                            }}
                            placeholder="Example"
                            aria-label={`Example for variable ${n}`}
                            dir={isRtl ? "rtl" : "ltr"}
                          />
                          <Select
                            value={src && !src.startsWith("text:") ? src : NONE}
                            onValueChange={(v) => {
                              const map = { ...draft.variableMap };
                              if (v === NONE) delete map[key];
                              else map[key] = v;
                              const ex = [...alignExamples(draft.body, draft.bodyExamples, "")];
                              if (v !== NONE && !ex[n - 1]) ex[n - 1] = sampleFor(v) ?? "";
                              patch({ variableMap: map, bodyExamples: ex });
                            }}
                          >
                            <SelectTrigger aria-label={`Source for variable ${n}`}>
                              <SelectValue />
                            </SelectTrigger>
                            <SelectContent>
                              <SelectItem value={NONE}>Fill in when sending</SelectItem>
                              {TEMPLATE_SOURCES.map((s) => (
                                <SelectItem key={s.key} value={s.key}>
                                  {s.label}
                                </SelectItem>
                              ))}
                            </SelectContent>
                          </Select>
                        </div>
                      );
                    })}
                    {errors
                      .filter((e) => e.path.startsWith("bodyExamples"))
                      .map((e, i) => (
                        <p key={i} className="text-destructive text-xs">
                          {e.message}
                        </p>
                      ))}
                  </div>
                )}

                {bodyNames.length > 0 && (
                  <div className="grid gap-2 rounded-md border p-3">
                    <p className="text-muted-foreground text-xs">
                      Meta needs an example for each name. The mapping says what fills it when the
                      template is sent.
                    </p>
                    {bodyNames.map((name) => {
                      const key = `body.${name}`;
                      const src = draft.variableMap[key];
                      return (
                        <div key={name} className="grid gap-2 sm:grid-cols-[8rem_1fr_1fr]">
                          <code className="self-center truncate text-xs" title={`{{${name}}}`}>
                            {`{{${name}}}`}
                          </code>
                          <Input
                            value={draft.namedExamples?.[name] ?? ""}
                            onChange={(e) =>
                              patch({
                                namedExamples: { ...draft.namedExamples, [name]: e.target.value },
                              })
                            }
                            placeholder="Example"
                            aria-label={`Example for ${name}`}
                            dir={isRtl ? "rtl" : "ltr"}
                          />
                          <Select
                            value={src && !src.startsWith("text:") ? src : NONE}
                            onValueChange={(v) => {
                              const map = { ...draft.variableMap };
                              if (v === NONE) delete map[key];
                              else map[key] = v;
                              const ex = { ...draft.namedExamples };
                              if (v !== NONE && !ex[name]) ex[name] = sampleFor(v) ?? "";
                              patch({ variableMap: map, namedExamples: ex });
                            }}
                          >
                            <SelectTrigger aria-label={`Source for ${name}`}>
                              <SelectValue />
                            </SelectTrigger>
                            <SelectContent>
                              <SelectItem value={NONE}>Fill in when sending</SelectItem>
                              {TEMPLATE_SOURCES.map((s) => (
                                <SelectItem key={s.key} value={s.key}>
                                  {s.label}
                                </SelectItem>
                              ))}
                            </SelectContent>
                          </Select>
                        </div>
                      );
                    })}
                    {errors
                      .filter((e) => e.path.startsWith("namedExamples"))
                      .map((e, i) => (
                        <p key={i} className="text-destructive text-xs">
                          {e.message}
                        </p>
                      ))}
                  </div>
                )}
              </section>
            )}

            {draft.type !== "carousel" && !isAuth && (
              <>
                <Field label="Footer (optional)">
                  <div className="grid gap-1">
                    <Input
                      value={draft.footer}
                      onChange={(e) => patch({ footer: e.target.value })}
                      dir={isRtl ? "rtl" : "ltr"}
                      placeholder={
                        draft.category === "MARKETING"
                          ? "Reply STOP to unsubscribe"
                          : "Short note under the message"
                      }
                    />
                    <Counter value={draft.footer.length} max={LIMITS.footer} />
                  </div>
                </Field>
                <section className="grid gap-2">
                  <Label>Buttons (optional)</Label>
                  <ButtonEditor
                    buttons={draft.buttons}
                    onChange={(buttons) =>
                      patch({
                        buttons,
                        ...(buttons.length && draft.type === "standard"
                          ? { type: "media_interactive" as const }
                          : {}),
                      })
                    }
                    allowCopyCode
                    allowCatalog={draft.category === "MARKETING"}
                  />
                  {draft.buttons.some((b) => b.type === "CATALOG") && (
                    <p className="text-muted-foreground text-xs">
                      Needs a product catalogue connected to this WhatsApp account in Meta Commerce
                      Manager. WhatsApp shows a catalogue picture above the text; a sender can pick
                      which item (its content ID).
                    </p>
                  )}
                </section>
              </>
            )}

            {draft.type === "carousel" && (
              <section className="grid gap-3">
                <div className="flex items-center justify-between">
                  <Label>
                    Cards ({draft.cards.length}/{LIMITS.cardsMax})
                  </Label>
                  <Button
                    type="button"
                    size="sm"
                    variant="outline"
                    disabled={draft.cards.length >= LIMITS.cardsMax}
                    onClick={() => patch({ cards: [...draft.cards, newCard(draft.cards[0])] })}
                  >
                    <Plus /> Add card
                  </Button>
                </div>
                {draft.cards.map((c, i) => (
                  <div key={i} className="grid gap-2 rounded-lg border p-3">
                    <div className="flex items-center justify-between">
                      <strong className="text-sm">Card {i + 1}</strong>
                      <Button
                        type="button"
                        variant="ghost"
                        size="icon"
                        aria-label="Remove card"
                        onClick={() => patch({ cards: draft.cards.filter((_, j) => j !== i) })}
                      >
                        <Trash2 />
                      </Button>
                    </div>
                    <div className="flex flex-wrap items-center gap-2">
                      <Select
                        value={c.format}
                        onValueChange={(v) =>
                          patch({
                            cards: draft.cards.map((x) => ({
                              ...x,
                              format: v as DraftCard["format"],
                              handle: undefined,
                              sampleName: undefined,
                            })),
                          })
                        }
                        disabled={i > 0}
                      >
                        <SelectTrigger className="w-32">
                          <SelectValue />
                        </SelectTrigger>
                        <SelectContent>
                          <SelectItem value="IMAGE">Image</SelectItem>
                          <SelectItem value="VIDEO">Video</SelectItem>
                        </SelectContent>
                      </Select>
                      <label className="inline-flex">
                        <input
                          type="file"
                          className="hidden"
                          accept={c.format === "IMAGE" ? "image/jpeg,image/png" : "video/mp4"}
                          onChange={(e) =>
                            upload(
                              e.target.files?.[0],
                              (r) =>
                                patch({
                                  cards: draft.cards.map((x, j) =>
                                    j === i ? { ...x, handle: r.handle, sampleName: r.name } : x,
                                  ),
                                }),
                              `card${i}`,
                            )
                          }
                        />
                        <span className="border-input hover:bg-accent inline-flex h-8 cursor-pointer items-center gap-1.5 rounded-md border px-3 text-sm">
                          {uploading === `card${i}` ? (
                            <Loader2 className="size-4 animate-spin" />
                          ) : (
                            <Upload className="size-4" />
                          )}
                          {c.handle ? "Replace sample" : "Upload sample"}
                        </span>
                      </label>
                      {c.handle && (
                        <span className="text-muted-foreground text-xs">
                          {c.sampleName ?? "Sample uploaded"}
                        </span>
                      )}
                    </div>
                    <div className="grid gap-1">
                      <Textarea
                        rows={2}
                        value={c.body}
                        onChange={(e) =>
                          patch({
                            cards: draft.cards.map((x, j) =>
                              j === i ? { ...x, body: e.target.value } : x,
                            ),
                          })
                        }
                        placeholder="Card text"
                        dir={isRtl ? "rtl" : "ltr"}
                      />
                      <Counter value={c.body.length} max={LIMITS.cardBody} />
                    </div>
                    <ButtonEditor
                      buttons={c.buttons}
                      allowCopyCode={false}
                      onChange={(buttons) =>
                        patch({
                          cards: draft.cards.map((x, j) =>
                            j === i ? { ...x, buttons: buttons.slice(0, LIMITS.cardButtons) } : x,
                          ),
                        })
                      }
                    />
                    {issueFor(`cards.${i}`).map((e, k) => (
                      <p key={k} className="text-destructive text-xs">
                        {e.message}
                      </p>
                    ))}
                  </div>
                ))}
                {errors
                  .filter((e) => e.path === "cards")
                  .map((e, i) => (
                    <p key={i} className="text-destructive text-xs">
                      {e.message}
                    </p>
                  ))}
              </section>
            )}

            {(errors.length > 0 || warnings.length > 0) && (
              <ul className="flex flex-col gap-1 rounded-md border p-3 text-xs">
                {errors.map((e, i) => (
                  <li key={`e${i}`} className="text-destructive flex gap-1.5">
                    <TriangleAlert className="mt-0.5 size-3.5 shrink-0" /> {e.message}
                  </li>
                ))}
                {warnings.map((w, i) => (
                  <li key={`w${i}`} className="flex gap-1.5 text-amber-700 dark:text-amber-300">
                    <TriangleAlert className="mt-0.5 size-3.5 shrink-0" /> {w.message}
                  </li>
                ))}
              </ul>
            )}
          </div>

          <div className="flex flex-col gap-4 lg:sticky lg:top-0 lg:self-start">
            <div dir={isRtl ? "rtl" : "ltr"}>
              <PhonePreview preview={preview} />
            </div>
            <div className="flex flex-col gap-2">
              {!editable && (
                <p className="text-muted-foreground text-xs">
                  A template in this state can&apos;t be edited right now.
                </p>
              )}
              {(!init.submitted || init.status === "DRAFT") && (
                <Button
                  type="button"
                  variant="outline"
                  onClick={save}
                  disabled={saving || submitting || !draft.name || !channelId}
                >
                  {saving && <Loader2 className="animate-spin" />} Save draft
                </Button>
              )}
              <Button
                type="button"
                onClick={submit}
                disabled={errors.length > 0 || saving || submitting || !editable || !channelId}
              >
                {submitting ? <Loader2 className="animate-spin" /> : <Send />}{" "}
                {init.submitted && init.status !== "DRAFT" ? "Save & resubmit" : "Submit to Meta"}
              </Button>
              {errors.length > 0 && (
                <p className="text-muted-foreground text-xs">
                  Fix the {errors.length} problem{errors.length > 1 ? "s" : ""} above to submit.
                </p>
              )}
            </div>
          </div>
        </div>
      </SheetContent>
      {askDialog}
    </Sheet>
  );
}

function newCard(like?: DraftCard): DraftCard {
  return {
    format: like?.format ?? "IMAGE",
    body: "",
    buttons: like
      ? like.buttons.map(
          (b) =>
            ({
              ...b,
              ...(b.type === "QUICK_REPLY" || b.type === "URL" || b.type === "PHONE_NUMBER"
                ? { text: "" }
                : {}),
            }) as DraftButton,
        )
      : [{ type: "URL", text: "", url: "https://" }],
  };
}
