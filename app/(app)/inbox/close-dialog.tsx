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
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Textarea } from "@/components/ui/textarea";

import { closeConversation } from "./actions";
import type { CategoryInfo } from "./types";

const NONE = "__none__";

export function CloseDialog({
  open,
  onOpenChange,
  conversationId,
  categories,
  settings,
}: {
  open: boolean;
  onOpenChange: (o: boolean) => void;
  conversationId: string;
  categories: CategoryInfo[];
  settings: { require_category_on_close: boolean; require_summary_on_close: boolean };
}) {
  const [category, setCategory] = useState<string>(NONE);
  const [summary, setSummary] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();

  function submit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    startTransition(async () => {
      const r = await closeConversation({
        conversation_id: conversationId,
        category_id: category === NONE ? null : category,
        summary,
      });
      if (!r.ok) {
        setError(r.error);
        return;
      }
      toast.success(r.message);
      onOpenChange(false);
      setSummary("");
      setCategory(NONE);
    });
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Close conversation</DialogTitle>
          <DialogDescription>
            It moves to Closed; a new patient message reopens it.
          </DialogDescription>
        </DialogHeader>
        <form onSubmit={submit} className="flex flex-col gap-4">
          <div className="grid gap-2">
            <Label>
              Category{" "}
              {settings.require_category_on_close && <span className="text-destructive">*</span>}
            </Label>
            <Select value={category} onValueChange={setCategory}>
              <SelectTrigger className="w-full">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value={NONE}>No category</SelectItem>
                {categories.map((c) => (
                  <SelectItem key={c.id} value={c.id}>
                    {c.name}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <div className="grid gap-2">
            <Label htmlFor="close-summary">
              Summary{" "}
              {settings.require_summary_on_close && <span className="text-destructive">*</span>}
            </Label>
            <Textarea
              id="close-summary"
              value={summary}
              onChange={(e) => setSummary(e.target.value)}
              rows={3}
              placeholder="What was resolved?"
            />
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
              {pending && <Loader2 className="animate-spin" />} Close conversation
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
