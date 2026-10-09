import { redirect } from "next/navigation";

import { can } from "@/lib/auth/can";
import { requireMember } from "@/lib/auth/session";

export default async function FinanceIndex() {
  const member = await requireMember();
  const landing: Array<[string, string]> = [
    ["finance.view", "/finance/summary"],
    ["finance.invoices.view", "/finance/invoices"],
    ["finance.claims.view", "/finance/claims"],
    ["finance.exceptions.manage", "/finance/exceptions"],
    ["finance.capture.manage", "/finance/health"],
  ];
  const target = landing.find(([perm]) => can(member, perm));
  redirect(target ? target[1] : "/dashboard");
}
