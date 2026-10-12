"use client";

import * as React from "react";
import { Download, Loader2, Plus } from "lucide-react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";

import { ConfirmDialog } from "@/components/shell/confirm-dialog";
import { Button } from "@/components/ui/button";
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
import { Textarea } from "@/components/ui/textarea";

import {
  cancelPrivacyRequest,
  createPrivacyRequest,
  decidePrivacyRequest,
  executeErasure,
  searchPatientsForRequest,
  type PatientHit,
} from "./actions";

export function NewRequestDialog() {
  const router = useRouter();
  const [open, setOpen] = React.useState(false);
  const [kind, setKind] = React.useState<"export" | "erasure">("export");
  const [query, setQuery] = React.useState("");
  const [hits, setHits] = React.useState<PatientHit[]>([]);
  const [patient, setPatient] = React.useState<PatientHit | null>(null);
  const [reason, setReason] = React.useState("");
  const [error, setError] = React.useState<string | null>(null);
  const [pending, start] = React.useTransition();

  React.useEffect(() => {
    if (patient || query.trim().length < 2) return setHits([]);
    const t = setTimeout(() => {
      void searchPatientsForRequest(query).then((r) => setHits(r.ok ? r.data : []));
    }, 250);
    return () => clearTimeout(t);
  }, [query, patient]);

  function submit() {
    if (!patient) return;
    setError(null);
    start(async () => {
      const res = await createPrivacyRequest({ kind, contactId: patient.id, reason });
      if (!res.ok) return setError(res.error);
      toast.success(res.message);
      setOpen(false);
      setPatient(null);
      setQuery("");
      setReason("");
      router.refresh();
    });
  }

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>
        <Button>
          <Plus /> New request
        </Button>
      </DialogTrigger>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>New patient data request</DialogTitle>
          <DialogDescription>
            A different administrator has to approve it before anything happens.
          </DialogDescription>
        </DialogHeader>
        <div className="grid gap-4">
          <div className="grid grid-cols-2 gap-2">
            <Button
              type="button"
              variant={kind === "export" ? "default" : "outline"}
              onClick={() => setKind("export")}
            >
              Copy of their data
            </Button>
            <Button
              type="button"
              variant={kind === "erasure" ? "destructive" : "outline"}
              onClick={() => setKind("erasure")}
            >
              Erase their data
            </Button>
          </div>
          <div className="grid gap-1.5">
            <Label htmlFor="pr-patient">Patient (name or phone)</Label>
            {patient ? (
              <div className="flex items-center justify-between rounded-md border px-3 py-2 text-sm">
                {patient.label}
                <Button type="button" variant="ghost" size="sm" onClick={() => setPatient(null)}>
                  Change
                </Button>
              </div>
            ) : (
              <>
                <Input
                  id="pr-patient"
                  value={query}
                  onChange={(e) => setQuery(e.target.value)}
                  autoComplete="off"
                />
                {hits.length > 0 && (
                  <ul className="rounded-md border">
                    {hits.map((h) => (
                      <li key={h.id}>
                        <button
                          type="button"
                          className="hover:bg-accent w-full px-3 py-2 text-left text-sm"
                          onClick={() => setPatient(h)}
                        >
                          {h.label}
                        </button>
                      </li>
                    ))}
                  </ul>
                )}
              </>
            )}
          </div>
          <div className="grid gap-1.5">
            <Label htmlFor="pr-reason">Why (who asked, and how)</Label>
            <Textarea
              id="pr-reason"
              rows={3}
              maxLength={1000}
              value={reason}
              onChange={(e) => setReason(e.target.value)}
            />
          </div>
          {error && <p className="text-destructive text-sm">{error}</p>}
        </div>
        <DialogFooter>
          <Button variant="ghost" onClick={() => setOpen(false)} disabled={pending}>
            Cancel
          </Button>
          <Button onClick={submit} disabled={pending || !patient || reason.trim().length < 5}>
            {pending && <Loader2 className="animate-spin" />} Raise request
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

export function RequestActions({
  id,
  kind,
  status,
  mine,
}: {
  id: string;
  kind: "export" | "erasure";
  status: "pending" | "approved" | "completed" | "rejected" | "cancelled";
  mine: boolean;
}) {
  const router = useRouter();
  const [pending, start] = React.useTransition();
  const [note, setNote] = React.useState("");

  const run = (fn: () => Promise<{ ok: boolean; message?: string; error?: string }>) =>
    start(async () => {
      const res = await fn();
      if (res.ok) {
        toast.success(res.message);
        router.refresh();
      } else toast.error(res.error);
    });

  if (status === "pending") {
    return (
      <div className="flex flex-wrap items-center gap-2">
        {mine ? (
          <>
            <span className="text-muted-foreground text-xs">
              Waiting for another administrator.
            </span>
            <Button
              size="sm"
              variant="outline"
              disabled={pending}
              onClick={() => run(() => cancelPrivacyRequest(id))}
            >
              Cancel request
            </Button>
          </>
        ) : (
          <>
            <Input
              className="h-8 max-w-xs"
              placeholder="Note (optional)"
              value={note}
              onChange={(e) => setNote(e.target.value)}
              maxLength={1000}
            />
            <Button
              size="sm"
              disabled={pending}
              onClick={() => run(() => decidePrivacyRequest({ id, decision: "approve", note }))}
            >
              Approve
            </Button>
            <Button
              size="sm"
              variant="outline"
              disabled={pending}
              onClick={() => run(() => decidePrivacyRequest({ id, decision: "reject", note }))}
            >
              Reject
            </Button>
          </>
        )}
      </div>
    );
  }

  if (status === "approved" && kind === "export") {
    return (
      <form
        action={`/api/privacy/requests/${id}/export`}
        method="post"
        onSubmit={() => setTimeout(() => router.refresh(), 2500)}
      >
        <Button type="submit" size="sm">
          <Download /> Download the patient&apos;s data (one time)
        </Button>
      </form>
    );
  }

  if (status === "approved" && kind === "erasure") {
    return (
      <ConfirmDialog
        trigger={
          <Button size="sm" variant="destructive">
            Carry out erasure
          </Button>
        }
        title="Erase this patient's data?"
        description="This cannot be undone. Personal details, messages and files are removed. Clinical records synced from Unite are kept."
        confirmLabel="Erase"
        destructive
        typeToConfirm="erase"
        onConfirm={async () => {
          const res = await executeErasure(id);
          if (res.ok) {
            toast.success(res.message);
            router.refresh();
          }
          return res;
        }}
      />
    );
  }
  return null;
}
