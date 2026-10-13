import type {
  CreateResult,
  CreateSignatureRequest,
  ESignProvider,
  FetchResult,
} from "@/lib/integrations/esign/types";

/** A minimal but valid-looking PDF (starts with %PDF-). */
export const FAKE_SIGNED_PDF = new TextEncoder().encode(
  "%PDF-1.4\n% synthetic signed document\n%%EOF\n",
);

let sequence = 0;

/** An in-memory e-signature provider for tests. Never touches the network. */
export function createFakeEsignProvider(
  script: {
    create?: CreateResult[];
    cancel?: { ok: boolean; code?: string };
    fetch?: FetchResult[];
  } = {},
): ESignProvider & { created: CreateSignatureRequest[]; cancelled: string[]; fetched: string[] } {
  const created: CreateSignatureRequest[] = [];
  const cancelled: string[] = [];
  const fetched: string[] = [];
  const creates = [...(script.create ?? [])];
  const fetches = [...(script.fetch ?? [])];
  return {
    id: "fake",
    created,
    cancelled,
    fetched,
    async createRequest(r) {
      created.push(r);
      return creates.shift() ?? { ok: true, providerRequestId: `fake-sig-${++sequence}` };
    },
    async cancelRequest(id) {
      cancelled.push(id);
      return script.cancel ?? { ok: true };
    },
    async fetchSignedPdf(id) {
      fetched.push(id);
      return fetches.shift() ?? { ok: true, bytes: FAKE_SIGNED_PDF };
    },
    async verify() {
      return { ok: true };
    },
  };
}
