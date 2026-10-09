"use client";

import { useEffect, useId, useRef, useState, useTransition } from "react";
import {
  ArrowDown,
  ArrowUp,
  Bold,
  Code,
  Copy,
  ExternalLink,
  Italic,
  Loader2,
  Phone,
  Plus,
  Reply,
  Strikethrough,
  Trash2,
  Upload,
} from "lucide-react";
import { toast } from "sonner";

import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { cn } from "@/lib/utils";
import {
  LIMITS,
  applyFormat,
  insertVariable,
  isRtlLanguage,
  syncExamples,
  variableIndexes,
  type ButtonDef,
  type CardDef,
  type FormatKind,
  type MediaFormat,
  type ValidationIssue,
} from "@/lib/whatsapp/template-builder";
import { MAPPABLE_FIELDS } from "@/lib/whatsapp/template-fields";

import { createClient } from "@/lib/supabase/client";

import { prepareSampleUpload, registerSample } from "./actions";

export function FieldError({ issues, path }: { issues: ValidationIssue[]; path: string }) {
  const hit = issues.filter((i) => i.path === path || i.path.startsWith(`${path}.`));
  if (!hit.length) return null;
  return (
    <p role="alert" className="text-destructive mt-1 text-xs">
      {hit[0].message}
    </p>
  );
}

function Counter({ n, max }: { n: number; max: number }) {
  return (
    <span
      className={cn("text-muted-foreground text-xs tabular-nums", n > max && "text-destructive")}
    >
      {n}/{max}
    </span>
  );
}

const SAMPLE_NAMES: Record<string, string> = {
  "contact.first_name": "Sara",
  "contact.last_name": "Example",
  "contact.name": "Sara Example",
  "contact.phone": "+971500000000",
};
const SAMPLE_NAMES_AR: Record<string, string> = {
  "contact.first_name": "سارة",
  "contact.last_name": "المثال",
  "contact.name": "سارة المثال",
  "contact.phone": "+971500000000",
};

export type BodyEdit = {
  text: string;
  /** Set when the edit added a variable: its number, the field it maps to, and a suggested example. */
  inserted?: { index: number; field: string | null; example: string };
};

