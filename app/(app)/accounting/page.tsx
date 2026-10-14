import { redirect } from "next/navigation";

import { enforceFinanceWindow, requireMember } from "@/lib/auth/session";
import { accountingLanding } from "@/lib/accounting/nav";

export default async function AccountingIndex() {
  const member = await requireMember();
  await enforceFinanceWindow(member); // outside the finance access window: the explanation page, not the dashboard
  redirect(accountingLanding(member) ?? "/dashboard");
}
