import { redirect } from "next/navigation";

import { requireMember } from "@/lib/auth/session";
import { accountingLanding } from "@/lib/accounting/nav";

export default async function AccountingIndex() {
  const member = await requireMember();
  redirect(accountingLanding(member) ?? "/dashboard");
}
