"use client";

import { useRouter } from "next/navigation";
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

import { startConversation } from "./actions";
import type { ChannelInfo } from "./types";

export function NewConversationDialog({
  open,
  onOpenChange,
  channels,
  canCreateContacts,
}: {
  open: boolean;
  onOpenChange: (o: boolean) => void;
  channels: ChannelInfo[];
  canCreateContacts: boolean;
}) {
  const router = useRouter();
  const active = channels.filter((c) => c.status === "active");
  const [channel, setChannel] = useState(active[0]?.id ?? "");
  const [phone, setPhone] = useState("");
  const [first, setFirst] = useState("");
  const [last, setLast] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();

  function submit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    startTransition(async () => {
      const r = await startConversation({
        channel_id: channel,
        phone,
        first_name: first,
        last_name: last,
      });
      if (!r.ok) {
        setError(r.error);
        return;
      }
      toast.success("Conversation opened. Outside the 24h window you'll need a template.");
      onOpenChange(false);
      router.push(`/inbox?c=${r.data.conversation_id}`);
    });
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>New conversation</DialogTitle>
          <DialogDescription>
            Start a WhatsApp conversation with a patient. New numbers create a contact.
          </DialogDescription>
        </DialogHeader>
        <form onSubmit={submit} className="flex flex-col gap-4">
          <div className="grid gap-2">
            <Label>From number</Label>
            <Select value={channel} onValueChange={setChannel}>
              <SelectTrigger className="w-full">
                <SelectValue placeholder="Pick a number" />
              </SelectTrigger>
              <SelectContent>
                {active.map((c) => (
                  <SelectItem key={c.id} value={c.id}>
                    {c.name}
                    {c.display_phone ? ` · ${c.display_phone}` : ""}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <div className="grid gap-2">
            <Label htmlFor="nc-phone">Patient phone</Label>
            <Input
              id="nc-phone"
              value={phone}
              onChange={(e) => setPhone(e.target.value)}
              placeholder="+971 50 000 0000"
              required
              inputMode="tel"
            />
          </div>
          {canCreateContacts && (
            <div className="grid grid-cols-2 gap-2">
              <div className="grid gap-2">
                <Label htmlFor="nc-first">First name</Label>
                <Input id="nc-first" value={first} onChange={(e) => setFirst(e.target.value)} />
              </div>
              <div className="grid gap-2">
                <Label htmlFor="nc-last">Last name</Label>
                <Input id="nc-last" value={last} onChange={(e) => setLast(e.target.value)} />
              </div>
            </div>
          )}
          {error && (
            <p className="text-destructive text-sm" role="alert">
              {error}
            </p>
          )}
          <DialogFooter>
            <Button type="button" variant="ghost" onClick={() => onOpenChange(false)}>
              Cancel
            </Button>
            <Button type="submit" disabled={pending || !channel}>
              {pending && <Loader2 className="animate-spin" />} Open
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
