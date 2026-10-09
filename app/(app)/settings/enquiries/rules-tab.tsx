"use client";

import * as React from "react";
import { ArrowDown, ArrowUp, Loader2, Pencil, Plus, Trash2 } from "lucide-react";
import { toast } from "sonner";

import { OptionSelect } from "@/app/(app)/enquiries/option-select";
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
import { MultiSelect } from "@/components/ui/multi-select";
import { Switch } from "@/components/ui/switch";
import {
  ruleActionSchema,
  ruleConditionsSchema,
  type RuleAction,
  type RuleConditions,
} from "@/lib/enquiries/assignment";
import { pickable } from "@/lib/enquiries/lookups";
import type { Lookups, OrgUser, PipelineInfo, TeamInfo } from "@/lib/enquiries/server";

import { deleteAssignmentRule, reorderAssignmentRules, saveAssignmentRule } from "./actions";

export type RuleRow = {
  id: string;
  name: string;
  sort: number;
  enabled: boolean;
  conditions: unknown;
  action: unknown;
};

type Refs = {
  pipelines: PipelineInfo[];
  teams: TeamInfo[];
  users: OrgUser[];
  lookups: Lookups;
  sources: string[];
};

function names(
  ids: string[] | undefined,
  list: Array<{ id: string; name: string }>,
): string | null {
  if (!ids?.length) return null;
  return ids.map((id) => list.find((x) => x.id === id)?.name ?? "?").join(" or ");
}

function summarise(r: RuleRow, refs: Refs): { when: string; then: string } {
  const c = ruleConditionsSchema.safeParse(r.conditions ?? {});
  const a = ruleActionSchema.safeParse(r.action);
  const parts: string[] = [];
  if (c.success) {
    const p = names(c.data.pipeline_ids, refs.pipelines);
    if (p) parts.push(`pipeline is ${p}`);
    if (c.data.sources?.length) parts.push(`source is ${c.data.sources.join(" or ")}`);
    const ch = names(c.data.channel_ids, refs.lookups.channels);
    if (ch) parts.push(`number is ${ch}`);
    const l = names(c.data.location_ids, refs.lookups.locations);
    if (l) parts.push(`location is ${l}`);
    const d = names(c.data.department_ids, refs.lookups.departments);
    if (d) parts.push(`department is ${d}`);
  }
  let then = "invalid action";
  if (a.success) {
    const act = a.data;
    then =
      act.type === "user"
        ? `assign to ${refs.users.find((u) => u.id === act.user_id)?.label ?? "?"}`
        : `round-robin ${refs.teams.find((t) => t.id === act.team_id)?.name ?? "?"}`;
  }
  return {
    when: c.success
      ? parts.length
        ? parts.join(" and ")
        : "every new enquiry"
      : "invalid conditions",
    then,
  };
}

export function RulesTab({ rules, ...refs }: { rules: RuleRow[] } & Refs) {
  const [editing, setEditing] = React.useState<RuleRow | "new" | null>(null);
  const [pending, startTransition] = React.useTransition();

  function move(i: number, dir: -1 | 1) {
    const ids = rules.map((r) => r.id);
    const j = i + dir;
    if (j < 0 || j >= ids.length) return;
    [ids[i], ids[j]] = [ids[j], ids[i]];
    startTransition(async () => {
      const res = await reorderAssignmentRules(ids);
      if (!res.ok) toast.error(res.error);
    });
  }

  return (
    <div className="flex max-w-3xl flex-col gap-4">
      <div className="flex items-center justify-between gap-4">
        <p className="text-muted-foreground text-sm">
          New enquiries without a chosen assignee go to the first rule that matches, top to bottom.
          If none match they stay unassigned.
        </p>
        <Button onClick={() => setEditing("new")}>
          <Plus /> New rule
        </Button>
      </div>
      {rules.length === 0 && (
        <p className="text-muted-foreground rounded-xl border border-dashed p-10 text-center text-sm">
          No assignment rules yet.
        </p>
      )}
      <ol className="flex flex-col gap-2">
        {rules.map((r, i) => {
          const s = summarise(r, refs);
          return (
            <li key={r.id} className="flex items-center gap-3 rounded-lg border p-3">
              <span className="text-muted-foreground w-5 text-center text-sm tabular-nums">
                {i + 1}
              </span>
              <Switch
                checked={r.enabled}
                aria-label={`${r.name} enabled`}
                disabled={pending}
                onCheckedChange={(enabled) =>
                  startTransition(async () => {
                    const res = await saveAssignmentRule(r.id, {
                      name: r.name,
                      enabled,
                      conditions: r.conditions,
                      action: r.action,
                    });
                    if (!res.ok) toast.error(res.error);
                  })
                }
              />
              <div className="min-w-0 flex-1">
                <p className="truncate text-sm font-medium">{r.name}</p>
                <p className="text-muted-foreground truncate text-xs">
                  When {s.when}, {s.then}
                </p>
              </div>
              <Button
                variant="ghost"
                size="icon"
                aria-label="Move up"
                disabled={i === 0 || pending}
                onClick={() => move(i, -1)}
              >
                <ArrowUp />
              </Button>
              <Button
                variant="ghost"
                size="icon"
                aria-label="Move down"
                disabled={i === rules.length - 1 || pending}
                onClick={() => move(i, 1)}
              >
                <ArrowDown />
              </Button>
              <Button
                variant="ghost"
                size="icon"
                aria-label={`Edit ${r.name}`}
                onClick={() => setEditing(r)}
              >
                <Pencil />
              </Button>
              <Button
                variant="ghost"
                size="icon"
                className="text-destructive"
                aria-label={`Delete ${r.name}`}
                disabled={pending}
                onClick={() =>
                  confirm(`Delete the rule “${r.name}”?`) &&
                  startTransition(async () => {
                    const res = await deleteAssignmentRule(r.id);
                    if (!res.ok) toast.error(res.error);
                  })
                }
              >
                <Trash2 />
              </Button>
            </li>
          );
        })}
      </ol>
      {editing && (
        <RuleDialog
          rule={editing === "new" ? null : editing}
          refs={refs}
          onClose={() => setEditing(null)}
        />
      )}
    </div>
  );
}

