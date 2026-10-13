"use client";

import Link from "next/link";
import { useState, useTransition } from "react";
import { Loader2 } from "lucide-react";
import { toast } from "sonner";

import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";

import { setAdConsentBasis } from "./capi-actions";

/** Who may be included in ad events, and a link to the report. The sentence is checked again on the server. */
export function CapiPanel({
  basis,
  basisAt,
  phrase,
  canManage,
  exists,
}: {
  basis: "contact_opt_in" | "admin_declared";
  basisAt: string | null;
  phrase: string;
  canManage: boolean;
  exists: boolean;
}) {
  const [pending, start] = useTransition();
  const [typed, setTyped] = useState("");

  function save(next: "contact_opt_in" | "admin_declared") {
    start(async () => {
      const r = await setAdConsentBasis({ basis: next, confirm: typed });
      if (r.ok) {
        toast.success(r.message);
        setTyped("");
      } else toast.error(r.error);
    });
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle>Whose events may be sent</CardTitle>
        <CardDescription>
          {basis === "contact_opt_in"
            ? "Only patients who opted in to marketing messages (and have not asked to stop) are included. This is the safe default."
            : `An administrator confirmed another basis for ad measurement${basisAt ? ` on ${new Date(basisAt).toLocaleDateString()}` : ""}. Patients who asked to stop marketing are still never included.`}{" "}
          Events only ever carry the event name, the ad click id and (if chosen) a hashed phone
          number. They never name a service, a doctor or a diagnosis, and carry no value.{" "}
          <Link className="underline" href="/reports/ads">
            Open the ad report
          </Link>
          .
        </CardDescription>
      </CardHeader>
      {canManage && (
        <CardContent className="flex flex-col gap-3">
          {basis === "contact_opt_in" ? (
            <div className="grid max-w-md gap-2">
              <Label htmlFor="capi-basis-confirm">
                To include patients who have not opted in, type <strong>{phrase}</strong>
              </Label>
              <Input
                id="capi-basis-confirm"
                autoComplete="off"
                value={typed}
                onChange={(e) => setTyped(e.target.value)}
              />
              <div>
                <Button
                  variant="outline"
                  disabled={pending || !exists || typed.trim() !== phrase}
                  onClick={() => save("admin_declared")}
                >
                  {pending && <Loader2 className="animate-spin" />} Use the confirmed basis
                </Button>
              </div>
              {!exists && (
                <p className="text-muted-foreground text-xs">Save the settings above first.</p>
              )}
            </div>
          ) : (
            <div>
              <Button variant="outline" disabled={pending} onClick={() => save("contact_opt_in")}>
                {pending && <Loader2 className="animate-spin" />} Go back to opt-in only
              </Button>
            </div>
          )}
        </CardContent>
      )}
    </Card>
  );
}
