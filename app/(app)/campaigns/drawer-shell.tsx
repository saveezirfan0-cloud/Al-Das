"use client";

import { useRouter } from "next/navigation";

import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
} from "@/components/ui/sheet";

/** Right-side drawer whose open state lives in the URL (?c=<id>) so it can be server-rendered and linked. */
export function DrawerShell({
  title,
  description,
  closeHref,
  children,
}: {
  title: string;
  description?: React.ReactNode;
  closeHref: string;
  children: React.ReactNode;
}) {
  const router = useRouter();
  return (
    <Sheet open onOpenChange={(o) => !o && router.push(closeHref)}>
      <SheetContent className="w-full overflow-y-auto sm:max-w-3xl">
        <SheetHeader>
          <SheetTitle>{title}</SheetTitle>
          <SheetDescription asChild>
            <div>{description}</div>
          </SheetDescription>
        </SheetHeader>
        <div className="flex flex-col gap-5 px-4 pb-6">{children}</div>
      </SheetContent>
    </Sheet>
  );
}
