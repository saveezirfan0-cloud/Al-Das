"use client";

import * as React from "react";
import {
  AlertTriangle,
  Bold,
  Code,
  Italic,
  Loader2,
  Plus,
  Strikethrough,
  Trash2,
  Upload,
  X,
} from "lucide-react";
import { toast } from "sonner";

import { PhonePreview } from "@/components/whatsapp/phone-preview";
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
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
} from "@/components/ui/sheet";
import { Textarea } from "@/components/ui/textarea";
import { canEdit, lockedFields, STATUS_LABEL } from "@/lib/templates/rules";
import {
  componentsToDraft,
  draftToComponents,
  emptyDraft,
  insertVariable,
  renumberVariables,
  TEMPLATE_CATEGORIES,
  TEMPLATE_LANGUAGES,
  VARIABLE_SOURCES,
  variableNumbers,
  type DraftButton,
  type DraftCard,
  type TemplateDraft,
} from "@/lib/whatsapp/template-draft";
import { validateDraft, LIMITS } from "@/lib/whatsapp/template-validate";
import { cn } from "@/lib/utils";

import {
  markTemplateReviewed,
  saveTemplateDraft,
  submitTemplateToMeta,
  uploadCardSample,
  uploadHeaderSample,
} from "./actions";
import { StatusBadge } from "./status-badge";
import type { ChannelOption, TemplateView } from "./types";

const NONE = "__none__";

export function draftFromTemplate(t: TemplateView): TemplateDraft {
  const d = componentsToDraft(t.components, {
    name: t.name,
    language: t.language,
    category: t.category,
    variableMap: t.variable_map,
  });
  if (
    t.header_sample_path &&
    (d.header.format === "IMAGE" || d.header.format === "VIDEO" || d.header.format === "DOCUMENT")
  )
    d.header = { ...d.header, samplePath: t.header_sample_path };
  d.cards = d.cards.map((c, i) => ({
    ...c,
    header: { ...c.header, samplePath: t.card_sample_paths[i] ?? undefined },
  }));
  return d;
}

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
    <div className={cn("space-y-1.5", className)}>
      <Label className="text-sm">{label}</Label>
      {children}
      {hint ? <p className="text-muted-foreground text-xs">{hint}</p> : null}
    </div>
  );
}

function Counter({ value, max }: { value: string; max: number }) {
  return (
    <span
      className={cn("text-xs", value.length > max ? "text-destructive" : "text-muted-foreground")}
    >
      {value.length}/{max}
    </span>
  );
}

