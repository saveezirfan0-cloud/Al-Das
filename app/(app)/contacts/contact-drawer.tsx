"use client";

import * as React from "react";
import { ContactAppointments } from "./contact-appointments";
import { ContactConversations } from "./contact-conversations";
import { ContactEnquiries } from "./contact-enquiries";
import { ContactHistory, ContactInvoices, ContactTasks } from "./patient-360-tabs";
import dynamic from "next/dynamic";

// The Documents tab brings the uploader and the photo editor; load them only when someone opens the tab.
const ContactDocuments = dynamic(
  () => import("./documents/documents-tab").then((m) => m.ContactDocuments),
  { ssr: false, loading: () => <Loader2 className="text-muted-foreground size-4 animate-spin" /> },
);
import { Loader2, MessageSquare, Phone, Plus, Save, Star, Trash2, GitMerge } from "lucide-react";
import { toast } from "sonner";

import { useConfirm } from "@/components/shell/confirm-dialog";
import { Avatar, AvatarFallback } from "@/components/ui/avatar";
import { Checkbox } from "@/components/ui/checkbox";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { MultiSelect } from "@/components/ui/multi-select";
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
} from "@/components/ui/sheet";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Textarea } from "@/components/ui/textarea";
import { initials } from "@/components/shell/user-menu";
import { Timeline } from "@/components/timeline/timeline";
import { displayName, formatDateTime, tagClass } from "@/lib/contacts/format";
import { formatPhone } from "@/lib/phone";

import {
  addContactPhone,
  addNote,
  createTag,
  deleteContacts,
  getContact,
  makePhonePrimary,
  removeContactPhone,
  setContactTags,
  setNoReviewRequests,
  updateContact,
  type ContactDetail,
} from "./actions";
import { ContactForm, toContactInput, type ContactFormValues } from "./contact-form";
import { MergeDialog } from "./merge-dialog";
import type { ContactsBootstrap, TagOption } from "./types";

function toForm(d: ContactDetail): ContactFormValues {
  const c = d.contact;
  return {
    first_name: c.first_name,
    last_name: c.last_name,
    phone: c.phone_e164 ?? "",
    email: c.email ?? "",
    gender: c.gender ?? "",
    nationality: c.nationality ?? "",
    country: c.country ?? "",
    language: c.language ?? "",
    dob: c.dob ?? "",
    label: c.label ?? "",
    owner_id: c.owner_id ?? "",
    assignee_id: c.assignee_id ?? "",
    source: c.source,
    external_id: c.external_id ?? "",
    promotions_opt_in: c.promotions_opt_in,
    stop_marketing: c.stop_marketing,
    location_id: c.location_id ?? "",
    custom: c.custom,
  };
}

