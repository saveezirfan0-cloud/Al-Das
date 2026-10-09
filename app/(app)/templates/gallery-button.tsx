"use client";

import { useState } from "react";
import { Plus } from "lucide-react";

import { Button } from "@/components/ui/button";

import { GalleryDialog } from "./gallery-dialog";

export function GalleryButton({
  keep,
  disabled,
}: {
  keep: Record<string, string>;
  disabled?: boolean;
}) {
  const [open, setOpen] = useState(false);
  return (
    <>
      <Button size="sm" disabled={disabled} onClick={() => setOpen(true)}>
        <Plus /> New template
      </Button>
      <GalleryDialog open={open} onOpenChange={setOpen} keep={keep} />
    </>
  );
}
