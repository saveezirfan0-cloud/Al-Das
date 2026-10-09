import { ComingSoon } from "@/components/shell/coming-soon";
import { requirePerm } from "@/lib/auth/session";

export const metadata = { title: "Reference data" };

export default async function Page() {
  await requirePerm("finance.reference.manage");
  return (
    <ComingSoon
      title="Reference data"
      phase="Finance phase F5"
      description="Branch map, doctor departments, service categories and exception thresholds."
    />
  );
}
