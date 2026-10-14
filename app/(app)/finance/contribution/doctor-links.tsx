"use client";

import * as React from "react";
import { toast } from "sonner";

import { Button } from "@/components/ui/button";

import { linkReportDoctor, unlinkReportDoctor } from "./actions";

type RefDoctor = { dhaId: string; name: string };

/** One unlinked report doctor: pick the DHA id from the reference doctors and link it. */
export function LinkDoctor({
  doctorKey,
  name,
  doctors,
}: {
  doctorKey: string;
  name: string;
  doctors: readonly RefDoctor[];
}) {
  const [dha, setDha] = React.useState("");
  const [pending, start] = React.useTransition();
  const id = `link-${doctorKey.replace(/[^a-z0-9]/gi, "-")}`;
  return (
    <form
      className="flex flex-wrap items-center gap-2"
      onSubmit={(e) => {
        e.preventDefault();
        start(async () => {
          const res = await linkReportDoctor(doctorKey, dha);
          if (res.ok) toast.success(res.message ?? "Linked");
          else toast.error(res.error);
        });
      }}
    >
      <label htmlFor={id} className="sr-only">
        DHA id for {name}
      </label>
      <select
        id={id}
        value={dha}
        onChange={(e) => setDha(e.target.value)}
        className="border-input bg-background h-9 max-w-72 rounded-md border px-2 text-sm"
        required
      >
        <option value="">Choose the doctor…</option>
        {doctors.map((d) => (
          <option key={d.dhaId} value={d.dhaId}>
            {d.name} ({d.dhaId})
          </option>
        ))}
      </select>
      <Button type="submit" size="sm" variant="secondary" disabled={pending || !dha}>
        Link
      </Button>
    </form>
  );
}

export function UnlinkDoctor({ doctorKey, name }: { doctorKey: string; name: string }) {
  const [pending, start] = React.useTransition();
  return (
    <Button
      type="button"
      size="sm"
      variant="ghost"
      disabled={pending}
      aria-label={`Remove the DHA link of ${name}`}
      onClick={() =>
        start(async () => {
          const res = await unlinkReportDoctor(doctorKey);
          if (res.ok) toast.success(res.message ?? "Removed");
          else toast.error(res.error);
        })
      }
    >
      Unlink
    </Button>
  );
}
