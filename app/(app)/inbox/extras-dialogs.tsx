"use client";

/**
 * Inbox extras dialogs (Sanoflow parity G11): forward a message, share a contact card, send a catalogue product,
 * move a chat to a new contact. Loaded on demand (next/dynamic) so the inbox's first load does not grow.
 */
import { useRouter } from "next/navigation";
import { useEffect, useState, useTransition } from "react";
import { Loader2 } from "lucide-react";
import { toast } from "sonner";

import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
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
import { Textarea } from "@/components/ui/textarea";
import { CHANNEL_TYPE_LABEL, channelTypeOf } from "@/lib/channels/types";
import { PRODUCT_LIMITS, parseRetailerIds } from "@/lib/inbox/extras";
import { cn } from "@/lib/utils";

import {
  forwardMessage,
  listForwardTargets,
  sendCatalogProduct,
  sendContactCard,
  unlinkConversationContact,
  type ForwardTarget,
} from "./extras-actions";

type DialogProps = { open: boolean; onOpenChange: (o: boolean) => void };

function ErrorLine({ error }: { error: string | null }) {
  if (!error) return null;
  return (
    <p className="text-destructive text-sm" role="alert">
      {error}
    </p>
  );
}

// ---------------------------------------------------------------------------
// Forward
// ---------------------------------------------------------------------------

