"use client";

import dynamic from "next/dynamic";
import { useRouter } from "next/navigation";
import { useEffect, useMemo, useRef, useState, useTransition } from "react";
import {
  Camera,
  Contact,
  FileText,
  Image as ImageIcon,
  Images,
  LayoutTemplate,
  Loader2,
  Mic,
  Paperclip,
  Send,
  ShoppingBag,
  Smile,
  Square,
  X,
} from "lucide-react";
import { toast } from "sonner";

import { MediaPicker } from "@/components/media/media-picker";
import { Button } from "@/components/ui/button";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { CHANNEL_TYPE_LABEL, channelTypeOf, hasWhatsAppFeatures } from "@/lib/channels/types";
import { mentionQueryAtCaret } from "@/lib/inbox/mentions";
import { matchShortcuts, pickQuickReplyText, renderQuickReply } from "@/lib/inbox/quick-reply";
import type { MessageRow } from "@/lib/inbox/queries";
import { createClient } from "@/lib/supabase/client";
import { cn } from "@/lib/utils";

import {
  addComment,
  createAttachmentUpload,
  sendAttachment,
  sendChat,
  sendLibraryMedia,
  startConversation,
} from "./actions";
import { recordSuggestionOutcome } from "./ai-actions";
import { AiPanel } from "./ai-panel";
import { ShortcutMenu } from "./shortcut-menu";
import { TemplatePicker } from "./template-picker";
import type { ConversationDetail, InboxProps, QuickReply } from "./types";

// G11 (contact card, catalogue product): the dialogs load only when opened.
const ContactCardDialog = dynamic(
  () => import("./extras-dialogs").then((m) => m.ContactCardDialog),
  { ssr: false },
);
const ProductDialog = dynamic(() => import("./extras-dialogs").then((m) => m.ProductDialog), {
  ssr: false,
});

const EMOJI = [
  "😊",
  "😂",
  "🙏",
  "👍",
  "👋",
  "❤️",
  "🎉",
  "✅",
  "⏰",
  "📅",
  "📍",
  "📞",
  "💊",
  "🩺",
  "🏥",
  "🙂",
  "😔",
  "🤝",
  "✨",
  "☀️",
];

/** Which Cloud API media type a browser file maps to (others go as documents). */
export function mediaTypeFor(mime: string): "image" | "video" | "audio" | "document" {
  if (mime === "image/jpeg" || mime === "image/png") return "image";
  if (mime === "video/mp4" || mime === "video/3gpp") return "video";
  if (
    [
      "audio/aac",
      "audio/mp4",
      "audio/mpeg",
      "audio/amr",
      "audio/ogg",
      "audio/ogg; codecs=opus",
      "audio/ogg;codecs=opus",
    ].includes(mime)
  )
    return "audio";
  return "document";
}

export function pickRecorderMime(): string | null {
  if (typeof MediaRecorder === "undefined") return null;
  for (const t of ["audio/ogg;codecs=opus", "audio/mp4", "audio/webm;codecs=opus", "audio/webm"]) {
    if (MediaRecorder.isTypeSupported(t)) return t;
  }
  return null;
}

type Mode = "chat" | "comment";

