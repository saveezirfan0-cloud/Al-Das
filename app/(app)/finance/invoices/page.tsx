import { ComingSoon } from "@/components/shell/coming-soon";
import { requirePerm } from "@/lib/auth/session";

export const metadata = { title: "Invoices" };

export default async function Page() {
  await requirePerm("finance.invoices.view");
  return (
    <ComingSoon
      title="Invoices"
      phase="Finance phase F5"
      description="Every Unite invoice with lines, payments, matched claim lines and version history."
    />
  );
}
