"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useCallback, useEffect, useRef, useState, useTransition } from "react";
import {
  Camera,
  FileText,
  Film,
  FolderPlus,
  Loader2,
  Pencil,
  Search,
  Trash2,
  Upload,
} from "lucide-react";
import { toast } from "sonner";

import dynamic from "next/dynamic";

import type { ImageEdit } from "@/components/media/image-editor";
import { ScanBadge } from "@/components/media/scan-badge";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
} from "@/components/ui/sheet";
import { parseTags } from "@/lib/documents/schema";
import { baseName, CONVERTIBLE_IMAGE } from "@/lib/media/upload-names";
import { formatBytes, validateMedia, WHATSAPP_LIMITS } from "@/lib/media/limits";
import { LIBRARY_BUCKET } from "@/lib/media/paths";
import type { AssetUsage, LibraryAsset } from "@/lib/media/library";
import { cn } from "@/lib/utils";

import {
  abandonLibraryUpload,
  createFolder,
  deleteAsset,
  deleteFolder,
  finalizeLibraryUpload,
  getAssetUrl,
  getAssetUsage,
  prepareLibraryUpload,
  renameFolder,
  rescanAsset,
  updateAsset,
} from "./actions";

const ImageEditorDialog = dynamic(
  () => import("@/components/media/image-editor").then((m) => m.ImageEditorDialog),
  { ssr: false },
);
const Lightbox = dynamic(() => import("@/components/media/lightbox").then((m) => m.Lightbox), {
  ssr: false,
});

type Filters = { folder: string; kind: string; tag: string; q: string };
type Folder = { id: string; name: string };

function href(f: Partial<Filters> & { page?: number }, base: Filters): string {
  const merged = { ...base, page: undefined as number | undefined, ...f };
  const p = new URLSearchParams();
  for (const [k, v] of Object.entries(merged)) if (v) p.set(k, String(v));
  const s = p.toString();
  return s ? `/media?${s}` : "/media";
}

function KindIcon({ kind, className }: { kind: string; className?: string }) {
  return kind === "video" ? (
    <Film className={className} aria-hidden />
  ) : (
    <FileText className={className} aria-hidden />
  );
}

type Job = { id: number; label: string; state: "working" | "done" | "error"; note?: string };

