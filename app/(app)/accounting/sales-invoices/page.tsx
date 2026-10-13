import { SalesList, type SalesSearch } from "./list";

export const metadata = { title: "Sales invoices" };
export const dynamic = "force-dynamic";

export default async function SalesInvoicesPage({
  searchParams,
}: {
  searchParams: Promise<SalesSearch>;
}) {
  return <SalesList kind="invoice" sp={await searchParams} />;
}
