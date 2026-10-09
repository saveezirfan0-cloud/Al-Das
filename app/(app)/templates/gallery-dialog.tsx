"use client";

import { useMemo, useState } from "react";
import Link from "next/link";

import { PhonePreview } from "@/components/phone-preview/phone-preview";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { ScrollArea } from "@/components/ui/scroll-area";
import { buildComponents } from "@/lib/templates/builder";
import { GALLERY, GALLERY_USE_CASES } from "@/lib/templates/gallery";
import { renderTemplatePreview } from "@/lib/whatsapp/templates";
import { cn } from "@/lib/utils";

import { templatesHref } from "./format";

/** “Choose a template”: start from an original clinic template or from scratch. */
export function GalleryDialog({
  open,
  onOpenChange,
  keep,
}: {
  open: boolean;
  onOpenChange: (o: boolean) => void;
  /** List filters to preserve in the builder's URL. */
  keep: Record<string, string>;
}) {
  const [useCase, setUseCase] = useState<string>("all");
  const [language, setLanguage] = useState<"all" | "en" | "ar">("all");
  const [pickedKey, setPickedKey] = useState<string | null>(null);

  const items = useMemo(
    () =>
      GALLERY.filter(
        (g) =>
          (useCase === "all" || g.useCase === useCase) &&
          (language === "all" || g.language === language),
      ),
    [useCase, language],
  );
  const picked = GALLERY.find((g) => g.key === pickedKey) ?? null;
  const preview = useMemo(
    () =>
      picked
        ? renderTemplatePreview(
            buildComponents(picked.draft),
            exampleValues(picked.draft.bodyExamples),
          )
        : null,
    [picked],
  );

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-4xl">
        <DialogHeader>
          <DialogTitle>Choose a template</DialogTitle>
          <DialogDescription>
            Original starter templates in English and Arabic. Pick one to adjust and submit, or
            start from scratch.
          </DialogDescription>
        </DialogHeader>
        <div className="flex flex-wrap items-center gap-1">
          {["all", ...GALLERY_USE_CASES].map((u) => (
            <button
              key={u}
              type="button"
              onClick={() => setUseCase(u)}
              className={cn(
                "rounded-full border px-2.5 py-1 text-xs",
                useCase === u ? "bg-primary text-primary-foreground" : "hover:bg-accent",
              )}
            >
              {u === "all" ? "All use cases" : u}
            </button>
          ))}
          <span className="mx-1 h-4 w-px bg-border" />
          {(["all", "en", "ar"] as const).map((l) => (
            <button
              key={l}
              type="button"
              onClick={() => setLanguage(l)}
              className={cn(
                "rounded-full border px-2.5 py-1 text-xs",
                language === l ? "bg-primary text-primary-foreground" : "hover:bg-accent",
              )}
            >
              {l === "all" ? "Any language" : l === "en" ? "English" : "Arabic"}
            </button>
          ))}
        </div>
        <div className="grid gap-4 md:grid-cols-[1fr_20rem]">
          <ScrollArea className="h-96 rounded-md border">
            <ul className="divide-y">
              {items.map((g) => (
                <li key={g.key}>
                  <button
                    type="button"
                    onClick={() => setPickedKey(g.key)}
                    className={cn(
                      "hover:bg-accent flex w-full flex-col gap-1 px-3 py-2 text-left",
                      pickedKey === g.key && "bg-accent",
                    )}
                  >
                    <span className="text-sm font-medium">{g.title}</span>
                    <span className="text-muted-foreground text-xs">{g.description}</span>
                    <span className="flex gap-1">
                      <Badge variant="outline">{g.language === "ar" ? "Arabic" : "English"}</Badge>
                      <Badge variant="outline">{g.draft.category.toLowerCase()}</Badge>
                      {g.needsMedia && <Badge variant="secondary">needs an image</Badge>}
                      {g.placeholderLink && <Badge variant="secondary">replace link</Badge>}
                    </span>
                  </button>
                </li>
              ))}
              {items.length === 0 && (
                <li className="text-muted-foreground p-4 text-sm">Nothing matches.</li>
              )}
            </ul>
          </ScrollArea>
          <div className="flex flex-col gap-3">
            {picked && preview ? (
              <>
                <div dir={picked.language === "ar" ? "rtl" : "ltr"}>
                  <PhonePreview preview={preview} />
                </div>
                <Button asChild>
                  <Link
                    href={templatesHref({ ...keep, new: "1", gallery: picked.key })}
                    scroll={false}
                  >
                    Use this template
                  </Link>
                </Button>
              </>
            ) : (
              <p className="text-muted-foreground text-sm">Pick a template to preview it.</p>
            )}
            <Button asChild variant="outline">
              <Link href={templatesHref({ ...keep, new: "1" })} scroll={false}>
                Start from scratch
              </Link>
            </Button>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}

function exampleValues(examples: string[]): Record<string, string> {
  return Object.fromEntries(examples.map((e, i) => [`body.${i + 1}`, e]));
}
