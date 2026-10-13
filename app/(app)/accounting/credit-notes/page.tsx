import { SalesList, type SalesSearch } from "../sales-invoices/list";

export const metadata = { title: "Credit notes" };
export const dynamic = "force-dynamic";

export default async function CreditNotesPage({
  searchParams,
}: {
  searchParams: Promise<SalesSearch>;
}) {
  return <SalesList kind="credit_note" sp={await searchParams} />;
}
