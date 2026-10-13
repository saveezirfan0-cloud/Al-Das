"use client";

import { useCallback, useEffect, useRef, useState, useTransition } from "react";
import {
  Camera,
  Download,
  Eye,
  FileText,
  History,
  ImageIcon,
  Loader2,
  Pencil,
  Trash2,
  Upload,
} from "lucide-react";
import { toast } from "sonner";

import dynamic from "next/dynamic";

import type { ImageEdit } from "@/components/media/image-editor";
import { ScanBadge } from "@/components/media/scan-badge";
import { Badge } from "@/components/ui/badge";
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
  DOCUMENT_CATEGORIES,
  categoryLabel,
  suggestsExpiry,
  type DocumentCategory,
} from "@/lib/documents/categories";
import { baseName, CONVERTIBLE_IMAGE } from "@/lib/media/upload-names";
import { formatBytes, PATIENT_DOCUMENT_MAX_BYTES, validateMedia } from "@/lib/media/limits";
import { DOCUMENT_BUCKET } from "@/lib/media/paths";
import { cn } from "@/lib/utils";

import { EsignPanel } from "./esign-panel";
import {
  abandonDocumentUpload,
  deleteDocument,
  finalizeDocumentUpload,
  getDocumentUrl,
  listContactDocuments,
  listDocumentAccess,
  prepareDocumentUpload,
  rescanDocument,
  updateDocument,
  type AccessEntry,
  type DocumentRow,
  type DocumentsView,
} from "./actions";

const ImageEditorDialog = dynamic(
  () => import("@/components/media/image-editor").then((m) => m.ImageEditorDialog),
  { ssr: false },
);

const EXPIRY_CLASS: Record<string, string> = {
  expired: "border-red-300 bg-red-50 text-red-800 dark:bg-red-950/40 dark:text-red-200",
  expiring: "border-amber-300 bg-amber-50 text-amber-800 dark:bg-amber-950/40 dark:text-amber-200",
};

function whenLabel(iso: string, tz: string): string {
  try {
    return new Intl.DateTimeFormat(undefined, { dateStyle: "medium", timeZone: tz }).format(
      new Date(iso),
    );
  } catch {
    return iso.slice(0, 10);
  }
}