export function ContactDrawer({
  contactId,
  onClose,
  bootstrap,
  tags,
  onTagCreated,
  onChanged,
  onOpenContact,
}: {
  contactId: string | null;
  onClose: () => void;
  bootstrap: ContactsBootstrap;
  tags: TagOption[];
  onTagCreated: (t: TagOption) => void;
  onChanged: () => void;
  onOpenContact: (id: string) => void;
}) {
  const [detail, setDetail] = React.useState<ContactDetail | null>(null);
  const [form, setForm] = React.useState<ContactFormValues | null>(null);
  const [dirty, setDirty] = React.useState(false);
  const [loading, setLoading] = React.useState(false);
  const [pending, startTransition] = React.useTransition();
  const [newPhone, setNewPhone] = React.useState("");
  const [note, setNote] = React.useState("");
  const [mergeOpen, setMergeOpen] = React.useState(false);
  const [confirm, confirmDialog] = useConfirm();

  // Callbacks from the workspace are recreated on every render; keep the latest
  // in refs so the load effect only depends on the contact id.
  const onCloseRef = React.useRef(onClose);
  onCloseRef.current = onClose;

  const load = React.useCallback(async () => {
    if (!contactId) return;
    setLoading(true);
    const res = await getContact(contactId);
    setLoading(false);
    if (!res.ok) {
      toast.error(res.error);
      onCloseRef.current();
      return;
    }
    setDetail(res.data);
    setForm(toForm(res.data));
    setDirty(false);
  }, [contactId]);

  React.useEffect(() => {
    if (contactId) void load();
    else {
      setDetail(null);
      setForm(null);
    }
  }, [contactId, load]);

  const canManage = bootstrap.can.manage;

  function run(
    fn: () => Promise<{ ok: boolean; message?: string; error?: string }>,
    after?: () => void,
  ) {
    startTransition(async () => {
      const res = await fn();
      if (!res.ok) {
        toast.error(res.error);
        return;
      }
      if (res.message) toast.success(res.message);
      await load();
      onChanged();
      after?.();
    });
  }

  const contact = detail?.contact;
  const name = contact ? displayName(contact) : "";

  return (
    <Sheet open={!!contactId} onOpenChange={(o) => !o && onClose()}>
      <SheetContent side="right" className="flex w-full flex-col gap-0 p-0 sm:max-w-5xl">
        {loading && !detail ? (
          <div className="text-muted-foreground flex flex-1 items-center justify-center">
            <Loader2 className="size-5 animate-spin" />
          </div>
        ) : contact && form ? (
          <>
            <SheetHeader className="border-b">
              <div className="flex items-center gap-3 pr-8">
                <Avatar className="size-10">
                  <AvatarFallback>{initials(name, contact.email ?? "")}</AvatarFallback>
                </Avatar>
                <div className="min-w-0 flex-1">
                  <SheetTitle className="truncate">{name}</SheetTitle>
                  <SheetDescription className="flex flex-wrap items-center gap-2">
                    {contact.phone_e164 && (
                      <span className="tabular-nums">{formatPhone(contact.phone_e164)}</span>
                    )}
                    <Badge variant="outline" className="gap-1">
                      <MessageSquare className="size-3" /> WhatsApp
                    </Badge>
                    {contact.stop_marketing && <Badge variant="destructive">Stop marketing</Badge>}
                    {contact.external_id && (
                      <Badge variant="secondary">Unite {contact.external_id}</Badge>
                    )}
                  </SheetDescription>
                  {/* Patient 360: who looks after the patient and where they are usually seen. */}
                  <p className="text-muted-foreground mt-0.5 flex flex-wrap gap-x-3 text-xs">
                    <span>
                      Owner:{" "}
                      <span className="text-foreground">
                        {contact.owner_id
                          ? (bootstrap.users.find((u) => u.id === contact.owner_id)?.label ??
                            "Former member")
                          : "Nobody yet"}
                      </span>
                    </span>
                    <span>
                      Home branch:{" "}
                      <span className="text-foreground">
                        {contact.location_id
                          ? (bootstrap.branches.find((b) => b.id === contact.location_id)?.name ??
                            "Other branch")
                          : "Not set"}
                      </span>
                    </span>
                  </p>
                </div>
                {canManage && (
                  <div className="flex gap-1">
                    <Button variant="outline" size="sm" onClick={() => setMergeOpen(true)}>
                      <GitMerge /> Merge
                    </Button>
                    <Button
                      variant="ghost"
                      size="icon-sm"
                      aria-label="Delete contact"
                      className="text-destructive"
                      onClick={async () => {
                        const ok = await confirm({
                          title: "Delete this patient?",
                          description:
                            "They disappear from lists and campaigns and can be restored from Settings, Recently deleted for a while.",
                          confirmLabel: "Delete",
                          destructive: true,
                        });
                        if (ok) run(() => deleteContacts([contact.id]), onClose);
                      }}
                    >
                      <Trash2 />
                    </Button>
                  </div>
                )}
              </div>
            </SheetHeader>

            <div className="grid min-h-0 flex-1 grid-cols-1 overflow-hidden lg:grid-cols-[minmax(0,5fr)_minmax(0,6fr)]">
              {/* Left: fields */}
              <div className="flex min-h-0 flex-col gap-4 overflow-y-auto border-r p-4">
                <section className="flex flex-col gap-2">
                  <h3 className="text-muted-foreground text-xs font-semibold tracking-wide uppercase">
                    Tags
                  </h3>
                  <MultiSelect
                    options={tags.map((t) => ({ value: t.id, label: t.name }))}
                    value={contact.tags.map((t) => t.id)}
                    disabled={!canManage}
                    placeholder="Add tags…"
                    onChange={(ids) => run(() => setContactTags(contact.id, ids))}
                    onCreate={
                      canManage
                        ? async (label) => {
                            const res = await createTag({ name: label });
                            if (!res.ok) {
                              toast.error(res.error);
                              return null;
                            }
                            onTagCreated(res.data);
                            return res.data.id;
                          }
                        : undefined
                    }
                  />
                  <div className="flex flex-wrap gap-1">
                    {contact.tags.map((t) => (
                      <span
                        key={t.id}
                        className={`rounded px-1.5 py-0.5 text-xs ${tagClass(t.color)}`}
                      >
                        {t.name}
                      </span>
                    ))}
                  </div>
                </section>

                <section className="flex flex-col gap-2">
                  <div className="flex items-center justify-between">
                    <h3 className="text-muted-foreground text-xs font-semibold tracking-wide uppercase">
                      Details
                    </h3>
                    {canManage && (
                      <Button
                        size="sm"
                        disabled={!dirty || pending}
                        onClick={() =>
                          run(
                            () => updateContact(contact.id, toContactInput(form)),
                            () => setDirty(false),
                          )
                        }
                      >
                        {pending ? <Loader2 className="animate-spin" /> : <Save />} Save
                      </Button>
                    )}
                  </div>
                  <fieldset disabled={!canManage} className="contents">
                    <ContactForm
                      value={form}
                      onChange={(v) => {
                        setForm(v);
                        setDirty(true);
                      }}
                      users={bootstrap.users}
                      customFields={bootstrap.customFields}
                      branches={bootstrap.branches}
                      idPrefix={`c-${contact.id.slice(0, 8)}`}
                    />
                  </fieldset>
                </section>

                <section className="flex flex-col gap-2">
                  <h3 className="text-muted-foreground text-xs font-semibold tracking-wide uppercase">
                    Review requests
                  </h3>
                  <label className="flex items-start gap-2 text-sm">
                    <Checkbox
                      className="mt-0.5"
                      checked={!!contact.no_review_requests_at}
                      disabled={!canManage || pending}
                      onCheckedChange={(v) => run(() => setNoReviewRequests(contact.id, !!v))}
                    />
                    <span>
                      Do not ask for a Google review
                      <span className="text-muted-foreground block text-xs">
                        Use this for a patient who has passed away, a placeholder record, or someone
                        who asked not to be asked.
                      </span>
                    </span>
                  </label>
                </section>

                <section className="flex flex-col gap-2">
                  <h3 className="text-muted-foreground text-xs font-semibold tracking-wide uppercase">
                    Alternate phones
                  </h3>
                  {detail.phones.length === 0 && (
                    <p className="text-muted-foreground text-sm">None.</p>
                  )}
                  <ul className="flex flex-col gap-1">
                    {detail.phones.map((p) => (
                      <li key={p.id} className="flex items-center gap-2 text-sm">
                        <Phone className="text-muted-foreground size-3.5" />
                        <span className="tabular-nums">{formatPhone(p.phone_e164)}</span>
                        {p.label && (
                          <span className="text-muted-foreground text-xs">{p.label}</span>
                        )}
                        {canManage && (
                          <span className="ml-auto flex gap-0.5">
                            <Button
                              variant="ghost"
                              size="icon-sm"
                              aria-label="Make primary"
                              title="Make primary"
                              onClick={() => run(() => makePhonePrimary(p.id))}
                            >
                              <Star className="size-3.5" />
                            </Button>
                            <Button
                              variant="ghost"
                              size="icon-sm"
                              aria-label="Remove phone"
                              onClick={() => run(() => removeContactPhone(p.id))}
                            >
                              <Trash2 className="size-3.5" />
                            </Button>
                          </span>
                        )}
                      </li>
                    ))}
                  </ul>
                  {canManage && (
                    <form
                      className="flex gap-2"
                      onSubmit={(e) => {
                        e.preventDefault();
                        if (!newPhone.trim()) return;
                        run(
                          () => addContactPhone(contact.id, newPhone),
                          () => setNewPhone(""),
                        );
                      }}
                    >
                      <Input
                        value={newPhone}
                        onChange={(e) => setNewPhone(e.target.value)}
                        placeholder="+971 5x xxx xxxx"
                        inputMode="tel"
                        aria-label="New alternate phone"
                        className="h-8"
                      />
                      <Button type="submit" size="sm" variant="outline" disabled={pending}>
                        <Plus /> Add
                      </Button>
                    </form>
                  )}
                </section>

                {detail.segments.length > 0 && (
                  <section className="flex flex-col gap-1">
                    <h3 className="text-muted-foreground text-xs font-semibold tracking-wide uppercase">
                      Segments
                    </h3>
                    <div className="flex flex-wrap gap-1">
                      {detail.segments.map((s) => (
                        <Badge key={s.id} variant="outline">
                          {s.name}
                        </Badge>
                      ))}
                    </div>
                  </section>
                )}
                <p className="text-muted-foreground text-xs">
                  Created {formatDateTime(contact.created_at, bootstrap.timezone)} · Updated{" "}
                  {formatDateTime(contact.updated_at, bootstrap.timezone)}
                  {contact.last_interaction_at &&
                    ` · Last interaction ${formatDateTime(contact.last_interaction_at, bootstrap.timezone)}`}
                </p>
              </div>

              {/* Right: tabs */}
              <Tabs defaultValue="timeline" className="flex min-h-0 flex-col gap-0 p-4">
                <TabsList className="h-auto w-full flex-wrap justify-start">
                  <TabsTrigger value="timeline">Timeline</TabsTrigger>
                  <TabsTrigger value="history">History</TabsTrigger>
                  <TabsTrigger value="inbox">Inbox</TabsTrigger>
                  <TabsTrigger value="enquiries">Enquiries</TabsTrigger>
                  <TabsTrigger value="appointments">Appointments</TabsTrigger>
                  {bootstrap.can.tasksView && <TabsTrigger value="tasks">Tasks</TabsTrigger>}
                  {bootstrap.can.invoicesView && (
                    <TabsTrigger value="invoices">Invoices</TabsTrigger>
                  )}
                  <TabsTrigger value="campaigns">Campaigns</TabsTrigger>
                  {bootstrap.can.documentsView && (
                    <TabsTrigger value="documents">Documents</TabsTrigger>
                  )}
                </TabsList>
                <TabsContent value="timeline" className="flex min-h-0 flex-1 flex-col gap-3 pt-3">
                  {canManage && (
                    <form
                      className="flex flex-col gap-2"
                      onSubmit={(e) => {
                        e.preventDefault();
                        run(
                          () => addNote(contact.id, note),
                          () => setNote(""),
                        );
                      }}
                    >
                      <Textarea
                        value={note}
                        onChange={(e) => setNote(e.target.value)}
                        placeholder="Add a note…"
                        rows={2}
                        aria-label="New note"
                      />
                      <div className="flex justify-end">
                        <Button
                          type="submit"
                          size="sm"
                          variant="outline"
                          disabled={pending || !note.trim()}
                        >
                          Add note
                        </Button>
                      </div>
                    </form>
                  )}
                  <Timeline events={detail.timeline} timezone={bootstrap.timezone} />
                </TabsContent>
                <TabsContent value="history" className="min-h-0 overflow-y-auto pt-3">
                  <ContactHistory contactId={contact.id} timezone={bootstrap.timezone} />
                </TabsContent>
                {bootstrap.can.tasksView && (
                  <TabsContent value="tasks" className="min-h-0 overflow-y-auto pt-3">
                    <ContactTasks
                      contactId={contact.id}
                      timezone={bootstrap.timezone}
                      users={bootstrap.users}
                    />
                  </TabsContent>
                )}
                {bootstrap.can.invoicesView && (
                  <TabsContent value="invoices" className="min-h-0 overflow-y-auto pt-3">
                    <ContactInvoices contactId={contact.id} />
                  </TabsContent>
                )}
                <TabsContent value="inbox" className="pt-3">
                  <ContactConversations contactId={contact.id} />
                </TabsContent>
                <TabsContent value="enquiries" className="pt-3">
                  <ContactEnquiries
                    contactId={contact.id}
                    timezone={bootstrap.timezone}
                    canView={bootstrap.can.enquiriesView}
                    canCreate={bootstrap.can.enquiriesManage}
                  />
                </TabsContent>
                <TabsContent value="appointments" className="pt-3">
                  <ContactAppointments contactId={contact.id} />
                </TabsContent>
                <TabsContent value="campaigns" className="pt-3">
                  {detail && detail.campaigns.length > 0 ? (
                    <ul className="divide-y rounded-lg border text-sm">
                      {detail.campaigns.map((c) => (
                        <li
                          key={c.id}
                          className="flex items-center justify-between gap-3 px-3 py-2"
                        >
                          <a
                            href={`/campaigns?c=${c.campaign_id}`}
                            className="font-medium hover:underline"
                          >
                            {c.name}
                          </a>
                          <span className="text-muted-foreground text-xs">
                            {c.status === "skipped" && c.skip_reason
                              ? `skipped: ${c.skip_reason.replace(/_/g, " ")}`
                              : c.status}
                            {c.replied_at ? " · replied" : ""}
                          </span>
                        </li>
                      ))}
                    </ul>
                  ) : (
                    <Placeholder text="Campaigns this contact was part of appear here." />
                  )}
                </TabsContent>
                {bootstrap.can.documentsView && (
                  <TabsContent value="documents" className="pt-3">
                    <ContactDocuments
                      contactId={contact.id}
                      canView={bootstrap.can.documentsView}
                      timezone={bootstrap.timezone}
                    />
                  </TabsContent>
                )}
              </Tabs>
            </div>

            {confirmDialog}
            {canManage && (
              <MergeDialog
                open={mergeOpen}
                onOpenChange={setMergeOpen}
                primary={contact}
                onMerged={() => {
                  setMergeOpen(false);
                  void load();
                  onChanged();
                }}
                onOpenContact={onOpenContact}
              />
            )}
          </>
        ) : null}
      </SheetContent>
    </Sheet>
  );
}

function Placeholder({ text }: { text: string }) {
  return (
    <p className="text-muted-foreground rounded-lg border border-dashed p-6 text-center text-sm">
      {text}
    </p>
  );
}
