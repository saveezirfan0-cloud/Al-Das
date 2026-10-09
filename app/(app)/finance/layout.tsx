import { can } from "@/lib/auth/can";
import { requireMember } from "@/lib/auth/session";

import { SettingsNav } from "../settings/settings-nav";

/** Finance & Insurance module shell. Each tab is gated again on its own page. */
export default async function FinanceLayout({ children }: { children: React.ReactNode }) {
  const member = await requireMember();
  const items = [
    can(member, "finance.view") && { href: "/finance/summary", label: "Monthly summary" },
    can(member, "finance.invoices.view") && { href: "/finance/invoices", label: "Invoices" },
    can(member, "finance.claims.view") && { href: "/finance/claims", label: "Claims" },
    can(member, "finance.claims.import") && { href: "/finance/upload", label: "Insurance upload" },
    can(member, "finance.exceptions.manage") && {
      href: "/finance/exceptions",
      label: "Exceptions",
    },
    can(member, "finance.capture.manage") && { href: "/finance/health", label: "Data health" },
    can(member, "finance.reference.manage") && {
      href: "/finance/reference",
      label: "Reference data",
    },
  ].filter((i): i is { href: string; label: string } => !!i);

  return (
    <div className="flex flex-col gap-6 md:flex-row md:gap-10">
      <SettingsNav items={items} label="Finance" />
      <div className="min-w-0 flex-1">{children}</div>
    </div>
  );
}
