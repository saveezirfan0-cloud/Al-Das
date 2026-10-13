"use client";

import { useCallback, useEffect, useState, useTransition } from "react";
import { Loader2, PenLine } from "lucide-react";
import { toast } from "sonner";

import { Badge } from "@/components/ui/badge";
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
import { ESIGN_STATUS_LABEL } from "@/lib/integrations/esign/state";

import {
  cancelSignature,
  getEsignView,
  sendForSignature,
  type EsignSource,
  type EsignView,
} from "./esign-actions";

const TONE: Record<string, "secondary" | "success" | "warning" | "destructive" | "outline"> = {
  creating: "secondary",
  pending: "warning",
  signed: "success",
  declined: "destructive",
  expired: "outline",
  cancelled: "outline",
  failed: "destructive",
};

function when(iso: string, tz: string): string {
  try {
    return new Intl.DateTimeFormat(undefined, { dateStyle: "medium", timeZone: tz }).format(
      new Date(iso),
    );
  } catch {
    return iso.slice(0, 10);
  }
}

/** The e-signature section of a patient's Documents tab. Shows nothing while the integration (or patient documents) is off. */
export function EsignPanel({
  contactId,
  timezone,
  onChanged,
}: {
  contactId: string;
  timezone: string;
  /** Called after a request is made, cancelled or the list refreshed so a newly signed document shows up above. */
  onChanged: () => void;
}) {
  const [view, setView] = useState<EsignView | null>(null);
  const [open, setOpen] = useState(false);
  const [pending, start] = useTransition();

  const load = useCallback(async () => {
    const r = await getEsignView(contactId);
    if (r.ok && r.data) setView(r.data);
  }, [contactId]);
  useEffect(() => {
    setView(null);
    void load();
  }, [load]);

  if (!view?.enabled) return null;
  return (
    <section className="flex flex-col gap-2" aria-label="E-signature">
      <div className="flex items-center justify-between gap-2">
        <h3 className="text-muted-foreground text-xs font-semibold tracking-wide uppercase">
          E-signature
        </h3>
        {view.canManage && (
          <Button
            type="button"
            size="sm"
            variant="outline"
            className="pointer-coarse:h-11"
            onClick={() => setOpen(true)}
          >
            <PenLine /> Send for signature
          </Button>
        )}
      </div>
      {view.requests.length === 0 ? (
        <p className="text-muted-foreground text-sm">
          No consent forms have been sent for signature.
        </p>
      ) : (
        <ul className="divide-y rounded-lg border text-sm">
          {view.requests.map((r) => (
            <li key={r.id} className="flex flex-wrap items-center gap-2 px-3 py-2">
              <Badge variant={TONE[r.status] ?? "outline"}>{ESIGN_STATUS_LABEL[r.status]}</Badge>
              {r.test_mode && <Badge variant="outline">Test</Badge>}
              <span className="text-muted-foreground text-xs">
                sent {when(r.created_at, timezone)}
                {r.signer_hint ? ` to ${r.signer_hint}` : ""}
              </span>
              {r.status === "failed" && r.error_code === "unknown_delivery" && (
                <span className="text-xs text-amber-800 dark:text-amber-200">
                  Check the provider before sending again.
                </span>
              )}
              {r.status === "signed" && !r.signed_document_id && (
                <span className="text-xs text-amber-800 dark:text-amber-200">
                  Signed, but the copy could not be stored: download it from the provider.
                </span>
              )}
              {r.status === "pending" && view.canManage && (
                <Button
                  type="button"
                  size="sm"
                  variant="ghost"
                  className="ml-auto"
                  disabled={pending}
                  onClick={() =>
                    start(async () => {
                      const res = await cancelSignature(r.id);
                      if (res.ok) {
                        toast.success(res.message ?? "Cancelled.");
                        void load();
                        onChanged();
                      } else toast.error(res.error);
                    })
                  }
                >
                  Cancel
                </Button>
              )}
            </li>
          ))}
        </ul>
      )}
      <SendDialog
        open={open}
        contactId={contactId}
        sources={view.sources}
        defaultName={view.defaultName}
        defaultEmail={view.defaultEmail}
        onClose={() => setOpen(false)}
        onDone={() => {
          setOpen(false);
          void load();
          onChanged();
        }}
      />
    </section>
  );
}

function SendDialog({
  open,
  contactId,
  sources,
  defaultName,
  defaultEmail,
  onClose,
  onDone,
}: {
  open: boolean;
  contactId: string;
  sources: EsignSource[];
  defaultName: string;
  defaultEmail: string;
  onClose: () => void;
  onDone: () => void;
}) {
  const [source, setSource] = useState("");
  const [name, setName] = useState(defaultName);
  const [email, setEmail] = useState(defaultEmail);
  const [pending, start] = useTransition();
  useEffect(() => {
    if (open) {
      setSource(sources[0] ? `${sources[0].kind}:${sources[0].id}` : "");
      setName(defaultName);
      setEmail(defaultEmail);
    }
  }, [open, sources, defaultName, defaultEmail]);

  function submit() {
    const [kind, id] = source.split(":");
    if (!kind || !id) return;
    start(async () => {
      const r = await sendForSignature({
        contactId,
        source: { kind: kind as "patient_document" | "library_asset", id },
        signerName: name,
        signerEmail: email,
      });
      if (r.ok) {
        toast.success(r.message ?? "Sent.");
        onDone();
      } else toast.error(r.error);
    });
  }

  return (
    <Dialog open={open} onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>Send for signature</DialogTitle>
          <DialogDescription>
            The e-signature service will receive the form and the signer&apos;s name and e-mail
            address, and will e-mail the signer. It keeps its own copy of the signed form. Nothing
            else about the patient is sent. The form needs the service&apos;s signature tags.
          </DialogDescription>
        </DialogHeader>
        {sources.length === 0 ? (
          <p className="text-muted-foreground text-sm">
            There is no PDF to send. Add this patient&apos;s consent form as a document (category
            Consent form) or a PDF to the Media Library.
          </p>
        ) : (
          <div className="flex flex-col gap-3">
            <div className="grid gap-1">
              <Label htmlFor="es-source">Form</Label>
              <select
                id="es-source"
                className="border-input bg-background h-9 rounded-md border px-3 text-sm"
                value={source}
                onChange={(e) => setSource(e.target.value)}
              >
                {sources.map((s) => (
                  <option key={`${s.kind}:${s.id}`} value={`${s.kind}:${s.id}`}>
                    {s.label}
                  </option>
                ))}
              </select>
            </div>
            <div className="grid gap-1">
              <Label htmlFor="es-name">Signer&apos;s name</Label>
              <Input
                id="es-name"
                value={name}
                onChange={(e) => setName(e.target.value)}
                autoComplete="off"
              />
            </div>
            <div className="grid gap-1">
              <Label htmlFor="es-email">Signer&apos;s e-mail address</Label>
              <Input
                id="es-email"
                type="email"
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                autoComplete="off"
              />
              <p className="text-muted-foreground text-xs">
                For a child, use the parent or guardian who signs.
              </p>
            </div>
          </div>
        )}
        <DialogFooter>
          <Button type="button" variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button
            type="button"
            disabled={pending || sources.length === 0 || !name.trim() || !email.trim()}
            onClick={submit}
          >
            {pending && <Loader2 className="animate-spin" />} Send
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