/** Contacts drawer, Documents tab: a patient's referral letters, lab reports, insurance cards and consent forms. */
export function ContactDocuments({
  contactId,
  canView,
  timezone,
}: {
  contactId: string;
  canView: boolean;
  timezone: string;
}) {
  const [view, setView] = useState<DocumentsView | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [uploadOpen, setUploadOpen] = useState(false);
  const [editing, setEditing] = useState<DocumentRow | null>(null);
  const [history, setHistory] = useState<{
    doc: DocumentRow;
    entries: AccessEntry[] | null;
  } | null>(null);
  const [pending, start] = useTransition();

  const load = useCallback(async () => {
    const r = await listContactDocuments(contactId);
    if (r.ok && r.data) {
      setView(r.data);
      setError(null);
    } else if (!r.ok) setError(r.error);
  }, [contactId]);

  useEffect(() => {
    if (!canView) return;
    setView(null);
    void load();
  }, [canView, load]);

  if (!canView)
    return (
      <p className="text-muted-foreground text-sm">
        You do not have access to patient documents. Ask an administrator for the “View patient
        documents” permission.
      </p>
    );
  if (error) return <p className="text-destructive text-sm">{error}</p>;
  if (!view)
    return <Loader2 className="text-muted-foreground size-4 animate-spin" aria-label="Loading" />;

  function open(doc: DocumentRow, mode: "view" | "download") {
    start(async () => {
      const r = await getDocumentUrl({ id: doc.id, mode });
      if (!r.ok || !r.data) toast.error(r.ok ? "Could not open the document." : r.error);
      else window.open(r.data.url, "_blank", "noopener");
    });
  }

  const unscanned = view.documents.filter((d) => d.scan_status !== "clean").length;

  return (
    <div className="flex flex-col gap-3">
      {!view.enabled && (
        <p className="rounded-md border border-amber-300 bg-amber-50 p-3 text-sm text-amber-900 dark:bg-amber-950/40 dark:text-amber-100">
          Patient documents are switched off for this workspace, so nothing can be added yet. An
          administrator turns them on under Settings, Patient documents, once the storage location
          has been approved.
        </p>
      )}
      {view.canManage && view.enabled && (
        <Button
          type="button"
          size="sm"
          className="pointer-coarse:h-11 w-fit"
          onClick={() => setUploadOpen(true)}
        >
          <Upload /> Add a document
        </Button>
      )}
      {unscanned > 0 && (
        <p className="text-xs text-amber-800 dark:text-amber-200">
          {unscanned} document{unscanned === 1 ? " has" : "s have"} not been checked by a malware
          scanner.
        </p>
      )}
      {view.documents.length === 0 ? (
        <p className="text-muted-foreground text-sm">
          No documents yet. Referral letters, lab reports, insurance cards and consent forms appear
          here.
        </p>
      ) : (
        <ul className="divide-y rounded-lg border text-sm">
          {view.documents.map((d) => (
            <li key={d.id} className="flex flex-col gap-2 px-3 py-2.5">
              <div className="flex items-start gap-2">
                {d.mime_type.startsWith("image/") ? (
                  <ImageIcon className="text-muted-foreground mt-0.5 size-4 shrink-0" aria-hidden />
                ) : (
                  <FileText className="text-muted-foreground mt-0.5 size-4 shrink-0" aria-hidden />
                )}
                <div className="min-w-0 flex-1">
                  <p className="truncate font-medium">{d.title}</p>
                  <p className="text-muted-foreground flex flex-wrap items-center gap-x-2 gap-y-1 text-xs">
                    <Badge variant="outline">{categoryLabel(d.category)}</Badge>
                    <span>{formatBytes(d.size_bytes)}</span>
                    <span>
                      added {whenLabel(d.created_at, timezone)}
                      {d.uploader ? ` by ${d.uploader}` : ""}
                    </span>
                  </p>
                  <p className="mt-1 flex flex-wrap items-center gap-1.5">
                    {d.expires_on && (
                      <Badge variant="outline" className={cn(EXPIRY_CLASS[d.expiry_state])}>
                        {d.expiry_text}
                      </Badge>
                    )}
                    {d.scan_status !== "clean" && <ScanBadge status={d.scan_status} />}
                  </p>
                </div>
              </div>
              <div className="flex flex-wrap gap-1.5">
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  className="pointer-coarse:h-11"
                  disabled={pending || d.scan_status === "infected"}
                  onClick={() => open(d, "view")}
                >
                  <Eye /> View
                </Button>
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  className="pointer-coarse:h-11"
                  disabled={pending || d.scan_status === "infected"}
                  onClick={() => open(d, "download")}
                >
                  <Download /> Download
                </Button>
                {view.canManage && (
                  <>
                    <Button
                      type="button"
                      variant="ghost"
                      size="sm"
                      className="pointer-coarse:h-11"
                      onClick={() => setEditing(d)}
                    >
                      <Pencil /> Edit
                    </Button>
                    <Button
                      type="button"
                      variant="ghost"
                      size="sm"
                      className="pointer-coarse:h-11"
                      onClick={() => {
                        setHistory({ doc: d, entries: null });
                        void listDocumentAccess(d.id).then((r) =>
                          setHistory({ doc: d, entries: r.ok ? (r.data ?? []) : [] }),
                        );
                      }}
                    >
                      <History /> Who opened it
                    </Button>
                    {d.scan_status !== "clean" && (
                      <Button
                        type="button"
                        variant="ghost"
                        size="sm"
                        className="pointer-coarse:h-11"
                        disabled={pending}
                        onClick={() =>
                          start(async () => {
                            const r = await rescanDocument(d.id);
                            if (r.ok) {
                              toast.success(r.message ?? "Scanned.");
                              void load();
                            } else toast.error(r.error);
                          })
                        }
                      >
                        Scan again
                      </Button>
                    )}
                    <Button
                      type="button"
                      variant="ghost"
                      size="sm"
                      className="pointer-coarse:h-11 text-destructive"
                      disabled={pending}
                      onClick={() => {
                        if (
                          !window.confirm(
                            "Delete this document permanently? This cannot be undone.",
                          )
                        )
                          return;
                        start(async () => {
                          const r = await deleteDocument(d.id);
                          if (r.ok) {
                            toast.success("Document deleted.");
                            void load();
                          } else toast.error(r.error);
                        });
                      }}
                    >
                      <Trash2 /> Delete
                    </Button>
                  </>
                )}
              </div>
            </li>
          ))}
        </ul>
      )}

      {view.enabled && (
        <EsignPanel contactId={contactId} timezone={timezone} onChanged={() => void load()} />
      )}

      <UploadDialog
        open={uploadOpen}
        contactId={contactId}
        onClose={() => setUploadOpen(false)}
        onDone={() => {
          setUploadOpen(false);
          void load();
        }}
      />
      <EditDialog
        doc={editing}
        onClose={() => setEditing(null)}
        onDone={() => {
          setEditing(null);
          void load();
        }}
      />
      <Dialog open={!!history} onOpenChange={(o) => !o && setHistory(null)}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>Who opened this document</DialogTitle>
            <DialogDescription>
              Every view and download is recorded: who, and when. This list shows the latest 50.
            </DialogDescription>
          </DialogHeader>
          {history?.entries === null ? (
            <Loader2 className="text-muted-foreground size-4 animate-spin" aria-label="Loading" />
          ) : history?.entries.length === 0 ? (
            <p className="text-muted-foreground text-sm">Nobody has opened it yet.</p>
          ) : (
            <ul className="divide-y text-sm">
              {history?.entries.map((e, i) => (
                <li key={i} className="flex items-center justify-between gap-2 py-1.5">
                  <span>{e.who}</span>
                  <span className="text-muted-foreground text-xs">
                    {e.action === "download" ? "downloaded" : "viewed"} {whenLabel(e.at, timezone)}{" "}
                    {new Date(e.at).toLocaleTimeString([], {
                      hour: "2-digit",
                      minute: "2-digit",
                      timeZone: timezone,
                    })}
                  </span>
                </li>
              ))}
            </ul>
          )}
        </DialogContent>
      </Dialog>
    </div>
  );
}

