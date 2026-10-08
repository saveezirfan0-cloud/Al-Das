"use client";

import * as React from "react";
import { Loader2 } from "lucide-react";
import { toast } from "sonner";

import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";

import { createContact } from "./actions";
import { ContactForm, EMPTY_CONTACT_FORM, toContactInput, type ContactFormValues } from "./contact-form";
import type { ContactsBootstrap } from "./types";

export function NewContactDialog({
  open,
  onOpenChange,
  bootstrap,
  onCreated,
}: {
  open: boolean;
  onOpenChange: (o: boolean) => void;
  bootstrap: ContactsBootstrap;
  onCreated: (id: string) => void;
}) {
  const [values, setValues] = React.useState<ContactFormValues>(EMPTY_CONTACT_FORM);
  const [error, setError] = React.useState<string | null>(null);
  const [pending, startTransition] = React.useTransition();

  React.useEffect(() => {
    if (open) {
      setValues(EMPTY_CONTACT_FORM);
      setError(null);
    }
  }, [open]);

  function submit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    startTransition(async () => {
      const res = await createContact(toContactInput(values));
      if (!res.ok) {
        setError(res.error);
        return;
      }
      toast.success(res.message);
      onOpenChange(false);
      onCreated(res.data.id);
    });
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[90vh] overflow-y-auto sm:max-w-2xl">
        <DialogHeader>
          <DialogTitle>New contact</DialogTitle>
          <DialogDescription>Phones are stored in international format. Existing numbers are rejected to keep one record per patient.</DialogDescription>
        </DialogHeader>
        <form onSubmit={submit} className="flex flex-col gap-4">
          <ContactForm value={values} onChange={setValues} users={bootstrap.users} customFields={bootstrap.customFields} idPrefix="new" />
          {error && (
            <p className="text-destructive text-sm" role="alert">
              {error}
            </p>
          )}
          <DialogFooter>
            <Button type="button" variant="ghost" onClick={() => onOpenChange(false)}>
              Cancel
            </Button>
            <Button type="submit" disabled={pending}>
              {pending && <Loader2 className="animate-spin" />} Create contact
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