function ButtonsEditor({
  buttons,
  onChange,
  disabled,
  max,
}: {
  buttons: DraftButton[];
  onChange: (b: DraftButton[]) => void;
  disabled?: boolean;
  max: number;
}) {
  const set = (i: number, patch: Partial<DraftButton>) =>
    onChange(buttons.map((b, j) => (j === i ? ({ ...b, ...patch } as DraftButton) : b)));
  const add = (type: DraftButton["type"]) => {
    const b: DraftButton =
      type === "QUICK_REPLY"
        ? { type, text: "" }
        : type === "URL"
          ? { type, text: "", url: "https://" }
          : type === "PHONE_NUMBER"
            ? { type, text: "", phone_number: "+971" }
            : { type, example: "" };
    onChange([...buttons, b]);
  };
  return (
    <div className="space-y-2">
      {buttons.map((b, i) => (
        <div key={i} className="space-y-2 rounded-md border p-2.5">
          <div className="flex items-center justify-between">
            <span className="text-xs font-medium">
              {
                {
                  QUICK_REPLY: "Quick reply",
                  URL: "Visit website",
                  PHONE_NUMBER: "Call phone number",
                  COPY_CODE: "Copy code",
                }[b.type]
              }
            </span>
            <Button
              type="button"
              size="icon"
              variant="ghost"
              className="size-7"
              disabled={disabled}
              onClick={() => onChange(buttons.filter((_, j) => j !== i))}
              aria-label="Remove button"
            >
              <Trash2 className="size-3.5" />
            </Button>
          </div>
          {b.type !== "COPY_CODE" ? (
            <div className="relative">
              <Input
                value={b.text}
                maxLength={60}
                disabled={disabled}
                placeholder="Button text"
                onChange={(e) => set(i, { text: e.target.value })}
              />
              <span className="absolute end-2 top-2">
                <Counter value={b.text} max={LIMITS.buttonTextMax} />
              </span>
            </div>
          ) : null}
          {b.type === "URL" ? (
            <>
              <Input
                value={b.url}
                disabled={disabled}
                placeholder="https://example.com/page"
                onChange={(e) => set(i, { url: e.target.value })}
              />
              {variableNumbers(b.url).length > 0 ? (
                <Input
                  value={b.example ?? ""}
                  disabled={disabled}
                  placeholder="Example address, e.g. https://example.com/page/42"
                  onChange={(e) => set(i, { example: e.target.value })}
                />
              ) : null}
            </>
          ) : null}
          {b.type === "PHONE_NUMBER" ? (
            <Input
              value={b.phone_number}
              disabled={disabled}
              placeholder="+97140000000"
              onChange={(e) => set(i, { phone_number: e.target.value })}
            />
          ) : null}
          {b.type === "COPY_CODE" ? (
            <Input
              value={b.example}
              maxLength={15}
              disabled={disabled}
              placeholder="Example code, e.g. SAVE20"
              onChange={(e) => set(i, { example: e.target.value })}
            />
          ) : null}
        </div>
      ))}
      {!disabled && buttons.length < max ? (
        <div className="flex flex-wrap gap-1.5">
          {(["QUICK_REPLY", "URL", "PHONE_NUMBER", "COPY_CODE"] as const).map((t) => (
            <Button key={t} type="button" size="sm" variant="outline" onClick={() => add(t)}>
              <Plus className="size-3.5" />
              {
                {
                  QUICK_REPLY: "Quick reply",
                  URL: "Website",
                  PHONE_NUMBER: "Call",
                  COPY_CODE: "Copy code",
                }[t]
              }
            </Button>
          ))}
        </div>
      ) : null}
    </div>
  );
}

