"use client";

import { useState, useTransition } from "react";
import { Loader2, MoreHorizontal, RefreshCw } from "lucide-react";
import { toast } from "sonner";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Textarea } from "@/components/ui/textarea";
import { BUSINESS_VERTICALS, type BusinessProfile } from "@/lib/whatsapp/types";

import {
  refreshChannel,
  removeChannel,
  subscribeChannelApp,
  syncChannelTemplates,
  updateChannel,
  updateChannelProfile,
  type ActionResult,
} from "./actions";

export type ChannelView = {
  id: string;
  name: string;
  status: "active" | "paused" | "disconnected";
  waba_id: string;
  phone_number_id: string;
  display_phone: string | null;
  verified_name: string | null;
  quality_rating: string | null;
  messaging_limit_tier: string | null;
  name_status: string | null;
  catalog_id: string | null;
  send_rate_per_sec: number;
  last_synced_at: string | null;
  business_profile: BusinessProfile;
  own_token: boolean;
  subscribed: boolean;
  templates: { total: number; approved: number };
};

function qualityVariant(q: string | null): "success" | "warning" | "destructive" | "outline" {
  switch (q) {
    case "GREEN":
      return "success";
    case "YELLOW":
      return "warning";
    case "RED":
      return "destructive";
    default:
      return "outline";
  }
}

function tierLabel(t: string | null): string {
  if (!t) return "tier unknown";
  return t.replace("TIER_", "").replace("UNLIMITED", "unlimited") + "/24h";
}

export function ChannelCard({ channel }: { channel: ChannelView }) {
  const [pending, startTransition] = useTransition();
  const [editing, setEditing] = useState(false);
  const [profile, setProfile] = useState(false);

  function run(fn: () => Promise<ActionResult>) {
    startTransition(async () => {
      const res = await fn();
      if (res.ok) toast.success(res.message);
      else toast.error(res.error);
    });
  }

  return (
    <Card className={channel.status === "disconnected" ? "opacity-60" : undefined}>
      <CardHeader>
        <CardTitle className="flex flex-wrap items-center gap-2">
          {channel.name}
          <Badge variant={channel.status === "active" ? "secondary" : "outline"}>
            {channel.status}
          </Badge>
          <Badge variant={qualityVariant(channel.quality_rating)}>
            {channel.quality_rating ?? "quality unknown"}
          </Badge>
          <Badge variant="outline">{tierLabel(channel.messaging_limit_tier)}</Badge>
        </CardTitle>
        <CardDescription>
          {channel.display_phone ?? "number pending"} ·{" "}
          {channel.verified_name ?? "no verified name"}
          {channel.name_status && channel.name_status !== "APPROVED" && ` (${channel.name_status})`}
        </CardDescription>
        <div className="col-start-2 row-span-2 row-start-1 flex items-center gap-1 self-start justify-self-end">
          <Button
            variant="ghost"
            size="icon-sm"
            aria-label="Refresh from Meta"
            disabled={pending}
            onClick={() => run(() => refreshChannel(channel.id))}
          >
            {pending ? <Loader2 className="animate-spin" /> : <RefreshCw />}
          </Button>
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button variant="ghost" size="icon-sm" aria-label={`Actions for ${channel.name}`}>
                <MoreHorizontal />
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end">
              <DropdownMenuItem onSelect={() => setEditing(true)}>Edit channel</DropdownMenuItem>
              <DropdownMenuItem onSelect={() => setProfile(true)}>
                Edit business profile
              </DropdownMenuItem>
              <DropdownMenuItem onSelect={() => run(() => subscribeChannelApp(channel.id))}>
                Subscribe webhook
              </DropdownMenuItem>
              <DropdownMenuItem onSelect={() => run(() => syncChannelTemplates(channel.id))}>
                Sync templates
              </DropdownMenuItem>
              <DropdownMenuSeparator />
              <DropdownMenuItem
                variant="destructive"
                onSelect={() => {
                  if (
                    confirm(
                      `Remove ${channel.name}? Conversations are kept; the number stops receiving messages here.`,
                    )
                  )
                    run(() => removeChannel(channel.id));
                }}
              >
                Remove
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
        </div>
      </CardHeader>
      <CardContent className="grid gap-2 text-sm">
        <dl className="text-muted-foreground grid grid-cols-[auto_1fr] gap-x-4 gap-y-1 text-xs">
          <dt>Phone number ID</dt>
          <dd className="text-foreground font-mono">{channel.phone_number_id}</dd>
          <dt>WABA ID</dt>
          <dd className="text-foreground font-mono">{channel.waba_id}</dd>
          <dt>Catalogue</dt>
          <dd className="text-foreground">{channel.catalog_id ?? "—"}</dd>
          <dt>Token</dt>
          <dd className="text-foreground">
            {channel.own_token ? "stored on channel (encrypted)" : "from environment"}
          </dd>
          <dt>Webhook</dt>
          <dd className="text-foreground">
            {channel.subscribed ? "subscribed" : "not confirmed — press Subscribe webhook"}
          </dd>
          <dt>Templates</dt>
          <dd className="text-foreground">
            {channel.templates.approved} approved / {channel.templates.total}
          </dd>
          <dt>Rate limit</dt>
          <dd className="text-foreground">{channel.send_rate_per_sec} msg/s</dd>
          <dt>Profile</dt>
          <dd className="text-foreground">
            {channel.business_profile.about || channel.business_profile.description || "—"}
            {channel.business_profile.address && (
              <span className="text-muted-foreground"> · {channel.business_profile.address}</span>
            )}
          </dd>
          <dt>Last sync</dt>
          <dd className="text-foreground">
            {channel.last_synced_at ? new Date(channel.last_synced_at).toLocaleString() : "never"}
          </dd>
        </dl>
      </CardContent>
      <EditChannelDialog channel={channel} open={editing} onOpenChange={setEditing} />
      <ProfileDialog channel={channel} open={profile} onOpenChange={setProfile} />
    </Card>
  );
}

