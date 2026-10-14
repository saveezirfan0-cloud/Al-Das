import { FilePenLine, ShieldAlert, ShieldCheck } from "lucide-react";

import { Badge } from "@/components/ui/badge";
import type { DocumentSigningView } from "@/lib/signing/view-types";

/**
 * Phase 22C: the organisation seal and the personal signatures of one document, as verified on the server when the page
 * was loaded ("Signature valid / invalid / not signed"). No hooks, so it renders in server and client components alike.
 */
export function SigningStatus({
  view,
  finalLabel,
}: {
  view: DocumentSigningView;
  /** When the document gets the seal, e.g. "once the voucher is fully approved". */
  finalLabel: string;
}) {
  const seal = view.seal;
  return (
    <div className="flex flex-col gap-2 text-sm" data-testid="signing-status">
      <p className="font-medium">Digital signatures</p>
      <div className="flex flex-wrap items-center gap-2">
        <span className="text-muted-foreground">Organisation seal</span>
        {seal.status === "valid" ? (
          <Badge variant="success">
            <ShieldCheck /> Signature valid
          </Badge>
        ) : seal.status === "invalid" ? (
          <Badge variant="destructive">
            <ShieldAlert /> Signature invalid
          </Badge>
        ) : (
          <Badge variant="outline">Not signed</Badge>
        )}
        {seal.status === "valid" && (
          <span className="text-muted-foreground text-xs">
            {seal.signer}
            {seal.at ? `, ${new Date(seal.at).toLocaleString("en-GB")}` : ""}
          </span>
        )}
        {seal.status === "invalid" && <span className="text-xs text-red-700">{seal.reason}</span>}
        {seal.status === "not_sealed" && (
          <span className="text-muted-foreground text-xs">
            {view.sealOn
              ? `Sealed ${finalLabel}.`
              : "The organisation seal is off (Settings, Integrations)."}
          </span>
        )}
      </div>
      {view.signatures.length === 0 ? (
        <p className="text-muted-foreground text-xs">
          No approval was signed with a personal certificate.
        </p>
      ) : (
        <ul className="flex flex-col gap-1">
          {view.signatures.map((s) => (
            <li key={s.id} className="flex flex-wrap items-center gap-2">
              <FilePenLine className="text-muted-foreground size-4" />
              <span>
                {s.stepLabel}: {s.signer}
              </span>
              {s.status === "valid" ? (
                <Badge variant="success">Signature valid</Badge>
              ) : (
                <Badge variant="destructive">Signature invalid</Badge>
              )}
              <span
                className="text-muted-foreground text-xs"
                title={`Certificate sha256 ${s.fingerprint}`}
              >
                {s.subjectCn ?? "certificate"}
                {s.issuerCn ? `, issued by ${s.issuerCn}` : ""}
              </span>
              {s.reason && <span className="text-xs text-red-700">{s.reason}</span>}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
