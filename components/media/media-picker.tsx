"use client";

import { useEffect, useState } from "react";
import { FileText, Film, Loader2, Search } from "lucide-react";
import Link from "next/link";

import { listPickerAssets } from "@/app/(app)/media/actions";
import { ScanBadge } from "@/components/media/scan-badge";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { formatBytes, type MediaKind } from "@/lib/media/limits";
import type { LibraryAsset } from "@/lib/media/library";
import { cn } from "@/lib/utils";

/**
 * "Choose from the Media Library" dialog, used by the template builder (header media), campaigns, quick replies
 * and the conversation composer. `mimes` narrows the list to what the destination accepts (for a template header
 * that is what Meta allows), so a file that would be refused later is not offered at all.
 */
export function MediaPicker({
  open,
  onOpenChange,
  onPick,
  kind = null,
  mimes = null,
  title = "Media Library",
  canUpload = false,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onPick: (asset: LibraryAsset) => void;
  kind?: MediaKind | null;
  mimes?: readonly string[] | null;
  title?: string;
  canUpload?: boolean;
}) {
  const [q, setQ] = useState("");
  const [assets, setAssets] = useState<LibraryAsset[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const mimeKey = mimes?.join(",") ?? "";

  useEffect(() => {
    if (!open) return;
    let alive = true;
    setAssets(null);
    setError(null);
    const handle = setTimeout(
      () => {
        listPickerAssets({ kind, q: q || null, mimes: mimeKey ? mimeKey.split(",") : null }).then(
          (r) => {
            if (!alive) return;
            if (r.ok) setAssets(r.data ?? []);
            else setError(r.error);
          },
        );
      },
      q ? 250 : 0,
    );
    return () => {
      alive = false;
      clearTimeout(handle);
    };
  }, [open, kind, q, mimeKey]);

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[90dvh] gap-3 overflow-hidden sm:max-w-2xl">
        <DialogHeader>
          <DialogTitle>{title}</DialogTitle>
          <DialogDescription>
            {kind ? `Showing ${kind}s` : "Images, PDFs and videos"} the team has uploaded.
          </DialogDescription>
        </DialogHeader>
        <div className="relative">
          <Search className="text-muted-foreground absolute top-2.5 left-2.5 size-4" aria-hidden />
          <Input
            value={q}
            onChange={(e) => setQ(e.target.value)}
            placeholder="Search by name or tag"
            className="pl-8"
            aria-label="Search the library"
          />
        </div>
        <div className="min-h-40 overflow-y-auto">
          {error ? (
            <p className="text-destructive text-sm">{error}</p>
          ) : assets === null ? (
            <Loader2
              className="text-muted-foreground mx-auto my-10 size-5 animate-spin"
              aria-label="Loading"
            />
          ) : assets.length === 0 ? (
            <div className="text-muted-foreground py-10 text-center text-sm">
              Nothing here yet.
              {canUpload && (
                <>
                  {" "}
                  <Link href="/media" className="text-primary underline">
                    Upload files to the library
                  </Link>
                  .
                </>
              )}
            </div>
          ) : (
            <ul className="grid grid-cols-2 gap-2 sm:grid-cols-3">
              {assets.map((a) => (
                <li key={a.id}>
                  <button
                    type="button"
                    onClick={() => {
                      onPick(a);
                      onOpenChange(false);
                    }}
                    className={cn(
                      "hover:bg-accent focus-visible:ring-ring flex w-full flex-col gap-1 rounded-md border p-2 text-left outline-none focus-visible:ring-2",
                    )}
                  >
                    <div className="bg-muted flex aspect-square items-center justify-center overflow-hidden rounded">
                      {a.thumb_url ? (
                        // eslint-disable-next-line @next/next/no-img-element -- signed, short-lived storage URL
                        <img
                          src={a.thumb_url}
                          alt=""
                          loading="lazy"
                          className="size-full object-cover"
                        />
                      ) : a.kind === "video" ? (
                        <Film className="text-muted-foreground size-8" aria-hidden />
                      ) : (
                        <FileText className="text-muted-foreground size-8" aria-hidden />
                      )}
                    </div>
                    <span className="truncate text-sm font-medium">{a.name}</span>
                    <span className="text-muted-foreground flex items-center justify-between gap-1 text-xs">
                      {formatBytes(a.size_bytes)}
                      {a.scan_status !== "clean" && <ScanBadge status={a.scan_status} />}
                    </span>
                  </button>
                </li>
              ))}
            </ul>
          )}
        </div>
        <div className="flex justify-end">
          <Button type="button" variant="ghost" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}
