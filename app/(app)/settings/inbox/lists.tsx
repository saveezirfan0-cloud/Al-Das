"use client";

import { useState, useTransition } from "react";
import { Loader2, Pencil, Plus, Trash2 } from "lucide-react";
import { toast } from "sonner";

import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { cn } from "@/lib/utils";

import {
  addCategory,
  deleteCategory,
  deleteLabel,
  deleteQuickReply,
  saveLabel,
  saveQuickReply,
  type ActionResult,
} from "./actions";

export const LABEL_COLOR_CLASSES: Record<string, string> = {
  gray: "bg-gray-200 text-gray-800",
  red: "bg-red-100 text-red-800",
  orange: "bg-orange-100 text-orange-800",
  amber: "bg-amber-100 text-amber-800",
  green: "bg-emerald-100 text-emerald-800",
  teal: "bg-teal-100 text-teal-800",
  blue: "bg-blue-100 text-blue-800",
  violet: "bg-violet-100 text-violet-800",
  pink: "bg-pink-100 text-pink-800",
};
const COLORS = Object.keys(LABEL_COLOR_CLASSES);

function useRun() {
  const [pending, startTransition] = useTransition();
  function run(fn: () => Promise<ActionResult>, after?: () => void) {
    startTransition(async () => {
      const res = await fn();
      if (res.ok) {
        toast.success(res.message);
        after?.();
      } else toast.error(res.error);
    });
  }
  return { pending, run };
}

export function CategoriesCard({ items }: { items: Array<{ id: string; name: string }> }) {
  const [name, setName] = useState("");
  const { pending, run } = useRun();
  return (
    <Card>
      <CardHeader>
        <CardTitle>Close categories</CardTitle>
        <CardDescription>Picked when a conversation is closed.</CardDescription>
      </CardHeader>
      <CardContent className="flex flex-col gap-3">
        <form
          className="flex gap-2"
          onSubmit={(e) => {
            e.preventDefault();
            run(
              () => addCategory(name),
              () => setName(""),
            );
          }}
        >
          <Input
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="e.g. Booking made"
          />
          <Button
            type="submit"
            size="icon"
            aria-label="Add category"
            disabled={pending || !name.trim()}
          >
            {pending ? <Loader2 className="animate-spin" /> : <Plus />}
          </Button>
        </form>
        <ul className="divide-y text-sm">
          {items.length === 0 && (
            <li className="text-muted-foreground py-2 text-xs">No categories yet.</li>
          )}
          {items.map((c) => (
            <li key={c.id} className="flex items-center justify-between py-1.5">
              {c.name}
              <Button
                variant="ghost"
                size="icon-sm"
                aria-label={`Delete ${c.name}`}
                disabled={pending}
                onClick={() => run(() => deleteCategory(c.id))}
              >
                <Trash2 />
              </Button>
            </li>
          ))}
        </ul>
      </CardContent>
    </Card>
  );
}

export function LabelsCard({
  items,
}: {
  items: Array<{ id: string; name: string; color: string }>;
}) {
  const [editing, setEditing] = useState<{ id: string | null; name: string; color: string }>({
    id: null,
    name: "",
    color: "blue",
  });
  const { pending, run } = useRun();
  return (
    <Card>
      <CardHeader>
        <CardTitle>Labels</CardTitle>
        <CardDescription>Coloured tags shown on conversations.</CardDescription>
      </CardHeader>
      <CardContent className="flex flex-col gap-3">
        <form
          className="flex flex-col gap-2"
          onSubmit={(e) => {
            e.preventDefault();
            run(
              () => saveLabel(editing.id, { name: editing.name, color: editing.color }),
              () => setEditing({ id: null, name: "", color: "blue" }),
            );
          }}
        >
          <div className="flex gap-2">
            <Input
              value={editing.name}
              onChange={(e) => setEditing((p) => ({ ...p, name: e.target.value }))}
              placeholder={editing.id ? "Rename label" : "e.g. Appointment request"}
            />
            <Button
              type="submit"
              size="icon"
              aria-label={editing.id ? "Save label" : "Add label"}
              disabled={pending || !editing.name.trim()}
            >
              {pending ? <Loader2 className="animate-spin" /> : editing.id ? <Pencil /> : <Plus />}
            </Button>
          </div>
          <div className="flex flex-wrap gap-1">
            {COLORS.map((c) => (
              <button
                key={c}
                type="button"
                aria-label={c}
                aria-pressed={editing.color === c}
                onClick={() => setEditing((p) => ({ ...p, color: c }))}
                className={cn(
                  "size-5 rounded-full border-2",
                  LABEL_COLOR_CLASSES[c],
                  editing.color === c ? "border-foreground" : "border-transparent",
                )}
              />
            ))}
            {editing.id && (
              <Button
                type="button"
                variant="ghost"
                size="sm"
                onClick={() => setEditing({ id: null, name: "", color: "blue" })}
              >
                Cancel
              </Button>
            )}
          </div>
        </form>
        <ul className="divide-y text-sm">
          {items.length === 0 && (
            <li className="text-muted-foreground py-2 text-xs">No labels yet.</li>
          )}
          {items.map((l) => (
            <li key={l.id} className="flex items-center justify-between py-1.5">
              <span
                className={cn(
                  "rounded-md px-2 py-0.5 text-xs font-medium",
                  LABEL_COLOR_CLASSES[l.color] ?? LABEL_COLOR_CLASSES.gray,
                )}
              >
                {l.name}
              </span>
              <span className="flex">
                <Button
                  variant="ghost"
                  size="icon-sm"
                  aria-label={`Edit ${l.name}`}
                  onClick={() => setEditing({ id: l.id, name: l.name, color: l.color })}
                >
                  <Pencil />
                </Button>
                <Button
                  variant="ghost"
                  size="icon-sm"
                  aria-label={`Delete ${l.name}`}
                  disabled={pending}
                  onClick={() => run(() => deleteLabel(l.id))}
                >
                  <Trash2 />
                </Button>
              </span>
            </li>
          ))}
        </ul>
      </CardContent>
    </Card>
  );
}

