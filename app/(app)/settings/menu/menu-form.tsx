"use client";

import { useState, useTransition } from "react";
import { Loader2 } from "lucide-react";
import { toast } from "sonner";

import { MenuChoices, type MenuChoiceOption } from "@/components/shell/menu-choices";
import { Button } from "@/components/ui/button";

import { saveWorkspaceMenu } from "./actions";

export function WorkspaceMenuForm({
  choices,
  initialHidden,
}: {
  choices: readonly MenuChoiceOption[];
  initialHidden: string[];
}) {
  const [hidden, setHidden] = useState<string[]>(initialHidden);
  const [saved, setSaved] = useState<string[]>(initialHidden);
  const [pending, startTransition] = useTransition();
  const dirty = [...hidden].sort().join() !== [...saved].sort().join();

  function save() {
    startTransition(async () => {
      const res = await saveWorkspaceMenu(hidden);
      if (!res.ok) {
        toast.error(res.error);
        return;
      }
      setSaved(hidden);
      toast.success(res.message);
    });
  }

  return (
    <div className="flex flex-col gap-4">
      <MenuChoices
        choices={choices}
        hidden={hidden}
        onChange={setHidden}
        idPrefix="workspace-menu"
      />
      <div className="flex flex-wrap items-center gap-2">
        <Button type="button" onClick={save} disabled={pending || !dirty}>
          {pending && <Loader2 className="animate-spin" />} Save menu
        </Button>
        <Button
          type="button"
          variant="ghost"
          onClick={() => setHidden([])}
          disabled={pending || hidden.length === 0}
        >
          Show everything
        </Button>
      </div>
    </div>
  );
}
