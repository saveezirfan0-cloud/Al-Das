"use client";

import * as React from "react";
import { Loader2, Plus, Trash2 } from "lucide-react";
import { toast } from "sonner";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { TAG_COLORS, tagClass } from "@/lib/contacts/format";

import { deleteTag, saveTag } from "./actions";

type Row = { id: string; name: string; color: string; count: number };

export function TagsManager({ tags }: { tags: Row[] }) {
  const [name, setName] = React.useState("");
  const [color, setColor] = React.useState<string>("gray");
  const [pending, startTransition] = React.useTransition();

  function run(fn: () => Promise<{ ok: boolean; message?: string; error?: string }>, after?: () => void) {
    startTransition(async () => {
      const res = await fn();
      if (res.ok) {
        toast.success(res.message);
        after?.();
      } else toast.error(res.error);
    });
  }

  return (
    <div className="flex flex-col gap-4">
      <form
        className="flex flex-wrap items-end gap-2"
        onSubmit={(e) => {
          e.preventDefault();
          run(
            () => saveTag(null, { name, color: color as (typeof TAG_COLORS)[number] }),
            () => setName(""),
          );
        }}
      >
        <Input value={name} onChange={(e) => setName(e.target.value)} placeholder="New tag name" aria-label="New tag name" className="w-56" required />
        <ColorSelect value={color} onChange={setColor} />
        <Button type="submit" disabled={pending}>
          {pending ? <Loader2 className="animate-spin" /> : <Plus />} Add tag
        </Button>
      </form>
      {tags.length === 0 ? (
        <p className="text-muted-foreground rounded-xl border border-dashed p-10 text-center text-sm">No tags yet.</p>
      ) : (
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Tag</TableHead>
              <TableHead>Colour</TableHead>
              <TableHead>Contacts</TableHead>
              <TableHead className="w-10" />
            </TableRow>
          </TableHeader>
          <TableBody>
            {tags.map((t) => (
              <TagRow key={t.id} tag={t} run={run} />
            ))}
          </TableBody>
        </Table>
      )}
    </div>
  );
}

function TagRow({ tag, run }: { tag: Row; run: (fn: () => Promise<{ ok: boolean; message?: string; error?: string }>, after?: () => void) => void }) {
  const [name, setName] = React.useState(tag.name);
  const [color, setColor] = React.useState(tag.color);
  const dirty = name !== tag.name || color !== tag.color;
  return (
    <TableRow>
      <TableCell>
        <span className="flex items-center gap-2">
          <span className={`rounded px-1.5 py-0.5 text-xs ${tagClass(color)}`}>{name || tag.name}</span>
          <Input value={name} onChange={(e) => setName(e.target.value)} aria-label={`Rename ${tag.name}`} className="h-8 w-48" />
        </span>
      </TableCell>
      <TableCell>
        <ColorSelect value={color} onChange={setColor} />
      </TableCell>
      <TableCell className="tabular-nums">{tag.count.toLocaleString()}</TableCell>
      <TableCell>
        <span className="flex gap-1">
          {dirty && (
            <Button size="sm" variant="outline" onClick={() => run(() => saveTag(tag.id, { name, color: color as (typeof TAG_COLORS)[number] }))}>
              Save
            </Button>
          )}
          <Button
            size="icon-sm"
            variant="ghost"
            aria-label={`Delete ${tag.name}`}
            className="text-destructive"
            onClick={() => {
              if (confirm(`Delete the tag "${tag.name}"? It is removed from ${tag.count} contacts.`)) run(() => deleteTag(tag.id));
            }}
          >
            <Trash2 />
          </Button>
        </span>
      </TableCell>
    </TableRow>
  );
}

function ColorSelect({ value, onChange }: { value: string; onChange: (v: string) => void }) {
  return (
    <Select value={value} onValueChange={onChange}>
      <SelectTrigger className="w-32" aria-label="Colour">
        <SelectValue />
      </SelectTrigger>
      <SelectContent>
        {TAG_COLORS.map((c) => (
          <SelectItem key={c} value={c}>
            <span className={`rounded px-1.5 text-xs ${tagClass(c)}`}>{c}</span>
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  );
}