export function QuickRepliesCard({
  items,
}: {
  items: Array<{ id: string; shortcut: string; text: string }>;
}) {
  const [editing, setEditing] = useState<{ id: string | null; shortcut: string; text: string }>({
    id: null,
    shortcut: "",
    text: "",
  });
  const { pending, run } = useRun();
  return (
    <Card>
      <CardHeader>
        <CardTitle>Quick replies</CardTitle>
        <CardDescription>Type / in the composer to insert one.</CardDescription>
      </CardHeader>
      <CardContent className="flex flex-col gap-3">
        <form
          className="flex flex-col gap-2"
          onSubmit={(e) => {
            e.preventDefault();
            run(
              () => saveQuickReply(editing.id, { shortcut: editing.shortcut, text: editing.text }),
              () => setEditing({ id: null, shortcut: "", text: "" }),
            );
          }}
        >
          <Input
            value={editing.shortcut}
            onChange={(e) => setEditing((p) => ({ ...p, shortcut: e.target.value }))}
            placeholder="shortcut, e.g. hours"
          />
          <Textarea
            value={editing.text}
            onChange={(e) => setEditing((p) => ({ ...p, text: e.target.value }))}
            placeholder="Reply text. {contact.first_name} is replaced when sent."
            rows={3}
          />
          <div className="flex justify-end gap-2">
            {editing.id && (
              <Button
                type="button"
                variant="ghost"
                size="sm"
                onClick={() => setEditing({ id: null, shortcut: "", text: "" })}
              >
                Cancel
              </Button>
            )}
            <Button
              type="submit"
              size="sm"
              disabled={pending || !editing.shortcut.trim() || !editing.text.trim()}
            >
              {pending && <Loader2 className="animate-spin" />} {editing.id ? "Save" : "Add"}
            </Button>
          </div>
        </form>
        <ul className="divide-y text-sm">
          {items.length === 0 && (
            <li className="text-muted-foreground py-2 text-xs">No quick replies yet.</li>
          )}
          {items.map((q) => (
            <li key={q.id} className="flex items-start justify-between gap-2 py-1.5">
              <span className="min-w-0">
                <span className="font-mono text-xs">/{q.shortcut}</span>
                <span className="text-muted-foreground line-clamp-2 block text-xs">{q.text}</span>
              </span>
              <span className="flex shrink-0">
                <Button
                  variant="ghost"
                  size="icon-sm"
                  aria-label={`Edit /${q.shortcut}`}
                  onClick={() => setEditing({ id: q.id, shortcut: q.shortcut, text: q.text })}
                >
                  <Pencil />
                </Button>
                <Button
                  variant="ghost"
                  size="icon-sm"
                  aria-label={`Delete /${q.shortcut}`}
                  disabled={pending}
                  onClick={() => run(() => deleteQuickReply(q.id))}
                >
                  <Trash2 />
                </Button>
              </span>
            </li>
          ))}
        </ul>
      </CardContent>
    </Card>
  );
}
