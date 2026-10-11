"use client";

import * as React from "react";
import Link from "next/link";
import { Download, ExternalLink, Loader2, Paperclip, Trash2 } from "lucide-react";
import { toast } from "sonner";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
} from "@/components/ui/sheet";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Textarea } from "@/components/ui/textarea";
import { formatDateTime, timeAgo } from "@/lib/contacts/format";
import { displayValue } from "@/lib/portal/field-types";
import type { PortalColumn } from "@/lib/portal/types";
import { SYSTEM_COLUMNS } from "@/lib/portal/types";
import { createClient } from "@/lib/supabase/client";

import {
  createPortalUpload,
  deletePortalAttachment,
  deletePortalRecord,
  getRecordDetail,
  portalAttachmentUrl,
  postComment,
  registerPortalAttachment,
  updatePortalRecord,
  type RecordDetail,
} from "./actions";
import { FieldInput } from "./field-input";
import type { PortalBootstrap } from "./types";

type Values = Record<string, unknown>;

function sameValue(a: unknown, b: unknown) {
  return JSON.stringify(a ?? null) === JSON.stringify(b ?? null);
}

function fmtSize(n: number | null) {
  if (n === null) return "";
  return n > 1_048_576
    ? `${(n / 1_048_576).toFixed(1)} MB`
    : `${Math.max(1, Math.round(n / 1024))} KB`;
}