export function MediaLibrary({
  assets,
  total,
  page,
  pageSize,
  folders,
  tags,
  filters,
  canManage,
  scanner,
  totalBytes,
}: {
  assets: LibraryAsset[];
  total: number;
  page: number;
  pageSize: number;
  folders: Folder[];
  tags: string[];
  filters: Filters;
  canManage: boolean;
  scanner: string;
  totalBytes: number;
}) {
  const router = useRouter();
  const [open, setOpen] = useState<LibraryAsset | null>(null);
  const [jobs, setJobs] = useState<Job[]>([]);
  const [editing, setEditing] = useState<{
    file: File;
    resolve: (e: ImageEdit | null) => void;
  } | null>(null);
  const [lightbox, setLightbox] = useState<number | null>(null);
  const [pendingFolder, startFolder] = useTransition();
  const fileInput = useRef<HTMLInputElement>(null);
  const cameraInput = useRef<HTMLInputElement>(null);
  const jobId = useRef(0);
  const currentFolder = folders.find((f) => f.id === filters.folder) ?? null;
  const images = assets.filter((a) => a.kind === "image");

  const setJob = useCallback((id: number, patch: Partial<Job>) => {
    setJobs((js) => js.map((j) => (j.id === id ? { ...j, ...patch } : j)));
  }, []);

  /** Ask the person to turn or trim one photo; resolves null if they cancel. */
  const review = useCallback(
    (file: File) => new Promise<ImageEdit | null>((resolve) => setEditing({ file, resolve })),
    [],
  );

  const uploadOne = useCallback(
    async (file: File, opts: { review: boolean }) => {
      const id = ++jobId.current;
      setJobs((js) => [...js.slice(-5), { id, label: baseName(file.name), state: "working" }]);
      let assetId: string | null = null;
      try {
        // Canvas and storage code is loaded only when something is actually uploaded.
        const [{ makeThumbnail, prepareImage }, { putToSignedUrl }] = await Promise.all([
          import("@/lib/media/client-image"),
          import("@/lib/media/client-upload"),
        ]);
        let blob: Blob = file;
        let mime = file.type;
        let width: number | null = null;
        let height: number | null = null;
        let thumb: Blob | null = null;
        if (/^image\/gif$/i.test(file.type))
          throw new Error("WhatsApp does not support GIF pictures. Use a video instead.");
        if (CONVERTIBLE_IMAGE.test(file.type)) {
          let edit: ImageEdit | null = {
            rotation: 0,
            insets: { top: 0, right: 0, bottom: 0, left: 0 },
          };
          if (opts.review) {
            edit = await review(file);
            if (!edit) {
              setJob(id, { state: "error", note: "Cancelled" });
              return;
            }
          }
          const prepared = await prepareImage(file, {
            rotation: edit.rotation,
            insets: edit.insets,
            maxBytes: WHATSAPP_LIMITS.image.maxBytes,
            maxEdge: 2048,
          });
          if (!prepared)
            throw new Error(
              "That picture is too large to fit WhatsApp's 5 MB limit, even after compressing.",
            );
          blob = prepared.blob;
          mime = prepared.mime;
          width = prepared.width;
          height = prepared.height;
          thumb = await makeThumbnail(blob).catch(() => null);
        } else {
          const check = validateMedia({ mime: file.type, size: file.size }, "library");
          if (!check.ok) throw new Error(check.message);
        }
        const prep = await prepareLibraryUpload({
          name: baseName(file.name),
          mime_type: mime,
          size: blob.size,
          original_size: file.size,
          width,
          height,
          folder_id: currentFolder?.id ?? null,
          tags: filters.tag ? [filters.tag] : [],
          with_thumb: !!thumb,
        });
        if (!prep.ok || !prep.data)
          throw new Error(prep.ok ? "Could not start the upload." : prep.error);
        assetId = prep.data.asset_id;
        const err = await putToSignedUrl(
          LIBRARY_BUCKET,
          prep.data.upload.path,
          prep.data.upload.token,
          blob,
          mime,
        );
        if (err) throw new Error(err);
        if (thumb && prep.data.thumb)
          await putToSignedUrl(
            LIBRARY_BUCKET,
            prep.data.thumb.path,
            prep.data.thumb.token,
            thumb,
            "image/jpeg",
          );
        const done = await finalizeLibraryUpload(assetId);
        if (!done.ok) {
          assetId = null; // the server already removed it
          throw new Error(done.error);
        }
        setJob(id, {
          state: "done",
          note:
            file.size > blob.size
              ? `${formatBytes(file.size)} → ${formatBytes(blob.size)}`
              : undefined,
        });
        if (done.message && !/^Uploaded\.$/.test(done.message)) toast.warning(done.message);
      } catch (e) {
        if (assetId) await abandonLibraryUpload(assetId);
        setJob(id, { state: "error", note: e instanceof Error ? e.message : "Upload failed" });
      }
    },
    [currentFolder?.id, filters.tag, review, setJob],
  );

  const uploadMany = useCallback(
    async (files: File[], reviewFirst = false) => {
      for (const f of files) await uploadOne(f, { review: reviewFirst && files.length === 1 });
      router.refresh();
    },
    [router, uploadOne],
  );

  // Clear finished rows after a while.
  useEffect(() => {
    if (jobs.length === 0 || jobs.some((j) => j.state === "working")) return;
    const t = setTimeout(() => setJobs([]), 12_000);
    return () => clearTimeout(t);
  }, [jobs]);

  const unscanned = assets.filter((a) => a.scan_status !== "clean").length;
  const pages = Math.max(1, Math.ceil(total / pageSize));

  return (
    <div
      className="flex flex-col gap-4"
      onDragOver={(e) => canManage && e.preventDefault()}
      onDrop={(e) => {
        if (!canManage) return;
        e.preventDefault();
        void uploadMany([...e.dataTransfer.files]);
      }}
    >
      {/* Folders: a chip row on phones, same links on desktop */}
      <nav aria-label="Folders" className="flex flex-wrap items-center gap-1.5">
        {[{ id: "", name: "All files" }, { id: "none", name: "Unfiled" }, ...folders].map((f) => (
          <Link
            key={f.id || "all"}
            href={href({ folder: f.id }, filters)}
            className={cn(
              "pointer-coarse:py-2.5 rounded-full border px-3 py-1 text-sm",
              filters.folder === f.id
                ? "bg-primary text-primary-foreground border-primary"
                : "hover:bg-accent",
            )}
          >
            {f.name}
          </Link>
        ))}
        {canManage && (
          <Button
            type="button"
            variant="ghost"
            size="sm"
            className="pointer-coarse:h-11"
            disabled={pendingFolder}
            onClick={() => {
              const name = window.prompt("Name the new folder");
              if (!name) return;
              startFolder(async () => {
                const r = await createFolder(name);
                if (!r.ok) toast.error(r.error);
                else router.refresh();
              });
            }}
          >
            <FolderPlus /> New folder
          </Button>
        )}
        {canManage && currentFolder && (
          <>
            <Button
              type="button"
              variant="ghost"
              size="sm"
              className="pointer-coarse:h-11"
              onClick={() => {
                const name = window.prompt("Rename the folder", currentFolder.name);
                if (!name || name === currentFolder.name) return;
                startFolder(async () => {
                  const r = await renameFolder(currentFolder.id, name);
                  if (!r.ok) toast.error(r.error);
                  else router.refresh();
                });
              }}
            >
              <Pencil /> Rename
            </Button>
            <Button
              type="button"
              variant="ghost"
              size="sm"
              className="pointer-coarse:h-11"
              onClick={() => {
                if (
                  !window.confirm(
                    `Delete the folder "${currentFolder.name}"? Its files are kept and become unfiled.`,
                  )
                )
                  return;
                startFolder(async () => {
                  const r = await deleteFolder(currentFolder.id);
                  if (!r.ok) toast.error(r.error);
                  else {
                    toast.success(r.message ?? "Folder deleted.");
                    router.push(href({ folder: "" }, filters));
                  }
                });
              }}
            >
              <Trash2 /> Delete folder
            </Button>
          </>
        )}
      </nav>

      <div className="flex flex-wrap items-end gap-2">
        <form action="/media" className="flex flex-1 flex-wrap items-end gap-2">
          {filters.folder && <input type="hidden" name="folder" value={filters.folder} />}
          <div className="relative min-w-48 flex-1">
            <Search
              className="text-muted-foreground absolute top-2.5 left-2.5 size-4"
              aria-hidden
            />
            <Input
              name="q"
              defaultValue={filters.q}
              placeholder="Search by name or tag"
              className="pointer-coarse:h-11 pl-8"
              aria-label="Search"
            />
          </div>
          <select
            name="kind"
            defaultValue={filters.kind}
            aria-label="Type"
            className="border-input bg-background pointer-coarse:h-11 h-9 rounded-md border px-2 text-sm"
          >
            <option value="">All types</option>
            <option value="image">Images</option>
            <option value="video">Videos</option>
            <option value="document">Documents</option>
          </select>
          {tags.length > 0 && (
            <select
              name="tag"
              defaultValue={filters.tag}
              aria-label="Tag"
              className="border-input bg-background pointer-coarse:h-11 h-9 rounded-md border px-2 text-sm"
            >
              <option value="">Any tag</option>
              {tags.map((t) => (
                <option key={t} value={t}>
                  {t}
                </option>
              ))}
            </select>
          )}
          <Button type="submit" variant="outline" className="pointer-coarse:h-11">
            Search
          </Button>
        </form>
        {canManage && (
          <div className="flex gap-2">
            <input
              ref={fileInput}
              type="file"
              multiple
              className="hidden"
              accept="image/*,video/mp4,video/3gpp,application/pdf,.doc,.docx,.xls,.xlsx,.ppt,.pptx,.txt"
              onChange={(e) => {
                const files = [...(e.target.files ?? [])];
                e.target.value = "";
                if (files.length) void uploadMany(files);
              }}
            />
            <input
              ref={cameraInput}
              type="file"
              accept="image/*"
              capture="environment"
              className="hidden"
              onChange={(e) => {
                const files = [...(e.target.files ?? [])];
                e.target.value = "";
                if (files.length) void uploadMany(files, true);
              }}
            />
            <Button
              type="button"
              className="pointer-coarse:h-11"
              onClick={() => fileInput.current?.click()}
            >
              <Upload /> Upload
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
        )}
      </div>

      {jobs.length > 0 && (
        <ul className="rounded-md border p-2 text-sm" aria-live="polite">
          {jobs.map((j) => (
            <li key={j.id} className="flex items-center gap-2 py-0.5">
              {j.state === "working" ? (
                <Loader2 className="size-3.5 animate-spin" aria-hidden />
              ) : j.state === "done" ? (
                <span className="text-emerald-600" aria-hidden>
                  ✓
                </span>
              ) : (
                <span className="text-destructive" aria-hidden>
                  ✕
                </span>
              )}
              <span className="truncate">{j.label}</span>
              {j.note && (
                <span
                  className={cn(
                    "text-xs",
                    j.state === "error" ? "text-destructive" : "text-muted-foreground",
                  )}
                >
                  {j.note}
                </span>
              )}
            </li>
          ))}
        </ul>
      )}

      <p className="text-muted-foreground text-xs">
        {total} file{total === 1 ? "" : "s"}
        {filters.q || filters.kind || filters.tag || filters.folder ? " in this view" : ""} ·{" "}
        {formatBytes(totalBytes)} used in all · malware scanner: {scanner}
        {unscanned > 0 && (
          <span className="ml-1 text-amber-700 dark:text-amber-300">
            · {unscanned} on this page not scanned
          </span>
        )}
      </p>

      {assets.length === 0 ? (
        <div className="text-muted-foreground rounded-lg border border-dashed p-10 text-center text-sm">
          {filters.q || filters.kind || filters.tag ? "No files match." : "No files yet."}
          {canManage ? " Upload images, PDFs or videos, or drop files here." : ""}
        </div>
      ) : (
        <ul className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-5 xl:grid-cols-6">
          {assets.map((a) => (
            <li key={a.id}>
              <button
                type="button"
                onClick={() => setOpen(a)}
                className="hover:bg-accent focus-visible:ring-ring flex w-full flex-col gap-1.5 rounded-lg border p-2 text-left outline-none focus-visible:ring-2"
              >
                <div className="bg-muted flex aspect-square items-center justify-center overflow-hidden rounded-md">
                  {a.thumb_url ? (
                    // eslint-disable-next-line @next/next/no-img-element -- signed, short-lived storage URL
                    <img
                      src={a.thumb_url}
                      alt=""
                      loading="lazy"
                      decoding="async"
                      className="size-full object-cover"
                    />
                  ) : (
                    <KindIcon kind={a.kind} className="text-muted-foreground size-9" />
                  )}
                </div>
                <span className="truncate text-sm font-medium">{a.name}</span>
                <span className="text-muted-foreground flex flex-wrap items-center gap-1 text-xs">
                  {formatBytes(a.size_bytes)}
                  {a.original_size_bytes && a.original_size_bytes > a.size_bytes * 1.1 && (
                    <span title="Compressed on upload">
                      (was {formatBytes(a.original_size_bytes)})
                    </span>
                  )}
                </span>
                {a.scan_status !== "clean" && <ScanBadge status={a.scan_status} />}
              </button>
            </li>
          ))}
        </ul>
      )}

      {pages > 1 && (
        <div className="flex items-center justify-between text-sm">
          {page > 1 ? (
            <Link className="underline" href={href({ page: page - 1 }, filters)}>
              Previous
            </Link>
          ) : (
            <span />
          )}
          <span className="text-muted-foreground">
            Page {page} of {pages}
          </span>
          {page < pages ? (
            <Link className="underline" href={href({ page: page + 1 }, filters)}>
              Next
            </Link>
          ) : (
            <span />
          )}
        </div>
      )}

      <AssetSheet
        asset={open}
        folders={folders}
        canManage={canManage}
        onClose={() => setOpen(null)}
        onChanged={() => {
          setOpen(null);
          router.refresh();
        }}
        onZoom={(a) => {
          const i = images.findIndex((x) => x.id === a.id);
          if (i >= 0) setLightbox(i);
        }}
      />
      <Lightbox
        items={images.map((a) => ({ id: a.id, label: a.name }))}
        index={lightbox}
        onIndexChange={setLightbox}
        onClose={() => setLightbox(null)}
        loadUrl={async (id) => {
          const r = await getAssetUrl(id);
          return r.ok && r.data ? r.data.url : null;
        }}
      />
      <ImageEditorDialog
        file={editing?.file ?? null}
        open={!!editing}
        onCancel={() => {
          editing?.resolve(null);
          setEditing(null);
        }}
        onDone={(edit) => {
          editing?.resolve(edit);
          setEditing(null);
        }}
      />
    </div>
  );
}

