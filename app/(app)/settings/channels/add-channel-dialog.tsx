"use client";

import { useState, useTransition } from "react";
import { Loader2, Plus } from "lucide-react";
import { toast } from "sonner";

import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";

import { addChannel } from "./actions";

export function AddChannelDialog({ envTokenAvailable }: { envTokenAvailable: boolean }) {
  const [open, setOpen] = useState(false);
  const [name, setName] = useState("");
  const [phoneNumberId, setPhoneNumberId] = useState("");
  const [wabaId, setWabaId] = useState("");
  const [token, setToken] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();

  function submit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    startTransition(async () => {
      const res = await addChannel({
        name,
        phone_number_id: phoneNumberId,
        waba_id: wabaId,
        access_token: token,
      });
      if (!res.ok) {
        setError(res.error);
        return;
      }
      toast.success(res.message);
      setOpen(false);
      setName("");
      setPhoneNumberId("");
      setWabaId("");
      setToken("");
    });
  }

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>
        <Button>
          <Plus /> Add number
        </Button>
      </DialogTrigger>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Add a WhatsApp number</DialogTitle>
          <DialogDescription>
            From Meta Business Manager → WhatsApp → API setup. The token is encrypted at rest and
            never shown again.
          </DialogDescription>
        </DialogHeader>
        <form onSubmit={submit} className="flex flex-col gap-4">
          <div className="grid gap-2">
            <Label htmlFor="ch-name">Name</Label>
            <Input
              id="ch-name"
              value={name}
              onChange={(e) => setName(e.target.value)}
              required
              placeholder="e.g. Golden Mile reception"
            />
          </div>
          <div className="grid gap-2">
            <Label htmlFor="ch-pnid">Phone number ID</Label>
            <Input
              id="ch-pnid"
              value={phoneNumberId}
              onChange={(e) => setPhoneNumberId(e.target.value.trim())}
              required
              inputMode="numeric"
              placeholder="1000000000000"
            />
          </div>
          <div className="grid gap-2">
            <Label htmlFor="ch-waba">WhatsApp Business Account ID</Label>
            <Input
              id="ch-waba"
              value={wabaId}
              onChange={(e) => setWabaId(e.target.value.trim())}
              required
              inputMode="numeric"
              placeholder="2000000000000"
            />
          </div>
          <div className="grid gap-2">
            <Label htmlFor="ch-token">
              System User token{" "}
              {envTokenAvailable && (
                <span className="text-muted-foreground font-normal">
                  (optional — uses META_SYSTEM_USER_TOKEN when empty)
                </span>
              )}
            </Label>
            <Input
              id="ch-token"
              type="password"
              autoComplete="off"
              value={token}
              onChange={(e) => setToken(e.target.value)}
              required={!envTokenAvailable}
              placeholder="EAAB…"
            />
          </div>
          {error && (
            <p className="text-destructive text-sm" role="alert">
              {error}
            </p>
          )}
          <DialogFooter>
            <Button type="button" variant="ghost" onClick={() => setOpen(false)}>
              Cancel
            </Button>
            <Button type="submit" disabled={pending}>
              {pending && <Loader2 className="animate-spin" />} Connect
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
