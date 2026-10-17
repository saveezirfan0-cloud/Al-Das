"use client";

import * as React from "react";
import { Loader2 } from "lucide-react";
import { toast } from "sonner";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import type { SignerCapacity } from "@/lib/campaigns/consent-rule";

import { signHealthDataRuleAction } from "./actions";

type Row = {
  capacity: SignerCapacity;
  label: string;
  signedBy: string | null;
  signedAt: string | null;
  current: boolean;
  mine: boolean;
};

const STATE_LABEL: Record<string, string> = {
  unsigned: "Waiting for both signatures",
  partly_signed: "Waiting for one more signature",
  signed: "Signed by both",
  outdated: "A signature no longer counts",
};

export function RuleSignoff({
  version,
  text,
  hashShort,
  state,
  rows,
}: {
  version: string;
  text: string;
  hashShort: string;
  state: string;
  rows: Row[];
}) {
  const [confirm, setConfirm] = React.useState("");
  const [pending, startTransition] = React.useTransition();

  function act(capacity: SignerCapacity, withdraw: boolean) {
    startTransition(async () => {
      const res = await signHealthDataRuleAction({ capacity, withdraw, confirm });
      if (res.ok) {
        toast.success(res.message);
        setConfirm("");
      } else toast.error(res.error);
    });
  }

  return (
    <div className="flex max-w-3xl flex-col gap-5">
      <section className="rounded-lg border p-4">
        <div className="mb-2 flex flex-wrap items-center gap-2">
          <h2 className="text-base font-semibold">The rule</h2>
          <Badge variant={state === "signed" ? "success" : "warning"}>{STATE_LABEL[state]}</Badge>
          <span className="text-muted-foreground text-xs">
            Version {version} · fingerprint {hashShort}
          </span>
        </div>
        <pre className="font-sans text-sm whitespace-pre-wrap">{text}</pre>
        <p className="text-muted-foreground mt-3 text-xs">
          The system refuses health information in marketing whether or not this is signed. The
          signatures record that the clinical lead and management accepted this wording. If the
          wording changes, earlier signatures stop counting.
        </p>
      </section>

      <section className="grid gap-3 sm:grid-cols-2">
        {rows.map((r) => (
          <div key={r.capacity} className="flex flex-col gap-2 rounded-lg border p-4">
            <h3 className="font-medium">{r.label}</h3>
            {r.signedBy ? (
              <p className="text-sm">
                {r.signedBy}
                {r.signedAt && (
                  <span className="text-muted-foreground">
                    {" "}
                    · {new Date(r.signedAt).toLocaleDateString("en-GB")}
                  </span>
                )}
                {!r.current && (
                  <span className="mt-1 block text-xs text-amber-800 dark:text-amber-300">
                    Signed for older wording. It does not count until signed again.
                  </span>
                )}
              </p>
            ) : (
              <p className="text-muted-foreground text-sm">Not signed yet.</p>
            )}
            <div className="mt-auto flex flex-wrap gap-2">
              {(!r.signedBy || !r.current) && (
                <Button size="sm" disabled={pending} onClick={() => act(r.capacity, false)}>
                  {pending && <Loader2 className="animate-spin" />} Sign as {r.label.toLowerCase()}
                </Button>
              )}
              {r.signedBy && r.mine && (
                <Button
                  size="sm"
                  variant="outline"
                  disabled={pending}
                  onClick={() => act(r.capacity, true)}
                >
                  Withdraw my signature
                </Button>
              )}
            </div>
          </div>
        ))}
      </section>

      <div className="grid max-w-xs gap-2">
        <Label htmlFor="rule-confirm">Type SIGN to confirm a signature</Label>
        <Input
          id="rule-confirm"
          value={confirm}
          onChange={(e) => setConfirm(e.target.value)}
          autoComplete="off"
        />
        <p className="text-muted-foreground text-xs">
          You sign with your own account. Two different people must sign.
        </p>
      </div>
    </div>
  );
}
