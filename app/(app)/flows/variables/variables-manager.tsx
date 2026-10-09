"use client";

import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";
import { Loader2, Plus, Trash2 } from "lucide-react";
import { toast } from "sonner";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Switch } from "@/components/ui/switch";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";

import { deleteVariable, saveVariable } from "../actions";

type Row = { id: string; key: string; value: string; enabled: boolean };

export function VariablesManager({ rows }: { rows: Row[] }) {
  const router = useRouter();
  const [key, setKey] = useState("");
  const [value, setValue] = useState("");
  const [drafts, setDrafts] = useState<Record<string, string>>({});
  const [pending, startTransition] = useTransition();

  function run(
    fn: () => Promise<{ ok: boolean; message?: string; error?: string }>,
    after?: () => void,
  ) {
    startTransition(async () => {
      const r = await fn();
      if (r.ok) {
        if (r.message) toast.success(r.message);
        after?.();
        router.refresh();
      } else toast.error(r.error);
    });
  }

  return (
    <div className="flex flex-col gap-4">
      <form
        className="flex flex-wrap items-end gap-2"
        onSubmit={(e) => {
          e.preventDefault();
          run(
            () => saveVariable(null, { key, value, enabled: true }),
            () => {
              setKey("");
              setValue("");
            },
          );
        }}
      >
        <Input
          value={key}
          onChange={(e) => setKey(e.target.value)}
          placeholder="NAME"
          aria-label="Variable name"
          className="w-48 font-mono"
          required
        />
        <Input
          value={value}
          onChange={(e) => setValue(e.target.value)}
          placeholder="Value"
          aria-label="Variable value"
          className="w-80"
        />
        <Button type="submit" disabled={pending}>
          {pending ? <Loader2 className="animate-spin" /> : <Plus />} Add variable
        </Button>
      </form>
      {rows.length === 0 ? (
        <p className="text-muted-foreground rounded-xl border border-dashed p-10 text-center text-sm">
          No variables yet.
        </p>
      ) : (
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Use as</TableHead>
              <TableHead>Value</TableHead>
              <TableHead>Enabled</TableHead>
              <TableHead className="w-10" />
            </TableRow>
          </TableHeader>
          <TableBody>
            {rows.map((r) => (
              <TableRow key={r.id}>
                <TableCell className="font-mono text-sm">{`{vars.${r.key}}`}</TableCell>
                <TableCell>
                  <Input
                    aria-label={`Value of ${r.key}`}
                    value={drafts[r.id] ?? r.value}
                    onChange={(e) => setDrafts((d) => ({ ...d, [r.id]: e.target.value }))}
                    onBlur={() => {
                      const v = drafts[r.id];
                      if (v !== undefined && v !== r.value)
                        run(
                          () => saveVariable(r.id, { key: r.key, value: v, enabled: r.enabled }),
                          () =>
                            setDrafts((d) => {
                              const next = { ...d };
                              delete next[r.id];
                              return next;
                            }),
                        );
                    }}
                  />
                </TableCell>
                <TableCell>
                  <Switch
                    checked={r.enabled}
                    aria-label={`Enable ${r.key}`}
                    onCheckedChange={(on) =>
                      run(() => saveVariable(r.id, { key: r.key, value: r.value, enabled: on }))
                    }
                  />
                </TableCell>
                <TableCell>
                  <Button
                    variant="ghost"
                    size="icon-sm"
                    aria-label={`Delete ${r.key}`}
                    onClick={() =>
                      confirm(`Delete ${r.key}? Flows using it will render it empty.`) &&
                      run(() => deleteVariable(r.id), undefined)
                    }
                  >
                    <Trash2 />
                  </Button>
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      )}
    </div>
  );
}
