import { signDetached } from "@/lib/signing/cms";
import type { SigningIdentity } from "@/lib/signing/p12";

/**
 * Applies the organisation seal to a PDF as a PAdES baseline (B-B) signature: an invisible signature field whose
 * dictionary has SubFilter ETSI.CAdES.detached, a ByteRange over the whole file except the signature itself, and a
 * detached CMS made by cms.ts (signing-certificate-v2, no CMS signing time; the time is the /M entry). The placeholder
 * is added with @signpdf/placeholder-pdf-lib and filled with @signpdf/signpdf; the CMS is Pulse's own. Server only
 * (dynamic imports keep pdf-lib and @signpdf out of any client bundle).
 */

export type SealOptions = {
  identity: Pick<SigningIdentity, "key" | "certDer" | "chainDer">;
  /** Shown by PDF readers as the signer's name next to the certificate's own subject. */
  name: string;
  reason: string;
  location: string;
  signingTime: Date;
};

/** Room for the CMS in the placeholder, in hex characters: twice the certificates plus the signature and attributes, with headroom. */
export function placeholderLength(identity: Pick<SigningIdentity, "certDer" | "chainDer">): number {
  const certs = identity.certDer.length + identity.chainDer.reduce((a, c) => a + c.length, 0);
  return Math.max(16384, Math.ceil(((certs + 4096) * 2) / 1024) * 1024);
}

export async function sealPdf(pdf: Uint8Array, o: SealOptions): Promise<Buffer> {
  const [{ PDFDocument }, { pdflibAddPlaceholder }, { SignPdf, Signer }, utils] = await Promise.all(
    [
      import("pdf-lib"),
      import("@signpdf/placeholder-pdf-lib"),
      import("@signpdf/signpdf"),
      import("@signpdf/utils"),
    ],
  );
  const doc = await PDFDocument.load(pdf, { updateMetadata: false });
  pdflibAddPlaceholder({
    pdfDoc: doc,
    reason: o.reason,
    contactInfo: "",
    name: o.name,
    location: o.location,
    signingTime: o.signingTime,
    signatureLength: placeholderLength(o.identity),
    subFilter: utils.SUBFILTER_ETSI_CADES_DETACHED,
    appName: "Pulse",
  });
  const withPlaceholder = Buffer.from(await doc.save({ useObjectStreams: false }));

  class PulseCmsSigner extends Signer {
    async sign(bytes: Buffer): Promise<Buffer> {
      return signDetached({ content: bytes, identity: o.identity });
    }
  }
  return new SignPdf().sign(withPlaceholder, new PulseCmsSigner());
}
