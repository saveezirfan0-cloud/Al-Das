import Link from "next/link";

import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { doneCount, type ReadinessStep } from "@/lib/finance/readiness";

const MARK = { done: "✓", todo: "○", blocked: "–" } as const;

/** What is left before the finance numbers are live. `allowed` = permissions the viewer holds. */
export function SetupChecklist({
  steps,
  allowed,
  compact = false,
}: {
  steps: readonly ReadinessStep[];
  allowed: readonly string[];
  compact?: boolean;
}) {
  const done = doneCount(steps);
  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          Getting the numbers live
          <Badge variant={done === steps.length ? "success" : "secondary"}>
            {done} of {steps.length} done
          </Badge>
        </CardTitle>
        {!compact && (
          <CardDescription>
            Nothing appears here until invoices are captured from Unite and a Diligence claims
            report is imported. Work through these in order.
          </CardDescription>
        )}
      </CardHeader>
      <CardContent>
        <ol className="flex flex-col gap-2">
          {steps.map((s) => (
            <li key={s.key} className="flex items-start gap-3 text-sm">
              <span
                aria-hidden
                className={
                  s.state === "done"
                    ? "mt-0.5 font-semibold text-emerald-600"
                    : "text-muted-foreground mt-0.5"
                }
              >
                {MARK[s.state]}
              </span>
              <div className="min-w-0">
                <div className={s.state === "done" ? "text-muted-foreground" : "font-medium"}>
                  {allowed.includes(s.perm) && s.state !== "done" ? (
                    <Link href={s.href} className="underline-offset-2 hover:underline">
                      {s.label}
                    </Link>
                  ) : (
                    s.label
                  )}
                  <span className="sr-only"> ({s.state})</span>
                </div>
                {!compact && <p className="text-muted-foreground text-xs">{s.hint}</p>}
              </div>
            </li>
          ))}
        </ol>
      </CardContent>
    </Card>
  );
}