export function ForwardDialog({
  open,
  onOpenChange,
  messageId,
  fromConversationId,
}: DialogProps & { messageId: string | null; fromConversationId: string }) {
  const [q, setQ] = useState("");
  const [targets, setTargets] = useState<ForwardTarget[] | null>(null);
  const [picked, setPicked] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();

  useEffect(() => {
    if (!open) return;
    setPicked(null);
    setError(null);
    let live = true;
    const t = setTimeout(async () => {
      const r = await listForwardTargets({ exclude: fromConversationId, q: q || undefined });
      if (!live) return;
      if (r.ok) setTargets(r.data);
      else setError(r.error);
    }, 250);
    return () => {
      live = false;
      clearTimeout(t);
    };
  }, [open, q, fromConversationId]);

  function submit() {
    if (!messageId || !picked) return;
    setError(null);
    startTransition(async () => {
      const r = await forwardMessage({ message_id: messageId, target_conversation_id: picked });
      if (!r.ok) {
        setError(r.error);
        return;
      }
      toast.success(r.message ?? "Message forwarded.");
      onOpenChange(false);
    });
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Forward message</DialogTitle>
          <DialogDescription>
            The other person will see this message as if you sent it. Only conversations with an
            open 24-hour window are listed.
          </DialogDescription>
        </DialogHeader>
        <div className="flex flex-col gap-3">
          <div className="grid gap-2">
            <Label htmlFor="fw-search">Search</Label>
            <Input
              id="fw-search"
              value={q}
              onChange={(e) => setQ(e.target.value)}
              placeholder="Name or number"
              autoComplete="off"
            />
          </div>
          <div
            role="radiogroup"
            aria-label="Conversation to forward to"
            className="flex max-h-72 flex-col gap-1 overflow-y-auto"
          >
            {targets === null ? (
              <p className="text-muted-foreground text-sm">Loading…</p>
            ) : targets.length === 0 ? (
              <p className="text-muted-foreground text-sm">
                No conversation with an open window matches.
              </p>
            ) : (
              targets.map((t) => (
                <button
                  key={t.id}
                  type="button"
                  role="radio"
                  aria-checked={picked === t.id}
                  onClick={() => setPicked(t.id)}
                  className={cn(
                    "hover:bg-accent flex min-h-11 items-center justify-between gap-2 rounded-md border px-3 py-2 text-left text-sm",
                    picked === t.id && "border-primary bg-accent",
                  )}
                >
                  <span className="min-w-0 truncate font-medium">{t.name}</span>
                  <span className="text-muted-foreground shrink-0 text-xs">
                    {t.channel_name || CHANNEL_TYPE_LABEL[channelTypeOf(t.channel_type)]}
                  </span>
                </button>
              ))
            )}
          </div>
          <ErrorLine error={error} />
        </div>
        <DialogFooter>
          <Button type="button" variant="ghost" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button type="button" onClick={submit} disabled={pending || !picked || !messageId}>
            {pending && <Loader2 className="animate-spin" />} Forward
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

// ---------------------------------------------------------------------------
// Contact card
// ---------------------------------------------------------------------------

export function ContactCardDialog({
  open,
  onOpenChange,
  conversationId,
}: DialogProps & { conversationId: string }) {
  const [name, setName] = useState("");
  const [phone, setPhone] = useState("");
  const [company, setCompany] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();

  function submit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    startTransition(async () => {
      const r = await sendContactCard({
        conversation_id: conversationId,
        name,
        phone,
        company: company || undefined,
      });
      if (!r.ok) {
        setError(r.error);
        return;
      }
      toast.success(r.message ?? "Contact card sent.");
      setName("");
      setPhone("");
      setCompany("");
      onOpenChange(false);
    });
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Share a contact card</DialogTitle>
          <DialogDescription>
            For a doctor&apos;s line, another branch or a lab. Type the details: cards are never
            filled from patient records.
          </DialogDescription>
        </DialogHeader>
        <form onSubmit={submit} className="flex flex-col gap-4">
          <div className="grid gap-2">
            <Label htmlFor="cc-name">Name on the card</Label>
            <Input id="cc-name" value={name} onChange={(e) => setName(e.target.value)} required />
          </div>
          <div className="grid gap-2">
            <Label htmlFor="cc-phone">Phone</Label>
            <Input
              id="cc-phone"
              value={phone}
              onChange={(e) => setPhone(e.target.value)}
              placeholder="+971 4 000 0000"
              inputMode="tel"
              required
            />
          </div>
          <div className="grid gap-2">
            <Label htmlFor="cc-company">Organisation (optional)</Label>
            <Input id="cc-company" value={company} onChange={(e) => setCompany(e.target.value)} />
          </div>
          <ErrorLine error={error} />
          <DialogFooter>
            <Button type="button" variant="ghost" onClick={() => onOpenChange(false)}>
              Cancel
            </Button>
            <Button type="submit" disabled={pending}>
              {pending && <Loader2 className="animate-spin" />} Send card
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

// ---------------------------------------------------------------------------
// Catalogue product
// ---------------------------------------------------------------------------

export function ProductDialog({
  open,
  onOpenChange,
  conversationId,
}: DialogProps & { conversationId: string }) {
  const [ids, setIds] = useState("");
  const [header, setHeader] = useState("");
  const [body, setBody] = useState("");
  const [footer, setFooter] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();
  const parsed = parseRetailerIds(ids);
  const several = parsed.length > 1;

  function submit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    startTransition(async () => {
      const r = await sendCatalogProduct({
        conversation_id: conversationId,
        retailer_ids: parsed,
        header: header || undefined,
        body: body || undefined,
        footer: footer || undefined,
      });
      if (!r.ok) {
        setError(r.error);
        return;
      }
      toast.success(r.message ?? "Product sent.");
      setIds("");
      setHeader("");
      setBody("");
      setFooter("");
      onOpenChange(false);
    });
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Send a catalogue product</DialogTitle>
          <DialogDescription>
            Type the product IDs (content IDs) from this number&apos;s WhatsApp catalogue. Up to{" "}
            {PRODUCT_LIMITS.items}, separated by commas or spaces.
          </DialogDescription>
        </DialogHeader>
        <form onSubmit={submit} className="flex flex-col gap-4">
          <div className="grid gap-2">
            <Label htmlFor="pr-ids">Product IDs</Label>
            <Input
              id="pr-ids"
              value={ids}
              onChange={(e) => setIds(e.target.value)}
              placeholder="e.g. checkup-basic, dental-clean"
              autoComplete="off"
              required
            />
            <p className="text-muted-foreground text-xs" aria-live="polite">
              {parsed.length === 0
                ? "No product yet."
                : several
                  ? `${parsed.length} products: sent as a list (heading and text required).`
                  : "One product."}
            </p>
          </div>
          {several && (
            <div className="grid gap-2">
              <Label htmlFor="pr-header">Heading</Label>
              <Input
                id="pr-header"
                value={header}
                maxLength={PRODUCT_LIMITS.header}
                onChange={(e) => setHeader(e.target.value)}
                required
              />
            </div>
          )}
          <div className="grid gap-2">
            <Label htmlFor="pr-body">Text{several ? "" : " (optional)"}</Label>
            <Textarea
              id="pr-body"
              value={body}
              maxLength={PRODUCT_LIMITS.body}
              onChange={(e) => setBody(e.target.value)}
              rows={3}
              dir="auto"
              required={several}
            />
          </div>
          <div className="grid gap-2">
            <Label htmlFor="pr-footer">Footer (optional)</Label>
            <Input
              id="pr-footer"
              value={footer}
              maxLength={PRODUCT_LIMITS.footer}
              onChange={(e) => setFooter(e.target.value)}
            />
          </div>
          <ErrorLine error={error} />
          <DialogFooter>
            <Button type="button" variant="ghost" onClick={() => onOpenChange(false)}>
              Cancel
            </Button>
            <Button type="submit" disabled={pending || parsed.length === 0}>
              {pending && <Loader2 className="animate-spin" />} Send
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

// ---------------------------------------------------------------------------
// Move the chat to a new contact
// ---------------------------------------------------------------------------

const RELATIONSHIPS = [
  { value: "child", label: "Child" },
  { value: "parent", label: "Parent" },
  { value: "spouse", label: "Spouse" },
  { value: "other", label: "Other" },
] as const;

export function UnlinkDialog({
  open,
  onOpenChange,
  conversationId,
  currentName,
}: DialogProps & { conversationId: string; currentName: string }) {
  const router = useRouter();
  const [first, setFirst] = useState("");
  const [last, setLast] = useState("");
  const [keep, setKeep] = useState(true);
  const [relationship, setRelationship] =
    useState<(typeof RELATIONSHIPS)[number]["value"]>("other");
  const [error, setError] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();

  function submit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    startTransition(async () => {
      const r = await unlinkConversationContact({
        conversation_id: conversationId,
        first_name: first,
        last_name: last,
        keep_household: keep,
        relationship,
      });
      if (!r.ok) {
        setError(r.error);
        return;
      }
      toast.success(r.message ?? "Chat moved.");
      setFirst("");
      setLast("");
      onOpenChange(false);
      router.refresh();
    });
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Move this chat to a new contact</DialogTitle>
          <DialogDescription>
            Use this when the person writing is not {currentName}, for example on a shared phone. A
            new contact takes over this WhatsApp number and its open chats. {currentName} keeps
            their record, appointments and closed chats, without the number. Messages are never
            deleted.
          </DialogDescription>
        </DialogHeader>
        <form onSubmit={submit} className="flex flex-col gap-4">
          <div className="grid grid-cols-2 gap-2">
            <div className="grid gap-2">
              <Label htmlFor="ul-first">First name</Label>
              <Input id="ul-first" value={first} onChange={(e) => setFirst(e.target.value)} />
            </div>
            <div className="grid gap-2">
              <Label htmlFor="ul-last">Last name</Label>
              <Input id="ul-last" value={last} onChange={(e) => setLast(e.target.value)} />
            </div>
          </div>
          <div className="flex items-start gap-2">
            <Checkbox
              id="ul-keep"
              checked={keep}
              onCheckedChange={(c) => setKeep(c === true)}
              className="mt-0.5"
            />
            <Label htmlFor="ul-keep" className="text-sm leading-snug font-normal">
              Keep {currentName} reachable on this number as a family member of the new contact
              (appointment messages go to this phone and name them)
            </Label>
          </div>
          {keep && (
            <div className="grid gap-2">
              <Label htmlFor="ul-rel">{currentName} is the new contact&apos;s</Label>
              <Select
                value={relationship}
                onValueChange={(v) => setRelationship(v as typeof relationship)}
              >
                <SelectTrigger id="ul-rel" className="w-full">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {RELATIONSHIPS.map((r) => (
                    <SelectItem key={r.value} value={r.value}>
                      {r.label}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
          )}
          <ErrorLine error={error} />
          <DialogFooter>
            <Button type="button" variant="ghost" onClick={() => onOpenChange(false)}>
              Cancel
            </Button>
            <Button type="submit" disabled={pending || (!first.trim() && !last.trim())}>
              {pending && <Loader2 className="animate-spin" />} Move chat
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