function RuleDialog({
  rule,
  refs,
  onClose,
}: {
  rule: RuleRow | null;
  refs: Refs;
  onClose: () => void;
}) {
  const parsedC = ruleConditionsSchema.safeParse(rule?.conditions ?? {});
  const parsedA = ruleActionSchema.safeParse(rule?.action);
  const [name, setName] = React.useState(rule?.name ?? "");
  const [cond, setCond] = React.useState<RuleConditions>(parsedC.success ? parsedC.data : {});
  const [action, setAction] = React.useState<RuleAction>(
    parsedA.success ? parsedA.data : { type: "team_round_robin", team_id: refs.teams[0]?.id ?? "" },
  );
  const [pending, startTransition] = React.useTransition();
  const opts = (l: Array<{ id: string; name: string }>) =>
    l.map((x) => ({ value: x.id, label: x.name }));
  const set = <K extends keyof RuleConditions>(k: K, v: RuleConditions[K]) =>
    setCond((c) => ({ ...c, [k]: v && v.length ? v : undefined }));
  const actionTarget = action.type === "user" ? action.user_id : action.team_id;

  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="max-h-[90vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle>{rule ? "Edit rule" : "New assignment rule"}</DialogTitle>
          <DialogDescription>Leave a condition empty to match anything.</DialogDescription>
        </DialogHeader>
        <form
          className="grid gap-4"
          onSubmit={(e) => {
            e.preventDefault();
            startTransition(async () => {
              const res = await saveAssignmentRule(rule?.id ?? null, {
                name,
                enabled: rule?.enabled ?? true,
                conditions: cond,
                action,
              });
              if (!res.ok) return void toast.error(res.error);
              toast.success(res.message ?? "Saved.");
              onClose();
            });
          }}
        >
          <div className="grid gap-1.5">
            <Label htmlFor="rule-name">Name</Label>
            <Input
              id="rule-name"
              value={name}
              onChange={(e) => setName(e.target.value)}
              maxLength={80}
              required
              autoFocus
            />
          </div>
          <fieldset className="grid gap-3 rounded-lg border p-3">
            <legend className="text-muted-foreground px-1 text-xs font-semibold tracking-wide uppercase">
              When the enquiry…
            </legend>
            <div className="grid gap-1">
              <Label className="text-xs">is in pipeline</Label>
              <MultiSelect
                options={opts(refs.pipelines)}
                value={cond.pipeline_ids ?? []}
                onChange={(v) => set("pipeline_ids", v)}
                placeholder="Any pipeline"
              />
            </div>
            <div className="grid gap-1">
              <Label className="text-xs">has source</Label>
              <MultiSelect
                options={refs.sources.map((s) => ({ value: s, label: s }))}
                value={cond.sources ?? []}
                onChange={(v) => set("sources", v)}
                placeholder="Any source"
              />
            </div>
            <div className="grid gap-1">
              <Label className="text-xs">came through number</Label>
              <MultiSelect
                options={opts(refs.lookups.channels)}
                value={cond.channel_ids ?? []}
                onChange={(v) => set("channel_ids", v)}
                placeholder="Any number"
              />
            </div>
            <div className="grid gap-1">
              <Label className="text-xs">is for location</Label>
              <MultiSelect
                options={opts(pickable(refs.lookups.locations, undefined))}
                value={cond.location_ids ?? []}
                onChange={(v) => set("location_ids", v)}
                placeholder="Any location"
              />
            </div>
            <div className="grid gap-1">
              <Label className="text-xs">is for department</Label>
              <MultiSelect
                options={opts(pickable(refs.lookups.departments, undefined))}
                value={cond.department_ids ?? []}
                onChange={(v) => set("department_ids", v)}
                placeholder="Any department"
              />
            </div>
          </fieldset>
          <fieldset className="grid gap-3 rounded-lg border p-3">
            <legend className="text-muted-foreground px-1 text-xs font-semibold tracking-wide uppercase">
              Then
            </legend>
            <OptionSelect
              allowNone={false}
              value={action.type}
              options={[
                { value: "team_round_robin", label: "Round-robin a team (online members)" },
                { value: "user", label: "Assign to a specific person" },
              ]}
              onChange={(v) =>
                setAction(
                  v === "user"
                    ? { type: "user", user_id: refs.users[0]?.id ?? "" }
                    : { type: "team_round_robin", team_id: refs.teams[0]?.id ?? "" },
                )
              }
            />
            <OptionSelect
              allowNone={false}
              placeholder={action.type === "user" ? "Choose a person" : "Choose a team"}
              value={actionTarget}
              options={
                action.type === "user"
                  ? refs.users.map((u) => ({ value: u.id, label: u.label }))
                  : opts(refs.teams)
              }
              onChange={(v) =>
                setAction(
                  action.type === "user"
                    ? { type: "user", user_id: v ?? "" }
                    : { type: "team_round_robin", team_id: v ?? "" },
                )
              }
            />
          </fieldset>
          <DialogFooter>
            <Button type="button" variant="ghost" onClick={onClose}>
              Cancel
            </Button>
            <Button type="submit" disabled={pending || !name.trim() || !actionTarget}>
              {pending && <Loader2 className="animate-spin" />} Save rule
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
