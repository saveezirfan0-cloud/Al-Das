"use client";

import { useEffect, useState } from "react";
import { FileText, Loader2 } from "lucide-react";

import { signedMediaUrl } from "./actions";

const cache = new Map<string, string>();

export function useSignedUrl(path: string | null) {
  const [url, setUrl] = useState<string | null>(path ? (cache.get(path) ?? null) : null);
  const [error, setError] = useState(false);
  useEffect(() => {
    if (!path || cache.has(path)) return;
    let alive = true;
    signedMediaUrl(path).then((r) => {
      if (!alive) return;
      if (r.ok) {
        cache.set(path, r.data.url);
        setUrl(r.data.url);
      } else setError(true);
    });
    return () => {
      alive = false;
    };
  }, [path]);
  return { url, error };
}

export function MediaBubble({
  kind,
  path,
  mime,
  filename,
  pending,
}: {
  kind: string;
  path: string | null;
  mime: string | null;
  filename: string | null;
  pending?: boolean;
}) {
  const { url, error } = useSignedUrl(path);
  if (!path) {
    return (
      <div className="text-muted-foreground flex items-center gap-2 text-xs">
        {pending ? <Loader2 className="size-3 animate-spin" /> : <FileText className="size-3" />}
        {pending ? `Loading ${kind}…` : `${kind} unavailable`}
      </div>
    );
  }
  if (error) return <p className="text-destructive text-xs">Could not load the file.</p>;
  if (!url) return <Loader2 className="text-muted-foreground size-4 animate-spin" />;
  if (kind === "image" || kind === "sticker") {
    return (
      <a href={url} target="_blank" rel="noreferrer">
        {/* eslint-disable-next-line @next/next/no-img-element -- signed, short-lived storage URL */}
        <img
          src={url}
          alt={filename ?? kind}
          className={kind === "sticker" ? "max-h-32" : "max-h-72 max-w-full rounded-md"}
        />
      </a>
    );
  }
  if (kind === "video")
    return <video src={url} controls className="max-h-72 max-w-full rounded-md" />;
  if (kind === "audio") return <audio src={url} controls className="max-w-full" />;
  return (
    <a
      href={url}
      target="_blank"
      rel="noreferrer"
      className="flex items-center gap-2 text-sm underline-offset-2 hover:underline"
    >
      <FileText className="size-4 shrink-0" />
      <span className="truncate">{filename ?? "Document"}</span>
      {mime && <span className="text-muted-foreground text-[10px]">{mime.split("/")[1]}</span>}
    </a>
  );
}
