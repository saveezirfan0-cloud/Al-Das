/** Types the voucher and close pages pass to their client components (no runtime code). */

export type SealStatus =
  | { status: "valid"; signer: string; at: string | null; pades: boolean }
  | { status: "invalid"; reason: string }
  | { status: "not_sealed" };

export type SignatureLine = {
  id: string;
  stepLabel: string;
  signer: string;
  subjectCn: string | null;
  issuerCn: string | null;
  fingerprint: string;
  status: "valid" | "invalid";
  reason: string | null;
};

export type DocumentSigningView = {
  /** The viewer's own certificate, when they have one (label = its subject CN, usable = not expired). */
  myCertificate: { label: string; usable: boolean } | null;
  signatures: SignatureLine[];
  seal: SealStatus;
  /** The organisation seal is switched on. */
  sealOn: boolean;
};