function AssetSheet({
  asset,
  folders,
  canManage,
  onClose,
  onChanged,
  onZoom,
}: {
  asset: LibraryAsset | null;
  folders: Folder[];
  canManage: boolean;
  onClose: () => void;
  onChanged: () => void;
  onZoom: (a: LibraryAsset) => void;
}) {
  const [name, setName] = useState("");
  const [folder, setFolder] = useState("");
  const [tagText, setTagText] = useState("");
  const [usage, setUsage] = useState<AssetUsage[] | null>(null);
  const [pending, start] = useTransition();

  useEffect(() => {
    if (!asset) return;
    setName(asset.name);
    setFolder(asset.folder_id ?? "");
    setTagText(asset.tags.join(", "));
    setUsage(null);
    let alive = true;
    getAssetUsage(asset.id).then((r) => alive && setUsage(r.ok ? (r.data ?? []) : []));
    return () => {
      alive = false;
    };
  }, [asset]);

  const blocking = (usage ?? []).filter((u) => u.blocking);

  function openFile(download: boolean) {
    if (!asset) return;
    start(async () => {
      const r = await getAssetUrl(asset.id, download);
      if (!r.ok || !r.data) toast.error(r.ok ? "Could not open the file." : r.error);
      else window.open(r.data.url, "_blank", "noopener");
    });
  }

  return (
    <Sheet open={!!asset} onOpenChange={(o) => !o && onClose()}>
      <SheetContent className="w-full overflow-y-auto sm:max-w-md">
        {asset && (
          <>
            <SheetHeader>
              <SheetTitle className="truncate pr-6">{asset.name}</SheetTitle>
              <SheetDescription>
                {asset.kind} · {formatBytes(asset.size_bytes)}
                {asset.width && asset.height ? ` · ${asset.width}×${asset.height}` : ""}
                {asset.uploader ? ` · added by ${asset.uploader}` : ""}
              </SheetDescription>
            </SheetHeader>
            <div className="flex flex-col gap-4 px-4 pb-4">
              <div className="bg-muted flex aspect-video items-center justify-center overflow-hidden rounded-md">
                {asset.thumb_url ? (
                  <button
                    type="button"
                    className="size-full"
                    onClick={() => onZoom(asset)}
                    aria-label="Enlarge"
                  >
                    {/* eslint-disable-next-line @next/next/no-img-element -- signed, short-lived storage URL */}
                    <img
                      src={asset.thumb_url}
                      alt={asset.name}
                      className="size-full object-contain"
                    />
                  </button>
                ) : (
                  <KindIcon kind={asset.kind} className="text-muted-foreground size-12" />
                )}
              </div>
              <ScanBadge status={asset.scan_status} className="w-fit" />
              <div className="flex flex-wrap gap-2">
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  className="pointer-coarse:h-11"
                  disabled={pending || asset.scan_status === "infected"}
                  onClick={() => openFile(false)}
                >
                  Open
                </Button>
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  className="pointer-coarse:h-11"
                  disabled={pending || asset.scan_status === "infected"}
                  onClick={() => openFile(true)}
                >
                  Download
                </Button>
                {canManage && asset.scan_status !== "clean" && (
                  <Button
                    type="button"
                    variant="outline"
                    size="sm"
                    className="pointer-coarse:h-11"
                    disabled={pending}
                    onClick={() =>
                      start(async () => {
                        const r = await rescanAsset(asset.id);
                        if (r.ok) {
                          toast.success(r.message ?? "Scanned.");
                          onChanged();
                        } else toast.error(r.error);
                      })
                    }
                  >
                    Scan again
                  </Button>
                )}
              </div>

              {canManage && (
                <form
                  className="grid gap-3"
                  onSubmit={(e) => {
                    e.preventDefault();
                    start(async () => {
                      const r = await updateAsset({
                        id: asset.id,
                        name,
                        folder_id: folder || null,
                        tags: parseTags(tagText),
                      });
                      if (r.ok) {
                        toast.success("Saved.");
                        onChanged();
                      } else toast.error(r.error);
                    });
                  }}
                >
                  <div className="grid gap-1.5">
                    <Label htmlFor="asset-name">Name</Label>
                    <Input
                      id="asset-name"
                      value={name}
                      onChange={(e) => setName(e.target.value)}
                      maxLength={120}
                      className="pointer-coarse:h-11"
                    />
                  </div>
                  <div className="grid gap-1.5">
                    <Label htmlFor="asset-folder">Folder</Label>
                    <select
                      id="asset-folder"
                      value={folder}
                      onChange={(e) => setFolder(e.target.value)}
                      className="border-input bg-background pointer-coarse:h-11 h-9 rounded-md border px-2 text-sm"
                    >
                      <option value="">Unfiled</option>
                      {folders.map((f) => (
                        <option key={f.id} value={f.id}>
                          {f.name}
                        </option>
                      ))}
                    </select>
                  </div>
                  <div className="grid gap-1.5">
                    <Label htmlFor="asset-tags">Tags</Label>
                    <Input
                      id="asset-tags"
                      value={tagText}
                      onChange={(e) => setTagText(e.target.value)}
                      placeholder="offers, ramadan"
                      className="pointer-coarse:h-11"
                    />
                    <span className="text-muted-foreground text-xs">
                      Separate with commas. Up to 10.
                    </span>
                  </div>
                  <Button
                    type="submit"
                    disabled={pending || !name.trim()}
                    className="pointer-coarse:h-11"
                  >
                    {pending && <Loader2 className="animate-spin" />} Save
                  </Button>
                </form>
              )}

              <section aria-label="Where this file is used" className="grid gap-1.5">
                <h3 className="text-sm font-medium">Where it is used</h3>
                {usage === null ? (
                  <Loader2
                    className="text-muted-foreground size-4 animate-spin"
                    aria-label="Loading"
                  />
                ) : usage.length === 0 ? (
                  <p className="text-muted-foreground text-sm">Not used anywhere yet.</p>
                ) : (
                  <ul className="divide-y rounded-md border text-sm">
                    {usage.map((u) => (
                      <li
                        key={`${u.kind}-${u.ref_id}`}
                        className="flex items-center justify-between gap-2 px-3 py-2"
                      >
                        <span className="min-w-0 truncate">
                          <span className="text-muted-foreground mr-1.5 text-xs uppercase">
                            {u.kind === "quick_reply" ? "quick reply" : u.kind}
                          </span>
                          {u.ref_name}
                        </span>
                        <span className="flex items-center gap-1.5">
                          {u.ref_status && (
                            <span className="text-muted-foreground text-xs">
                              {u.ref_status.toLowerCase()}
                            </span>
                          )}
                          {u.blocking && <Badge variant="outline">live</Badge>}
                        </span>
                      </li>
                    ))}
                  </ul>
                )}
              </section>

              {canManage && (
                <div className="grid gap-1.5 border-t pt-4">
                  <Button
                    type="button"
                    variant="destructive"
                    disabled={pending || blocking.length > 0}
                    className="pointer-coarse:h-11"
                    onClick={() => {
                      if (!window.confirm("Delete this file for everyone? This cannot be undone."))
                        return;
                      start(async () => {
                        const r = await deleteAsset(asset.id);
                        if (r.ok) {
                          toast.success("File deleted.");
                          onChanged();
                        } else toast.error(r.error);
                      });
                    }}
                  >
                    <Trash2 /> Delete
                  </Button>
                  {blocking.length > 0 && (
                    <p className="text-muted-foreground text-xs">
                      A live template, campaign or quick reply uses this file. Remove it there
                      first, or wait for the campaign to finish.
                    </p>
                  )}
                </div>
              )}
            </div>
          </>
        )}
      </SheetContent>
    </Sheet>
  );
}
