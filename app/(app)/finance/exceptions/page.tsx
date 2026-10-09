import { ComingSoon } from "@/components/shell/coming-soon";
import { requirePerm } from "@/lib/auth/session";

export const metadata = { title: "Exceptions" };

export default async function Page() {
  await requirePerm("finance.exceptions.manage");
  return (
    <ComingSoon
      title="Exceptions"
      phase="Finance phase F5"
      description="Your queue of finance exceptions: assign, comment and close."
    />
  );
}
