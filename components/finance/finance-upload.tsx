"use client";

import * as React from "react";
import { Eye, Loader2, Paperclip } from "lucide-react";
import { toast } from "sonner";

import {
  abandonFinanceUpload,
  finalizeFinanceUpload,
  openFinanceDocument,
  prepareFinanceUpload,
} from "@/app/(app)/finance/payables/actions";
import { ScanBadge } from "@/components/media/scan-badge";
import { Button } from "@/components/ui/button";
import {
  FINANCE_DOCUMENT_MAX_BYTES,
  FINANCE_DOCUMENT_TYPES,
  formatBytes,
} from "@/lib/media/limits";
import type { ActionResult } from "@/lib/finance/action-support";
import { FINANCE_DOCUMENT_BUCKET } from "@/lib/media/paths";

/**
 * Attach a finance document (supplier invoice, voucher backup): a PDF, an Excel or CSV file or a phone photo of a paper invoice.
 * prepare -> upload straight to private storage through a signed URL -> finalise (the server checks the stored file, takes
 * its sha256 and runs the malware-scan hook). The file name is never sent to the server.
 */

export type UploadedDocument = {
  id: string;
  kind: string;
  sha256: string;
  size: number;
  scan: string;
};

export const FINANCE_UPLOAD_ACCEPT = [
  ...Object.keys(FINANCE_DOCUMENT_TYPES),
  ".heic",
  ".heif",
  ".xlsx",
  ".csv",
].join(",");

/** The three server actions an upload goes through (the 20D payables ones, or the Finance inbox's). */
export type FinanceUploadActions = {
  prepare: (input: {
    mime: string;
    size: number;
  }) => Promise<ActionResult<{ documentId: string; path: string; token: string }>>;
  finalize: (input: { id: string }) => Promise<ActionResult<UploadedDocument>>;
  abandon: (input: { id: string }) => Promise<ActionResult>;
};

/**
 * Uploads one file: size check, prepare, straight to private storage through the signed URL, finalise. Throws with a
 * sentence for the person; a half-done upload is abandoned so it never lingers.
 */
export async function uploadFinanceFile(
  file: File,
  actions: FinanceUploadActions,
): Promise<{ doc: UploadedDocument; message?: string }> {
  if (file.size > FINANCE_DOCUMENT_MAX_BYTES)
    throw new Error(
      `That file is ${formatBytes(file.size)}; the limit is ${formatBytes(FINANCE_DOCUMENT_MAX_BYTES)}.`,
    );
  // Windows often calls a .csv file "application/vnd.ms-excel"; the server checks the content anyway
  const mime = /\.csv$/i.test(file.name)
    ? "text/csv"
    : file.type || (/\.hei[cf]$/i.test(file.name) ? "image/heic" : "application/octet-stream");
  let documentId: string | null = null;
  try {
    const prep = await actions.prepare({ mime, size: file.size });
    if (!prep.ok || !prep.data) throw new Error(prep.ok ? "Upload failed" : prep.error);
    documentId = prep.data.documentId;
    // the storage client loads only when someone actually uploads (keeps it out of the pages' first load)
    const { createClient } = await import("@/lib/supabase/client");
    const { error } = await createClient()
      .storage.from(FINANCE_DOCUMENT_BUCKET)
      .uploadToSignedUrl(prep.data.path, prep.data.token, file, { contentType: mime });
    if (error) throw new Error("The upload did not finish. Please try again.");
    const done = await actions.finalize({ id: documentId });
    if (!done.ok || !done.data) throw new Error(done.ok ? "Upload failed" : done.error);
    documentId = null;
    return { doc: done.data, message: done.message };
  } catch (err) {
    if (documentId) await actions.abandon({ id: documentId }).catch(() => undefined);
    throw err instanceof Error ? err : new Error("Upload failed");
  }
}

export function FinanceUploadButton({
  kind,
  onUploaded,
  label = "Attach document",
  size = "sm",
}: {
  kind: "supplier_invoice" | "voucher_backup";
  onUploaded: (doc: UploadedDocument) => void;
  label?: string;
  size?: "sm" | "default";
}) {
  const input = React.useRef<HTMLInputElement>(null);
  const [busy, setBusy] = React.useState(false);

  async function onFile(file: File) {
    setBusy(true);
    try {
      const { doc, message } = await uploadFinanceFile(file, {
        prepare: (i) => prepareFinanceUpload({ ...i, kind }),
        finalize: finalizeFinanceUpload,
        abandon: abandonFinanceUpload,
      });
      onUploaded(doc);
      toast.success(message ?? "Attached.");
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Upload failed");
    } finally {
      setBusy(false);
      if (input.current) input.current.value = "";
    }
  }

  return (
    <>
      <input
        ref={input}
        type="file"
        accept={FINANCE_UPLOAD_ACCEPT}
        className="hidden"
        onChange={(e) => e.target.files?.[0] && onFile(e.target.files[0])}
      />
      <Button
        type="button"
        variant="outline"
        size={size}
        disabled={busy}
        onClick={() => input.current?.click()}
      >
        {busy ? <Loader2 className="animate-spin" /> : <Paperclip />} {busy ? "Uploading…" : label}
      </Button>
    </>
  );
}

/** Opens a stored document in a new tab through a 60-second link (the open is logged). */
export function OpenDocumentButton({
  id,
  label = "Open",
  open = openFinanceDocument,
}: {
  id: string;
  label?: string;
  /** The server action that hands out the link (default: the payables one). */
  open?: (input: { id: string }) => Promise<ActionResult<{ url: string }>>;
}) {
  const [busy, setBusy] = React.useState(false);
  return (
    <Button
      type="button"
      variant="ghost"
      size="sm"
      disabled={busy}
      onClick={async () => {
        setBusy(true);
        // open the tab synchronously so the browser does not block it as a pop-up
        const tab = window.open("about:blank", "_blank");
        const res = await open({ id });
        setBusy(false);
        if (res.ok && res.data && tab) tab.location.href = res.data.url;
        else {
          tab?.close();
          toast.error(res.ok ? "Could not open the document." : res.error);
        }
      }}
    >
      {busy ? <Loader2 className="animate-spin" /> : <Eye />} {label}
    </Button>
  );
}

const CHIP_LABEL: Record<string, string> = {
  supplier_invoice: "Supplier invoice",
  bank_statement: "Bank statement",
  processor_report: "Processor report",
  unclassified: "Document",
};

/** One attached document: kind, size, a short fingerprint, its scan state and an Open button. */
export function DocumentChip({
  doc,
  onRemove,
}: {
  doc: { id: string; kind: string; sha256: string; size: number; scan: string };
  onRemove?: () => void;
}) {
  return (
    <div className="flex flex-wrap items-center gap-2 rounded-md border px-2 py-1 text-xs">
      <span className="font-medium">{CHIP_LABEL[doc.kind] ?? "Backup"}</span>
      <span className="text-muted-foreground">{formatBytes(doc.size)}</span>
      <span className="text-muted-foreground font-mono" title={doc.sha256}>
        {doc.sha256.slice(0, 12)}…
      </span>
      {doc.scan !== "clean" && <ScanBadge status={doc.scan} />}
      <OpenDocumentButton id={doc.id} />
      {onRemove && (
        <Button type="button" variant="ghost" size="sm" onClick={onRemove}>
          Remove
        </Button>
      )}
    </div>
  );
}
