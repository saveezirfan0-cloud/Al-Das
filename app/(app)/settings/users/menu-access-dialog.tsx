"use client";

import { useState, useTransition } from "react";
import { Loader2 } from "lucide-react";
import { toast } from "sonner";

import { MenuChoices, type MenuChoiceOption } from "@/components/shell/menu-choices";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";

import { setMemberMenu } from "./actions";

/** Settings, Users, Menu access: which of the entries their role allows one person sees. */
export function MenuAccessDialog({
  membershipId,
  displayName,
  roleName,
  choices,
  hidden: initialHidden,
  workspaceHidden,
  open,
  onOpenChange,
}: {
  membershipId: string;
  displayName: string;
  roleName: string;
  choices: MenuChoiceOption[];
  hidden: string[];
  workspaceHidden: string[];
  open: boolean;
  onOpenChange: (o: boolean) => void;
}) {
  const [hidden, setHidden] = useState<string[]>(initialHidden);
  const [error, setError] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();

  function submit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    startTransition(async () => {
      const res = await setMemberMenu(membershipId, hidden);
      if (!res.ok) {
        setError(res.error);
        return;
      }
      toast.success(res.message);
      onOpenChange(false);
    });
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-xl">
        <DialogHeader>
          <DialogTitle>Menu for {displayName}</DialogTitle>
          <DialogDescription>
            The entries their role ({roleName}) allows. Untick one to hide it from their menu and
            quick search; its pages tell them it is hidden. Their role still decides what they can
            do.
          </DialogDescription>
        </DialogHeader>
        <form onSubmit={submit} className="flex flex-col gap-4">
          <div className="max-h-[50vh] overflow-y-auto">
            <MenuChoices
              choices={choices}
              hidden={hidden}
              onChange={setHidden}
              lockedHidden={workspaceHidden}
              idPrefix={`member-menu-${membershipId}`}
            />
          </div>
          {error && (
            <p className="text-destructive text-sm" role="alert">
              {error}
            </p>
          )}
          <DialogFooter>
            <Button
              type="button"
              variant="ghost"
              onClick={() => setHidden([])}
              disabled={pending || hidden.length === 0}
            >
              Show everything
            </Button>
            <Button type="button" variant="ghost" onClick={() => onOpenChange(false)}>
              Cancel
            </Button>
            <Button type="submit" disabled={pending}>
              {pending && <Loader2 className="animate-spin" />} Save
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
