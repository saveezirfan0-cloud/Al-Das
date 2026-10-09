"use client";

import { useEffect, useState, useTransition } from "react";
import { Loader2, Search, X } from "lucide-react";
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
import { formatPhone } from "@/lib/phone";

import { createEnquiryAction, searchContacts, type ContactOption } from "./actions";
import type { EnquiriesBootstrap } from "./types";

const NONE = "__none";

/** New enquiry: pick the patient, the pipeline and stage, then a few essentials; the rest is edited in the drawer. */
export function NewEnquiryDialog({
  bootstrap,
  open,
  onOpenChange,
  pipelineId,
  stageId,
  contact,
  onCreated,
}: {
  bootstrap: EnquiriesBootstrap;
  open: boolean;
  onOpenChange: (o: boolean) => void;
  pipelineId: string;
  stageId?: string | null;
  /** Prefilled patient (from the inbox or contact drawer). */
  contact?: ContactOption | null;
  onCreated: (id: string) => void;
}) {
  const active = bootstrap.pipelines.filter((p) => !p.archived);
  const [picked, setPicked] = useState<ContactOption | null>(contact ?? null);
  const [term, setTerm] = useState("");
  const [found, setFound] = useState<ContactOption[]>([]);
  const [pipeline, setPipeline] = useState(pipelineId);
  const [stage, setStage] = useState(stageId ?? "");
  const [title, setTitle] = useState("");
  const [source, setSource] = useState("");
  const [channel, setChannel] = useState(NONE);
  const [assignee, setAssignee] = useState(NONE);
  const [value, setValue] = useState("");
  const [pending, start] = useTransition();

  const stages = active.find((p) => p.id === pipeline)?.stages ?? [];

  useEffect(() => {
    if (picked || term.trim().length < 2) {
      setFound([]);
      return;
    }
    const handle = setTimeout(async () => {
      const r = await searchContacts(term);
      setFound(r.ok ? r.contacts : []);
    }, 250);
    return () => clearTimeout(handle);
  }, [term, picked]);

  function submit() {
    if (!picked) return;
    const est = value.trim() === "" ? null : Number(value);
    if (est !== null && (!Number.isFinite(est) || est < 0)) {
      toast.error("Estimated value must be a positive number.");
      return;
    }
    start(async () => {
      const r = await createEnquiryAction({
        contact_id: picked.id,
        pipeline_id: pipeline,
        stage_id: stage && stages.some((s) => s.id === stage) ? stage : undefined,
        title: title.trim(),
        source: source.trim() || null,
        channel_id: channel === NONE ? null : channel,
        assignee_id: assignee === NONE ? undefined : assignee,
        est_value: est,
      });
      if (!r.ok) {
        toast.error(r.error);
        return;
      }
      toast.success(`Enquiry #${r.number} created.`);
      onOpenChange(false);
      onCreated(r.id);
    });
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>New enquiry</DialogTitle>
          <DialogDescription>
            Start with the patient. You can fill in the rest from the enquiry drawer.
          </DialogDescription>
        </DialogHeader>

        <div className="flex flex-col gap-3">
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="enq-patient">Patient</Label>
            {picked ? (
              <div className="flex items-center justify-between rounded-md border px-3 py-2 text-sm">
                <span>
                  {picked.name || "Unnamed contact"}
                  {picked.phone && (
                    <span className="text-muted-foreground ms-2 tabular-nums">
                      {formatPhone(picked.phone)}
                    </span>
                  )}
                </span>
                {!contact && (
                  <button
                    type="button"
                    aria-label="Choose another patient"
                    onClick={() => setPicked(null)}
                  >
                    <X className="size-4" />
                  </button>
                )}
              </div>
            ) : (
              <>
                <div className="relative">
                  <Search
                    className="text-muted-foreground pointer-events-none absolute start-2 top-1/2 size-4 -translate-y-1/2"
                    aria-hidden
                  />
                  <Input
                    id="enq-patient"
                    className="ps-8"
                    placeholder="Search by name or phone"
                    value={term}
                    onChange={(e) => setTerm(e.target.value)}
                    autoComplete="off"
                  />
                </div>
                {found.length > 0 && (
                  <ul
                    className="max-h-40 overflow-y-auto rounded-md border"
                    role="listbox"
                    aria-label="Matching patients"
                  >
                    {found.map((c) => (
                      <li key={c.id}>
                        <button
                          type="button"
                          role="option"
                          aria-selected={false}
                          className="hover:bg-accent flex w-full items-center justify-between px-3 py-1.5 text-start text-sm"
                          onClick={() => setPicked(c)}
                        >
                          <span>{c.name || "Unnamed contact"}</span>
                          {c.phone && (
                            <span className="text-muted-foreground tabular-nums">
                              {formatPhone(c.phone)}
                            </span>
                          )}
                        </button>
                      </li>
                    ))}
                  </ul>
                )}
                {term.trim().length >= 2 && found.length === 0 && (
                  <p className="text-muted-foreground text-xs">
                    No match. Add the patient in Contacts first.
                  </p>
                )}
              </>
            )}
          </div>

          <div className="grid grid-cols-2 gap-3">
            <div className="flex flex-col gap-1.5">
              <Label>Pipeline</Label>
              <Select
                value={pipeline}
                onValueChange={(v) => {
                  setPipeline(v);
                  setStage("");
                }}
              >
                <SelectTrigger className="w-full" aria-label="Pipeline">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {active.map((p) => (
                    <SelectItem key={p.id} value={p.id}>
                      {p.name}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div className="flex flex-col gap-1.5">
              <Label>Stage</Label>
              <Select value={stage || stages[0]?.id || ""} onValueChange={setStage}>
                <SelectTrigger className="w-full" aria-label="Stage">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {stages.map((s) => (
                    <SelectItem key={s.id} value={s.id}>
                      {s.name}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
          </div>

          <div className="flex flex-col gap-1.5">
            <Label htmlFor="enq-title">Title</Label>
            <Input
              id="enq-title"
              value={title}
              maxLength={200}
              onChange={(e) => setTitle(e.target.value)}
              placeholder="What is this about?"
            />
          </div>

          <div className="grid grid-cols-2 gap-3">
            <div className="flex flex-col gap-1.5">
              <Label htmlFor="enq-source">Source</Label>
              <Input
                id="enq-source"
                list="enq-sources"
                value={source}
                maxLength={80}
                onChange={(e) => setSource(e.target.value)}
              />
              <datalist id="enq-sources">
                {bootstrap.sources.map((s) => (
                  <option key={s} value={s} />
                ))}
              </datalist>
            </div>
            <div className="flex flex-col gap-1.5">
              <Label htmlFor="enq-value">Estimated value</Label>
              <Input
                id="enq-value"
                inputMode="decimal"
                value={value}
                onChange={(e) => setValue(e.target.value)}
                placeholder="Optional"
              />
            </div>
            <div className="flex flex-col gap-1.5">
              <Label>Channel</Label>
              <Select value={channel} onValueChange={setChannel}>
                <SelectTrigger className="w-full" aria-label="Channel">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value={NONE}>—</SelectItem>
                  {bootstrap.channels.map((c) => (
                    <SelectItem key={c.id} value={c.id}>
                      {c.name}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div className="flex flex-col gap-1.5">
              <Label>Assigned to</Label>
              <Select value={assignee} onValueChange={setAssignee}>
                <SelectTrigger className="w-full" aria-label="Assigned to">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value={NONE}>Use the assignment rule</SelectItem>
                  {bootstrap.users.map((u) => (
                    <SelectItem key={u.id} value={u.id}>
                      {u.label}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
          </div>
        </div>

        <DialogFooter>
          <Button variant="ghost" onClick={() => onOpenChange(false)} disabled={pending}>
            Cancel
          </Button>
          <Button disabled={!picked || !pipeline || pending} onClick={submit}>
            {pending && <Loader2 className="animate-spin" />} Create enquiry
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