/** Body textarea with a formatting toolbar and "@" to insert variables. */
export function BodyEditor({
  label,
  value,
  examples,
  language,
  max,
  disabled,
  placeholder,
  rows = 6,
  onEdit,
  onExamples,
  allowMapping = true,
  issues,
  path,
}: {
  label: string;
  value: string;
  examples: string[];
  language: string;
  max: number;
  disabled?: boolean;
  placeholder?: string;
  rows?: number;
  onEdit: (edit: BodyEdit) => void;
  onExamples: (examples: string[]) => void;
  allowMapping?: boolean;
  issues: ValidationIssue[];
  path: string;
}) {
  const ref = useRef<HTMLTextAreaElement>(null);
  const sel = useRef({ start: 0, end: 0 });
  const pending = useRef<{ start: number; end: number } | null>(null);
  const [menu, setMenu] = useState(false);
  const id = useId();
  const rtl = isRtlLanguage(language);

  // Restore the caret after a programmatic edit.
  useEffect(() => {
    const p = pending.current;
    if (p && ref.current) {
      ref.current.focus();
      ref.current.setSelectionRange(p.start, p.end);
      sel.current = p;
      pending.current = null;
    }
  }, [value]);

  function remember() {
    const el = ref.current;
    if (el) sel.current = { start: el.selectionStart, end: el.selectionEnd };
  }

  function format(kind: FormatKind) {
    remember();
    const r = applyFormat(value, sel.current.start, sel.current.end, kind);
    pending.current = { start: r.selStart, end: r.selEnd };
    onEdit({ text: r.text });
  }

  function addVariable(field: string | null) {
    const r = insertVariable(value, sel.current.end);
    pending.current = { start: r.caret, end: r.caret };
    const names = rtl ? SAMPLE_NAMES_AR : SAMPLE_NAMES;
    onEdit({
      text: r.text,
      inserted: { index: r.index, field, example: field ? (names[field] ?? "") : "" },
    });
    setMenu(false);
  }

  const vars = variableIndexes(value);
  const shownExamples = syncExamples(value, examples);

  return (
    <div className="flex flex-col gap-2">
      <div className="flex items-center justify-between">
        <Label htmlFor={id}>{label}</Label>
        <Counter n={value.length} max={max} />
      </div>
      <div className="relative">
        <div className="flex flex-wrap items-center gap-1 rounded-t-md border border-b-0 p-1">
          {(
            [
              ["bold", Bold, "Bold"],
              ["italic", Italic, "Italic"],
              ["strike", Strikethrough, "Strikethrough"],
              ["mono", Code, "Monospace"],
            ] as const
          ).map(([kind, Icon, name]) => (
            <Button
              key={kind}
              type="button"
              variant="ghost"
              size="icon-sm"
              aria-label={name}
              title={name}
              disabled={disabled}
              onClick={() => format(kind)}
            >
              <Icon />
            </Button>
          ))}
          <Button
            type="button"
            variant="ghost"
            size="sm"
            disabled={disabled}
            onClick={() => {
              remember();
              setMenu((m) => !m);
            }}
            aria-expanded={menu}
          >
            <Plus /> Variable <kbd className="text-muted-foreground ms-1 text-xs">@</kbd>
          </Button>
        </div>
        {menu && (
          <div
            role="menu"
            className="bg-popover absolute start-2 top-10 z-20 w-60 rounded-md border p-1 shadow-md"
            onKeyDown={(e) => e.key === "Escape" && (setMenu(false), ref.current?.focus())}
          >
            {allowMapping &&
              MAPPABLE_FIELDS.map((f) => (
                <button
                  key={f.key}
                  type="button"
                  role="menuitem"
                  className="hover:bg-accent w-full rounded-sm px-2 py-1.5 text-start text-sm"
                  onClick={() => addVariable(f.key)}
                >
                  {f.label}
                </button>
              ))}
            <button
              type="button"
              role="menuitem"
              className="hover:bg-accent w-full rounded-sm px-2 py-1.5 text-start text-sm"
              onClick={() => addVariable(null)}
            >
              Custom value (filled at send time)
            </button>
          </div>
        )}
        <Textarea
          id={id}
          ref={ref}
          dir={rtl ? "rtl" : "ltr"}
          rows={rows}
          value={value}
          disabled={disabled}
          placeholder={placeholder}
          className="rounded-t-none"
          onChange={(e) => {
            remember();
            onEdit({ text: e.target.value });
          }}
          onSelect={remember}
          onKeyUp={remember}
          onClick={remember}
          onKeyDown={(e) => {
            if (e.key === "@") {
              e.preventDefault();
              remember();
              setMenu(true);
            } else if (e.key === "Escape") setMenu(false);
          }}
        />
      </div>
      <FieldError issues={issues} path={path} />
      {vars.length > 0 && (
        <div className="flex flex-col gap-2 rounded-md border p-3">
          <p className="text-muted-foreground text-xs">
            Meta reviews your variables with example values. Use realistic, non-personal examples.
          </p>
          {vars.map((n, i) => (
            <div key={n} className="grid grid-cols-[3.5rem_1fr] items-center gap-2">
              <code className="text-muted-foreground text-xs">{`{{${n}}}`}</code>
              <Input
                aria-label={`Example for variable ${n}`}
                dir={rtl ? "rtl" : "ltr"}
                value={shownExamples[i] ?? ""}
                disabled={disabled}
                onChange={(e) => {
                  const next = [...shownExamples];
                  next[i] = e.target.value;
                  onExamples(next);
                }}
                placeholder="Example value"
              />
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

const BUTTON_LABEL: Record<ButtonDef["type"], string> = {
  QUICK_REPLY: "Quick reply",
  URL: "Visit website",
  PHONE_NUMBER: "Call phone number",
  COPY_CODE: "Copy code",
};

export function ButtonsEditor({
  buttons,
  onChange,
  max,
  allowCopyCode,
  disabled,
  issues,
  path,
  language,
}: {
  buttons: ButtonDef[];
  onChange: (b: ButtonDef[]) => void;
  max: number;
  allowCopyCode: boolean;
  disabled?: boolean;
  issues: ValidationIssue[];
  path: string;
  language: string;
}) {
  const count = (t: ButtonDef["type"]) => buttons.filter((b) => b.type === t).length;
  const canAdd = (t: ButtonDef["type"]) =>
    buttons.length < max &&
    (t !== "URL" || count("URL") < LIMITS.urlButtonsMax) &&
    (t !== "PHONE_NUMBER" || count("PHONE_NUMBER") < LIMITS.phoneButtonsMax) &&
    (t !== "COPY_CODE" || (allowCopyCode && count("COPY_CODE") < LIMITS.copyCodeButtonsMax));

  function add(t: ButtonDef["type"]) {
    const next: ButtonDef =
      t === "QUICK_REPLY"
        ? { type: "QUICK_REPLY", text: "" }
        : t === "URL"
          ? { type: "URL", text: "", url: "https://", example: "" }
          : t === "PHONE_NUMBER"
            ? { type: "PHONE_NUMBER", text: "", phone_number: "+971" }
            : { type: "COPY_CODE", example: "" };
    onChange([...buttons, next]);
  }
  const patch = (i: number, p: Partial<ButtonDef>) =>
    onChange(buttons.map((b, j) => (j === i ? ({ ...b, ...p } as ButtonDef) : b)));
  const move = (i: number, d: -1 | 1) => {
    const j = i + d;
    if (j < 0 || j >= buttons.length) return;
    const next = [...buttons];
    [next[i], next[j]] = [next[j], next[i]];
    onChange(next);
  };
  const rtl = isRtlLanguage(language);
  const types: ButtonDef["type"][] = ["QUICK_REPLY", "URL", "PHONE_NUMBER", "COPY_CODE"];

  return (
    <div className="flex flex-col gap-2">
      {buttons.map((b, i) => (
        <div key={i} className="flex flex-col gap-2 rounded-md border p-3">
          <div className="flex items-center justify-between gap-2">
            <span className="flex items-center gap-1.5 text-sm font-medium">
              {b.type === "URL" ? (
                <ExternalLink className="size-3.5" />
              ) : b.type === "PHONE_NUMBER" ? (
                <Phone className="size-3.5" />
              ) : b.type === "COPY_CODE" ? (
                <Copy className="size-3.5" />
              ) : (
                <Reply className="size-3.5" />
              )}
              {BUTTON_LABEL[b.type]}
            </span>
            <span className="flex items-center">
              <Button
                type="button"
                variant="ghost"
                size="icon-sm"
                aria-label="Move up"
                disabled={disabled || i === 0}
                onClick={() => move(i, -1)}
              >
                <ArrowUp />
              </Button>
              <Button
                type="button"
                variant="ghost"
                size="icon-sm"
                aria-label="Move down"
                disabled={disabled || i === buttons.length - 1}
                onClick={() => move(i, 1)}
              >
                <ArrowDown />
              </Button>
              <Button
                type="button"
                variant="ghost"
                size="icon-sm"
                aria-label="Remove button"
                disabled={disabled}
                onClick={() => onChange(buttons.filter((_x, j) => j !== i))}
              >
                <Trash2 />
              </Button>
            </span>
          </div>
          {b.type !== "COPY_CODE" && (
            <div>
              <Input
                aria-label="Button text"
                dir={rtl ? "rtl" : "ltr"}
                value={b.text}
                maxLength={LIMITS.buttonTextMax + 10}
                disabled={disabled}
                placeholder="Button text"
                onChange={(e) => patch(i, { text: e.target.value })}
              />
              <FieldError issues={issues} path={`${path}.${i}.text`} />
            </div>
          )}
          {b.type === "URL" && (
            <>
              <Input
                aria-label="Website URL"
                dir="ltr"
                value={b.url}
                disabled={disabled}
                placeholder="https://example.com/page or https://example.com/{{1}}"
                onChange={(e) => patch(i, { url: e.target.value })}
              />
              <FieldError issues={issues} path={`${path}.${i}.url`} />
              {/\{\{1\}\}$/.test(b.url) && (
                <>
                  <Input
                    aria-label="Example URL"
                    dir="ltr"
                    value={b.example}
                    disabled={disabled}
                    placeholder="Example full URL, e.g. https://example.com/abc"
                    onChange={(e) => patch(i, { example: e.target.value })}
                  />
                  <FieldError issues={issues} path={`${path}.${i}.example`} />
                </>
              )}
            </>
          )}
          {b.type === "PHONE_NUMBER" && (
            <>
              <Input
                aria-label="Phone number"
                dir="ltr"
                value={b.phone_number}
                disabled={disabled}
                placeholder="+971…"
                onChange={(e) => patch(i, { phone_number: e.target.value })}
              />
              <FieldError issues={issues} path={`${path}.${i}.phone_number`} />
            </>
          )}
          {b.type === "COPY_CODE" && (
            <>
              <Input
                aria-label="Example code"
                dir="ltr"
                value={b.example}
                maxLength={15}
                disabled={disabled}
                placeholder="Example code, e.g. SAVE20"
                onChange={(e) => patch(i, { example: e.target.value })}
              />
              <FieldError issues={issues} path={`${path}.${i}.example`} />
            </>
          )}
        </div>
      ))}
      <FieldError issues={issues.filter((i) => i.path === path)} path={path} />
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button
            type="button"
            variant="outline"
            size="sm"
            className="self-start"
            disabled={disabled || buttons.length >= max}
          >
            <Plus /> Add button ({buttons.length}/{max})
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="start">
          {types
            .filter((t) => t !== "COPY_CODE" || allowCopyCode)
            .map((t) => (
              <DropdownMenuItem key={t} disabled={!canAdd(t)} onSelect={() => add(t)}>
                {BUTTON_LABEL[t]}
              </DropdownMenuItem>
            ))}
        </DropdownMenuContent>
      </DropdownMenu>
    </div>
  );
}

const ACCEPT: Record<MediaFormat, string> = {
  IMAGE: "image/jpeg,image/png",
  VIDEO: "video/mp4",
  DOCUMENT: "application/pdf",
};

export type UploadedSample = { handle: string; path: string; fileName: string };

/** Uploads a header / card sample through Meta's Resumable Upload API (via the server action). */
export function SampleUpload({
  channelId,
  kind,
  format,
  fileName,
  hasSample,
  disabled,
  onUploaded,
}: {
  channelId: string;
  kind: "header" | "card";
  format: MediaFormat;
  fileName?: string;
  hasSample: boolean;
  disabled?: boolean;
  onUploaded: (s: UploadedSample, previewUrl: string | null) => void;
}) {
  const input = useRef<HTMLInputElement>(null);
  const [pending, start] = useTransition();
  const [preview, setPreview] = useState<string | null>(null);

  function onFile(file: File | undefined) {
    if (!file) return;
    if (!channelId) {
      toast.error("Choose a WhatsApp number first.");
      return;
    }
    start(async () => {
      const mime = file.type || "application/octet-stream";
      const prep = await prepareSampleUpload({
        channel_id: channelId,
        kind,
        format,
        filename: file.name,
        mime_type: mime,
        size: file.size,
      });
      if (!prep.ok) {
        toast.error(prep.error);
        return;
      }
      const { error } = await createClient()
        .storage.from("wa-media")
        .uploadToSignedUrl(prep.path, prep.token, file, { contentType: mime });
      if (error) {
        toast.error("Could not upload the file.");
        return;
      }
      const r = await registerSample({
        channel_id: channelId,
        kind,
        format,
        path: prep.path,
        filename: file.name,
        mime_type: mime,
      });
      if (!r.ok) {
        toast.error(r.error);
        return;
      }
      setPreview(r.previewUrl);
      onUploaded({ handle: r.handle, path: r.path, fileName: r.fileName }, r.previewUrl);
      toast.success("Sample uploaded to Meta.");
    });
  }

  return (
    <div className="flex items-center gap-3">
      {preview && format === "IMAGE" && (
        // eslint-disable-next-line @next/next/no-img-element
        <img src={preview} alt="" className="size-14 rounded-md border object-cover" />
      )}
      <div className="min-w-0 flex-1">
        <p className="truncate text-sm">
          {hasSample ? (fileName ?? "Sample uploaded") : "No sample file yet"}
        </p>
        <p className="text-muted-foreground text-xs">
          {format === "IMAGE" && "JPEG or PNG, up to 5 MB"}
          {format === "VIDEO" && "MP4, up to 16 MB"}
          {format === "DOCUMENT" && "PDF, up to 15 MB"}. Meta reviews this sample; patients receive
          the real file at send time.
        </p>
      </div>
      <input
        ref={input}
        type="file"
        accept={ACCEPT[format]}
        className="sr-only"
        aria-label={`Upload ${format.toLowerCase()} sample`}
        onChange={(e) => {
          onFile(e.target.files?.[0]);
          e.target.value = "";
        }}
      />
      <Button
        type="button"
        variant="outline"
        size="sm"
        disabled={disabled || pending}
        onClick={() => input.current?.click()}
      >
        {pending ? <Loader2 className="animate-spin" /> : <Upload />}
        {hasSample ? "Replace" : "Upload"}
      </Button>
    </div>
  );
}

export function CardsEditor({
  cards,
  onChange,
  channelId,
  language,
  disabled,
  issues,
}: {
  cards: CardDef[];
  onChange: (c: CardDef[]) => void;
  channelId: string;
  language: string;
  disabled?: boolean;
  issues: ValidationIssue[];
}) {
  const format = cards[0]?.format ?? "IMAGE";
  const rtl = isRtlLanguage(language);
  const blank = (): CardDef => ({
    format,
    handle: "",
    body: "",
    examples: [],
    buttons: cards[0]
      ? cards[0].buttons.map((b) =>
          b.type === "QUICK_REPLY"
            ? { type: "QUICK_REPLY" as const, text: "" }
            : b.type === "URL"
              ? { type: "URL" as const, text: "", url: "https://", example: "" }
              : { type: "PHONE_NUMBER" as const, text: "", phone_number: "+971" },
        )
      : [{ type: "QUICK_REPLY" as const, text: "" }],
  });
  const patch = (i: number, p: Partial<CardDef>) =>
    onChange(cards.map((c, j) => (j === i ? { ...c, ...p } : c)));

  return (
    <div className="flex flex-col gap-3">
      <FieldError issues={issues.filter((i) => i.path === "cards")} path="cards" />
      {cards.length > 0 && (
        <div className="flex items-center gap-2">
          <Label className="text-sm">Card media</Label>
          {(["IMAGE", "VIDEO"] as const).map((f) => (
            <Button
              key={f}
              type="button"
              size="sm"
              variant={format === f ? "default" : "outline"}
              disabled={disabled}
              onClick={() =>
                onChange(cards.map((c) => ({ ...c, format: f, handle: "", mediaPath: undefined })))
              }
            >
              {f === "IMAGE" ? "Image" : "Video"}
            </Button>
          ))}
        </div>
      )}
      {cards.map((c, i) => {
        const p = `cards.${i}`;
        return (
          <div key={i} className="flex flex-col gap-3 rounded-md border p-3">
            <div className="flex items-center justify-between">
              <span className="text-sm font-medium">Card {i + 1}</span>
              <Button
                type="button"
                variant="ghost"
                size="icon-sm"
                aria-label={`Remove card ${i + 1}`}
                disabled={disabled}
                onClick={() => onChange(cards.filter((_x, j) => j !== i))}
              >
                <Trash2 />
              </Button>
            </div>
            <SampleUpload
              channelId={channelId}
              kind="card"
              format={c.format}
              hasSample={!!c.handle || !!c.mediaPath}
              fileName={c.mediaPath ? "Sample uploaded" : undefined}
              disabled={disabled}
              onUploaded={(s) => patch(i, { handle: s.handle, mediaPath: s.path })}
            />
            <FieldError issues={issues} path={`${p}.media`} />
            <div>
              <div className="mb-1 flex items-center justify-between">
                <Label>Card text</Label>
                <Counter n={c.body.length} max={LIMITS.cardBodyMax} />
              </div>
              <Textarea
                dir={rtl ? "rtl" : "ltr"}
                rows={2}
                value={c.body}
                disabled={disabled}
                onChange={(e) =>
                  patch(i, {
                    body: e.target.value,
                    examples: syncExamples(e.target.value, c.examples),
                  })
                }
              />
              <FieldError issues={issues} path={`${p}.body`} />
              {variableIndexes(c.body).map((n, k) => (
                <Input
                  key={n}
                  className="mt-2"
                  aria-label={`Card ${i + 1} example for variable ${n}`}
                  placeholder={`Example for {{${n}}}`}
                  value={c.examples[k] ?? ""}
                  disabled={disabled}
                  onChange={(e) => {
                    const ex = syncExamples(c.body, c.examples);
                    ex[k] = e.target.value;
                    patch(i, { examples: ex });
                  }}
                />
              ))}
            </div>
            <ButtonsEditor
              buttons={c.buttons}
              onChange={(b) => patch(i, { buttons: b as CardDef["buttons"] })}
              max={LIMITS.cardButtonsMax}
              allowCopyCode={false}
              disabled={disabled}
              issues={issues}
              path={`${p}.buttons`}
              language={language}
            />
          </div>
        );
      })}
      <Button
        type="button"
        variant="outline"
        size="sm"
        className="self-start"
        disabled={disabled || cards.length >= LIMITS.cardsMax}
        onClick={() => onChange([...cards, blank()])}
      >
        <Plus /> Add card ({cards.length}/{LIMITS.cardsMax})
      </Button>
    </div>
  );
}
