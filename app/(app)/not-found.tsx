import Link from "next/link";
import { SearchX } from "lucide-react";

import { Button } from "@/components/ui/button";

export default function AppNotFound() {
  return (
    <div className="mx-auto flex max-w-md flex-col items-center gap-3 py-16 text-center">
      <span className="bg-muted text-muted-foreground flex size-12 items-center justify-center rounded-full">
        <SearchX className="size-6" aria-hidden />
      </span>
      <h2 className="text-lg font-semibold">We couldn’t find that</h2>
      <p className="text-muted-foreground text-sm">
        The record may have been merged or deleted, or you may not have access to it.
      </p>
      <Button asChild>
        <Link href="/dashboard">Back to the dashboard</Link>
      </Button>
    </div>
  );
}