export function Composer({
  selected,
  ai,
  channels,
  quickReplies,
  quickReplyContext,
  templates,
  people,
  perms,
  me,
  windowOpen,
  replyTo,
  onClearReply,
  onComposing,
  onStoppedComposing,
}: InboxProps & {
  selected: ConversationDetail;
  windowOpen: boolean;
  replyTo: MessageRow | null;
  onClearReply: () => void;
  /** Phase F: tells colleagues on the same chat that someone is writing a reply (no text is shared). */
  onComposing?: () => void;
  onStoppedComposing?: () => void;
}) {
  const router = useRouter();
  const [mode, setMode] = useState<Mode>("chat");
  const [text, setText] = useState("");
  const [caret, setCaret] = useState(0);
  const [pending, startTransition] = useTransition();
  const [templateOpen, setTemplateOpen] = useState(false);
  const [uploading, setUploading] = useState(false);
  const [attachment, setAttachment] = useState<NonNullable<QuickReply["media"]> | null>(null);
  const [libraryOpen, setLibraryOpen] = useState(false);
  const [recording, setRecording] = useState(false);
  const [extra, setExtra] = useState<"card" | "product" | null>(null);
  // The AI suggestion currently in the box, so sending can report whether it was used as written. Never stored client-side beyond this.
  const suggestion = useRef<{ usageId: string; text: string } | null>(null);
  const recorder = useRef<MediaRecorder | null>(null);
  const chunks = useRef<Blob[]>([]);
  const textarea = useRef<HTMLTextAreaElement>(null);
  const fileInput = useRef<HTMLInputElement>(null);
  const cameraInput = useRef<HTMLInputElement>(null);
  const galleryInput = useRef<HTMLInputElement>(null);

  useEffect(() => {
    setText("");
    setMode("chat");
    setAttachment(null);
    suggestion.current = null;
  }, [selected.id]);

  const chatDisabled = mode === "chat" && !windowOpen;
  // Phase 20e: website chat, Instagram and Messenger are text only (no templates, files, voice notes, flows or number switch).
  const channelType = channelTypeOf(channels.find((c) => c.id === selected.channel_id)?.type);
  const waFeatures = hasWhatsAppFeatures(channelType);
  const hasCatalog = !!channels.find((c) => c.id === selected.channel_id)?.has_catalog;
  const slash =
    mode === "chat" && text.startsWith("/") && !text.includes("\n")
      ? text.slice(1).toLowerCase()
      : null;
  const slashMatches = useMemo(
    () => (slash === null ? [] : matchShortcuts(quickReplies, `/${slash}`)),
    [slash, quickReplies],
  );
  // The wording for this patient's language with {{variables}} filled in. A variable with no value stays
  // visible ({{doctor}}) so it is fixed before sending instead of going out blank.
  const fillQuickReply = (q: QuickReply) =>
    renderQuickReply(pickQuickReplyText(q, selected.contact.language), quickReplyContext);
  function applyQuickReply(q: QuickReply) {
    const { text: filled, unresolved } = fillQuickReply(q);
    setText(filled);
    // A quick reply can carry a Media Library file: it is attached and goes out with the text as its caption (WhatsApp only).
    setAttachment(waFeatures ? q.media : null);
    if (unresolved.length)
      toast.warning(`Fill in before sending: ${unresolved.map((v) => `{{${v}}}`).join(", ")}`);
  }
  const mention = mode === "comment" ? mentionQueryAtCaret(text, caret) : null;
  const mentionMatches = useMemo(
    () =>
      mention
        ? people
            .filter(
              (p) =>
                p.id !== me.userId && p.name.toLowerCase().includes(mention.query.toLowerCase()),
            )
            .slice(0, 6)
        : [],
    [mention, people, me.userId],
  );

  function insertAtCaret(snippet: string, replaceFrom?: number) {
    const el = textarea.current;
    const start = replaceFrom ?? el?.selectionStart ?? text.length;
    const end = el?.selectionEnd ?? text.length;
    const next = text.slice(0, start) + snippet + text.slice(end);
    setText(next);
    requestAnimationFrame(() => {
      el?.focus();
      const pos = start + snippet.length;
      el?.setSelectionRange(pos, pos);
      setCaret(pos);
    });
  }

  function submit() {
    const body = text.trim();
    const withFile = mode === "chat" ? attachment : null;
    if ((!body && !withFile) || pending) return;
    startTransition(async () => {
      const r = withFile
        ? await sendLibraryMedia({
            conversation_id: selected.id,
            asset_id: withFile.id,
            caption: body || undefined,
          })
        : mode === "chat"
          ? await sendChat({
              conversation_id: selected.id,
              text: body,
              reply_to: replyTo?.wa_message_id ?? null,
            })
          : await addComment({ conversation_id: selected.id, text: body });
      if (!r.ok) {
        toast.error(r.error);
        return;
      }
      if (mode === "chat" && suggestion.current && !withFile) {
        const used = suggestion.current;
        suggestion.current = null;
        void recordSuggestionOutcome({ usage_id: used.usageId, suggestion: used.text, sent: body });
      }
      setText("");
      setAttachment(null);
      onClearReply();
      onStoppedComposing?.();
    });
  }

  async function upload(file: File, mediaType?: "image" | "video" | "audio" | "document") {
    setUploading(true);
    try {
      const prep = await createAttachmentUpload({
        conversation_id: selected.id,
        filename: file.name,
        mime_type: file.type || "application/octet-stream",
        size: file.size,
      });
      if (!prep.ok) throw new Error(prep.error);
      const supabase = createClient();
      const { error } = await supabase.storage
        .from("wa-media")
        .uploadToSignedUrl(prep.data.path, prep.data.token, file, {
          contentType: file.type || "application/octet-stream",
        });
      if (error) throw new Error(error.message);
      const r = await sendAttachment({
        conversation_id: selected.id,
        path: prep.data.path,
        mime_type: file.type || "application/octet-stream",
        filename: file.name,
        media_type: mediaType ?? mediaTypeFor(file.type),
        caption: mode === "chat" && text.trim() ? text.trim() : undefined,
      });
      if (!r.ok) throw new Error(r.error);
      setText("");
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Upload failed");
    } finally {
      setUploading(false);
    }
  }

  /** Camera and gallery files: HEIC/HEIF cannot go to WhatsApp, so say so instead of failing later. */
  async function uploadPhoto(file: File) {
    if (/hei[cf]/i.test(file.type) || /\.hei[cf]$/i.test(file.name)) {
      toast.error(
        "That photo is in HEIC format, which WhatsApp does not accept. Choose a JPEG or PNG, or set the camera to 'Most Compatible'.",
      );
      return;
    }
    await upload(file);
  }

  async function toggleRecording() {
    if (recording) {
      recorder.current?.stop();
      return;
    }
    const mime = pickRecorderMime();
    if (!mime) {
      toast.error("Voice notes are not supported in this browser.");
      return;
    }
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      const rec = new MediaRecorder(stream, { mimeType: mime });
      chunks.current = [];
      rec.ondataavailable = (e) => chunks.current.push(e.data);
      rec.onstop = () => {
        stream.getTracks().forEach((t) => t.stop());
        setRecording(false);
        const blob = new Blob(chunks.current, { type: mime });
        if (blob.size < 1000) return;
        const base = mime.split(";")[0];
        const ext = base === "audio/ogg" ? "ogg" : base === "audio/mp4" ? "m4a" : "webm";
        const file = new File([blob], `voice-note.${ext}`, { type: base });
        // WhatsApp accepts ogg/opus, mp4 and aac as audio; webm goes as a document.
        void upload(file, base === "audio/webm" ? "document" : "audio");
        if (base === "audio/webm")
          toast.info(
            "This browser records WebM, which WhatsApp plays as a file rather than a voice note.",
          );
      };
      rec.start();
      recorder.current = rec;
      setRecording(true);
    } catch {
      toast.error("Microphone access was refused.");
    }
  }

  function switchNumber(channelId: string) {
    if (channelId === selected.channel_id) return;
    startTransition(async () => {
      const r = await startConversation({ channel_id: channelId, contact_id: selected.contact.id });
      if (!r.ok) {
        toast.error(r.error);
        return;
      }
      router.push(`/inbox?c=${r.data.conversation_id}`);
    });
  }

  const active = channels.filter(
    (c) => c.status === "active" && channelTypeOf(c.type) === "whatsapp",
  );

  return (
    <div
      className="bg-background border-t"
      style={{ paddingBottom: "var(--composer-safe-bottom, 0px)" }}
    >
      {replyTo && (
        <div className="bg-muted/50 flex items-center gap-2 border-b px-3 py-1.5 text-xs">
          <span className="text-muted-foreground">Replying to:</span>
          <span className="truncate">{replyTo.body ?? replyTo.kind}</span>
          <button
            type="button"
            className="ml-auto"
            aria-label="Cancel reply"
            onClick={onClearReply}
          >
            <X className="size-3.5" />
          </button>
        </div>
      )}
      <div className="flex items-center gap-2 px-3 pt-2">
        <div className="bg-muted flex rounded-md p-0.5 text-xs">
          {(["chat", "comment"] as Mode[]).map((m) => (
            <button
              key={m}
              type="button"
              onClick={() => setMode(m)}
              className={cn(
                "rounded px-2 py-0.5 capitalize",
                mode === m && "bg-background shadow-xs",
              )}
              aria-pressed={mode === m}
            >
              {m}
            </button>
          ))}
        </div>
        {mode === "chat" && !waFeatures && (
          <span className="text-muted-foreground text-xs">
            {CHANNEL_TYPE_LABEL[channelType]} · text only
          </span>
        )}
        {mode === "chat" && waFeatures && (
          <Select value={selected.channel_id} onValueChange={switchNumber} disabled={pending}>
            <SelectTrigger size="sm" className="h-7 max-w-52 text-xs" aria-label="Send from number">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {(active.some((c) => c.id === selected.channel_id)
                ? active
                : [...active, ...channels.filter((c) => c.id === selected.channel_id)]
              ).map((c) => (
                <SelectItem key={c.id} value={c.id}>
                  {c.name}
                  {c.display_phone ? ` · ${c.display_phone}` : ""}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        )}
        {mode === "chat" && !windowOpen && !waFeatures && (
          <span className="text-muted-foreground ml-auto text-xs">
            24h reply window closed: wait for the person to write again
          </span>
        )}
        {mode === "chat" && !windowOpen && waFeatures && (
          <span className="text-muted-foreground ml-auto text-xs">
            24h window closed —{" "}
            <button
              type="button"
              className="text-primary underline"
              onClick={() => setTemplateOpen(true)}
            >
              send a template
            </button>
          </span>
        )}
        {mode === "chat" && selected.contact.stop_marketing && (
          <span className="ml-auto text-xs text-amber-700 dark:text-amber-300">
            Opted out of marketing
          </span>
        )}
      </div>

      <div className="relative px-3 pt-2 pb-1">
        {slashMatches.length > 0 && (
          <ul
            className="bg-popover absolute bottom-full left-3 z-20 mb-1 w-80 rounded-md border p-1 shadow-md"
            role="listbox"
          >
            {slashMatches.map((q) => (
              <li key={q.id}>
                <button
                  type="button"
                  className="hover:bg-accent flex w-full flex-col rounded px-2 py-1 text-left text-sm"
                  onClick={() => applyQuickReply(q)}
                >
                  <span className="font-mono text-xs">
                    /{q.shortcut}
                    {q.text_ar && <span className="text-muted-foreground"> · EN / AR</span>}
                  </span>
                  <span className="text-muted-foreground line-clamp-1 text-xs" dir="auto">
                    {fillQuickReply(q).text}
                  </span>
                </button>
              </li>
            ))}
          </ul>
        )}
        {mention && mentionMatches.length > 0 && (
          <ul
            className="bg-popover absolute bottom-full left-3 z-20 mb-1 w-64 rounded-md border p-1 shadow-md"
            role="listbox"
          >
            {mentionMatches.map((p) => (
              <li key={p.id}>
                <button
                  type="button"
                  className="hover:bg-accent flex w-full items-center gap-2 rounded px-2 py-1 text-left text-sm"
                  onClick={() => insertAtCaret(`@[${p.name}](${p.id}) `, mention.start)}
                >
                  <span
                    className={cn(
                      "size-2 rounded-full",
                      p.presence === "online" ? "bg-emerald-500" : "bg-gray-300 dark:bg-gray-600",
                    )}
                  />
                  {p.name}
                </button>
              </li>
            ))}
          </ul>
        )}
        {mode === "chat" && attachment && (
          <div className="bg-muted mb-1.5 flex items-center gap-2 rounded-md border px-2 py-1 text-xs">
            <Images className="size-3.5 shrink-0" aria-hidden />
            <span className="min-w-0 flex-1 truncate">
              Sending the library file “{attachment.name}”
              {text.trim() ? " with this text as its caption" : ""}
            </span>
            <button
              type="button"
              className="pointer-coarse:size-11 inline-flex size-6 items-center justify-center rounded hover:bg-black/10 dark:hover:bg-white/10"
              aria-label="Remove the attached file"
              onClick={() => setAttachment(null)}
            >
              <X className="size-3.5" />
            </button>
          </div>
        )}
        <textarea
          ref={textarea}
          value={text}
          onChange={(e) => {
            setText(e.target.value);
            setCaret(e.target.selectionStart);
            // Only patient replies count: an internal note does not clash with anyone.
            if (mode === "chat" && e.target.value.trim()) onComposing?.();
            else onStoppedComposing?.();
          }}
          onSelect={(e) => setCaret((e.target as HTMLTextAreaElement).selectionStart)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) {
              e.preventDefault();
              if (slashMatches.length === 1 && slash !== null) applyQuickReply(slashMatches[0]);
              else submit();
            }
          }}
          disabled={chatDisabled || pending}
          rows={2}
          placeholder={
            mode === "comment"
              ? "Internal note — @ to mention a colleague"
              : windowOpen
                ? "Type a message — / for quick replies, Enter to send"
                : waFeatures
                  ? "Outside the 24h window: send a template"
                  : "Outside the 24h reply window"
          }
          className={cn(
            "w-full resize-none rounded-md border px-3 py-2 text-base outline-none focus-visible:ring-2 md:text-sm",
            mode === "comment" &&
              "border-amber-300 dark:border-amber-500/30 bg-amber-50/60 dark:bg-amber-950/20",
          )}
          aria-label={mode === "comment" ? "Internal note" : "Message"}
          dir="auto"
        />
      </div>

      <div className="flex flex-wrap items-center gap-1 px-3 pb-2">
        <Popover>
          <PopoverTrigger asChild>
            <Button variant="ghost" size="icon-sm" aria-label="Emoji" disabled={chatDisabled}>
              <Smile />
            </Button>
          </PopoverTrigger>
          <PopoverContent align="start" className="grid w-56 grid-cols-8 gap-1 p-2">
            {EMOJI.map((e) => (
              <button
                key={e}
                type="button"
                className="hover:bg-accent rounded text-lg"
                onClick={() => insertAtCaret(e)}
              >
                {e}
              </button>
            ))}
          </PopoverContent>
        </Popover>
        {mode === "chat" && (
          <>
            {waFeatures && (
              <>
                <input
                  ref={fileInput}
                  type="file"
                  className="hidden"
                  onChange={(e) => e.target.files?.[0] && upload(e.target.files[0])}
                  accept="image/jpeg,image/png,video/mp4,audio/*,application/pdf,.doc,.docx,.xls,.xlsx,.ppt,.pptx,.txt"
                />
                {/* Phones: take a photo, or pick from the gallery. image/jpeg and png only: iOS then converts HEIC for us. */}
                <input
                  ref={cameraInput}
                  type="file"
                  className="hidden"
                  accept="image/*"
                  capture="environment"
                  onChange={(e) => {
                    const f = e.target.files?.[0];
                    e.target.value = "";
                    if (f) void uploadPhoto(f);
                  }}
                />
                <input
                  ref={galleryInput}
                  type="file"
                  className="hidden"
                  accept="image/jpeg,image/png,video/mp4"
                  onChange={(e) => {
                    const f = e.target.files?.[0];
                    e.target.value = "";
                    if (f) void uploadPhoto(f);
                  }}
                />
                <Button
                  variant="ghost"
                  size="icon-sm"
                  className="pointer-fine:hidden"
                  aria-label="Take a photo"
                  disabled={chatDisabled || uploading}
                  onClick={() => cameraInput.current?.click()}
                >
                  <Camera />
                </Button>
                <Button
                  variant="ghost"
                  size="icon-sm"
                  className="pointer-fine:hidden"
                  aria-label="Choose a photo or video"
                  disabled={chatDisabled || uploading}
                  onClick={() => galleryInput.current?.click()}
                >
                  <ImageIcon />
                </Button>
                <Button
                  variant="ghost"
                  size="icon-sm"
                  aria-label="Attach file"
                  disabled={chatDisabled || uploading}
                  onClick={() => fileInput.current?.click()}
                >
                  {uploading ? <Loader2 className="animate-spin" /> : <Paperclip />}
                </Button>
                {perms.media && (
                  <Button
                    variant="ghost"
                    size="icon-sm"
                    aria-label="Choose a file from the Media Library"
                    disabled={chatDisabled || uploading}
                    onClick={() => setLibraryOpen(true)}
                  >
                    <Images />
                  </Button>
                )}
                <Button
                  variant={recording ? "destructive" : "ghost"}
                  size="icon-sm"
                  aria-label={recording ? "Stop recording" : "Record voice note"}
                  disabled={chatDisabled || uploading}
                  onClick={toggleRecording}
                >
                  {recording ? <Square /> : <Mic />}
                </Button>
                <Button
                  variant="ghost"
                  size="icon-sm"
                  aria-label="Share a contact card"
                  disabled={chatDisabled}
                  onClick={() => setExtra("card")}
                >
                  <Contact />
                </Button>
                {hasCatalog && (
                  <Button
                    variant="ghost"
                    size="icon-sm"
                    aria-label="Send a catalogue product"
                    disabled={chatDisabled}
                    onClick={() => setExtra("product")}
                  >
                    <ShoppingBag />
                  </Button>
                )}
              </>
            )}
            {ai.available && (
              <AiPanel
                conversationId={selected.id}
                text={text}
                onText={setText}
                onSuggestion={(s) => (suggestion.current = s)}
                disabled={chatDisabled || pending}
              />
            )}
            {waFeatures && (
              <Button
                variant="ghost"
                size="sm"
                aria-label="Templates"
                onClick={() => setTemplateOpen(true)}
                disabled={templates.length === 0}
              >
                <LayoutTemplate /> Template
              </Button>
            )}
            {waFeatures && (
              <ShortcutMenu conversationId={selected.id} botActive={selected.bot_active} />
            )}
            {quickReplies.length > 0 && (
              <Button
                variant="ghost"
                size="sm"
                aria-label="Quick replies"
                onClick={() => insertAtCaret("/", 0)}
                disabled={chatDisabled}
              >
                <FileText /> /
              </Button>
            )}
          </>
        )}
        <Button
          className="ml-auto"
          size="sm"
          onClick={submit}
          disabled={pending || chatDisabled || (!text.trim() && !(mode === "chat" && attachment))}
        >
          {pending ? <Loader2 className="animate-spin" /> : <Send />}{" "}
          {mode === "comment" ? "Add note" : "Send"}
        </Button>
      </div>
      {perms.media && (
        <MediaPicker
          open={libraryOpen}
          onOpenChange={setLibraryOpen}
          title="Send a library file"
          onPick={(a) => setAttachment({ id: a.id, name: a.name, kind: a.kind })}
        />
      )}
      {extra === "card" && (
        <ContactCardDialog
          open
          onOpenChange={(o) => !o && setExtra(null)}
          conversationId={selected.id}
        />
      )}
      {extra === "product" && (
        <ProductDialog
          open
          onOpenChange={(o) => !o && setExtra(null)}
          conversationId={selected.id}
        />
      )}
      <TemplatePicker
        open={templateOpen}
        onOpenChange={setTemplateOpen}
        conversation={selected}
        canMedia={perms.media}
        templates={templates.filter((t) => !t.channel_id || t.channel_id === selected.channel_id)}
      />
    </div>
  );
}
