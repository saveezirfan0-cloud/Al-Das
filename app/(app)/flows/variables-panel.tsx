"use client";

import * as React from "react";
import { useRouter } from "next/navigation";
import { Loader2, Pencil, Plus, Trash2 } from "lucide-react";
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
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";

import { deleteFlowVariable, saveFlowVariable } from "./actions";
import type { VariableItem } from "./types";

type Draft = {
  id?: string;
  key: string;
  label: string;
  value_type: VariableItem["value_type"];
  default_value: string;
  description: string;
};
const blank: Draft = { key: "", label: "", value_type: "text", default_value: "", description: "" };

export function VariablesPanel({ variables }: { variables: VariableItem[] }) {
  const router = useRouter();
  const [draft, setDraft] = React.useState<Draft | null>(null);
  const [busy, setBusy] = React.useState(false);

  async function save() {
    if (!draft) return;
    setBusy(true);
    const r = await saveFlowVariable(
      {
        key: draft.key,
        label: draft.label || null,
        value_type: draft.value_type,
        default_value: draft.default_value || null,
        description: draft.description || null,
      },
      draft.id,
    );
    setBusy(false);
    if (!r.ok) return void toast.error(r.error);
    toast.success("Saved.");
    setDraft(null);
    router.refresh();
  }

  async function remove(v: VariableItem) {
    const r = await deleteFlowVariable(v.id);
    if (!r.ok) return void toast.error(r.error);
    router.refresh();
  }

  return (
    <div className="space-y-3">
      <div className="flex items-center justify-between gap-3">
        <p className="text-muted-foreground max-w-2xl text-sm">
          Variables hold values every flow can use as <code>{"{vars.NAME}"}</code>, such as the
          clinic phone number or a booking link. Each run starts with these defaults; questions and
          API steps can overwrite them for that run only.
        </p>
        <Button variant="outline" onClick={() => setDraft(blank)}>
          <Plus className="size-4" />
          Add variable
        </Button>
      </div>
      <div className="rounded-md border">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Name</TableHead>
              <TableHead>Type</TableHead>
              <TableHead>Default</TableHead>
              <TableHead>Description</TableHead>
              <TableHead className="w-24" />
            </TableRow>
          </TableHeader>
          <TableBody>
            {variables.length === 0 ? (
              <TableRow>
                <TableCell colSpan={5} className="text-muted-foreground h-20 text-center">
                  No variables yet.
                </TableCell>
              </TableRow>
            ) : (
              variables.map((v) => (
                <TableRow key={v.id}>
                  <TableCell>
                    <code className="text-sm">{`{vars.${v.key}}`}</code>
                    {v.label ? (
                      <div className="text-muted-foreground text-xs">{v.label}</div>
                    ) : null}
                  </TableCell>
                  <TableCell className="capitalize">{v.value_type}</TableCell>
                  <TableCell className="max-w-48 truncate">{v.default_value ?? "—"}</TableCell>
                  <TableCell className="text-muted-foreground max-w-64 truncate text-sm">
                    {v.description ?? ""}
                  </TableCell>
                  <TableCell>
                    <div className="flex justify-end gap-1">
                      <Button
                        variant="ghost"
                        size="icon"
                        className="size-8"
                        aria-label={`Edit ${v.key}`}
                        onClick={() =>
                          setDraft({
                            id: v.id,
                            key: v.key,
                            label: v.label ?? "",
                            value_type: v.value_type,
                            default_value: v.default_value ?? "",
                            description: v.description ?? "",
                          })
                        }
                      >
                        <Pencil className="size-4" />
                      </Button>
                      <Button
                        variant="ghost"
                        size="icon"
                        className="size-8"
                        aria-label={`Delete ${v.key}`}
                        onClick={() => remove(v)}
                      >
                        <Trash2 className="size-4" />
                      </Button>
                    </div>
                  </TableCell>
                </TableRow>
              ))
            )}
          </TableBody>
        </Table>
      </div>

      <Dialog open={!!draft} onOpenChange={(o) => !o && setDraft(null)}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>{draft?.id ? "Edit variable" : "New variable"}</DialogTitle>
            <DialogDescription>
              Letters, digits and underscores, starting with a letter.
            </DialogDescription>
          </DialogHeader>
          {draft ? (
            <div className="space-y-3">
              <div className="space-y-1.5">
                <Label htmlFor="var-key">Name</Label>
                <Input
                  id="var-key"
                  value={draft.key}
                  maxLength={40}
                  onChange={(e) => setDraft({ ...draft, key: e.target.value })}
                  className="font-mono"
                />
              </div>
              <div className="space-y-1.5">
                <Label htmlFor="var-label">Label</Label>
                <Input
                  id="var-label"
                  value={draft.label}
                  maxLength={80}
                  onChange={(e) => setDraft({ ...draft, label: e.target.value })}
                />
              </div>
              <div className="grid grid-cols-2 gap-3">
                <div className="space-y-1.5">
                  <Label>Type</Label>
                  <Select
                    value={draft.value_type}
                    onValueChange={(v) =>
                      setDraft({ ...draft, value_type: v as Draft["value_type"] })
                    }
                  >
                    <SelectTrigger>
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="text">Text</SelectItem>
                      <SelectItem value="number">Number</SelectItem>
                      <SelectItem value="boolean">Yes / no</SelectItem>
                    </SelectContent>
                  </Select>
                </div>
                <div className="space-y-1.5">
                  <Label htmlFor="var-default">Default</Label>
                  <Input
                    id="var-default"
                    value={draft.default_value}
                    maxLength={500}
                    onChange={(e) => setDraft({ ...draft, default_value: e.target.value })}
                    placeholder={draft.value_type === "boolean" ? "true / false" : ""}
                  />
                </div>
              </div>
              <div className="space-y-1.5">
                <Label htmlFor="var-desc">Description</Label>
                <Input
                  id="var-desc"
                  value={draft.description}
                  maxLength={300}
                  onChange={(e) => setDraft({ ...draft, description: e.target.value })}
                />
              </div>
            </div>
          ) : null}
          <DialogFooter>
            <Button variant="ghost" onClick={() => setDraft(null)}>
              Cancel
            </Button>
            <Button onClick={save} disabled={busy || !draft?.key.trim()}>
              {busy ? <Loader2 className="size-4 animate-spin" /> : null}
              Save
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