function EditChannelDialog({
  channel,
  open,
  onOpenChange,
}: {
  channel: ChannelView;
  open: boolean;
  onOpenChange: (o: boolean) => void;
}) {
  const [name, setName] = useState(channel.name);
  const [catalog, setCatalog] = useState(channel.catalog_id ?? "");
  const [rate, setRate] = useState(String(channel.send_rate_per_sec));
  const [status, setStatus] = useState<"active" | "paused">(
    channel.status === "paused" ? "paused" : "active",
  );
  const [token, setToken] = useState("");
  const [clearToken, setClearToken] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();

  function submit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    startTransition(async () => {
      const res = await updateChannel(channel.id, {
        name,
        catalog_id: catalog,
        send_rate_per_sec: Number(rate),
        status,
        access_token: token,
        clear_token: clearToken,
      });
      if (!res.ok) {
        setError(res.error);
        return;
      }
      toast.success(res.message);
      setToken("");
      onOpenChange(false);
    });
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Edit {channel.name}</DialogTitle>
          <DialogDescription>Name, catalogue, throughput and token.</DialogDescription>
        </DialogHeader>
        <form onSubmit={submit} className="flex flex-col gap-4">
          <div className="grid gap-2">
            <Label htmlFor={`n-${channel.id}`}>Name</Label>
            <Input
              id={`n-${channel.id}`}
              value={name}
              onChange={(e) => setName(e.target.value)}
              required
            />
          </div>
          <div className="grid gap-2">
            <Label htmlFor={`c-${channel.id}`}>Catalogue ID</Label>
            <Input
              id={`c-${channel.id}`}
              value={catalog}
              onChange={(e) => setCatalog(e.target.value)}
              placeholder="Meta catalogue id (optional)"
            />
          </div>
          <div className="grid grid-cols-2 gap-4">
            <div className="grid gap-2">
              <Label htmlFor={`r-${channel.id}`}>Max messages / second</Label>
              <Input
                id={`r-${channel.id}`}
                type="number"
                min={1}
                max={1000}
                value={rate}
                onChange={(e) => setRate(e.target.value)}
              />
            </div>
            <div className="grid gap-2">
              <Label>Status</Label>
              <Select value={status} onValueChange={(v) => setStatus(v as "active" | "paused")}>
                <SelectTrigger className="w-full">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="active">Active</SelectItem>
                  <SelectItem value="paused">Paused (no sends)</SelectItem>
                </SelectContent>
              </Select>
            </div>
          </div>
          <div className="grid gap-2">
            <Label htmlFor={`t-${channel.id}`}>Replace System User token</Label>
            <Input
              id={`t-${channel.id}`}
              type="password"
              autoComplete="off"
              value={token}
              onChange={(e) => setToken(e.target.value)}
              placeholder={
                channel.own_token
                  ? "stored — paste to replace"
                  : "none stored — using environment token"
              }
              disabled={clearToken}
            />
            {channel.own_token && (
              <label className="flex items-center gap-2 text-xs">
                <input
                  type="checkbox"
                  checked={clearToken}
                  onChange={(e) => setClearToken(e.target.checked)}
                />{" "}
                Remove the stored token and use META_SYSTEM_USER_TOKEN
              </label>
            )}
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

function ProfileDialog({
  channel,
  open,
  onOpenChange,
}: {
  channel: ChannelView;
  open: boolean;
  onOpenChange: (o: boolean) => void;
}) {
  const p = channel.business_profile;
  const [about, setAbout] = useState(p.about ?? "");
  const [address, setAddress] = useState(p.address ?? "");
  const [description, setDescription] = useState(p.description ?? "");
  const [email, setEmail] = useState(p.email ?? "");
  const [vertical, setVertical] = useState<string>(p.vertical ?? "HEALTH");
  const [websites, setWebsites] = useState((p.websites ?? []).join("\n"));
  const [error, setError] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();

  function submit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    startTransition(async () => {
      const res = await updateChannelProfile(channel.id, {
        about,
        address,
        description,
        email,
        vertical: vertical as (typeof BUSINESS_VERTICALS)[number],
        websites: websites
          .split(/\n+/)
          .map((w) => w.trim())
          .filter(Boolean),
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
          <DialogTitle>Business profile · {channel.display_phone ?? channel.name}</DialogTitle>
          <DialogDescription>
            What patients see when they open the number&apos;s profile in WhatsApp.
          </DialogDescription>
        </DialogHeader>
        <form onSubmit={submit} className="flex flex-col gap-4">
          <div className="grid gap-2">
            <Label htmlFor="bp-about">About (max 139)</Label>
            <Input
              id="bp-about"
              value={about}
              onChange={(e) => setAbout(e.target.value)}
              maxLength={139}
            />
          </div>
          <div className="grid gap-2">
            <Label htmlFor="bp-desc">Description</Label>
            <Textarea
              id="bp-desc"
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              maxLength={512}
              rows={3}
            />
          </div>
          <div className="grid gap-2">
            <Label htmlFor="bp-addr">Address</Label>
            <Input
              id="bp-addr"
              value={address}
              onChange={(e) => setAddress(e.target.value)}
              maxLength={256}
            />
          </div>
          <div className="grid grid-cols-2 gap-4">
            <div className="grid gap-2">
              <Label htmlFor="bp-email">Email</Label>
              <Input
                id="bp-email"
                type="email"
                value={email}
                onChange={(e) => setEmail(e.target.value)}
              />
            </div>
            <div className="grid gap-2">
              <Label>Vertical</Label>
              <Select value={vertical} onValueChange={setVertical}>
                <SelectTrigger className="w-full">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {BUSINESS_VERTICALS.map((v) => (
                    <SelectItem key={v} value={v}>
                      {v}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
          </div>
          <div className="grid gap-2">
            <Label htmlFor="bp-web">Websites (one per line, max 2)</Label>
            <Textarea
              id="bp-web"
              value={websites}
              onChange={(e) => setWebsites(e.target.value)}
              rows={2}
              placeholder="https://"
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
              {pending && <Loader2 className="animate-spin" />} Save to Meta
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
