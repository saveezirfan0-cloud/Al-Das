"use client";

import Link from "next/link";
import { useEffect, useState, useTransition } from "react";
import { CalendarPlus, KanbanSquare, Loader2, Merge } from "lucide-react";
import { toast } from "sonner";

import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { ScrollArea } from "@/components/ui/scroll-area";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { cn } from "@/lib/utils";

import { mergeContacts, updateContactFromInbox } from "./actions";
import { MediaBubble } from "./media-bubble";
import type { ConversationDetail, InboxProps } from "./types";

const UNSET = "__unset__";

export function Sidebar({
  selected,
  sidebar,
  perms,
  className,
}: InboxProps & { selected: ConversationDetail; className?: string }) {
  const c = selected.contact;
  const [form, setForm] = useState(toForm(c));
  const [pending, startTransition] = useTransition();
  useEffect(() => setForm(toForm(c)), [c]);
  const editable = perms.contactsManage;

  function save(e: React.FormEvent) {
    e.preventDefault();
    startTransition(async () => {
      const r = await updateContactFromInbox({
        contact_id: c.id,
        ...form,
        gender: form.gender as "" | "female" | "male" | "other" | "unknown",
      });
      if (r.ok) toast.success(r.message);
      else toast.error(r.error);
    });
  }

  function merge(dupId: string) {
    if (
      !confirm(
        "Merge that contact into this one? Its conversations and phones move here and it is removed.",
      )
    )
      return;
    startTransition(async () => {
      const r = await mergeContacts(c.id, dupId);
      if (r.ok) toast.success(r.message);
      else toast.error(r.error);
    });
  }

  return (
    <aside
      className={cn("bg-background w-80 shrink-0 flex-col border-l", className)}
      aria-label="Conversation details"
    >
      <Tabs defaultValue="contact" className="flex h-full flex-col">
        <TabsList className="m-2 grid grid-cols-4">
          <TabsTrigger value="contact">Contact</TabsTrigger>
          <TabsTrigger value="media">Media</TabsTrigger>
          <TabsTrigger value="merge">
            Merge{sidebar && sidebar.merge.length > 0 ? ` (${sidebar.merge.length})` : ""}
          </TabsTrigger>
          <TabsTrigger value="more">More</TabsTrigger>
        </TabsList>
        <ScrollArea className="flex-1">
          <TabsContent value="contact" className="px-3 pb-4">
            <form onSubmit={save} className="flex flex-col gap-3 text-sm">
              <div className="grid grid-cols-2 gap-2">
                <Field label="First name">
                  <Input
                    value={form.first_name}
                    disabled={!editable}
                    onChange={(e) => setForm((p) => ({ ...p, first_name: e.target.value }))}
                  />
                </Field>
                <Field label="Last name">
                  <Input
                    value={form.last_name}
                    disabled={!editable}
                    onChange={(e) => setForm((p) => ({ ...p, last_name: e.target.value }))}
                  />
                </Field>
              </div>
              <Field label="WhatsApp">
                <p className="text-muted-foreground text-xs">
                  {c.phone_e164 ?? "no phone (username user)"}
                  {c.wa_profile_name && ` · profile “${c.wa_profile_name}”`}
                </p>
              </Field>
              <Field label="Email">
                <Input
                  type="email"
                  value={form.email}
                  disabled={!editable}
                  onChange={(e) => setForm((p) => ({ ...p, email: e.target.value }))}
                />
              </Field>
              <div className="grid grid-cols-2 gap-2">
                <Field label="Gender">
                  <Select
                    value={form.gender || UNSET}
                    onValueChange={(v) => setForm((p) => ({ ...p, gender: v === UNSET ? "" : v }))}
                    disabled={!editable}
                  >
                    <SelectTrigger size="sm" className="w-full">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value={UNSET}>—</SelectItem>
                      <SelectItem value="female">Female</SelectItem>
                      <SelectItem value="male">Male</SelectItem>
                      <SelectItem value="other">Other</SelectItem>
                      <SelectItem value="unknown">Unknown</SelectItem>
                    </SelectContent>
                  </Select>
                </Field>
                <Field label="Date of birth">
                  <Input
                    type="date"
                    value={form.dob}
                    disabled={!editable}
                    onChange={(e) => setForm((p) => ({ ...p, dob: e.target.value }))}
                  />
                </Field>
              </div>
              <div className="grid grid-cols-2 gap-2">
                <Field label="Language">
                  <Input
                    value={form.language}
                    placeholder="en / ar"
                    disabled={!editable}
                    onChange={(e) => setForm((p) => ({ ...p, language: e.target.value }))}
                  />
                </Field>
                <Field label="Nationality">
                  <Input
                    value={form.nationality}
                    disabled={!editable}
                    onChange={(e) => setForm((p) => ({ ...p, nationality: e.target.value }))}
                  />
                </Field>
              </div>
              <label className="flex items-center gap-2 text-xs">
                <Checkbox
                  checked={form.promotions_opt_in}
                  disabled={!editable}
                  onCheckedChange={(v) => setForm((p) => ({ ...p, promotions_opt_in: v === true }))}
                />{" "}
                Promotions opt-in
              </label>
              <label className="flex items-center gap-2 text-xs">
                <Checkbox
                  checked={form.stop_marketing}
                  disabled={!editable}
                  onCheckedChange={(v) => setForm((p) => ({ ...p, stop_marketing: v === true }))}
                />{" "}
                Stop marketing (no campaign templates)
              </label>
              <p className="text-muted-foreground text-[11px]">
                Source: {c.source} · since {new Date(c.created_at).toLocaleDateString()}
                {c.last_interaction_at &&
                  ` · last seen ${new Date(c.last_interaction_at).toLocaleDateString()}`}
              </p>
              {editable && (
                <Button type="submit" size="sm" disabled={pending}>
                  {pending && <Loader2 className="animate-spin" />} Save contact
                </Button>
              )}
              {sidebar && sidebar.otherConversations.length > 0 && (
                <div className="border-t pt-2">
                  <p className="mb-1 text-xs font-medium">Other conversations</p>
                  <ul className="flex flex-col gap-1">
                    {sidebar.otherConversations.map((o) => (
                      <li key={o.id}>
                        <Link
                          href={`/inbox?c=${o.id}`}
                          className="text-muted-foreground hover:text-foreground text-xs"
                        >
                          {o.channel_name} · {o.status} ·{" "}
                          {o.last_message_at
                            ? new Date(o.last_message_at).toLocaleDateString()
                            : ""}
                        </Link>
                      </li>
                    ))}
                  </ul>
                </div>
              )}
            </form>
          </TabsContent>
          <TabsContent value="media" className="px-3 pb-4">
            {!sidebar || sidebar.media.length === 0 ? (
              <p className="text-muted-foreground text-xs">No shared media yet.</p>
            ) : (
              <ul className="grid grid-cols-2 gap-2">
                {sidebar.media.map((m) => (
                  <li
                    key={m.id}
                    className="bg-muted/40 overflow-hidden rounded-md border p-1 text-xs"
                  >
                    <MediaBubble
                      kind={m.kind}
                      path={m.media_path}
                      mime={m.media_mime}
                      filename={m.media_filename}
                    />
                    <p className="text-muted-foreground mt-1 truncate text-[10px]">
                      {new Date(m.at).toLocaleDateString()}
                    </p>
                  </li>
                ))}
              </ul>
            )}
          </TabsContent>
          <TabsContent value="merge" className="px-3 pb-4">
            {!sidebar || sidebar.merge.length === 0 ? (
              <p className="text-muted-foreground text-xs">
                No possible duplicates found (same name or same alternate phone).
              </p>
            ) : (
              <ul className="flex flex-col gap-2">
                {sidebar.merge.map((m) => (
                  <li
                    key={m.id}
                    className="flex items-center justify-between gap-2 rounded-md border p-2 text-xs"
                  >
                    <span className="min-w-0">
                      <span className="block truncate font-medium">{m.name}</span>
                      <span className="text-muted-foreground">
                        {m.phone ?? "no phone"} · {m.reason}
                      </span>
                    </span>
                    {editable && (
                      <Button
                        size="sm"
                        variant="outline"
                        disabled={pending}
                        onClick={() => merge(m.id)}
                      >
                        <Merge /> Merge
                      </Button>
                    )}
                  </li>
                ))}
              </ul>
            )}
          </TabsContent>
          <TabsContent value="more" className="flex flex-col gap-2 px-3 pb-4">
            {perms.enquiriesManage ? (
              <Button variant="outline" size="sm" asChild>
                <Link
                  href={`/enquiries?${new URLSearchParams({
                    new: "1",
                    contact: c.id,
                    ...(selected.channel_id ? { channel: selected.channel_id } : {}),
                  }).toString()}`}
                >
                  <KanbanSquare /> Create enquiry
                </Link>
              </Button>
            ) : (
              <Button variant="outline" size="sm" disabled title="You cannot create enquiries">
                <KanbanSquare /> Create enquiry
              </Button>
            )}
            <Button variant="outline" size="sm" disabled title="Appointments arrive in Phase 6">
              <CalendarPlus /> Book appointment
            </Button>
            <p className="text-muted-foreground text-[11px]">
              Appointments (Phase 6) plug in here.
            </p>
          </TabsContent>
        </ScrollArea>
      </Tabs>
    </aside>
  );
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="grid gap-1">
      <Label className="text-muted-foreground text-[11px]">{label}</Label>
      {children}
    </div>
  );
}

function toForm(c: ConversationDetail["contact"]) {
  return {
    first_name: c.first_name,
    last_name: c.last_name,
    email: c.email ?? "",
    language: c.language ?? "",
    gender: c.gender ?? "",
    nationality: c.nationality ?? "",
    dob: c.dob ?? "",
    promotions_opt_in: c.promotions_opt_in,
    stop_marketing: c.stop_marketing,
  };
}
