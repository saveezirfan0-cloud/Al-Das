/**
 * The "Digital signatures" section printed on the approval certificate and the close pack PDF (pure). Each renderer
 * draws these lines with its own fonts. Certificate data only (subject, issuer, serial, fingerprint, validity) and the
 * verification result; nothing secret.
 */

export type PrintedSignature = {
  stepLabel: string;
  /** The Pulse user who acted. */
  signer: string;
  subject: string;
  issuer: string;
  serial: string;
  fingerprint: string;
  validFrom: string;
  validTo: string;
  signedAt: string;
  /** "Valid" or "Invalid: <reason>", as checked when the PDF was made. */
  result: string;
};

export type SealState =
  | { state: "sealed"; name: string; at: string; subject: string; fingerprint: string }
  | { state: "off" }
  | { state: "not_final"; why: string };

export type SigningSection = { signatures: PrintedSignature[]; seal: SealState };

export type Line = { text: string; style: "bold" | "normal" | "mono" | "grey"; indent?: boolean };

export const NOT_SEALED_LINE = "Not digitally sealed (no organisation certificate configured).";

const day = (iso: string) => iso.slice(0, 10);

export function signingLines(s: SigningSection, when: (iso: string) => string): Line[] {
  const out: Line[] = [];
  if (s.signatures.length === 0)
    out.push({
      text: "No personal certificate signatures. Each approval above is recorded in Pulse with the person, time and fingerprint.",
      style: "grey",
    });
  for (const g of s.signatures) {
    out.push({ text: `${g.stepLabel}: ${g.signer}, ${when(g.signedAt)}`, style: "bold" });
    out.push({ text: `Certificate: ${g.subject}`, style: "normal", indent: true });
    out.push({ text: `Issued by: ${g.issuer}`, style: "normal", indent: true });
    out.push({
      text: `Serial ${g.serial}, valid ${day(g.validFrom)} to ${day(g.validTo)}`,
      style: "normal",
      indent: true,
    });
    out.push({ text: `sha256 ${g.fingerprint}`, style: "mono", indent: true });
    out.push({
      text: `Signature over the approval statement: ${g.result}`,
      style: "normal",
      indent: true,
    });
  }
  if (s.seal.state === "sealed")
    out.push({
      text: `Sealed by ${s.seal.name} (${s.seal.subject}) on ${when(s.seal.at)}. The seal is a digital signature over this whole file: open the signature panel of your PDF reader to check it. Certificate sha256 ${s.seal.fingerprint}.`,
      style: "normal",
    });
  else if (s.seal.state === "off") out.push({ text: NOT_SEALED_LINE, style: "bold" });
  else out.push({ text: `Not sealed: ${s.seal.why}`, style: "grey" });
  out.push({
    text: "The organisation seal and the recorded approvals are not a UAE qualified electronic signature.",
    style: "grey",
  });
  return out;
}
