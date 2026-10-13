"use client";

import { useEffect, useState, useTransition } from "react";
import { Loader2, Sparkles } from "lucide-react";
import { toast } from "sonner";

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
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Textarea } from "@/components/ui/textarea";
import {
  ENQUIRY_STATUSES,
  REASON_STATUSES,
  STATUS_LABELS,
  type EnquiryStatus,
} from "@/lib/enquiries/constants";

import { closeConversation } from "./actions";
import { aiSummarize } from "./ai-actions";
import {
  closeConversationWithEnquiry,
  loadCloseEnquiryOptions,
  type CloseEnquiryOptions,
} from "./close-actions";
import type { CategoryInfo } from "./types";

const NONE = "__none__";
const CREATE = "__create__";
const KEEP = "__keep__";

export function CloseDialog({
  open,
  onOpenChange,
  conversationId,
  categories,
  settings,
  aiAvailable = false,
  enquiriesManage = false,
}: {
  open: boolean;
  onOpenChange: (o: boolean) => void;
  conversationId: string;
  categories: CategoryInfo[];
  settings: { require_category_on_close: boolean; require_summary_on_close: boolean };
  aiAvailable?: boolean;
  /** May this person create and move enquiries (enquiries.manage)? Shows the enquiry section. */
  enquiriesManage?: boolean;
}) {
  const [category, setCategory] = useState<string>(NONE);
  const [summary, setSummary] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();
  const [summarizing, startSummarize] = useTransition();

  // Enquiry part (Phase 20d): nothing, a new enquiry, or one of the patient's open enquiries.
  const [options, setOptions] = useState<CloseEnquiryOptions | null>(null);
  const [optionsFor, setOptionsFor] = useState<string | null>(null);
  const [enquiry, setEnquiry] = useState<string>(NONE);
  const [pipelineId, setPipelineId] = useState("");
  const [stageId, setStageId] = useState<string>(KEEP);
  const [title, setTitle] = useState("WhatsApp enquiry");
  const [status, setStatus] = useState<string>(KEEP);
  const [reason, setReason] = useState("");
  const [apptDate, setApptDate] = useState("");

  useEffect(() => {
    if (!open || !enquiriesManage || optionsFor === conversationId) return;
    setOptionsFor(conversationId);
    setOptions(null);
    setEnquiry(NONE);
    void loadCloseEnquiryOptions(conversationId).then((r) => {
      if (r.ok) {
        setOptions(r.data);
        setPipelineId(r.data.pipelines[0]?.id ?? "");
      }
    });
  }, [open, enquiriesManage, conversationId, optionsFor]);

  const selectedEnquiry = options?.enquiries.find((e) => e.id === enquiry) ?? null;
  const pipeline =
    options?.pipelines.find(
      (p) => p.id === (selectedEnquiry ? selectedEnquiry.pipeline_id : pipelineId),
    ) ?? null;
  const needsReason = REASON_STATUSES.includes(status as EnquiryStatus);

  function resetEnquiry() {
    setStageId(KEEP);
    setStatus(KEEP);
    setReason("");
    setApptDate("");
  }

  function suggestSummary() {
    setError(null);
    startSummarize(async () => {
      const r = await aiSummarize({ conversation_id: conversationId });
      if (!r.ok) {
        setError(r.error);
        return;
      }
      setSummary(r.data.text); // a draft in the box: the person edits it and decides when to close
    });
  }

  function submit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    startTransition(async () => {
      const base = {
        conversation_id: conversationId,
        category_id: category === NONE ? null : category,
        summary,
      };
      const stage = stageId === KEEP ? null : stageId;
      const st = status === KEEP ? undefined : (status as EnquiryStatus);
      const r =
        enquiry === NONE
          ? await closeConversation(base)
          : await closeConversationWithEnquiry({
              ...base,
              enquiry:
                enquiry === CREATE
                  ? {
                      mode: "create",
                      pipeline_id: pipelineId,
                      stage_id: stage,
                      title,
                      status: st ?? "open",
                      reason: needsReason ? reason : null,
                      appt_date: apptDate || null,
                    }
                  : {
                      mode: "update",
                      enquiry_id: enquiry,
                      stage_id: stage,
                      status: st,
                      reason: needsReason ? reason : null,
                      appt_date: apptDate || undefined,
                    },
            });
      if (!r.ok) {
        setError(r.error);
        return;
      }
      toast.success(r.message);
      onOpenChange(false);
      setSummary("");
      setCategory(NONE);
      setEnquiry(NONE);
      setOptionsFor(null);
      resetEnquiry();
    });
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[90dvh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle>Close conversation</DialogTitle>
          <DialogDescription>
            It moves to Closed; a new patient message reopens it.
          </DialogDescription>
        </DialogHeader>
        <form onSubmit={submit} className="flex flex-col gap-4">
          <div className="grid gap-2">
            <Label>
              Category{" "}
              {settings.require_category_on_close && <span className="text-destructive">*</span>}
            </Label>
            <Select value={category} onValueChange={setCategory}>
              <SelectTrigger className="w-full">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value={NONE}>No category</SelectItem>
                {categories.map((c) => (
                  <SelectItem key={c.id} value={c.id}>
                    {c.name}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <div className="grid gap-2">
            <div className="flex items-center justify-between">
              <Label htmlFor="close-summary">
                Summary{" "}
                {settings.require_summary_on_close && <span className="text-destructive">*</span>}
              </Label>
              {aiAvailable && (
                <Button
                  type="button"
                  variant="ghost"
                  size="xs"
                  onClick={suggestSummary}
                  disabled={summarizing || pending}
                >
                  {summarizing ? <Loader2 className="animate-spin" /> : <Sparkles />} Draft with AI
                </Button>
              )}
            </div>
            <Textarea
              id="close-summary"
              value={summary}
              onChange={(e) => setSummary(e.target.value)}
              rows={3}
              placeholder="What was resolved?"
              dir="auto"
            />
          </div>

          {enquiriesManage && (
            <fieldset className="grid gap-3 rounded-lg border p-3">
              <legend className="px-1 text-sm font-medium">Enquiry</legend>
              {!options ? (
                <p className="text-muted-foreground flex items-center gap-2 text-xs">
                  <Loader2 className="size-3 animate-spin" /> Loading enquiries…
                </p>
              ) : (
                <>
                  <Select
                    value={enquiry}
                    onValueChange={(v) => {
                      setEnquiry(v);
                      resetEnquiry();
                      if (v === CREATE) setStatus("open");
                    }}
                  >
                    <SelectTrigger className="w-full" aria-label="Enquiry">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value={NONE}>Leave enquiries as they are</SelectItem>
                      {options.pipelines.length > 0 && (
                        <SelectItem value={CREATE}>Create a new enquiry</SelectItem>
                      )}
                      {options.enquiries.map((q) => (
                        <SelectItem key={q.id} value={q.id}>
                          Update #{q.number} {q.title}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>

                  {enquiry === CREATE && (
                    <div className="grid gap-3 sm:grid-cols-2">
                      <div className="grid gap-1.5 sm:col-span-2">
                        <Label htmlFor="close-enq-title">Title</Label>
                        <Input
                          id="close-enq-title"
                          value={title}
                          onChange={(e) => setTitle(e.target.value)}
                          maxLength={200}
                        />
                      </div>
                      <div className="grid gap-1.5">
                        <Label>Pipeline</Label>
                        <Select
                          value={pipelineId}
                          onValueChange={(v) => {
                            setPipelineId(v);
                            setStageId(KEEP);
                          }}
                        >
                          <SelectTrigger>
                            <SelectValue />
                          </SelectTrigger>
                          <SelectContent>
                            {options.pipelines.map((p) => (
                              <SelectItem key={p.id} value={p.id}>
                                {p.name}
                              </SelectItem>
                            ))}
                          </SelectContent>
                        </Select>
                      </div>
                    </div>
                  )}

                  {enquiry !== NONE && pipeline && (
                    <div className="grid gap-3 sm:grid-cols-2">
                      <div className="grid gap-1.5">
                        <Label>Stage</Label>
                        <Select value={stageId} onValueChange={setStageId}>
                          <SelectTrigger>
                            <SelectValue />
                          </SelectTrigger>
                          <SelectContent>
                            <SelectItem value={KEEP}>
                              {enquiry === CREATE ? "First stage" : "Keep the current stage"}
                            </SelectItem>
                            {pipeline.stages.map((s) => (
                              <SelectItem key={s.id} value={s.id}>
                                {s.name}
                              </SelectItem>
                            ))}
                          </SelectContent>
                        </Select>
                      </div>
                      <div className="grid gap-1.5">
                        <Label>Status</Label>
                        <Select value={status} onValueChange={setStatus}>
                          <SelectTrigger>
                            <SelectValue />
                          </SelectTrigger>
                          <SelectContent>
                            {enquiry !== CREATE && (
                              <SelectItem value={KEEP}>Keep the current status</SelectItem>
                            )}
                            {ENQUIRY_STATUSES.map((s) => (
                              <SelectItem key={s} value={s}>
                                {STATUS_LABELS[s]}
                              </SelectItem>
                            ))}
                          </SelectContent>
                        </Select>
                      </div>
                      {needsReason && (
                        <div className="grid gap-1.5 sm:col-span-2">
                          <Label htmlFor="close-enq-reason">
                            Reason <span className="text-destructive">*</span>
                          </Label>
                          {options.lostReasons.length > 0 && (
                            <div
                              className="flex flex-wrap gap-1.5"
                              role="group"
                              aria-label="Common reasons"
                            >
                              {options.lostReasons.map((r) => (
                                <Button
                                  key={r}
                                  type="button"
                                  size="xs"
                                  variant={reason === r ? "default" : "outline"}
                                  aria-pressed={reason === r}
                                  onClick={() => setReason(r)}
                                >
                                  {r}
                                </Button>
                              ))}
                            </div>
                          )}
                          <Input
                            id="close-enq-reason"
                            value={reason}
                            onChange={(e) => setReason(e.target.value)}
                            maxLength={500}
                            placeholder={options.lostReasons.length ? "Or write your own" : "Why?"}
                          />
                        </div>
                      )}
                      <div className="grid gap-1.5 sm:col-span-2">
                        <Label htmlFor="close-enq-appt">Appointment requested for (optional)</Label>
                        <Input
                          id="close-enq-appt"
                          type="date"
                          value={apptDate}
                          onChange={(e) => setApptDate(e.target.value)}
                          className="w-48"
                        />
                      </div>
                    </div>
                  )}
                </>
              )}
            </fieldset>
          )}

          {error && (
            <p className="text-destructive text-sm" role="alert">
              {error}
            </p>
          )}
          <DialogFooter>
            <Button type="button" variant="ghost" onClick={() => onOpenChange(false)}>
              Cancel
            </Button>
            <Button type="submit" disabled={pending}>
              {pending && <Loader2 className="animate-spin" />}{" "}
              {enquiry === NONE ? "Close conversation" : "Save enquiry and close"}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
