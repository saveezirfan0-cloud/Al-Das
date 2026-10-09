"use client";

import { useRouter } from "next/navigation";
import { useEffect, useMemo, useRef, useState, useTransition } from "react";
import {
  FileText,
  LayoutTemplate,
  Loader2,
  Mic,
  Paperclip,
  Send,
  Smile,
  Square,
  X,
} from "lucide-react";
import { toast } from "sonner";

import { Button } from "@/components/ui/button";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { mentionQueryAtCaret } from "@/lib/inbox/mentions";
import type { MessageRow } from "@/lib/inbox/queries";
import { createClient } from "@/lib/supabase/client";
import { cn } from "@/lib/utils";

import {
  addComment,
  createAttachmentUpload,
  sendAttachment,
  sendChat,
  startConversation,
} from "./actions";
import { ShortcutMenu } from "./shortcut-menu";
import { TemplatePicker } from "./template-picker";
import type { ConversationDetail, InboxProps } from "./types";

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
  channels,
  quickReplies,
  templates,
  people,
  me,
  windowOpen,
  replyTo,
  onClearReply,
}: InboxProps & {
  selected: ConversationDetail;
  windowOpen: boolean;
  replyTo: MessageRow | null;
  onClearReply: () => void;
}) {
  const router = useRouter();
  const [mode, setMode] = useState<Mode>("chat");
  const [text, setText] = useState("");
  const [caret, setCaret] = useState(0);
  const [pending, startTransition] = useTransition();
  const [templateOpen, setTemplateOpen] = useState(false);
  const [uploading, setUploading] = useState(false);
  const [recording, setRecording] = useState(false);
  const recorder = useRef<MediaRecorder | null>(null);
  const chunks = useRef<Blob[]>([]);
  const textarea = useRef<HTMLTextAreaElement>(null);
  const fileInput = useRef<HTMLInputElement>(null);

  useEffect(() => {
    setText("");
    setMode("chat");
  }, [selected.id]);

  const chatDisabled = mode === "chat" && !windowOpen;
  const slash =
    mode === "chat" && text.startsWith("/") && !text.includes("\n")
      ? text.slice(1).toLowerCase()
      : null;
  const slashMatches = useMemo(
    () =>
      slash === null ? [] : quickReplies.filter((q) => q.shortcut.startsWith(slash)).slice(0, 8),
    [slash, quickReplies],
  );
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
    if (!body || pending) return;
    startTransition(async () => {
      const r =
        mode === "chat"
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
      setText("");
      onClearReply();
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

  const active = channels.filter((c) => c.status === "active");

  return (
    <div className="bg-background border-t">
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
        {mode === "chat" && (
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
        {mode === "chat" && !windowOpen && (
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
          <span className="ml-auto text-xs text-amber-700">Opted out of marketing</span>
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
                  onClick={() => setText(q.text)}
                >
                  <span className="font-mono text-xs">/{q.shortcut}</span>
                  <span className="text-muted-foreground line-clamp-1 text-xs">{q.text}</span>
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
                      p.presence === "online" ? "bg-emerald-500" : "bg-gray-300",
                    )}
                  />
                  {p.name}
                </button>
              </li>
            ))}
          </ul>
        )}
        <textarea
          ref={textarea}
          value={text}
          onChange={(e) => {
            setText(e.target.value);
            setCaret(e.target.selectionStart);
          }}
          onSelect={(e) => setCaret((e.target as HTMLTextAreaElement).selectionStart)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) {
              e.preventDefault();
              if (slashMatches.length === 1 && slash !== null) setText(slashMatches[0].text);
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
                : "Outside the 24h window: send a template"
          }
          className={cn(
            "w-full resize-none rounded-md border px-3 py-2 text-sm outline-none focus-visible:ring-2",
            mode === "comment" && "border-amber-300 bg-amber-50/60 dark:bg-amber-950/20",
          )}
          aria-label={mode === "comment" ? "Internal note" : "Message"}
        />
      </div>

      <div className="flex items-center gap-1 px-3 pb-2">
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
            <input
              ref={fileInput}
              type="file"
              className="hidden"
              onChange={(e) => e.target.files?.[0] && upload(e.target.files[0])}
              accept="image/jpeg,image/png,video/mp4,audio/*,application/pdf,.doc,.docx,.xls,.xlsx,.ppt,.pptx,.txt"
            />
            <Button
              variant="ghost"
              size="icon-sm"
              aria-label="Attach file"
              disabled={chatDisabled || uploading}
              onClick={() => fileInput.current?.click()}
            >
              {uploading ? <Loader2 className="animate-spin" /> : <Paperclip />}
            </Button>
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
              size="sm"
              aria-label="Templates"
              onClick={() => setTemplateOpen(true)}
              disabled={templates.length === 0}
            >
              <LayoutTemplate /> Template
            </Button>
            <ShortcutMenu conversationId={selected.id} botActive={selected.bot_active} />
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
          disabled={pending || chatDisabled || !text.trim()}
        >
          {pending ? <Loader2 className="animate-spin" /> : <Send />}{" "}
          {mode === "comment" ? "Add note" : "Send"}
        </Button>
      </div>
      <TemplatePicker
        open={templateOpen}
        onOpenChange={setTemplateOpen}
        conversation={selected}
        templates={templates.filter((t) => !t.channel_id || t.channel_id === selected.channel_id)}
      />
    </div>
  );
}
