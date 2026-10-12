import type {
  CreatePaymentInput,
  CreatePaymentResult,
  PaymentProvider,
} from "@/lib/integrations/payments/types";

/** A scripted payment provider for tests. Never touches the network. */
export function createFakePaymentProvider(
  opts: { fail?: CreatePaymentResult & { ok: false }; expire?: boolean; refPrefix?: string } = {},
): PaymentProvider & { created: CreatePaymentInput[]; expired: string[] } {
  const created: CreatePaymentInput[] = [];
  const expired: string[] = [];
  return {
    id: "stripe",
    created,
    expired,
    async createPayment(input) {
      created.push(input);
      if (opts.fail) return opts.fail;
      return {
        ok: true,
        ref: `${opts.refPrefix ?? "cs_test_fake"}_${created.length}`,
        url: `https://pay.example.test/session/${created.length}`,
        expiresAt: input.expiresAt,
      };
    },
    async expire(ref) {
      expired.push(ref);
      return opts.expire ?? true;
    },
  };
}
