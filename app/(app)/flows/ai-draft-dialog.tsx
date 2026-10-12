"use client";

import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";
import { Loader2, Sparkles, TriangleAlert } from "lucide-react";

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
import { Textarea } from "@/components/ui/textarea";
import { AI_FLOW_LIMITS } from "@/lib/ai/flow-copilot/policy";
import { TRIGGER_LABELS } from "@/lib/flow-engine/labels";

import { draftFlowWithAi, type AiDraftResult } from "./ai-actions";

const EXAMPLES = [
  "Greet new patients, ask whether they want to book, and hand booking requests to the front desk.",
  "When the clinic is closed, tell the patient our opening hours and that we will reply in the morning.",
  "After a visit, ask how it went with Good / Okay / Poor buttons and alert the manager on Poor.",
];

/**
 * “Describe what the bot should do.” Creates a NEW unpublished draft (never changes an existing flow) and shows what the checks
 * found before opening it. Nothing the AI writes can run until a person has reviewed and published it.
 */
export function AiDraftDialog({
  open,
  onOpenChange,
}: {
  open: boolean;
  onOpenChange: (o: boolean) => void;
}) {
  const router = useRouter();
  const [prompt, setPrompt] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<AiDraftResult | null>(null);
  const [pending, startTransition] = useTransition();

  function create() {
    setError(null);
    startTransition(async () => {
      const r = await draftFlowWithAi({ prompt });
      if (r.ok) setResult(r.data);
      else setError(r.error);
    });
  }

  function close(o: boolean) {
    if (!o) {
      setResult(null);
      setError(null);
    }
    onOpenChange(o);
  }

  const needs = result ? result.needs.templates + result.needs.teams + result.needs.people : 0;

  return (
    <Dialog open={open} onOpenChange={close}>
      <DialogContent className="sm:max-w-xl">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <Sparkles className="size-4" /> Describe the bot
          </DialogTitle>
          <DialogDescription>
            AI writes a draft flow from your description. It opens as an unpublished draft: you
            check every step, choose the templates and teams, run a dry run, and mark it reviewed
            before it can be published. Your description is sent to the AI provider, so do not type
            patient names or numbers.
          </DialogDescription>
        </DialogHeader>

        {result ? (
          <div className="flex flex-col gap-3 text-sm" role="status">
            <p className="font-medium">
              Draft “{result.name}” created: {result.steps} steps, starts on{" "}
              {TRIGGER_LABELS[result.triggerType] ?? result.triggerType}.
              {result.repaired ? " The first attempt needed one correction." : ""}
            </p>
            {needs > 0 && (
              <p>
                {needs} step{needs === 1 ? "" : "s"} still need your choice (
                {[
                  result.needs.templates && `${result.needs.templates} template`,
                  result.needs.teams && `${result.needs.teams} team`,
                  result.needs.people && `${result.needs.people} person or role`,
                ]
                  .filter(Boolean)
                  .join(", ")}
                ). They are highlighted in the builder.
              </p>
            )}
            {result.notes.length > 0 && (
              <ul className="text-muted-foreground flex list-disc flex-col gap-1 pl-5">
                {result.notes.map((n) => (
                  <li key={n}>{n}</li>
                ))}
              </ul>
            )}
            <p className="text-muted-foreground">
              Not published. It cannot be published until you have reviewed it.
            </p>
          </div>
        ) : (
          <div className="grid gap-2">
            <Label htmlFor="ai-flow-prompt">What should the bot do?</Label>
            <Textarea
              id="ai-flow-prompt"
              rows={5}
              maxLength={AI_FLOW_LIMITS.maxPromptChars}
              value={prompt}
              onChange={(e) => setPrompt(e.target.value)}
              placeholder="Describe the conversation, in English or Arabic."
              dir="auto"
            />
            <div className="flex flex-wrap gap-1.5">
              {EXAMPLES.map((e) => (
                <button
                  key={e}
                  type="button"
                  className="hover:bg-accent rounded-full border px-2.5 py-1 text-left text-xs"
                  onClick={() => setPrompt(e)}
                >
                  {e.slice(0, 48)}…
                </button>
              ))}
            </div>
            {error && (
              <p className="text-destructive flex gap-1.5 text-sm" role="alert">
                <TriangleAlert className="mt-0.5 size-4 shrink-0" /> {error}
              </p>
            )}
          </div>
        )}

        <DialogFooter>
          {result ? (
            <Button onClick={() => router.push(`/flows/${result.id}`)}>Open the draft</Button>
          ) : (
            <Button onClick={create} disabled={pending || !prompt.trim()}>
              {pending ? <Loader2 className="animate-spin" /> : <Sparkles />} Create draft
            </Button>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
