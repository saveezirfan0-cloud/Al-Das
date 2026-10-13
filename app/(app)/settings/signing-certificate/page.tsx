import { PageHeader } from "@/components/shell/page-header";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { canAny, ForbiddenError } from "@/lib/auth/can";
import { requireMember } from "@/lib/auth/session";
import { loadOwnCertificate, SIGNING_PERMS } from "@/lib/signing/personal-server";
import { createAdminClient } from "@/lib/supabase/admin";

import { RevokeCertificateButton, UploadCertificateForm } from "./forms";

export const metadata = { title: "Signing certificate" };
export const dynamic = "force-dynamic";

/**
 * Phase 22C: the person's own soft certificate for signing approvals (voucher verification and approval, close sign-offs).
 * Only the person themself sees or changes it; nobody else, administrators included, can sign with it (the PIN is theirs).
 */
export default async function SigningCertificatePage() {
  const member = await requireMember();
  if (!canAny(member, SIGNING_PERMS)) throw new ForbiddenError("finance.vouchers.check");
  const admin = createAdminClient(); // service role AFTER the permission check; own row only
  const cert = await loadOwnCertificate(admin, member.orgId, member.userId);
  const tz = member.profile.timezone || member.org.timezone || "UTC";
  const day = (iso: string) =>
    new Date(iso).toLocaleDateString("en-GB", { timeZone: tz, dateStyle: "medium" });

  return (
    <div className="flex flex-col gap-6">
      <PageHeader
        title="Signing certificate"
        description="Your own digital certificate for signing the approvals you give in Pulse: verifying and approving payment vouchers, and the month-end sign-off."
      />
      <Card>
        <CardHeader>
          <CardTitle className="flex flex-wrap items-center gap-2">
            Your certificate
            {cert ? (
              cert.problems.length === 0 ? (
                <Badge variant="success">Ready to sign</Badge>
              ) : (
                <Badge variant="destructive">Cannot sign</Badge>
              )
            ) : (
              <Badge variant="outline">None</Badge>
            )}
          </CardTitle>
          <CardDescription>
            When you approve with your certificate, Pulse signs a short statement (the document, the
            step, you, the time and the fingerprint of what you approved) with it, and lists the
            signature on the approval certificate. Approving without it still works and is still
            recorded.
          </CardDescription>
        </CardHeader>
        <CardContent className="flex flex-col gap-4 text-sm">
          {cert && (
            <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-1">
              <dt className="text-muted-foreground">Name</dt>
              <dd>{cert.subjectCn ?? "-"}</dd>
              <dt className="text-muted-foreground">Subject</dt>
              <dd className="break-all">{cert.subject}</dd>
              <dt className="text-muted-foreground">Issued by</dt>
              <dd className="break-all">{cert.issuer}</dd>
              <dt className="text-muted-foreground">Serial</dt>
              <dd className="font-mono text-xs break-all">{cert.serial}</dd>
              <dt className="text-muted-foreground">Valid</dt>
              <dd>
                {day(cert.validFrom)} to {day(cert.validTo)}
              </dd>
              <dt className="text-muted-foreground">Fingerprint</dt>
              <dd className="font-mono text-xs break-all">sha256 {cert.fingerprint}</dd>
              {cert.problems.map((p) => (
                <dd key={p} className="col-span-2 text-red-700">
                  {p}
                </dd>
              ))}
            </dl>
          )}
          {cert && (
            <div>
              <RevokeCertificateButton />
            </div>
          )}
          <UploadCertificateForm replacing={!!cert} />
        </CardContent>
      </Card>
      <Card>
        <CardHeader>
          <CardTitle>Good to know</CardTitle>
        </CardHeader>
        <CardContent className="text-muted-foreground flex flex-col gap-2 text-sm">
          <p>
            Use a soft certificate exported as .p12 or .pfx (RSA, with its private key and a PIN). A
            USB token cannot be used by a web application; keep using it in Tally where it is
            needed.
          </p>
          <p>
            Pulse stores the file encrypted and never stores your PIN. A wrong PIN stops the
            approval: nothing is saved until you type it correctly or approve without signing.
          </p>
          <p>
            Revoke the certificate here at once if you think the file or its PIN may be known to
            someone else. Signatures you already made stay on record.
          </p>
        </CardContent>
      </Card>
    </div>
  );
}
