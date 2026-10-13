"use client";

import { useState, useTransition } from "react";
import { Loader2 } from "lucide-react";
import { toast } from "sonner";

import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";

import { saveReviewLinks } from "./review-actions";

/** One Google review link per location. Only the clinic's own links, on Google's hosts, are accepted (checked again on the server). */
export function ReviewLinks({
  canManage,
  locations,
}: {
  canManage: boolean;
  locations: Array<{ id: string; name: string; url: string }>;
}) {
  const [pending, start] = useTransition();
  const [values, setValues] = useState<Record<string, string>>(
    Object.fromEntries(locations.map((l) => [l.id, l.url])),
  );

  return (
    <Card>
      <CardHeader>
        <CardTitle>Review links</CardTitle>
        <CardDescription>
          The Google review link of each location (for example https://g.page/r/…/review). A visit
          at a location without a link is never asked. Pulse does not contact Google: the link is
          only text inside the WhatsApp message.
        </CardDescription>
      </CardHeader>
      <CardContent className="flex flex-col gap-4">
        {locations.length === 0 && (
          <p className="text-muted-foreground text-sm">Add a location under Settings first.</p>
        )}
        {locations.map((l) => (
          <div key={l.id} className="grid max-w-xl gap-1">
            <Label htmlFor={`rl-${l.id}`}>{l.name}</Label>
            <Input
              id={`rl-${l.id}`}
              type="url"
              autoComplete="off"
              disabled={!canManage}
              placeholder="https://g.page/r/…/review"
              value={values[l.id] ?? ""}
              onChange={(e) => setValues((v) => ({ ...v, [l.id]: e.target.value }))}
            />
          </div>
        ))}
        {canManage && locations.length > 0 && (
          <div>
            <Button
              disabled={pending}
              onClick={() =>
                start(async () => {
                  const r = await saveReviewLinks({ links: values });
                  if (r.ok) toast.success(r.message);
                  else toast.error(r.error);
                })
              }
            >
              {pending && <Loader2 className="animate-spin" />} Save links
            </Button>
          </div>
        )}
      </CardContent>
    </Card>
  );
}
