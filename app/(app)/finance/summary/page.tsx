import { ComingSoon } from "@/components/shell/coming-soon";
import { requirePerm } from "@/lib/auth/session";

export const metadata = { title: "Monthly summary" };

export default async function Page() {
  await requirePerm("finance.view");
  return (
    <ComingSoon
      title="Monthly summary"
      phase="Finance phase F5"
      description="Generated, claimed, remitted, rejected, outstanding and self-pay collected, by month and branch."
    />
  );
}
