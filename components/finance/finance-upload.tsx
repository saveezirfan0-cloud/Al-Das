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
import { FINANCE_DOCUMENT_BUCKET } from "@/lib/media/paths";

/**
 * Attach a finance document (supplier invoice, voucher backup): a PDF, an Excel file or a phone photo of a paper invoice.
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

const ACCEPT = [...Object.keys(FINANCE_DOCUMENT_TYPES), ".heic", ".heif", ".xlsx"].join(",");

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
    if (file.size > FINANCE_DOCUMENT_MAX_BYTES) {
      toast.error(
        `That file is ${formatBytes(file.size)}; the limit is ${formatBytes(FINANCE_DOCUMENT_MAX_BYTES)}.`,
      );
      return;
    }
    const mime =
      file.type || (/\.hei[cf]$/i.test(file.name) ? "image/heic" : "application/octet-stream");
    setBusy(true);
    let documentId: string | null = null;
    try {
      const prep = await prepareFinanceUpload({ kind, mime, size: file.size });
      if (!prep.ok || !prep.data) throw new Error(prep.ok ? "Upload failed" : prep.error);
      documentId = prep.data.documentId;
      // the storage client loads only when someone actually uploads (keeps it out of the pages' first load)
      const { createClient } = await import("@/lib/supabase/client");
      const { error } = await createClient()
        .storage.from(FINANCE_DOCUMENT_BUCKET)
        .uploadToSignedUrl(prep.data.path, prep.data.token, file, { contentType: mime });
      if (error) throw new Error("The upload did not finish. Please try again.");
      const done = await finalizeFinanceUpload({ id: documentId });
      if (!done.ok || !done.data) throw new Error(done.ok ? "Upload failed" : done.error);
      documentId = null;
      onUploaded(done.data);
      toast.success(done.message ?? "Attached.");
    } catch (err) {
      if (documentId) await abandonFinanceUpload({ id: documentId }).catch(() => undefined);
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
        accept={ACCEPT}
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
export function OpenDocumentButton({ id, label = "Open" }: { id: string; label?: string }) {
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
        const res = await openFinanceDocument({ id });
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
      <span className="font-medium">
        {doc.kind === "supplier_invoice" ? "Supplier invoice" : "Backup"}
      </span>
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
