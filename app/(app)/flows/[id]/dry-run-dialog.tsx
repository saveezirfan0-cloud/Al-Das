"use client";

import { useState, useTransition } from "react";
import { CheckCircle2, CircleDashed, Loader2, Play, TriangleAlert, XCircle } from "lucide-react";

import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import type { SimResult } from "@/lib/flow-engine/simulate";
import type { FlowGraph } from "@/lib/flow-engine/types";

import { dryRunFlow } from "../ai-actions";

const STATUS_TEXT: Record<SimResult["status"], string> = {
  completed: "The flow reached its end.",
  waiting: "The flow stopped, waiting for the patient.",
  failed: "A step failed.",
  not_started: "The flow did not start.",
  stopped: "The dry run stopped.",
};

/**
 * Replays sample patient messages through the flow on screen with every send stubbed: nothing is saved, sent or called. Shows the
 * path taken, step by step, so a draft (AI-written or not) can be checked before it meets a patient.
 */
export function DryRunDialog({
  open,
  onOpenChange,
  graph,
  triggerType,
  triggerConfig,
  onSelectNode,
}: {
  open: boolean;
  onOpenChange: (o: boolean) => void;
  graph: FlowGraph;
  triggerType: string;
  triggerConfig: Record<string, unknown>;
  onSelectNode: (id: string) => void;
}) {
  const [text, setText] = useState("Hello, I would like to book an appointment\nYes");
  const [language, setLanguage] = useState<"en" | "ar">("en");
  const [result, setResult] = useState<SimResult | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();

  function run() {
    setError(null);
    startTransition(async () => {
      const r = await dryRunFlow({
        graph,
        trigger_type: triggerType as never,
        trigger_config: triggerConfig,
        inbound: text
          .split("\n")
          .map((l) => l.trim())
          .filter(Boolean),
        language,
      });
      if (r.ok) setResult(r.data);
      else {
        setResult(null);
        setError(r.error);
      }
    });
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[90dvh] overflow-y-auto sm:max-w-2xl">
        <DialogHeader>
          <DialogTitle>Dry run</DialogTitle>
          <DialogDescription>
            Type what a patient might write, one message per line. The first starts the flow; the
            others answer its questions. Nothing is sent, saved or called: every message and action
            is only shown here. Waits are skipped ahead.
          </DialogDescription>
        </DialogHeader>
        <div className="grid gap-2">
          <Label htmlFor="dry-run-messages">Sample patient messages</Label>
          <Textarea
            id="dry-run-messages"
            rows={4}
            value={text}
            onChange={(e) => setText(e.target.value)}
            dir="auto"
            maxLength={3000}
          />
          <div className="flex items-center gap-3">
            <label className="flex items-center gap-1.5 text-sm">
              Patient language
              <select
                className="bg-background rounded-md border px-2 py-1 text-sm"
                value={language}
                onChange={(e) => setLanguage(e.target.value as "en" | "ar")}
              >
                <option value="en">English</option>
                <option value="ar">العربية</option>
              </select>
            </label>
            <Button className="ml-auto" onClick={run} disabled={pending}>
              {pending ? <Loader2 className="animate-spin" /> : <Play />} Run
            </Button>
          </div>
        </div>

        {error && (
          <p className="text-destructive text-sm" role="alert">
            {error}
          </p>
        )}
        {result && (
          <div className="flex flex-col gap-3">
            <p className="text-sm font-medium" role="status">
              {STATUS_TEXT[result.status]}{" "}
              <span className="text-muted-foreground font-normal">{result.reason}</span>
            </p>
            <ol className="flex flex-col gap-1.5">
              {result.steps.map((s) => (
                <li key={s.seq}>
                  <button
                    type="button"
                    className="hover:bg-accent flex w-full items-start gap-2 rounded-md border px-2.5 py-2 text-left text-sm"
                    onClick={() => {
                      onSelectNode(s.nodeId);
                      onOpenChange(false);
                    }}
                  >
                    {s.outcome === "failed" ? (
                      <XCircle
                        className="text-destructive mt-0.5 size-4 shrink-0"
                        aria-label="Failed"
                      />
                    ) : s.outcome === "waiting" ? (
                      <CircleDashed className="mt-0.5 size-4 shrink-0" aria-label="Waiting" />
                    ) : (
                      <CheckCircle2
                        className="mt-0.5 size-4 shrink-0 text-emerald-600"
                        aria-label="Done"
                      />
                    )}
                    <span className="min-w-0">
                      <span className="font-medium">
                        {s.seq}. {s.label}
                        {s.handle && s.handle !== "default"
                          ? ` → ${s.handle.replace("option:", "")}`
                          : ""}
                      </span>
                      {s.stub && (
                        <span className="ml-2 inline-flex items-center gap-1 rounded bg-amber-100 px-1 text-[11px] text-amber-800">
                          <TriangleAlert className="size-3" /> choose this in the builder
                        </span>
                      )}
                      <span className="text-muted-foreground block break-words" dir="auto">
                        {s.detail}
                      </span>
                    </span>
                  </button>
                </li>
              ))}
            </ol>
            {result.unmatchedReplies > 0 && (
              <p className="text-muted-foreground text-xs">
                {result.unmatchedReplies} answer{result.unmatchedReplies === 1 ? " was" : "s were"}{" "}
                not understood by a question, which kept waiting.
              </p>
            )}
            {result.inboundUnused > 0 && (
              <p className="text-muted-foreground text-xs">
                {result.inboundUnused} sample message
                {result.inboundUnused === 1 ? " was" : "s were"} never reached by the flow.
              </p>
            )}
          </div>
        )}
      </DialogContent>
    </Dialog>
  );
}
