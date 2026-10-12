import { redirect } from "next/navigation";

import { requireMember } from "@/lib/auth/session";
import { financeLanding } from "@/lib/finance/nav";

export default async function FinanceIndex() {
  const member = await requireMember();
  redirect(financeLanding(member) ?? "/dashboard");
}
