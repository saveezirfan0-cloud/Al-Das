"use client";

import { useState, useTransition } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import {
  Archive,
  ArchiveRestore,
  Copy,
  MoreHorizontal,
  Pencil,
  Shuffle,
  Trash2,
} from "lucide-react";
import { toast } from "sonner";

import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";

import { archiveTemplate, deleteTemplate, duplicateTemplate } from "./actions";
import { MapDialog, type MapTemplate } from "./map-dialog";

export function RowActions({
  id,
  editHref,
  archived,
  map,
}: {
  id: string;
  editHref: string;
  archived: boolean;
  map: MapTemplate;
}) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [mapOpen, setMapOpen] = useState(false);

  function run(
    fn: () => Promise<{ ok: boolean; error?: string; message?: string }>,
    confirmText?: string,
  ) {
    if (confirmText && !window.confirm(confirmText)) return;
    startTransition(async () => {
      const r = await fn();
      if (!r.ok) toast.error(r.error ?? "Something went wrong.");
      else {
        toast.success(r.message ?? "Done.");
        router.refresh();
      }
    });
  }

  return (
    <>
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button variant="ghost" size="icon" aria-label="Template actions" disabled={pending}>
            <MoreHorizontal />
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end">
          <DropdownMenuItem asChild>
            <Link href={editHref} scroll={false}>
              <Pencil /> Edit
            </Link>
          </DropdownMenuItem>
          <DropdownMenuItem onSelect={() => setMapOpen(true)}>
            <Shuffle /> Map variables
          </DropdownMenuItem>
          <DropdownMenuItem onSelect={() => run(() => duplicateTemplate(id))}>
            <Copy /> Duplicate
          </DropdownMenuItem>
          <DropdownMenuItem onSelect={() => run(() => archiveTemplate(id, !archived))}>
            {archived ? <ArchiveRestore /> : <Archive />} {archived ? "Unarchive" : "Archive"}
          </DropdownMenuItem>
          <DropdownMenuSeparator />
          <DropdownMenuItem
            variant="destructive"
            onSelect={() =>
              run(
                () => deleteTemplate(id),
                "Delete this template? If it was submitted, it is also deleted on Meta and can't be sent again.",
              )
            }
          >
            <Trash2 /> Delete
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
      <MapDialog open={mapOpen} onOpenChange={setMapOpen} template={map} />
    </>
  );
}
