"use client";

import * as React from "react";
import dynamic from "next/dynamic";
import { FileText, ImageIcon, Loader2, Paperclip, Plus, Trash2, Video, X } from "lucide-react";
import { toast } from "sonner";

import { getAssetUrl } from "@/app/(app)/media/actions";
import { ScanBadge } from "@/components/media/scan-badge";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { formatDateTime } from "@/lib/contacts/format";
import { mentionQueryAtCaret } from "@/lib/inbox/mentions";
import { checklistProgress } from "@/lib/tasks/checklist";

import {
  addChecklistItemAction,
  addTaskCommentAction,
  attachTaskFileAction,
  detachTaskFileAction,
  loadTaskPartsAction,
  removeChecklistItemAction,
  setChecklistItemDoneAction,
  type TaskParts as Parts,
} from "./parts-actions";

// The picker lists the library only when someone wants to attach a file.
const MediaPicker = dynamic(
  () => import("@/components/media/media-picker").then((m) => m.MediaPicker),
  {
    ssr: false,
  },
);

const KIND_ICON = { image: ImageIcon, video: Video, document: FileText } as const;

/** Tasks v2 (Phase F): a task's checklist, comments with @mentions and Media Library files, in the task drawer. */
export function TaskParts({
  taskId,
  timezone,
  users,
  canManage,
  canMedia,
}: {
  taskId: string;
  timezone: string;
  users: Array<{ id: string; label: string }>;
  canManage: boolean;
  canMedia: boolean;
}) {
  const [parts, setParts] = React.useState<Parts | null>(null);
  const [newLine, setNewLine] = React.useState("");
  const [comment, setComment] = React.useState("");
  const [caret, setCaret] = React.useState(0);
  const [pickerOpen, setPickerOpen] = React.useState(false);
  const [pending, startTransition] = React.useTransition();
  const commentRef = React.useRef<HTMLTextAreaElement>(null);

  const load = React.useCallback(async () => {
    const r = await loadTaskPartsAction(taskId);
    if (r.ok) setParts(r.data);
    else toast.error(r.error);
  }, [taskId]);

  React.useEffect(() => {
    setParts(null);
    setNewLine("");
    setComment("");
    void load();
  }, [load]);

  function run(
    fn: () => Promise<{ ok: boolean; message?: string; error?: string }>,
    after?: () => void,
  ) {
    startTransition(async () => {
      const r = await fn();
      if (!r.ok) return void toast.error(r.error);
      if (r.message) toast.success(r.message);
      after?.();
      await load();
    });
  }

  const mention = mentionQueryAtCaret(comment, caret);
  const matches = mention
    ? users.filter((u) => u.label.toLowerCase().includes(mention.query.toLowerCase())).slice(0, 6)
    : [];

  function insertMention(u: { id: string; label: string }) {
    if (!mention) return;
    const token = `@[${u.label}](${u.id}) `;
    const next = comment.slice(0, mention.start) + token + comment.slice(caret);
    setComment(next);
    const pos = mention.start + token.length;
    setCaret(pos);
    requestAnimationFrame(() => {
      commentRef.current?.focus();
      commentRef.current?.setSelectionRange(pos, pos);
    });
  }

  if (!parts) return <Loader2 className="text-muted-foreground size-4 animate-spin" />;
  const progress = checklistProgress(parts.checklist);

  return (
    <div className="grid gap-5">
      <section className="grid gap-2" aria-labelledby={`cl-${taskId}`}>
        <h3
          id={`cl-${taskId}`}
          className="text-muted-foreground flex items-center gap-2 text-xs font-semibold tracking-wide uppercase"
        >
          Checklist
          {progress.total > 0 && (
            <span className="tabular-nums normal-case">
              {progress.done} of {progress.total}
            </span>
          )}
        </h3>
        {parts.checklist.length > 0 && (
          <ul className="grid gap-1">
            {parts.checklist.map((l) => (
              <li key={l.id} className="group flex items-center gap-2 text-sm">
                <Checkbox
                  checked={l.done}
                  disabled={!canManage || pending}
                  aria-label={l.done ? `Untick ${l.title}` : `Tick ${l.title}`}
                  onCheckedChange={(c) =>
                    run(() => setChecklistItemDoneAction(taskId, l.id, c === true))
                  }
                />
                <span className={l.done ? "text-muted-foreground line-through" : undefined}>
                  {l.title}
                </span>
                {canManage && (
                  <Button
                    variant="ghost"
                    size="icon-sm"
                    className="ml-auto opacity-60 group-hover:opacity-100"
                    aria-label={`Remove ${l.title}`}
                    onClick={() => run(() => removeChecklistItemAction(taskId, l.id))}
                  >
                    <X />
                  </Button>
                )}
              </li>
            ))}
          </ul>
        )}
        {canManage && (
          <form
            className="flex gap-2"
            onSubmit={(e) => {
              e.preventDefault();
              if (!newLine.trim()) return;
              run(
                () => addChecklistItemAction(taskId, newLine),
                () => setNewLine(""),
              );
            }}
          >
            <Input
              value={newLine}
              maxLength={200}
              onChange={(e) => setNewLine(e.target.value)}
              placeholder="Add an item"
              aria-label="New checklist item"
              className="h-8"
            />
            <Button type="submit" size="sm" variant="outline" disabled={pending || !newLine.trim()}>
              <Plus /> Add
            </Button>
          </form>
        )}
      </section>

      <section className="grid gap-2" aria-labelledby={`files-${taskId}`}>
        <h3
          id={`files-${taskId}`}
          className="text-muted-foreground text-xs font-semibold tracking-wide uppercase"
        >
          Files
        </h3>
        {!canMedia ? (
          <p className="text-muted-foreground text-xs">
            Files come from the Media Library, which you cannot open.
          </p>
        ) : (
          <>
            {parts.attachments.length === 0 && (
              <p className="text-muted-foreground text-xs">No files.</p>
            )}
            <ul className="grid gap-1">
              {parts.attachments.map((a) => {
                const Icon = KIND_ICON[a.kind as keyof typeof KIND_ICON] ?? FileText;
                return (
                  <li key={a.id} className="flex items-center gap-2 text-sm">
                    <Icon className="text-muted-foreground size-4 shrink-0" aria-hidden />
                    <button
                      type="button"
                      className="min-w-0 truncate text-left hover:underline"
                      onClick={async () => {
                        const r = await getAssetUrl(a.media_asset_id);
                        if (!r.ok) toast.error(r.error);
                        else if (r.data) window.open(r.data.url, "_blank", "noopener,noreferrer");
                      }}
                    >
                      {a.name}
                    </button>
                    {a.scan_status !== "clean" && <ScanBadge status={a.scan_status} />}
                    {canManage && (
                      <Button
                        variant="ghost"
                        size="icon-sm"
                        className="ml-auto"
                        aria-label={`Remove ${a.name} from the task`}
                        onClick={() => run(() => detachTaskFileAction(taskId, a.id))}
                      >
                        <Trash2 />
                      </Button>
                    )}
                  </li>
                );
              })}
            </ul>
            {canManage && (
              <Button
                variant="outline"
                size="sm"
                className="justify-self-start"
                disabled={pending}
                onClick={() => setPickerOpen(true)}
              >
                <Paperclip /> Attach from the library
              </Button>
            )}
            {pickerOpen && (
              <MediaPicker
                open={pickerOpen}
                onOpenChange={setPickerOpen}
                title="Attach a file to the task"
                onPick={(asset) => {
                  setPickerOpen(false);
                  run(() => attachTaskFileAction(taskId, asset.id));
                }}
              />
            )}
          </>
        )}
      </section>

      <section className="grid gap-2" aria-labelledby={`cm-${taskId}`}>
        <h3
          id={`cm-${taskId}`}
          className="text-muted-foreground text-xs font-semibold tracking-wide uppercase"
        >
          Comments
        </h3>
        {parts.comments.length === 0 && (
          <p className="text-muted-foreground text-xs">No comments yet.</p>
        )}
        <ul className="grid gap-2">
          {parts.comments.map((c) => (
            <li key={c.id} className="bg-muted/40 rounded-lg px-3 py-2 text-sm">
              <div className="text-muted-foreground mb-0.5 text-xs">
                <span className="text-foreground font-medium">{c.author}</span> ·{" "}
                {formatDateTime(c.created_at, timezone)}
              </div>
              <p className="whitespace-pre-line">{c.body}</p>
            </li>
          ))}
        </ul>
        {canManage && (
          <form
            className="grid gap-2"
            onSubmit={(e) => {
              e.preventDefault();
              if (!comment.trim()) return;
              run(
                () => addTaskCommentAction(taskId, comment),
                () => setComment(""),
              );
            }}
          >
            <div className="relative">
              <Textarea
                ref={commentRef}
                rows={2}
                value={comment}
                maxLength={2400}
                placeholder="Write a comment. Type @ to mention a colleague."
                aria-label="New comment"
                onChange={(e) => {
                  setComment(e.target.value);
                  setCaret(e.target.selectionStart);
                }}
                onSelect={(e) => setCaret((e.target as HTMLTextAreaElement).selectionStart)}
              />
              {matches.length > 0 && (
                <ul
                  role="listbox"
                  aria-label="Mention a colleague"
                  className="bg-popover absolute bottom-full left-0 z-10 mb-1 w-64 rounded-md border p-1 shadow-md"
                >
                  {matches.map((u) => (
                    <li key={u.id} role="option" aria-selected={false}>
                      <button
                        type="button"
                        className="hover:bg-accent w-full rounded px-2 py-1 text-left text-sm"
                        onClick={() => insertMention(u)}
                      >
                        {u.label}
                      </button>
                    </li>
                  ))}
                </ul>
              )}
            </div>
            <Button
              type="submit"
              size="sm"
              variant="outline"
              className="justify-self-end"
              disabled={pending || !comment.trim()}
            >
              {pending && <Loader2 className="animate-spin" />} Comment
            </Button>
          </form>
        )}
      </section>
    </div>
  );
}
