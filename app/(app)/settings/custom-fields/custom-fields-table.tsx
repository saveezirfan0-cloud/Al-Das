"use client";

import * as React from "react";
import { ArrowDown, ArrowUp, MoreHorizontal } from "lucide-react";
import { toast } from "sonner";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import type { CustomFieldDef } from "@/lib/contacts/custom-values";

import { deleteCustomField, reorderCustomFields } from "./actions";
import { CustomFieldDialog } from "./custom-field-dialog";

type Row = CustomFieldDef & { id: string; entity: string; sort: number };

export function CustomFieldsTable({ rows }: { rows: Row[] }) {
  const [editing, setEditing] = React.useState<Row | null>(null);
  const [pending, startTransition] = React.useTransition();

  function move(i: number, dir: -1 | 1) {
    const ids = rows.map((r) => r.id);
    const j = i + dir;
    if (j < 0 || j >= ids.length) return;
    [ids[i], ids[j]] = [ids[j], ids[i]];
    startTransition(async () => {
      const res = await reorderCustomFields("contact", ids);
      if (!res.ok) toast.error(res.error);
    });
  }

  function remove(r: Row) {
    if (!confirm(`Delete the field "${r.label}"? Filters and segments using it will stop matching.`)) return;
    startTransition(async () => {
      const res = await deleteCustomField(r.id);
      if (res.ok) toast.success(res.message);
      else toast.error(res.error);
    });
  }

  return (
    <>
      <Table>
        <TableHeader>
          <TableRow>
            <TableHead className="w-16">Order</TableHead>
            <TableHead>Label</TableHead>
            <TableHead>Key</TableHead>
            <TableHead>Type</TableHead>
            <TableHead>Options</TableHead>
            <TableHead>Required</TableHead>
            <TableHead className="w-10" />
          </TableRow>
        </TableHeader>
        <TableBody>
          {rows.map((r, i) => (
            <TableRow key={r.id}>
              <TableCell>
                <span className="flex">
                  <Button variant="ghost" size="icon-sm" aria-label="Move up" disabled={pending || i === 0} onClick={() => move(i, -1)}>
                    <ArrowUp className="size-3.5" />
                  </Button>
                  <Button variant="ghost" size="icon-sm" aria-label="Move down" disabled={pending || i === rows.length - 1} onClick={() => move(i, 1)}>
                    <ArrowDown className="size-3.5" />
                  </Button>
                </span>
              </TableCell>
              <TableCell className="font-medium">{r.label}</TableCell>
              <TableCell>
                <code className="text-xs">custom.{r.key}</code>
              </TableCell>
              <TableCell>
                <Badge variant="outline">{r.type.replace("_", " ")}</Badge>
              </TableCell>
              <TableCell className="text-muted-foreground max-w-64 truncate text-xs">{r.options.map((o) => o.label).join(", ")}</TableCell>
              <TableCell>{r.required ? "Yes" : ""}</TableCell>
              <TableCell>
                <DropdownMenu>
                  <DropdownMenuTrigger asChild>
                    <Button variant="ghost" size="icon-sm" aria-label={`Actions for ${r.label}`}>
                      <MoreHorizontal />
                    </Button>
                  </DropdownMenuTrigger>
                  <DropdownMenuContent align="end">
                    <DropdownMenuItem onClick={() => setEditing(r)}>Edit</DropdownMenuItem>
                    <DropdownMenuItem variant="destructive" onClick={() => remove(r)}>
                      Delete
                    </DropdownMenuItem>
                  </DropdownMenuContent>
                </DropdownMenu>
              </TableCell>
            </TableRow>
          ))}
        </TableBody>
      </Table>
      {editing && <CustomFieldDialog mode="edit" field={editing} open onOpenChange={(o) => !o && setEditing(null)} />}
    </>
  );
}
