import { ComingSoon } from "@/components/shell/coming-soon";
import { requirePerm } from "@/lib/auth/session";

export const metadata = { title: "Claims" };

export default async function Page() {
  await requirePerm("finance.claims.view");
  return (
    <ComingSoon
      title="Claims"
      phase="Finance phase F5"
      description="Diligence claim activities by status, payer and denial type, with a status timeline."
    />
  );
}