export function TemplateDrawer({
  open,
  template,
  channels,
  canManage,
  uploadsEnabled,
  initial,
  onClose,
  onChanged,
}: {
  open: boolean;
  template: TemplateView | null;
  channels: ChannelOption[];
  canManage: boolean;
  uploadsEnabled: boolean;
  /** Pre-filled draft for a new template (e.g. from the starter gallery). */
  initial?: TemplateDraft | null;
  onClose: () => void;
  onChanged: () => void;
}) {
  const [draft, setDraft] = React.useState<TemplateDraft>(() =>
    template ? draftFromTemplate(template) : (initial ?? emptyDraft()),
  );
  const [channelId, setChannelId] = React.useState<string>(
    template?.channel_id ??
      channels.find((c) => c.status === "active")?.id ??
      channels[0]?.id ??
      "",
  );
  const [id, setId] = React.useState<string | null>(template?.id ?? null);
  const [dirty, setDirty] = React.useState(false);
  const [busy, setBusy] = React.useState<null | "save" | "submit" | "upload" | "review">(null);
  const bodyRef = React.useRef<HTMLTextAreaElement>(null);
  const fileRef = React.useRef<HTMLInputElement>(null);

  const status = template?.status ?? "DRAFT";
  const onMeta = !!template?.meta_template_id;
  const locks = template ? lockedFields(template) : [];
  const editable = template ? canEdit({ ...template, needs_review: false }) : { ok: true as const };
  const readOnly = !canManage || !editable.ok;
  const rtl = draft.language.startsWith("ar");
  const check = React.useMemo(() => validateDraft(draft), [draft]);
  const components = React.useMemo(() => draftToComponents(draft), [draft]);
  const needsReview = template?.needs_review ?? false;
  const approvedEdit = status === "APPROVED" && onMeta;

  const patch = (p: Partial<TemplateDraft>) => {
    setDraft((d) => ({ ...d, ...p }));
    setDirty(true);
  };

  const bodyVars = variableNumbers(draft.body);

  const wrap = (open: string, close = open) => {
    const el = bodyRef.current;
    if (!el) return;
    const { selectionStart: a, selectionEnd: b, value } = el;
    patch({ body: `${value.slice(0, a)}${open}${value.slice(a, b)}${close}${value.slice(b)}` });
    requestAnimationFrame(() => {
      el.focus();
      el.setSelectionRange(a + open.length, b + open.length);
    });
  };

  const addVariable = () => {
    const el = bodyRef.current;
    const r = insertVariable(draft.body, el?.selectionStart ?? draft.body.length);
    const ex = [...draft.bodyExamples];
    ex[r.number - 1] = ex[r.number - 1] ?? "";
    patch({ body: r.text, bodyExamples: ex });
    requestAnimationFrame(() => el?.focus());
  };

  const fixNumbering = () => {
    const r = renumberVariables(draft.body);
    const ex: string[] = [];
    const map: Record<string, string> = {};
    for (const [oldN, newN] of Object.entries(r.mapping)) {
      ex[newN - 1] = draft.bodyExamples[Number(oldN) - 1] ?? "";
      const m = draft.variableMap[`body.${oldN}`];
      if (m) map[`body.${newN}`] = m;
    }
    patch({ body: r.text, bodyExamples: ex, variableMap: map });
  };

  async function save(): Promise<string | null> {
    if (!channelId) {
      toast.error("Choose a WhatsApp number first.");
      return null;
    }
    setBusy("save");
    const r = await saveTemplateDraft({ id, channelId, draft });
    setBusy(null);
    if (!r.ok) {
      toast.error(r.error);
      return null;
    }
    setId(r.id);
    setDirty(false);
    onChanged();
    return r.id;
  }

  async function submit() {
    setBusy("submit");
    let target = id;
    if (!approvedEdit && (dirty || !id)) {
      const saved = await saveTemplateDraft({ id, channelId, draft });
      if (!saved.ok) {
        setBusy(null);
        toast.error(saved.error);
        return;
      }
      target = saved.id;
      setId(saved.id);
      setDirty(false);
    }
    const r = await submitTemplateToMeta(target!, approvedEdit ? draft : undefined);
    setBusy(null);
    if (!r.ok) {
      toast.error(r.error);
      onChanged();
      return;
    }
    toast.success(
      r.status === "APPROVED"
        ? "Changes sent to Meta."
        : "Sent to Meta for review. The status updates here when Meta replies.",
    );
    onChanged();
    onClose();
  }

  async function upload(file: File) {
    const target = id ?? (await save());
    if (!target) return;
    setBusy("upload");
    const fd = new FormData();
    fd.set("id", target);
    fd.set("file", file);
    const r = await uploadHeaderSample(fd);
    setBusy(null);
    if (!r.ok) {
      toast.error(r.error);
      return;
    }
    if (
      draft.header.format === "IMAGE" ||
      draft.header.format === "VIDEO" ||
      draft.header.format === "DOCUMENT"
    )
      patch({ header: { ...draft.header, samplePath: r.path } });
    toast.success("Sample attached.");
    onChanged();
  }

  async function uploadCard(index: number, file: File) {
    const target = id ?? (await save());
    if (!target) return;
    setBusy("upload");
    // Save first so the card exists server-side at this index.
    if (dirty) {
      const saved = await saveTemplateDraft({ id: target, channelId, draft });
      if (!saved.ok) {
        setBusy(null);
        toast.error(saved.error);
        return;
      }
      setDirty(false);
    }
    const fd = new FormData();
    fd.set("id", target);
    fd.set("index", String(index));
    fd.set("file", file);
    const r = await uploadCardSample(fd);
    setBusy(null);
    if (!r.ok) {
      toast.error(r.error);
      return;
    }
    setDraft((d) => ({
      ...d,
      cards: d.cards.map((c, j) =>
        j === index ? { ...c, header: { ...c.header, samplePath: r.path } } : c,
      ),
    }));
    toast.success(`Card ${index + 1} sample attached.`);
    onChanged();
  }

  async function review() {
    if (!id) return;
    setBusy("review");
    const r = await markTemplateReviewed(id);
    setBusy(null);
    if (!r.ok) toast.error(r.error);
    else {
      toast.success("Marked as reviewed.");
      onChanged();
    }
  }

  const header = draft.header;
  const mediaFormat =
    header.format === "IMAGE" || header.format === "VIDEO" || header.format === "DOCUMENT"
      ? header.format
      : null;
  const accept =
    mediaFormat === "IMAGE"
      ? "image/jpeg,image/png"
      : mediaFormat === "VIDEO"
        ? "video/mp4"
        : "application/pdf";
  const sampleReady =
    mediaFormat &&
    header.format !== "NONE" &&
    ("samplePath" in header ? !!header.samplePath : false);

  const dir = rtl ? "rtl" : "ltr";

  return (
    <Sheet open={open} onOpenChange={(o) => !o && onClose()}>
      <SheetContent
        side="right"
        className="flex w-full flex-col gap-0 overflow-y-auto sm:max-w-5xl"
      >
        <SheetHeader>
          <SheetTitle className="flex items-center gap-2">
            {template ? template.name : "New template"}
            {template ? (
              <StatusBadge status={template.status} archived={!!template.archived_at} />
            ) : null}
          </SheetTitle>
          <SheetDescription>
            {readOnly
              ? !canManage
                ? "You can view templates; ask an administrator for permission to change them."
                : !editable.ok
                  ? editable.reason
                  : ""
              : "Write the message, add variables with “Add variable”, and check the preview. Meta reviews every template before it can be sent."}
          </SheetDescription>
        </SheetHeader>

        <div className="grid flex-1 gap-6 px-4 pb-6 lg:grid-cols-[minmax(0,1fr)_340px]">
          <div className="space-y-5">
            {template?.rejected_reason && status === "REJECTED" ? (
              <Alert variant="destructive">
                <AlertTriangle />
                <AlertTitle>Meta rejected this template</AlertTitle>
                <AlertDescription>
                  {template.rejected_reason.replaceAll("_", " ").toLowerCase()}. Edit the wording
                  and submit again.
                </AlertDescription>
              </Alert>
            ) : null}
            {template?.last_error ? (
              <Alert variant="destructive">
                <AlertTriangle />
                <AlertTitle>The last submission failed</AlertTitle>
                <AlertDescription>{template.last_error}</AlertDescription>
              </Alert>
            ) : null}
            {needsReview ? (
              <Alert>
                <AlertTriangle />
                <AlertTitle>This wording needs review</AlertTitle>
                <AlertDescription>
                  <p>
                    Starter text in {draft.language.startsWith("ar") ? "Arabic" : "this language"}{" "}
                    was written without a native-speaker check. Read it, fix anything that sounds
                    wrong, then mark it reviewed. It cannot be submitted before that.
                  </p>
                  {canManage && id ? (
                    <Button
                      type="button"
                      size="sm"
                      className="mt-2"
                      onClick={review}
                      disabled={busy !== null}
                    >
                      {busy === "review" ? <Loader2 className="size-3.5 animate-spin" /> : null}I
                      have reviewed this wording
                    </Button>
                  ) : null}
                </AlertDescription>
              </Alert>
            ) : null}
            {template?.internal_key ? (
              <Alert>
                <AlertTitle>Used by the clinical rules</AlertTitle>
                <AlertDescription>
                  Key <code>{template.internal_key}</code>, clinical approval:{" "}
                  <strong>{template.clinical_approval}</strong>. Changing the wording of an approved
                  clinical template needs the clinical lead to approve it again.
                </AlertDescription>
              </Alert>
            ) : null}

            <section className="grid gap-4 sm:grid-cols-2">
              <Field
                label="Template name"
                hint={
                  locks.includes("name")
                    ? "Fixed once the template is on Meta."
                    : "Lowercase letters, numbers and underscores."
                }
              >
                <Input
                  value={draft.name}
                  disabled={readOnly || locks.includes("name")}
                  placeholder="appointment_reminder"
                  onChange={(e) =>
                    patch({ name: e.target.value.toLowerCase().replace(/[^a-z0-9_]/g, "_") })
                  }
                />
              </Field>
              <Field
                label="Number"
                hint={locks.includes("channel") ? "Fixed once the template is on Meta." : undefined}
              >
                <Select
                  value={channelId}
                  onValueChange={(v) => {
                    setChannelId(v);
                    setDirty(true);
                  }}
                  disabled={readOnly || locks.includes("channel")}
                >
                  <SelectTrigger>
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
              </Field>
              <Field
                label="Category"
                hint={
                  draft.category === "MARKETING"
                    ? "Promotions and recalls. Needs opt-in."
                    : draft.category === "UTILITY"
                      ? "Updates about something the patient already did or booked."
                      : "One-time codes."
                }
              >
                <Select
                  value={draft.category}
                  onValueChange={(v) => patch({ category: v as TemplateDraft["category"] })}
                  disabled={readOnly || locks.includes("category")}
                >
                  <SelectTrigger>
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
              </Field>
              <Field label="Language">
                <Select
                  value={draft.language}
                  onValueChange={(v) => patch({ language: v })}
                  disabled={readOnly || locks.includes("language")}
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
              <Field label="Format" className="sm:col-span-2">
                <Select
                  value={draft.kind === "carousel" ? "carousel" : "single"}
                  onValueChange={(v) =>
                    patch({
                      kind: v === "carousel" ? "carousel" : "standard",
                      cards:
                        v === "carousel" && draft.cards.length === 0
                          ? [blankCard(), blankCard()]
                          : draft.cards,
                    })
                  }
                  disabled={readOnly || onMeta}
                >
                  <SelectTrigger>
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="single">Message (text, media, buttons)</SelectItem>
                    <SelectItem value="carousel">Carousel (2–10 swipeable cards)</SelectItem>
                  </SelectContent>
                </Select>
              </Field>
            </section>

            {draft.kind !== "carousel" ? (
              <Field label="Header (optional)">
                <div className="space-y-2">
                  <Select
                    value={header.format}
                    disabled={readOnly}
                    onValueChange={(v) =>
                      patch({
                        header:
                          v === "NONE"
                            ? { format: "NONE" }
                            : v === "TEXT"
                              ? { format: "TEXT", text: "" }
                              : v === "LOCATION"
                                ? { format: "LOCATION" }
                                : { format: v as "IMAGE" | "VIDEO" | "DOCUMENT" },
                      })
                    }
                  >
                    <SelectTrigger>
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="NONE">No header</SelectItem>
                      <SelectItem value="TEXT">Text</SelectItem>
                      <SelectItem value="IMAGE">Image</SelectItem>
                      <SelectItem value="VIDEO">Video</SelectItem>
                      <SelectItem value="DOCUMENT">Document (PDF)</SelectItem>
                      <SelectItem value="LOCATION">Location</SelectItem>
                    </SelectContent>
                  </Select>
                  {header.format === "TEXT" ? (
                    <>
                      <div className="relative">
                        <Input
                          dir={dir}
                          value={header.text}
                          disabled={readOnly}
                          placeholder="Short title"
                          onChange={(e) => patch({ header: { ...header, text: e.target.value } })}
                        />
                        <span className="absolute end-2 top-2">
                          <Counter value={header.text} max={LIMITS.headerTextMax} />
                        </span>
                      </div>
                      {variableNumbers(header.text).length > 0 ? (
                        <Input
                          value={header.example ?? ""}
                          disabled={readOnly}
                          placeholder="Example for {{1}}"
                          onChange={(e) =>
                            patch({ header: { ...header, example: e.target.value } })
                          }
                        />
                      ) : null}
                    </>
                  ) : null}
                  {mediaFormat ? (
                    <div className="flex flex-wrap items-center gap-2 rounded-md border border-dashed p-3">
                      <input
                        ref={fileRef}
                        type="file"
                        accept={accept}
                        className="hidden"
                        onChange={(e) => {
                          const f = e.target.files?.[0];
                          if (f) void upload(f);
                          e.target.value = "";
                        }}
                      />
                      <Button
                        type="button"
                        size="sm"
                        variant="outline"
                        disabled={readOnly || busy !== null || !uploadsEnabled}
                        onClick={() => fileRef.current?.click()}
                      >
                        {busy === "upload" ? (
                          <Loader2 className="size-3.5 animate-spin" />
                        ) : (
                          <Upload className="size-3.5" />
                        )}
                        {sampleReady ? "Replace sample" : "Upload sample"}
                      </Button>
                      <span className="text-muted-foreground text-xs">
                        {sampleReady
                          ? "Sample attached. It is sent to Meta when you submit."
                          : uploadsEnabled
                            ? "Meta needs an example file for review."
                            : "META_APP_ID is not set, so samples cannot be uploaded."}
                      </span>
                    </div>
                  ) : null}
                </div>
              </Field>
            ) : null}

            <Field
              label="Message"
              hint="Variables are numbered {{1}}, {{2}}… and each needs an example."
            >
              <div className="space-y-2">
                <div className="flex flex-wrap items-center gap-1">
                  <Button
                    type="button"
                    size="icon"
                    variant="outline"
                    className="size-8"
                    disabled={readOnly}
                    onClick={() => wrap("*")}
                    aria-label="Bold"
                  >
                    <Bold className="size-3.5" />
                  </Button>
                  <Button
                    type="button"
                    size="icon"
                    variant="outline"
                    className="size-8"
                    disabled={readOnly}
                    onClick={() => wrap("_")}
                    aria-label="Italic"
                  >
                    <Italic className="size-3.5" />
                  </Button>
                  <Button
                    type="button"
                    size="icon"
                    variant="outline"
                    className="size-8"
                    disabled={readOnly}
                    onClick={() => wrap("~")}
                    aria-label="Strikethrough"
                  >
                    <Strikethrough className="size-3.5" />
                  </Button>
                  <Button
                    type="button"
                    size="icon"
                    variant="outline"
                    className="size-8"
                    disabled={readOnly}
                    onClick={() => wrap("```")}
                    aria-label="Monospace"
                  >
                    <Code className="size-3.5" />
                  </Button>
                  <Button
                    type="button"
                    size="sm"
                    variant="secondary"
                    disabled={readOnly}
                    onClick={addVariable}
                  >
                    <Plus className="size-3.5" />
                    Add variable
                  </Button>
                  <span className="ms-auto">
                    <Counter value={draft.body} max={LIMITS.bodyMax} />
                  </span>
                </div>
                <Textarea
                  ref={bodyRef}
                  dir={dir}
                  rows={6}
                  value={draft.body}
                  disabled={readOnly}
                  onChange={(e) => patch({ body: e.target.value })}
                />
                {bodyVars.length > 0 ? (
                  <div className="space-y-2 rounded-md border p-2.5">
                    {bodyVars.map((n) => (
                      <div key={n} className="grid items-center gap-2 sm:grid-cols-[48px_1fr_1fr]">
                        <code className="text-xs">{`{{${n}}}`}</code>
                        <Input
                          value={draft.bodyExamples[n - 1] ?? ""}
                          disabled={readOnly}
                          placeholder="Example value"
                          dir={dir}
                          onChange={(e) => {
                            const ex = [...draft.bodyExamples];
                            ex[n - 1] = e.target.value;
                            patch({ bodyExamples: ex });
                          }}
                        />
                        <Select
                          value={draft.variableMap[`body.${n}`] ?? NONE}
                          disabled={readOnly}
                          onValueChange={(v) => {
                            const map = { ...draft.variableMap };
                            if (v === NONE) delete map[`body.${n}`];
                            else map[`body.${n}`] = v;
                            const ex = [...draft.bodyExamples];
                            if (v !== NONE && !ex[n - 1])
                              ex[n - 1] = VARIABLE_SOURCES.find((s) => s.key === v)?.example ?? "";
                            patch({ variableMap: map, bodyExamples: ex });
                          }}
                        >
                          <SelectTrigger>
                            <SelectValue placeholder="Fill from…" />
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
                    {!readOnly && !bodyVars.every((n, i) => n === i + 1) ? (
                      <Button type="button" size="sm" variant="outline" onClick={fixNumbering}>
                        Renumber variables 1, 2, 3…
                      </Button>
                    ) : null}
                  </div>
                ) : null}
              </div>
            </Field>

            {draft.kind !== "carousel" ? (
              <>
                <Field
                  label="Footer (optional)"
                  hint={
                    draft.category === "MARKETING"
                      ? "For marketing messages, say how to opt out, for example “Reply STOP to opt out”."
                      : undefined
                  }
                >
                  <div className="relative">
                    <Input
                      dir={dir}
                      value={draft.footer}
                      disabled={readOnly}
                      onChange={(e) => patch({ footer: e.target.value })}
                    />
                    <span className="absolute end-2 top-2">
                      <Counter value={draft.footer} max={LIMITS.footerMax} />
                    </span>
                  </div>
                </Field>
                <Field
                  label="Buttons (optional)"
                  hint="Up to 10. Keep quick replies together. Up to 2 website buttons and 1 call button."
                >
                  <ButtonsEditor
                    buttons={draft.buttons}
                    onChange={(buttons) => patch({ buttons })}
                    disabled={readOnly}
                    max={LIMITS.buttonsMax}
                  />
                </Field>
              </>
            ) : (
              <Field
                label="Cards"
                hint="Every card needs the same media type, a sample file and the same buttons. Samples are sent to Meta when you submit."
              >
                <div className="space-y-3">
                  {draft.cards.map((c, i) => (
                    <div key={i} className="space-y-2 rounded-md border p-3">
                      <div className="flex items-center justify-between">
                        <span className="text-sm font-medium">Card {i + 1}</span>
                        <div className="flex items-center gap-1">
                          <Select
                            value={c.header.format}
                            disabled={readOnly}
                            onValueChange={(v) =>
                              patch({
                                cards: draft.cards.map((x, j) =>
                                  j === i
                                    ? {
                                        ...x,
                                        header: { ...x.header, format: v as "IMAGE" | "VIDEO" },
                                      }
                                    : x,
                                ),
                              })
                            }
                          >
                            <SelectTrigger className="h-8 w-28">
                              <SelectValue />
                            </SelectTrigger>
                            <SelectContent>
                              <SelectItem value="IMAGE">Image</SelectItem>
                              <SelectItem value="VIDEO">Video</SelectItem>
                            </SelectContent>
                          </Select>
                          <Button
                            type="button"
                            size="icon"
                            variant="ghost"
                            className="size-8"
                            disabled={readOnly || draft.cards.length <= 2}
                            onClick={() => patch({ cards: draft.cards.filter((_, j) => j !== i) })}
                            aria-label="Remove card"
                          >
                            <X className="size-4" />
                          </Button>
                        </div>
                      </div>
                      <div className="flex items-center gap-2 text-xs">
                        <label
                          className={cn(
                            "inline-flex cursor-pointer items-center gap-1.5 rounded-md border px-2.5 py-1.5",
                            (readOnly || busy !== null || !uploadsEnabled) &&
                              "pointer-events-none opacity-50",
                          )}
                        >
                          <Upload className="size-3.5" />
                          {c.header.samplePath ? "Replace sample" : "Upload sample"}
                          <input
                            type="file"
                            className="hidden"
                            accept={
                              c.header.format === "VIDEO" ? "video/mp4" : "image/jpeg,image/png"
                            }
                            onChange={(e) => {
                              const f = e.target.files?.[0];
                              if (f) void uploadCard(i, f);
                              e.target.value = "";
                            }}
                          />
                        </label>
                        <span className="text-muted-foreground">
                          {c.header.samplePath ? "Sample attached." : "No sample yet."}
                        </span>
                      </div>
                      <Textarea
                        dir={dir}
                        rows={2}
                        value={c.body}
                        disabled={readOnly}
                        placeholder="Card text"
                        onChange={(e) =>
                          patch({
                            cards: draft.cards.map((x, j) =>
                              j === i ? { ...x, body: e.target.value } : x,
                            ),
                          })
                        }
                      />
                      <ButtonsEditor
                        buttons={c.buttons}
                        disabled={readOnly}
                        max={LIMITS.carouselCardButtonsMax}
                        onChange={(buttons) =>
                          patch({
                            cards: draft.cards.map((x, j) => (j === i ? { ...x, buttons } : x)),
                          })
                        }
                      />
                    </div>
                  ))}
                  {!readOnly && draft.cards.length < LIMITS.carouselCardsMax ? (
                    <Button
                      type="button"
                      size="sm"
                      variant="outline"
                      onClick={() => patch({ cards: [...draft.cards, blankCard(draft.cards[0])] })}
                    >
                      <Plus className="size-3.5" />
                      Add card
                    </Button>
                  ) : null}
                </div>
              </Field>
            )}
          </div>

          <aside className="space-y-4 lg:sticky lg:top-2 lg:self-start">
            <PhonePreview components={components} rtl={rtl} />
            <div className="rounded-md border p-3 text-sm" aria-live="polite">
              {check.issues.length === 0 ? (
                <p className="text-emerald-700 dark:text-emerald-400">
                  Looks good. Ready to send to Meta.
                </p>
              ) : (
                <ul className="space-y-1.5">
                  {check.issues.map((i, k) => (
                    <li
                      key={k}
                      className={cn(
                        "flex gap-1.5 text-xs",
                        i.severity === "error"
                          ? "text-destructive"
                          : "text-amber-700 dark:text-amber-400",
                      )}
                    >
                      <AlertTriangle className="mt-0.5 size-3 shrink-0" />
                      <span>{i.message}</span>
                    </li>
                  ))}
                </ul>
              )}
            </div>
            <p className="text-muted-foreground text-xs">
              Status: {STATUS_LABEL[status] ?? status}
              {template?.submitted_at
                ? ` · sent ${new Date(template.submitted_at).toLocaleDateString()}`
                : ""}
            </p>
          </aside>
        </div>

        {!readOnly ? (
          <div className="bg-background sticky bottom-0 flex flex-wrap items-center justify-end gap-2 border-t px-4 py-3">
            <Button type="button" variant="ghost" onClick={onClose} disabled={busy !== null}>
              Close
            </Button>
            {!approvedEdit ? (
              <Button
                type="button"
                variant="outline"
                onClick={() => void save()}
                disabled={busy !== null || !draft.name}
              >
                {busy === "save" ? <Loader2 className="size-4 animate-spin" /> : null}Save draft
              </Button>
            ) : null}
            <Button
              type="button"
              onClick={() => void submit()}
              disabled={busy !== null || !check.ok || needsReview || !channelId}
            >
              {busy === "submit" ? <Loader2 className="size-4 animate-spin" /> : null}
              {approvedEdit
                ? "Submit changes to Meta"
                : onMeta
                  ? "Resubmit to Meta"
                  : "Submit to Meta"}
            </Button>
          </div>
        ) : null}
      </SheetContent>
    </Sheet>
  );
}

function blankCard(like?: DraftCard): DraftCard {
  return {
    header: { format: like?.header.format ?? "IMAGE" },
    body: "",
    bodyExamples: [],
    buttons: like
      ? like.buttons.map((b) =>
          b.type === "QUICK_REPLY" ? { ...b } : b.type === "URL" ? { ...b } : b,
        )
      : [{ type: "QUICK_REPLY", text: "Book" }],
  };
}
