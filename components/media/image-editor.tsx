"use client";

import { useEffect, useRef, useState } from "react";
import { Camera, RotateCcw, RotateCw } from "lucide-react";

import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { decodeImage, renderPreview, type Decoded } from "@/lib/media/client-image";
import { NO_INSETS, normaliseRotation, type Insets } from "@/lib/media/image-ops";

export type ImageEdit = { rotation: number; insets: Insets };

const SIDES: Array<{ key: keyof Insets; label: string }> = [
  { key: "top", label: "Trim top" },
  { key: "bottom", label: "Trim bottom" },
  { key: "left", label: "Trim left" },
  { key: "right", label: "Trim right" },
];

/**
 * Turn and trim a photo before it is uploaded (phone camera shots often arrive sideways or with the table in
 * view). Canvas only: nothing leaves the browser until "Use this photo". Sliders instead of drag handles so it
 * works with a thumb and with a keyboard.
 */
export function ImageEditorDialog({
  file,
  open,
  title = "Adjust the photo",
  onCancel,
  onDone,
}: {
  file: File | null;
  open: boolean;
  title?: string;
  onCancel: () => void;
  onDone: (edit: ImageEdit) => void;
}) {
  const canvas = useRef<HTMLCanvasElement>(null);
  const decoded = useRef<Decoded | null>(null);
  const [ready, setReady] = useState(false);
  const [failed, setFailed] = useState(false);
  const [rotation, setRotation] = useState(0);
  const [insets, setInsets] = useState<Insets>(NO_INSETS);

  useEffect(() => {
    if (!open || !file) return;
    let alive = true;
    setReady(false);
    setFailed(false);
    setRotation(0);
    setInsets(NO_INSETS);
    decodeImage(file)
      .then((d) => {
        if (!alive) return d.close();
        decoded.current = d;
        setReady(true);
      })
      .catch(() => alive && setFailed(true));
    return () => {
      alive = false;
      decoded.current?.close();
      decoded.current = null;
    };
  }, [open, file]);

  useEffect(() => {
    if (ready && decoded.current && canvas.current)
      renderPreview(decoded.current, canvas.current, rotation, insets);
  }, [ready, rotation, insets]);

  const changed = rotation !== 0 || JSON.stringify(insets) !== JSON.stringify(NO_INSETS);

  return (
    <Dialog open={open} onOpenChange={(o) => !o && onCancel()}>
      <DialogContent className="max-h-[92dvh] overflow-y-auto sm:max-w-md">
        <DialogHeader>
          <DialogTitle>{title}</DialogTitle>
          <DialogDescription>
            Turn the photo if it is sideways and trim the edges. It is compressed automatically
            before it is uploaded.
          </DialogDescription>
        </DialogHeader>
        {failed ? (
          <p className="text-destructive text-sm">
            This browser cannot open that picture. You can still upload it as it is.
          </p>
        ) : (
          <div className="bg-muted flex min-h-40 items-center justify-center rounded-md p-2">
            {ready ? (
              <canvas
                ref={canvas}
                className="max-h-72 max-w-full rounded"
                aria-label="Photo preview"
              />
            ) : (
              <Camera className="text-muted-foreground size-8 animate-pulse" aria-hidden />
            )}
          </div>
        )}
        {!failed && (
          <div className="grid gap-3">
            <div className="flex gap-2">
              <Button
                type="button"
                variant="outline"
                className="pointer-coarse:h-11 flex-1"
                onClick={() => setRotation((r) => normaliseRotation(r - 90))}
              >
                <RotateCcw /> Turn left
              </Button>
              <Button
                type="button"
                variant="outline"
                className="pointer-coarse:h-11 flex-1"
                onClick={() => setRotation((r) => normaliseRotation(r + 90))}
              >
                <RotateCw /> Turn right
              </Button>
            </div>
            <div className="grid grid-cols-2 gap-x-4 gap-y-2">
              {SIDES.map((s) => (
                <label key={s.key} className="grid gap-1 text-xs">
                  <span className="text-muted-foreground">
                    {s.label} ({Math.round(insets[s.key] * 100)}%)
                  </span>
                  <input
                    type="range"
                    min={0}
                    max={40}
                    step={1}
                    value={Math.round(insets[s.key] * 100)}
                    onChange={(e) =>
                      setInsets((i) => ({ ...i, [s.key]: Number(e.target.value) / 100 }))
                    }
                    className="h-6 w-full"
                    aria-label={s.label}
                  />
                </label>
              ))}
            </div>
          </div>
        )}
        <DialogFooter>
          <Button type="button" variant="ghost" onClick={onCancel}>
            Cancel
          </Button>
          <Button
            type="button"
            variant="outline"
            disabled={!changed}
            onClick={() => {
              setRotation(0);
              setInsets(NO_INSETS);
            }}
          >
            Reset
          </Button>
          <Button type="button" onClick={() => onDone({ rotation, insets })}>
            Use this photo
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
