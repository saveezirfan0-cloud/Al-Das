"use client";

import { useState, useTransition } from "react";
import { AlertTriangle, ClipboardCopy, Loader2, Sparkles, ThumbsDown, ThumbsUp, Undo2 } from "lucide-react";
import { toast } from "sonner";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { Separator } from "@/components/ui/separator";
import { TONES, type Language, type Tone } from "@/lib/ai/types";

import { aiAsk, aiFeedback, aiRewrite, aiSuggestReply, aiSummarize, saveConversationSummary, type AiPayload } from "./ai-actions";

type Kind = "suggest" | "rewrite" | "ask" | "summarize";

type Shown = AiPayload & { kind: Kind };

const TONE_LABEL: Record<Tone, string> = {
  professional: "Professional",
  friendly: "Friendly",
  empathetic: "Empathetic",
  concise: "Concise",
  formal: "Formal",
};

const LANGUAGE_LABEL: Record<Language, string> = { en: "English", ar: "العربية" };

/**
 * AI assist for the composer. Everything it produces is a DRAFT: suggestions and rewrites replace
 * the text in the message box (with Undo), answers and summaries are shown here. Nothing is sent
 * until a person presses Send.
 */
export function AiPanel({
  conversationId,
  text,
  onText,
  disabled,
}: {
  conversationId: string;
  text: string;
  onText: (next: string) => void;
  disabled?: boolean;
}) {
  const [open, setOpen] = useState(false);
  const [pending, startTransition] = useTransition();
  const [busy, setBusy] = useState<Kind | null>(null);
  const [question, setQuestion] = useState("");
  const [shown, setShown] = useState<Shown | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [previous, setPrevious] = useState<string | null>(null);
  const [vote, setVote] = useState<boolean | null>(null);

  function run(kind: Kind, call: () => ReturnType<typeof aiSuggestReply>, apply: boolean) {
    setError(null);
    setBusy(kind);
    startTransition(async () => {
      const r = await call();
      setBusy(null);
      if (!r.ok) {
        setError(r.error);
        return;
      }
      setVote(null);
      setShown({ ...r.data, kind });
      if (apply) {
        setPrevious(text);
        onText(r.data.text);
        if (r.data.needsReview) toast.warning("Read this draft carefully before sending.");
      }
    });
  }

  function sendFeedback(positive: boolean) {
    if (!shown?.usageId) return;
    setVote(positive);
    startTransition(async () => {
      const r = await aiFeedback({ usage_id: shown.usageId!, positive, chunk_ids: shown.chunkIds });
      if (!r.ok) {
        setVote(null);
        toast.error(r.error);
      }
    });
  }

  const hasDraft = text.trim().length > 0;
  const working = pending || busy !== null;

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <Button variant="ghost" size="sm" aria-label="AI assist" disabled={disabled}>
          <Sparkles /> AI
        </Button>
      </PopoverTrigger>
      <PopoverContent align="start" side="top" className="w-96 max-w-[calc(100vw-2rem)] space-y-3 p-3">
        <p className="text-muted-foreground text-xs">
          Drafts only. You review and send. Never relied on for medical advice.
        </p>

        <Button
          size="sm"
          className="w-full"
          disabled={working}
          onClick={() => run("suggest", () => aiSuggestReply({ conversation_id: conversationId }), true)}
        >
          {busy === "suggest" ? <Loader2 className="animate-spin" /> : <Sparkles />} Suggest a reply
        </Button>

        <form
          className="flex gap-2"
          onSubmit={(e) => {
            e.preventDefault();
            if (question.trim()) run("ask", () => aiAsk({ conversation_id: conversationId, question }), false);
          }}
        >
          <Input
            value={question}
            onChange={(e) => setQuestion(e.target.value)}
            placeholder="Ask AI about this conversation…"
            aria-label="Ask AI"
            maxLength={500}
            dir="auto"
          />
          <Button type="submit" size="sm" variant="outline" disabled={working || !question.trim()}>
            {busy === "ask" ? <Loader2 className="animate-spin" /> : "Ask"}
          </Button>
        </form>

        <Button
          size="sm"
          variant="outline"
          className="w-full"
          disabled={working}
          onClick={() => run("summarize", () => aiSummarize({ conversation_id: conversationId }), false)}
        >
          {busy === "summarize" && <Loader2 className="animate-spin" />} Summarize conversation
        </Button>

        <Separator />

        <div className="space-y-2">
          <p className="text-xs font-medium">Improve my message</p>
          <div className="flex flex-wrap gap-1">
            {TONES.map((tone) => (
              <Button
                key={tone}
                size="xs"
                variant="outline"
                disabled={working || !hasDraft}
                onClick={() =>
                  run("rewrite", () => aiRewrite({ conversation_id: conversationId, draft: text, mode: { kind: "tone", tone } }), true)
                }
              >
                {TONE_LABEL[tone]}
              </Button>
            ))}
          </div>
          <div className="flex flex-wrap gap-1">
            {(Object.keys(LANGUAGE_LABEL) as Language[]).map((language) => (
              <Button
                key={language}
                size="xs"
                variant="outline"
                disabled={working || !hasDraft}
                onClick={() =>
                  run("rewrite", () => aiRewrite({ conversation_id: conversationId, draft: text, mode: { kind: "language", language } }), true)
                }
              >
                Translate → {LANGUAGE_LABEL[language]}
              </Button>
            ))}
            <Button
              size="xs"
              variant="outline"
              disabled={working || !hasDraft}
              onClick={() =>
                run("rewrite", () => aiRewrite({ conversation_id: conversationId, draft: text, mode: { kind: "grammar" } }), true)
              }
            >
              Fix spelling &amp; grammar
            </Button>
          </div>
          {!hasDraft && <p className="text-muted-foreground text-xs">Type a message first to use these.</p>}
        </div>

        {error && (
          <p className="text-destructive text-sm" role="alert">
            {error}
          </p>
        )}

        {shown && (
          <div className="bg-muted/50 space-y-2 rounded-md border p-2">
            {shown.flags.length > 0 && (
              <ul className="space-y-1 text-xs text-amber-800 dark:text-amber-300" role="status">
                {shown.flags.map((f) => (
                  <li key={f} className="flex gap-1.5">
                    <AlertTriangle className="mt-0.5 size-3.5 shrink-0" /> {f}
                  </li>
                ))}
              </ul>
            )}
            {(shown.kind === "ask" || shown.kind === "summarize") && (
              <p className="max-h-48 overflow-y-auto text-sm whitespace-pre-wrap" dir="auto">
                {shown.text}
              </p>
            )}
            {(shown.kind === "suggest" || shown.kind === "rewrite") && (
              <p className="text-muted-foreground text-xs">Draft placed in the message box. Edit it before sending.</p>
            )}
            <div className="flex flex-wrap items-center gap-1">
              {(shown.kind === "suggest" || shown.kind === "rewrite") && previous !== null && (
                <Button
                  size="xs"
                  variant="ghost"
                  onClick={() => {
                    onText(previous);
                    setPrevious(null);
                  }}
                >
                  <Undo2 /> Undo
                </Button>
              )}
              {(shown.kind === "ask" || shown.kind === "summarize") && (
                <Button
                  size="xs"
                  variant="ghost"
                  onClick={() => {
                    void navigator.clipboard.writeText(shown.text).then(() => toast.success("Copied."));
                  }}
                >
                  <ClipboardCopy /> Copy
                </Button>
              )}
              {shown.kind === "summarize" && (
                <Button
                  size="xs"
                  variant="ghost"
                  disabled={pending}
                  onClick={() =>
                    startTransition(async () => {
                      const r = await saveConversationSummary({ conversation_id: conversationId, summary: shown.text });
                      if (r.ok) toast.success(r.message ?? "Summary saved.");
                      else toast.error(r.error);
                    })
                  }
                >
                  Save as conversation summary
                </Button>
              )}
              {shown.usageId && (
                <span className="ml-auto flex items-center gap-1">
                  <Button
                    size="icon-xs"
                    variant={vote === true ? "secondary" : "ghost"}
                    aria-label="Helpful"
                    aria-pressed={vote === true}
                    onClick={() => sendFeedback(true)}
                  >
                    <ThumbsUp />
                  </Button>
                  <Button
                    size="icon-xs"
                    variant={vote === false ? "secondary" : "ghost"}
                    aria-label="Not helpful"
                    aria-pressed={vote === false}
                    onClick={() => sendFeedback(false)}
                  >
                    <ThumbsDown />
                  </Button>
                </span>
              )}
            </div>
          </div>
        )}
      </PopoverContent>
    </Popover>
  );
}
