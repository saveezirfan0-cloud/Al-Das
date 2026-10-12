"use client";

import { usePathname } from "next/navigation";
import { useState, useTransition } from "react";
import { Loader2 } from "lucide-react";
import { toast } from "sonner";

import { submitFeedback } from "@/app/(app)/help/actions";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Textarea } from "@/components/ui/textarea";

type Kind = "idea" | "problem" | "question" | "praise";

export function FeedbackDialog({
  open,
  onOpenChange,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const pathname = usePathname();
  const [kind, setKind] = useState<Kind>("idea");
  const [message, setMessage] = useState("");
  const [pending, startTransition] = useTransition();

  function send() {
    startTransition(async () => {
      const r = await submitFeedback({ page: pathname, kind, message });
      if (r.ok) {
        toast.success(r.message);
        setMessage("");
        onOpenChange(false);
      } else toast.error(r.error);
    });
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Send feedback</DialogTitle>
          <DialogDescription>
            Tell us what to fix or add. We note which page you were on.{" "}
            <strong>Do not write patient names, numbers or medical details here.</strong>
          </DialogDescription>
        </DialogHeader>
        <div className="grid gap-3">
          <Select value={kind} onValueChange={(v) => setKind(v as Kind)}>
            <SelectTrigger className="w-full" aria-label="Kind of feedback">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="idea">An idea</SelectItem>
              <SelectItem value="problem">Something is wrong</SelectItem>
              <SelectItem value="question">A question</SelectItem>
              <SelectItem value="praise">Something works well</SelectItem>
            </SelectContent>
          </Select>
          <Textarea
            rows={5}
            maxLength={2000}
            value={message}
            onChange={(e) => setMessage(e.target.value)}
            placeholder="What happened, or what would help?"
            aria-label="Your feedback"
          />
        </div>
        <DialogFooter>
          <Button onClick={send} disabled={pending || message.trim().length < 3}>
            {pending && <Loader2 className="animate-spin" />} Send
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
