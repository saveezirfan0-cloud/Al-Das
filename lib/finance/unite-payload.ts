import { z } from "zod";

/**
 * Envelope of the Unite `GetFinanceDetails` response.
 *
 * Unite has not yet sent the field list and enums (open item), so only the
 * envelope and the fields the brief confirms are validated here. Everything
 * else is passed through untouched (`loose`) and stored in the raw batch; the
 * F2 mapper adds the full invoice field mapping once the list arrives.
 *
 * Remember (CLAUDE.md rule 7): the API is deliver-once. Parsing must never
 * run before the raw payload is stored, and a parse failure must never lose a
 * batch.
 */
const invoiceItem = z.looseObject({
  ItemCode: z.string().nullish(),
  ActualCostPrice: z.union([z.number(), z.string()]).nullish(),
});

const invoicePayment = z.looseObject({
  PaymentMode: z.string().nullish(),
});

export const uniteInvoiceSchema = z.looseObject({
  InvDisplayNumber: z.string().min(1),
  AppointmentId: z.union([z.string(), z.number()]).nullish(), // empty for direct invoices: valid
  ClinicLongName: z.string().nullish(),
  IsDeleted: z.union([z.boolean(), z.string(), z.number()]).nullish(),
  ItemsDetails: z.array(invoiceItem).nullish(),
  PaymentDetails: z.array(invoicePayment).nullish(),
});

export const uniteFinanceResponseSchema = z.looseObject({
  MessageStatus: z.string().nullish(),
  DetailMessage: z.string().nullish(),
  DataBalancetoSync: z.coerce.number().int().nonnegative().nullish(),
  OverallDataBalancetoSync: z.coerce.number().int().nonnegative().nullish(),
  Data: z.array(uniteInvoiceSchema).nullish(),
});

export type UniteInvoice = z.infer<typeof uniteInvoiceSchema>;
export type UniteFinanceResponse = z.infer<typeof uniteFinanceResponseSchema>;

/** Request body of GetFinanceDetails. Dates are dd-MM-yyyy. */
export const uniteFinanceRequestSchema = z.object({
  fromDate: z.string().regex(/^\d{2}-\d{2}-\d{4}$/),
  toDate: z.string().regex(/^\d{2}-\d{2}-\d{4}$/),
  count: z.number().int().min(1).max(500),
});
export type UniteFinanceRequest = z.infer<typeof uniteFinanceRequestSchema>;

/** Invoice numbers in a response that fail validation (reported, never dropped from raw). */
export function invalidInvoiceCount(raw: unknown): number {
  const data = (raw as { Data?: unknown } | null)?.Data;
  if (!Array.isArray(data)) return 0;
  return data.filter((d) => !uniteInvoiceSchema.safeParse(d).success).length;
}
