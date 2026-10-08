"use client";

import { useMemo, useState, useTransition } from "react";
import { Loader2, Plus } from "lucide-react";
import { toast } from "sonner";

import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Switch } from "@/components/ui/switch";
import { Textarea } from "@/components/ui/textarea";
import { PERMISSION_GROUPS, PERMISSIONS } from "@/lib/auth/permissions";

import { createRole, updateRole } from "./actions";

export type RoleInput = { name: string; description: string; permissions: string[] };

type Props =
  | { mode: "create"; role?: undefined; open?: undefined; onOpenChange?: undefined }
  | {
      mode: "edit";
      role: RoleInput & { id: string; is_system: boolean };
      open: boolean;
      onOpenChange: (o: boolean) => void;
    };

export function RoleDialog(props: Props) {
  const [internalOpen, setInternalOpen] = useState(false);
  const open = props.mode === "edit" ? props.open : internalOpen;
  const setOpen = props.mode === "edit" ? props.onOpenChange : setInternalOpen;

  const initial: RoleInput = props.role ?? { name: "", description: "", permissions: [] };
  const [name, setName] = useState(initial.name);
  const [description, setDescription] = useState(initial.description);
  const [full, setFull] = useState(initial.permissions.includes("*"));
  const [perms, setPerms] = useState<string[]>(initial.permissions.filter((p) => p !== "*"));
  const [error, setError] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();

  const grouped = useMemo(
    () =>
      PERMISSION_GROUPS.map((g) => ({
        group: g,
        items: PERMISSIONS.filter((p) => p.group === g),
      })).filter((g) => g.items.length > 0),
    [],
  );

  const isAdminRole = props.mode === "edit" && props.role.permissions.includes("*");

  function submit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    const permissions = full ? ["*"] : perms;
    startTransition(async () => {
      const res =
        props.mode === "create"
          ? await createRole({ name, description, permissions })
          : await updateRole(props.role.id, { name, description, permissions });
      if (!res.ok) {
        setError(res.error);
        return;
      }
      toast.success(res.message);
      setOpen(false);
      if (props.mode === "create") {
        setName("");
        setDescription("");
        setFull(false);
        setPerms([]);
      }
    });
  }

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      {props.mode === "create" && (
        <DialogTrigger asChild>
          <Button>
            <Plus /> New role
          </Button>
        </DialogTrigger>
      )}
      <DialogContent className="sm:max-w-xl">
        <DialogHeader>
          <DialogTitle>
            {props.mode === "create" ? "New role" : `Edit ${props.role.name}`}
          </DialogTitle>
          <DialogDescription>Permissions apply to every member with this role.</DialogDescription>
        </DialogHeader>
        <form onSubmit={submit} className="flex flex-col gap-4">
          <div className="grid gap-2">
            <Label htmlFor="role-name">Name</Label>
            <Input
              id="role-name"
              value={name}
              onChange={(e) => setName(e.target.value)}
              required
              disabled={props.mode === "edit" && props.role.is_system}
            />
          </div>
          <div className="grid gap-2">
            <Label htmlFor="role-desc">Description</Label>
            <Textarea
              id="role-desc"
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              rows={2}
            />
          </div>
          <label className="flex items-center justify-between rounded-md border px-3 py-2 text-sm">
            <span>
              <span className="font-medium">Full access</span>
              <span className="text-muted-foreground block text-xs">
                Everything, including settings and user management.
              </span>
            </span>
            <Switch checked={full} onCheckedChange={setFull} disabled={isAdminRole} />
          </label>
          {!full && (
            <ScrollArea className="h-72 rounded-md border">
              <div className="flex flex-col gap-4 p-3">
                {grouped.map(({ group, items }) => (
                  <fieldset key={group} className="flex flex-col gap-2">
                    <legend className="mb-1 text-xs font-semibold tracking-wide uppercase">
                      {group}
                    </legend>
                    {items.map((p) => (
                      <label key={p.key} className="flex items-start gap-2 text-sm">
                        <Checkbox
                          className="mt-0.5"
                          checked={perms.includes(p.key)}
                          onCheckedChange={(c) =>
                            setPerms((prev) =>
                              c ? [...prev, p.key] : prev.filter((k) => k !== p.key),
                            )
                          }
                        />
                        <span>
                          <span>{p.label}</span>
                          <span className="text-muted-foreground block text-xs">
                            {"description" in p && p.description ? p.description : p.key}
                          </span>
                        </span>
                      </label>
                    ))}
                  </fieldset>
                ))}
              </div>
            </ScrollArea>
          )}
          {error && (
            <p className="text-destructive text-sm" role="alert">
              {error}
            </p>
          )}
          <DialogFooter>
            <Button type="button" variant="ghost" onClick={() => setOpen(false)}>
              Cancel
            </Button>
            <Button type="submit" disabled={pending}>
              {pending && <Loader2 className="animate-spin" />}{" "}
              {props.mode === "create" ? "Create role" : "Save"}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
