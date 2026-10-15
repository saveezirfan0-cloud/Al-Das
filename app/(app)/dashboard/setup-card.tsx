import Link from "next/link";
import { ArrowRight, Circle } from "lucide-react";

import { Button } from "@/components/ui/button";
import {
  Card,
  CardAction,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import type { ReadinessRow } from "@/lib/golive/readiness";

/** First-run card on the dashboard: the next clinic set-up steps (lib/golive/readiness.ts setupProgress). */
export function SetupCard({
  done,
  total,
  next,
  allowed,
}: {
  done: number;
  total: number;
  next: readonly ReadinessRow[];
  allowed: (perm: string | undefined) => boolean;
}) {
  return (
    <Card aria-labelledby="dash-setup">
      <CardHeader>
        <CardTitle id="dash-setup">Set up your clinic</CardTitle>
        <CardDescription>
          {done} of {total} done. Next steps:
        </CardDescription>
        <CardAction>
          <Button asChild variant="outline" size="sm">
            <Link href="/settings/readiness">Full checklist</Link>
          </Button>
        </CardAction>
      </CardHeader>
      <CardContent>
        <ol className="flex flex-col gap-3">
          {next.map((r) => (
            <li key={r.key} className="flex items-start gap-3">
              <Circle className="text-muted-foreground mt-0.5 size-4 shrink-0" aria-hidden />
              <div className="min-w-0 flex-1">
                <div className="text-sm font-medium">
                  {r.href && allowed(r.perm) ? (
                    <Link
                      href={r.href}
                      className="inline-flex items-center gap-1 underline-offset-2 hover:underline"
                    >
                      {r.label}
                      <ArrowRight className="size-3.5" aria-hidden />
                    </Link>
                  ) : (
                    r.label
                  )}
                </div>
                <p className="text-muted-foreground text-xs text-pretty">{r.detail}</p>
              </div>
            </li>
          ))}
        </ol>
      </CardContent>
    </Card>
  );
}
