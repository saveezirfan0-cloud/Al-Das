"use client";

import * as React from "react";
import { useRouter } from "next/navigation";
import { Loader2 } from "lucide-react";
import { toast } from "sonner";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";

import { revokeSigningCertificate, uploadSigningCertificate } from "./actions";

export function UploadCertificateForm({ replacing }: { replacing: boolean }) {
  const router = useRouter();
  const [pending, start] = React.useTransition();
  const formRef = React.useRef<HTMLFormElement>(null);
  return (
    <form
      ref={formRef}
      className="flex max-w-md flex-col gap-3"
      onSubmit={(e) => {
        e.preventDefault();
        const data = new FormData(e.currentTarget);
        start(async () => {
          const r = await uploadSigningCertificate(data);
          if (r.ok) {
            toast.success(r.message);
            formRef.current?.reset();
            router.refresh();
          } else toast.error(r.error);
        });
      }}
    >
      <div className="grid gap-1">
        <Label htmlFor="cert-file">Certificate file (.p12 or .pfx)</Label>
        <Input
          id="cert-file"
          name="file"
          type="file"
          accept=".p12,.pfx,application/x-pkcs12"
          required
        />
      </div>
      <div className="grid gap-1">
        <Label htmlFor="cert-pin">Certificate PIN</Label>
        <Input
          id="cert-pin"
          name="pin"
          type="password"
          autoComplete="off"
          minLength={4}
          maxLength={200}
          required
        />
        <p className="text-muted-foreground text-xs">
          Used once to read the certificate, then forgotten. You type it again each time you sign.
        </p>
      </div>
      <div>
        <Button type="submit" className="min-h-11" disabled={pending}>
          {pending && <Loader2 className="animate-spin" />}{" "}
          {replacing ? "Replace my certificate" : "Add my certificate"}
        </Button>
      </div>
    </form>
  );
}

export function RevokeCertificateButton() {
  const router = useRouter();
  const [pending, start] = React.useTransition();
  return (
    <Button
      variant="outline"
      className="min-h-11"
      disabled={pending}
      onClick={() => {
        if (!window.confirm("Revoke your signing certificate? Pulse deletes its copy of the file."))
          return;
        start(async () => {
          const r = await revokeSigningCertificate();
          if (r.ok) {
            toast.success(r.message);
            router.refresh();
          } else toast.error(r.error);
        });
      }}
    >
      {pending && <Loader2 className="animate-spin" />} Revoke
    </Button>
  );
}
