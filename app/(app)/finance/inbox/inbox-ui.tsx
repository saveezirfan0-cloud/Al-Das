"use client";

import * as React from "react";
import { useRouter } from "next/navigation";
import { Loader2, Upload } from "lucide-react";
import { toast } from "sonner";

import { RunButton, selectClass } from "@/components/finance/forms";
import {
  FINANCE_UPLOAD_ACCEPT,
  OpenDocumentButton,
  uploadFinanceFile,
} from "@/components/finance/finance-upload";
import { Button } from "@/components/ui/button";

import {
  abandonInboxUpload,
  discardInboxFile,
  finalizeInboxUpload,
  labelInboxDocument,
  openInboxDocument,
  prepareInboxUpload,
} from "./actions";

const ACTIONS = {
  prepare: prepareInboxUpload,
  finalize: finalizeInboxUpload,
  abandon: abandonInboxUpload,
};

/** Drop zone for several files at once (paper invoices photographed at a branch, bank statements, processor reports). */
export function InboxDropZone() {
  const router = useRouter();
  const input = React.useRef<HTMLInputElement>(null);
  const [left, setLeft] = React.useState(0);
  const [over, setOver] = React.useState(false);

  async function upload(files: File[]) {
    if (files.length === 0 || left > 0) return;
    setLeft(files.length);
    let stored = 0;
    let already = 0;
    for (const file of files) {
      try {
        const { doc } = await uploadFinanceFile(file, ACTIONS);
        if ("duplicateOf" in doc && doc.duplicateOf) already++;
        else stored++;
      } catch (err) {
        toast.error(err instanceof Error ? err.message : "Upload failed");
      }
      setLeft((n) => n - 1);
    }
    if (stored > 0) toast.success(stored === 1 ? "1 file added." : `${stored} files added.`);
    if (already > 0)
      toast.message(
        already === 1
          ? "1 file was already in Pulse and was not added again."
          : `${already} files were already in Pulse and were not added again.`,
      );
    if (input.current) input.current.value = "";
    router.refresh();
  }

  return (
    <div
      className={`flex flex-col items-center gap-2 rounded-lg border-2 border-dashed p-6 text-center text-sm ${over ? "border-primary bg-muted" : ""}`}
      onDragOver={(e) => {
        e.preventDefault();
        setOver(true);
      }}
      onDragLeave={() => setOver(false)}
      onDrop={(e) => {
        e.preventDefault();
        setOver(false);
        void upload(Array.from(e.dataTransfer.files));
      }}
    >
      <input
        ref={input}
        type="file"
        multiple
        accept={FINANCE_UPLOAD_ACCEPT}
        className="hidden"
        onChange={(e) => void upload(Array.from(e.target.files ?? []))}
      />
      <p className="text-muted-foreground">
        Drop files here: PDF, photos (JPEG, PNG, HEIC), Excel or CSV, up to 20 MB each.
      </p>
      <Button
        type="button"
        variant="outline"
        disabled={left > 0}
        onClick={() => input.current?.click()}
      >
        {left > 0 ? <Loader2 className="animate-spin" /> : <Upload />}
        {left > 0 ? `Uploading (${left} left)…` : "Choose files"}
      </Button>
    </div>
  );
}

const LABEL_OPTIONS = [
  { value: "unclassified", label: "Not labelled" },
  { value: "supplier_invoice", label: "Supplier invoice" },
  { value: "bank_statement", label: "Bank statement" },
  { value: "processor_report", label: "Processor report" },
  { value: "other", label: "Other" },
] as const;

export function LabelSelect({ id, kind }: { id: string; kind: string }) {
  const [pending, start] = React.useTransition();
  return (
    <select
      aria-label="Label"
      className={selectClass}
      defaultValue={kind}
      disabled={pending}
      onChange={(e) => {
        const next = e.target.value as (typeof LABEL_OPTIONS)[number]["value"];
        start(async () => {
          const res = await labelInboxDocument({ id, kind: next });
          if (res.ok) toast.success(res.message ?? "Saved");
          else toast.error(res.error);
        });
      }}
    >
      {LABEL_OPTIONS.map((o) => (
        <option key={o.value} value={o.value}>
          {o.label}
        </option>
      ))}
    </select>
  );
}

export function OpenInboxButton({ id }: { id: string }) {
  return <OpenDocumentButton id={id} open={openInboxDocument} />;
}

export function DiscardButton({ id }: { id: string }) {
  return (
    <RunButton
      variant="ghost"
      action={() => discardInboxFile({ id })}
      confirm="Discard this file? It is deleted from Pulse and cannot be brought back."
    >
      Discard
    </RunButton>
  );
}
