/**
 * An e-signature provider. The signer is the only personal data the provider receives besides the document itself: a name and an
 * e-mail address (or a phone number, for providers that can sign by SMS). The title and message are fixed generic wording.
 */
export type Signer = { name: string; email?: string; phone?: string };

export type CreateSignatureRequest = {
  /** Fixed generic wording: never a patient name or a clinical term. */
  title: string;
  message: string;
  signer: Signer;
  /** A short-lived link the provider downloads the document from. */
  fileUrl: string;
  expiresAt: Date;
  /** Our request id, echoed back in the provider's metadata and callbacks. */
  clientRef: string;
  testMode: boolean;
};

export type CreateResult =
  | { ok: true; providerRequestId: string }
  | {
      ok: false;
      code: string;
      /** Safe to ask again right away (nothing was created). */
      retryable: boolean;
      /** The provider may have created the request even though no answer came back: never ask again automatically. */
      ambiguous: boolean;
    };

export type FetchResult =
  { ok: true; bytes: Uint8Array } | { ok: false; code: string; retryable: boolean };

export interface ESignProvider {
  readonly id: "dropbox_sign" | "fake";
  createRequest(r: CreateSignatureRequest): Promise<CreateResult>;
  cancelRequest(providerRequestId: string): Promise<{ ok: boolean; code?: string }>;
  /** The fully signed PDF. */
  fetchSignedPdf(providerRequestId: string): Promise<FetchResult>;
  verify(): Promise<{ ok: boolean; code?: string }>;
}
