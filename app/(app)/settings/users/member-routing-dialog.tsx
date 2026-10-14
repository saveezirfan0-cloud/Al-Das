"use client";

import { useState, useTransition } from "react";
import { Loader2 } from "lucide-react";
import { toast } from "sonner";

import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Switch } from "@/components/ui/switch";
import {
  ENQUIRY_VIEW_SCOPE_LABELS,
  ENQUIRY_VIEW_SCOPES,
  type EnquiryViewScope,
} from "@/lib/enquiries/scope";

import { setMemberRouting } from "./actions";

/** Phase 20c: open conversation limit and enquiry view for one member. */
export function MemberRoutingDialog({
  membershipId,
  displayName,
  maxOpen,
  enquiryScope,
  open,
  onOpenChange,
}: {
  membershipId: string;
  displayName: string;
  maxOpen: number | null;
  enquiryScope: EnquiryViewScope;
  open: boolean;
  onOpenChange: (o: boolean) => void;
}) {
  const [limit, setLimit] = useState<number | null>(maxOpen);
  const [scope, setScope] = useState<EnquiryViewScope>(enquiryScope);
  const [error, setError] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();

  function submit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    startTransition(async () => {
      const res = await setMemberRouting(membershipId, {
        max_open_conversations: limit,
        enquiry_scope: scope,
      });
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
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Routing for {displayName}</DialogTitle>
          <DialogDescription>
            How many conversations round-robin may give them, and which enquiries they see.
          </DialogDescription>
        </DialogHeader>
        <form onSubmit={submit} className="flex flex-col gap-4">
          <div className="flex items-center justify-between gap-4 rounded-md border px-3 py-2 text-sm">
            <span>
              <span className="font-medium">Limit open conversations</span>
              <span className="text-muted-foreground block text-xs">
                Round-robin skips them at the limit. You can still assign them more by hand.
              </span>
            </span>
            <div className="flex items-center gap-2">
              <Switch
                checked={limit !== null}
                onCheckedChange={(c) => setLimit(c ? 10 : null)}
                aria-label="Limit open conversations"
              />
              <Input
                type="number"
                min={1}
                max={500}
                className="w-20"
                aria-label="Maximum open conversations"
                value={limit ?? ""}
                disabled={limit === null}
                onChange={(e) => setLimit(e.target.value === "" ? null : Number(e.target.value))}
              />
            </div>
          </div>
          <div className="grid gap-2">
            <Label htmlFor="member-enquiry-scope">Enquiries they can see</Label>
            <Select value={scope} onValueChange={(v) => setScope(v as EnquiryViewScope)}>
              <SelectTrigger id="member-enquiry-scope">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {ENQUIRY_VIEW_SCOPES.map((s) => (
                  <SelectItem key={s} value={s}>
                    {ENQUIRY_VIEW_SCOPE_LABELS[s]}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            <p className="text-muted-foreground text-xs">
              Their own: assigned to them, or unassigned ones they created. Their team&apos;s: also
              those assigned to anyone in their teams, plus unassigned ones. Applies on top of their
              role.
            </p>
          </div>
          {error && (
            <p className="text-destructive text-sm" role="alert">
              {error}
            </p>
          )}
          <DialogFooter>
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