function CategorySelect({
  value,
  onChange,
  id,
}: {
  value: DocumentCategory;
  onChange: (v: DocumentCategory) => void;
  id: string;
}) {
  return (
    <select
      id={id}
      value={value}
      onChange={(e) => onChange(e.target.value as DocumentCategory)}
      className="border-input bg-background pointer-coarse:h-11 h-9 rounded-md border px-2 text-sm"
    >
      {DOCUMENT_CATEGORIES.map((c) => (
        <option key={c.key} value={c.key}>
          {c.label}
        </option>
      ))}
    </select>
  );
}

function UploadDialog({
  open,
  contactId,
  onClose,
  onDone,
}: {
  open: boolean;
  contactId: string;
  onClose: () => void;
  onDone: () => void;
}) {
  const [file, setFile] = useState<File | null>(null);
  const [title, setTitle] = useState("");
  const [category, setCategory] = useState<DocumentCategory>("other");
  const [expires, setExpires] = useState("");
  const [edit, setEdit] = useState<ImageEdit | null>(null);
  const [adjusting, setAdjusting] = useState(false);
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  const fileInput = useRef<HTMLInputElement>(null);
  const cameraInput = useRef<HTMLInputElement>(null);
  const isPhoto = !!file && CONVERTIBLE_IMAGE.test(file.type);

  useEffect(() => {
    if (!open) return;
    setFile(null);
    setTitle("");
    setCategory("other");
    setExpires("");
    setEdit(null);
    setProblem(null);
  }, [open]);

  function pick(f: File | undefined, fromCamera = false) {
    if (!f) return;
    setProblem(null);
    setEdit(null);
    if (!CONVERTIBLE_IMAGE.test(f.type)) {
      const check = validateMedia({ mime: f.type, size: f.size }, "patient_document");
      if (!check.ok) {
        setProblem(check.message);
        return;
      }
    }
    setFile(f);
    if (!title) setTitle(baseName(f.name).slice(0, 120));
    if (fromCamera) setAdjusting(true);
  }

  async function submit() {
    if (!file) return;
    setBusy(true);
    setProblem(null);
    let documentId: string | null = null;
    try {
      const [{ prepareImage }, { putToSignedUrl }] = await Promise.all([
        import("@/lib/media/client-image"),
        import("@/lib/media/client-upload"),
      ]);
      let blob: Blob = file;
      let mime = file.type;
      if (isPhoto) {
        const prepared = await prepareImage(file, {
          rotation: edit?.rotation,
          insets: edit?.insets,
          maxBytes: 8 * 1024 * 1024,
          maxEdge: 2600,
        });
        if (!prepared)
          throw new Error("That photo could not be made small enough. Try a lower resolution.");
        blob = prepared.blob;
        mime = prepared.mime;
      }
      if (blob.size > PATIENT_DOCUMENT_MAX_BYTES) throw new Error("That file is too large.");
      const prep = await prepareDocumentUpload({
        contact_id: contactId,
        title,
        category,
        expires_on: expires || null,
        mime_type: mime || "application/octet-stream",
        size: blob.size,
      });
      if (!prep.ok || !prep.data)
        throw new Error(prep.ok ? "Could not start the upload." : prep.error);
      documentId = prep.data.document_id;
      const err = await putToSignedUrl(
        DOCUMENT_BUCKET,
        prep.data.upload.path,
        prep.data.upload.token,
        blob,
        mime,
      );
      if (err) throw new Error(err);
      const done = await finalizeDocumentUpload(documentId);
      if (!done.ok) {
        documentId = null; // already removed by the server
        throw new Error(done.error);
      }
      if (done.message && done.message !== "Document saved.") toast.warning(done.message);
      else toast.success("Document saved.");
      onDone();
    } catch (e) {
      if (documentId) await abandonDocumentUpload(documentId);
      setProblem(e instanceof Error ? e.message : "The upload failed.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <>
      <Dialog open={open && !adjusting} onOpenChange={(o) => !o && !busy && onClose()}>
        <DialogContent className="max-h-[92dvh] overflow-y-auto sm:max-w-md">
          <DialogHeader>
            <DialogTitle>Add a document</DialogTitle>
            <DialogDescription>
              Referral letters, lab reports, insurance cards and consent forms. PDF, a photo or a
              Word file, up to 25 MB.
            </DialogDescription>
          </DialogHeader>
          <div className="grid gap-3">
            <div className="flex flex-wrap gap-2">
              <input
                ref={fileInput}
                type="file"
                className="hidden"
                accept="application/pdf,image/*,.doc,.docx"
                onChange={(e) => {
                  pick(e.target.files?.[0]);
                  e.target.value = "";
                }}
              />
              <input
                ref={cameraInput}
                type="file"
                className="hidden"
                accept="image/*"
                capture="environment"
                onChange={(e) => {
                  pick(e.target.files?.[0], true);
                  e.target.value = "";
                }}
              />
              <Button
                type="button"
                variant="outline"
                className="pointer-coarse:h-11"
                onClick={() => fileInput.current?.click()}
              >
                <Upload /> Choose a file
              </Button>
              <Button
                type="button"
                variant="outline"
                className="pointer-coarse:h-11"
                onClick={() => cameraInput.current?.click()}
              >
                <Camera /> Take a photo
              </Button>
            </div>
            {file && (
              <p className="text-muted-foreground flex flex-wrap items-center gap-2 text-xs">
                <span className="truncate">Selected: {formatBytes(file.size)}</span>
                {isPhoto && (
                  <Button
                    type="button"
                    variant="ghost"
                    size="sm"
                    onClick={() => setAdjusting(true)}
                  >
                    Turn or trim{edit ? " (adjusted)" : ""}
                  </Button>
                )}
              </p>
            )}
            <div className="grid gap-1.5">
              <Label htmlFor="doc-title">Title</Label>
              <Input
                id="doc-title"
                value={title}
                onChange={(e) => setTitle(e.target.value)}
                maxLength={120}
                className="pointer-coarse:h-11"
              />
              <span className="text-muted-foreground text-xs">
                Anyone who can open this patient&apos;s documents sees the title. It is not shown in
                alerts.
              </span>
            </div>
            <div className="grid gap-1.5">
              <Label htmlFor="doc-category">Category</Label>
              <CategorySelect id="doc-category" value={category} onChange={setCategory} />
            </div>
            <div className="grid gap-1.5">
              <Label htmlFor="doc-expiry">
                Expiry date {suggestsExpiry(category) ? "(recommended)" : "(optional)"}
              </Label>
              <Input
                id="doc-expiry"
                type="date"
                value={expires}
                onChange={(e) => setExpires(e.target.value)}
                className="pointer-coarse:h-11"
              />
              {suggestsExpiry(category) && (
                <span className="text-muted-foreground text-xs">
                  The team is reminded before an insurance card expires.
                </span>
              )}
            </div>
            {problem && <p className="text-destructive text-sm">{problem}</p>}
          </div>
          <DialogFooter>
            <Button type="button" variant="ghost" onClick={onClose} disabled={busy}>
              Cancel
            </Button>
            <Button
              type="button"
              onClick={() => void submit()}
              disabled={busy || !file || !title.trim()}
            >
              {busy && <Loader2 className="animate-spin" />} Save document
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
      <ImageEditorDialog
        file={isPhoto ? file : null}
        open={open && adjusting && isPhoto}
        onCancel={() => setAdjusting(false)}
        onDone={(e) => {
          setEdit(e);
          setAdjusting(false);
        }}
      />
    </>
  );
}

function EditDialog({
  doc,
  onClose,
  onDone,
}: {
  doc: DocumentRow | null;
  onClose: () => void;
  onDone: () => void;
}) {
  const [title, setTitle] = useState("");
  const [category, setCategory] = useState<DocumentCategory>("other");
  const [expires, setExpires] = useState("");
  const [pending, start] = useTransition();

  useEffect(() => {
    if (!doc) return;
    setTitle(doc.title);
    setCategory(doc.category);
    setExpires(doc.expires_on ?? "");
  }, [doc]);

  return (
    <Dialog open={!!doc} onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>Edit document</DialogTitle>
          <DialogDescription>Change the title, the category or the expiry date.</DialogDescription>
        </DialogHeader>
        <div className="grid gap-3">
          <div className="grid gap-1.5">
            <Label htmlFor="edit-title">Title</Label>
            <Input
              id="edit-title"
              value={title}
              onChange={(e) => setTitle(e.target.value)}
              maxLength={120}
              className="pointer-coarse:h-11"
            />
          </div>
          <div className="grid gap-1.5">
            <Label htmlFor="edit-category">Category</Label>
            <CategorySelect id="edit-category" value={category} onChange={setCategory} />
          </div>
          <div className="grid gap-1.5">
            <Label htmlFor="edit-expiry">Expiry date</Label>
            <Input
              id="edit-expiry"
              type="date"
              value={expires}
              onChange={(e) => setExpires(e.target.value)}
              className="pointer-coarse:h-11"
            />
          </div>
        </div>
        <DialogFooter>
          <Button type="button" variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button
            type="button"
            disabled={pending || !title.trim() || !doc}
            onClick={() =>
              doc &&
              start(async () => {
                const r = await updateDocument({
                  id: doc.id,
                  title,
                  category,
                  expires_on: expires || null,
                });
                if (r.ok) {
                  toast.success(r.message ?? "Saved.");
                  onDone();
                } else toast.error(r.error);
              })
            }
          >
            {pending && <Loader2 className="animate-spin" />} Save
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
