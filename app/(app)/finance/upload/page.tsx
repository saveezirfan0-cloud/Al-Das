import { ComingSoon } from "@/components/shell/coming-soon";
import { requirePerm } from "@/lib/auth/session";

export const metadata = { title: "Insurance upload" };

export default async function Page() {
  await requirePerm("finance.claims.import");
  return (
    <ComingSoon
      title="Insurance upload"
      phase="Finance phase F4"
      description="Upload the Diligence claims report, review the validation preview, then confirm."
    />
  );
}