export function RecordDrawer({
  recordId,
  bootstrap,
  onClose,
  onChanged,
}: {
  recordId: string | null;
  bootstrap: PortalBootstrap;
  onClose: () => void;
  onChanged: () => void;
}) {
  const def = bootstrap.object;
  const [detail, setDetail] = React.useState<RecordDetail | null>(null);
  const [loading, setLoading] = React.useState(false);
  const [values, setValues] = React.useState<Values>({});
  const [errors, setErrors] = React.useState<Record<string, string>>({});
  const [pending, startTransition] = React.useTransition();
  const [reloadKey, setReloadKey] = React.useState(0);

  React.useEffect(() => {
    if (!recordId) {
      setDetail(null);
      return;
    }
    let cancelled = false;
    setLoading(true);
    getRecordDetail(def.key, recordId).then((res) => {
      if (cancelled) return;
      setLoading(false);
      if (!res.ok) {
        toast.error(res.error);
        onClose();
        return;
      }
      setDetail(res.data);
      setValues(res.data.row);
      setErrors({});
    });
    return () => {
      cancelled = true;
    };
    // onClose changes identity every render of the parent; the record id is what matters.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [recordId, def.key, reloadKey]);

  const userName = (id: string | null) =>
    id ? (bootstrap.users.find((u) => u.id === id)?.label ?? "Someone") : "System";

  const editable = def.columns.filter((c) => !c.readOnly);
  const readOnly = [...def.columns.filter((c) => c.readOnly), ...SYSTEM_COLUMNS];
  const dirtyKeys = detail
    ? editable
        .filter((c) => !c.createOnly && !sameValue(values[c.key], detail.row[c.key]))
        .map((c) => c.key)
    : [];
  const title = detail ? String(detail.row[def.titleColumn] ?? "Record") : "";

  function save() {
    if (!detail) return;
    const patch = Object.fromEntries(dirtyKeys.map((k) => [k, values[k]]));
    startTransition(async () => {
      const res = await updatePortalRecord(def.key, detail.row.id, patch);
      if (!res.ok) {
        setErrors(res.fieldErrors ?? {});
        toast.error(res.error);
        return;
      }
      toast.success(res.message ?? "Saved.");
      setReloadKey((k) => k + 1);
      onChanged();
    });
  }

  function remove() {
    if (
      !detail ||
      !confirm(`Delete this ${def.label.toLowerCase()} record? This cannot be undone.`)
    )
      return;
    startTransition(async () => {
      const res = await deletePortalRecord(def.key, detail.row.id);
      if (!res.ok) {
        toast.error(res.error);
        return;
      }
      toast.success("Deleted.");
      onClose();
      onChanged();
    });
  }

  return (
    <Sheet open={!!recordId} onOpenChange={(o) => !o && onClose()}>
      <SheetContent side="right" className="flex w-full flex-col gap-0 p-0 sm:max-w-4xl">
        {loading && !detail ? (
          <div className="text-muted-foreground flex flex-1 items-center justify-center">
            <Loader2 className="size-5 animate-spin" />
          </div>
        ) : detail ? (
          <>
            <SheetHeader className="border-b">
              <div className="flex items-center gap-3 pr-8">
                <div className="min-w-0 flex-1">
                  <SheetTitle className="truncate">{title}</SheetTitle>
                  <SheetDescription>{def.label}</SheetDescription>
                </div>
                {bootstrap.can.write && (
                  <Button size="sm" disabled={dirtyKeys.length === 0 || pending} onClick={save}>
                    {pending && <Loader2 className="animate-spin" />} Save
                  </Button>
                )}
                {bootstrap.can.delete && (
                  <Button
                    variant="ghost"
                    size="icon-sm"
                    aria-label="Delete record"
                    className="text-destructive"
                    disabled={pending}
                    onClick={remove}
                  >
                    <Trash2 />
                  </Button>
                )}
              </div>
            </SheetHeader>

            <div className="grid min-h-0 flex-1 grid-cols-1 overflow-hidden lg:grid-cols-[minmax(0,5fr)_minmax(0,4fr)]">
              <div className="flex min-h-0 flex-col gap-5 overflow-y-auto border-r p-4">
                <fieldset disabled={!bootstrap.can.write} className="flex flex-col gap-3">
                  {editable.map((c) => (
                    <div key={c.key} className="grid gap-1.5">
                      <Label htmlFor={`f-${c.key}`}>
                        {c.label}
                        {c.required && <span className="text-destructive"> *</span>}
                      </Label>
                      <FieldInput
                        id={`f-${c.key}`}
                        column={c}
                        value={values[c.key]}
                        onChange={(v) => setValues((s) => ({ ...s, [c.key]: v }))}
                        linkOptions={bootstrap.linkOptions[c.key]}
                        disabled={!bootstrap.can.write || (c.createOnly ?? false)}
                      />
                      {c.description && (
                        <p className="text-muted-foreground text-xs">{c.description}</p>
                      )}
                      {errors[c.key] && <p className="text-destructive text-xs">{errors[c.key]}</p>}
                    </div>
                  ))}
                </fieldset>

                <LinkedRecords detail={detail} columns={def.columns} />

                <section className="flex flex-col gap-2">
                  <h3 className="text-muted-foreground text-xs font-semibold tracking-wide uppercase">
                    Record info
                  </h3>
                  <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-1 text-sm">
                    {readOnly.map((c) => (
                      <React.Fragment key={c.key}>
                        <dt className="text-muted-foreground">{c.label}</dt>
                        <dd className="min-w-0 truncate">
                          {c.type === "datetime"
                            ? formatDateTime(detail.row[c.key] as string | null, bootstrap.timezone)
                            : displayValue(c, detail.row[c.key]) || "—"}
                        </dd>
                      </React.Fragment>
                    ))}
                  </dl>
                </section>
              </div>

              <Tabs defaultValue="timeline" className="flex min-h-0 flex-col gap-0">
                <TabsList className="m-3 self-start">
                  <TabsTrigger value="timeline">Timeline</TabsTrigger>
                  <TabsTrigger value="comments">Comments ({detail.comments.length})</TabsTrigger>
                  <TabsTrigger value="files">Files ({detail.attachments.length})</TabsTrigger>
                </TabsList>
                <TabsContent value="timeline" className="min-h-0 flex-1 overflow-y-auto px-4 pb-4">
                  <Timeline
                    detail={detail}
                    columns={def.columns}
                    userName={userName}
                    timezone={bootstrap.timezone}
                  />
                </TabsContent>
                <TabsContent value="comments" className="flex min-h-0 flex-1 flex-col px-4 pb-4">
                  <Comments
                    detail={detail}
                    objectKey={def.key}
                    bootstrap={bootstrap}
                    userName={userName}
                    onPosted={() => setReloadKey((k) => k + 1)}
                  />
                </TabsContent>
                <TabsContent value="files" className="min-h-0 flex-1 overflow-y-auto px-4 pb-4">
                  <Files
                    detail={detail}
                    objectKey={def.key}
                    canWrite={bootstrap.can.write}
                    userName={userName}
                    onChanged={() => setReloadKey((k) => k + 1)}
                  />
                </TabsContent>
              </Tabs>
            </div>
          </>
        ) : null}
      </SheetContent>
    </Sheet>
  );
}

function LinkedRecords({ detail, columns }: { detail: RecordDetail; columns: PortalColumn[] }) {
  const links = columns.filter((c) => c.type === "link" && c.link && detail.row[c.key]);
  if (links.length === 0) return null;
  return (
    <section className="flex flex-col gap-2">
      <h3 className="text-muted-foreground text-xs font-semibold tracking-wide uppercase">
        Linked records
      </h3>
      <ul className="flex flex-col gap-1 text-sm">
        {links.map((c) => {
          const id = String(detail.row[c.key]);
          return (
            <li key={c.key} className="flex items-center gap-2">
              <span className="text-muted-foreground">{c.label}:</span>
              <Link
                href={`/portal/${c.link!.object}?record=${id}`}
                className="inline-flex items-center gap-1 underline-offset-2 hover:underline"
              >
                {detail.links[c.key]?.[id] ?? id} <ExternalLink className="size-3" />
              </Link>
            </li>
          );
        })}
      </ul>
    </section>
  );
}

function Timeline({
  detail,
  columns,
  userName,
  timezone,
}: {
  detail: RecordDetail;
  columns: PortalColumn[];
  userName: (id: string | null) => string;
  timezone: string;
}) {
  const label = (k: string) => columns.find((c) => c.key === k)?.label ?? k;
  if (detail.events.length === 0)
    return <p className="text-muted-foreground text-sm">No activity yet.</p>;
  return (
    <ol className="flex flex-col gap-3 text-sm">
      {detail.events.map((e) => {
        const changes =
          e.type === "updated" && e.payload && typeof e.payload === "object"
            ? ((e.payload as { changes?: Record<string, { from: unknown; to: unknown }> })
                .changes ?? {})
            : {};
        return (
          <li key={e.id} className="flex flex-col gap-0.5">
            <div className="flex items-baseline justify-between gap-2">
              <span className="font-medium capitalize">{e.type}</span>
              <span
                className="text-muted-foreground text-xs"
                title={formatDateTime(e.createdAt, timezone)}
              >
                {userName(e.actorId)} · {timeAgo(e.createdAt)}
              </span>
            </div>
            {Object.entries(changes).map(([k, ch]) => (
              <span key={k} className="text-muted-foreground text-xs">
                {label(k)}: <s>{String(ch.from ?? "—")}</s> → {String(ch.to ?? "—")}
              </span>
            ))}
          </li>
        );
      })}
    </ol>
  );
}

function Comments({
  detail,
  objectKey,
  bootstrap,
  userName,
  onPosted,
}: {
  detail: RecordDetail;
  objectKey: string;
  bootstrap: PortalBootstrap;
  userName: (id: string | null) => string;
  onPosted: () => void;
}) {
  const [text, setText] = React.useState("");
  const [pending, startTransition] = React.useTransition();

  function post() {
    startTransition(async () => {
      const res = await postComment(objectKey, detail.row.id, text);
      if (!res.ok) {
        toast.error(res.error);
        return;
      }
      setText("");
      onPosted();
    });
  }

  return (
    <div className="flex min-h-0 flex-1 flex-col gap-3">
      <ul className="flex min-h-0 flex-1 flex-col gap-3 overflow-y-auto text-sm">
        {detail.comments.length === 0 && (
          <li className="text-muted-foreground">No comments yet.</li>
        )}
        {detail.comments.map((c) => (
          <li key={c.id} className="bg-muted/50 rounded-md p-2">
            <div className="text-muted-foreground mb-1 flex justify-between text-xs">
              <span>{userName(c.authorId)}</span>
              <span>{timeAgo(c.createdAt)}</span>
            </div>
            <p className="break-words whitespace-pre-wrap">{c.body}</p>
          </li>
        ))}
      </ul>
      <div className="flex flex-col gap-2">
        <Textarea
          rows={3}
          value={text}
          maxLength={5000}
          placeholder="Write a comment. Use “Mention” to notify a colleague."
          onChange={(e) => setText(e.target.value)}
        />
        <div className="flex items-center justify-between gap-2">
          <Select
            value=""
            onValueChange={(id) => {
              const u = bootstrap.users.find((x) => x.id === id);
              if (u)
                setText(
                  (t) =>
                    `${t}${t && !t.endsWith(" ") ? " " : ""}@[${u.label.replace(/[\]\[()]/g, "")}](${u.id}) `,
                );
            }}
          >
            <SelectTrigger className="w-40">
              <SelectValue placeholder="Mention…" />
            </SelectTrigger>
            <SelectContent>
              {bootstrap.users.map((u) => (
                <SelectItem key={u.id} value={u.id}>
                  {u.label}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          <Button size="sm" disabled={!text.trim() || pending} onClick={post}>
            {pending && <Loader2 className="animate-spin" />} Comment
          </Button>
        </div>
      </div>
    </div>
  );
}

function Files({
  detail,
  objectKey,
  canWrite,
  userName,
  onChanged,
}: {
  detail: RecordDetail;
  objectKey: string;
  canWrite: boolean;
  userName: (id: string | null) => string;
  onChanged: () => void;
}) {
  const [busy, setBusy] = React.useState(false);
  const input = React.useRef<HTMLInputElement>(null);

  async function upload(file: File) {
    setBusy(true);
    try {
      const prep = await createPortalUpload(objectKey, {
        recordId: detail.row.id,
        fileName: file.name,
        contentType: file.type || undefined,
        sizeBytes: file.size,
      });
      if (!prep.ok) return toast.error(prep.error);
      const { error } = await createClient()
        .storage.from("portal-files")
        .uploadToSignedUrl(prep.data.path, prep.data.token, file);
      if (error) return toast.error("Upload failed.");
      const reg = await registerPortalAttachment(objectKey, {
        recordId: detail.row.id,
        path: prep.data.path,
        fileName: file.name,
        contentType: file.type || undefined,
        sizeBytes: file.size,
      });
      if (!reg.ok) return toast.error(reg.error);
      onChanged();
    } finally {
      setBusy(false);
      if (input.current) input.current.value = "";
    }
  }

  async function open(id: string) {
    const res = await portalAttachmentUrl(objectKey, id);
    if (!res.ok) return toast.error(res.error);
    window.open(res.data.url, "_blank", "noopener");
  }

  async function remove(id: string) {
    if (!confirm("Remove this file?")) return;
    const res = await deletePortalAttachment(objectKey, id);
    if (!res.ok) return toast.error(res.error);
    onChanged();
  }

  return (
    <div className="flex flex-col gap-3">
      {canWrite && (
        <div>
          <input
            ref={input}
            type="file"
            className="hidden"
            onChange={(e) => e.target.files?.[0] && upload(e.target.files[0])}
          />
          <Button
            variant="outline"
            size="sm"
            disabled={busy}
            onClick={() => input.current?.click()}
          >
            {busy ? <Loader2 className="animate-spin" /> : <Paperclip />} Attach file
          </Button>
          <p className="text-muted-foreground mt-1 text-xs">
            Up to 25 MB. Do not attach patient records here.
          </p>
        </div>
      )}
      <ul className="flex flex-col gap-2 text-sm">
        {detail.attachments.length === 0 && <li className="text-muted-foreground">No files.</li>}
        {detail.attachments.map((a) => (
          <li key={a.id} className="flex items-center gap-2 rounded-md border p-2">
            <div className="min-w-0 flex-1">
              <div className="truncate font-medium">{a.fileName}</div>
              <div className="text-muted-foreground text-xs">
                {fmtSize(a.sizeBytes)} · {userName(a.uploadedBy)} · {timeAgo(a.createdAt)}
              </div>
            </div>
            <Button variant="ghost" size="icon-sm" aria-label="Download" onClick={() => open(a.id)}>
              <Download />
            </Button>
            {canWrite && (
              <Button
                variant="ghost"
                size="icon-sm"
                aria-label="Remove file"
                className="text-destructive"
                onClick={() => remove(a.id)}
              >
                <Trash2 />
              </Button>
            )}
          </li>
        ))}
      </ul>
      <Badge variant="outline" className="self-start">
        Stored privately; links expire in 5 minutes
      </Badge>
    </div>
  );
}
