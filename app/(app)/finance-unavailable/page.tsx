import Link from "next/link";
import { Clock } from "lucide-react";

import { Button } from "@/components/ui/button";
import { requireMember } from "@/lib/auth/session";
import { formatIp } from "@/lib/security/client-ip";
import { denyReasonText, describeWindow, readFinanceAccess } from "@/lib/security/finance-access";

export const metadata = { title: "Finance is closed" };
export const dynamic = "force-dynamic";

/**
 * Where finance and accounting page navigations land when the finance access window (Settings, Security) refuses them.
 * Shows the reason, when finance is open and, for an address problem, the person's own address so IT can add it.
 * The refusal itself was recorded by the gate that sent them here (lib/auth/session.ts).
 */
export default async function FinanceUnavailablePage() {
  const member = await requireMember();
  const decision = member.financeAccess;
  const stored = readFinanceAccess(member.org.settings);

  if (decision.allowed) {
    return (
      <div className="mx-auto flex max-w-md flex-col items-center gap-3 py-16 text-center">
        <h1 className="text-lg font-semibold">Finance is open</h1>
        <p className="text-muted-foreground text-sm">You can carry on where you were.</p>
        <Button asChild>
          <Link href="/finance">Go to Finance</Link>
        </Button>
      </div>
    );
  }

  const s = stored.ok ? stored.settings : null;
  const addressProblem = decision.reason === "ip_not_allowed" || decision.reason === "ip_unknown";

  return (
    <div className="mx-auto flex max-w-md flex-col items-center gap-3 py-16 text-center">
      <span className="bg-muted text-muted-foreground flex size-12 items-center justify-center rounded-full">
        <Clock className="size-6" aria-hidden />
      </span>
      <h1 className="text-lg font-semibold">Finance is not available right now</h1>
      <p className="text-sm">{denyReasonText(decision.reason)}</p>
      {s && (
        <p className="text-muted-foreground text-sm">
          Your organisation opens Finance and Accounting{" "}
          {s.limit_hours ? <b>{describeWindow(s, member.org.timezone)}</b> : "at any time"}
          {s.ip_allowlist.length > 0 ? ", from the clinic’s approved locations only" : ""}.
        </p>
      )}
      {addressProblem && (
        <p className="text-muted-foreground text-xs">
          {member.clientIp
            ? `Your connection's address is ${formatIp(member.clientIp)}.`
            : "Your connection's address could not be read."}{" "}
          If you should have access from here, ask an administrator to add it under Settings,
          Security.
        </p>
      )}
      <p className="text-muted-foreground text-xs">
        Everything else in Pulse works as usual. Refused attempts are reported to your
        administrators.
      </p>
      <Button asChild>
        <Link href="/dashboard">Back to the dashboard</Link>
      </Button>
    </div>
  );
}
