"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
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
import { Switch } from "@/components/ui/switch";
import { describeTtl, TEMPLATE_RETRY_MAX, TTL_PRESETS } from "@/lib/templates/delivery";

import { saveTemplateDelivery } from "./actions";

export type DeliveryTemplate = {
  id: string;
  name: string;
  category: string;
  retry_on_fail: boolean;
  sms_fallback: boolean;
  ttl_seconds: number | null;
};

const NONE = "none";

export function DeliveryDialog({
  open,
  onOpenChange,
  template,
}: {
  open: boolean;
  onOpenChange: (o: boolean) => void;
  template: DeliveryTemplate;
}) {
  const router = useRouter();
  const marketing = template.category.toUpperCase() === "MARKETING";
  const [retry, setRetry] = useState(template.retry_on_fail);
  const [sms, setSms] = useState(template.sms_fallback && !marketing);
  const [ttl, setTtl] = useState<string>(
    template.ttl_seconds ? String(template.ttl_seconds) : NONE,
  );
  const [pending, startTransition] = useTransition();
  const presets = TTL_PRESETS.some((p) => p.seconds === template.ttl_seconds)
    ? TTL_PRESETS
    : [...TTL_PRESETS, { seconds: template.ttl_seconds, label: describeTtl(template.ttl_seconds) }];

  function save() {
    startTransition(async () => {
      const r = await saveTemplateDelivery(template.id, {
        retry_on_fail: retry,
        sms_fallback: marketing ? false : sms,
        ttl_seconds: ttl === NONE ? null : Number(ttl),
      });
      if (!r.ok) {
        toast.error(r.error);
        return;
      }
      toast.success(r.message ?? "Saved.");
      onOpenChange(false);
      router.refresh();
    });
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>Delivery settings · {template.name}</DialogTitle>
          <DialogDescription>
            What happens when a message with this template cannot be delivered.
          </DialogDescription>
        </DialogHeader>
        <div className="flex flex-col gap-5">
          <div className="flex items-start justify-between gap-4">
            <div className="grid gap-1">
              <Label htmlFor="d-retry">Retry when sending fails</Label>
              <p className="text-muted-foreground text-xs">
                Up to {TEMPLATE_RETRY_MAX} more tries (after 10 minutes, then 1 hour), only for
                temporary WhatsApp errors. Campaigns use their own retry rounds instead.
              </p>
            </div>
            <Switch id="d-retry" checked={retry} onCheckedChange={setRetry} />
          </div>
          <div className="flex items-start justify-between gap-4">
            <div className="grid gap-1">
              <Label htmlFor="d-sms">SMS fallback for appointment reminders</Label>
              <p className="text-muted-foreground text-xs">
                {marketing
                  ? "Marketing templates never fall back to SMS."
                  : "When this template is the appointment reminder and WhatsApp cannot deliver it, a short fixed SMS goes out instead (only while the SMS integration is on)."}
              </p>
            </div>
            <Switch id="d-sms" checked={sms} onCheckedChange={setSms} disabled={marketing} />
          </div>
          <div className="grid gap-1.5">
            <Label>Time limit</Label>
            <Select value={ttl} onValueChange={setTtl}>
              <SelectTrigger>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {presets.map((p) => (
                  <SelectItem key={p.label} value={p.seconds ? String(p.seconds) : NONE}>
                    {p.label}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            <p className="text-muted-foreground text-xs">
              A message that is still waiting to go out after this long is not sent at all, so
              nobody gets a reminder that is already out of date. Retries count from the first try.
            </p>
          </div>
        </div>
        <DialogFooter>
          <Button variant="ghost" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button onClick={save} disabled={pending}>
            {pending && <Loader2 className="animate-spin" />} Save
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
