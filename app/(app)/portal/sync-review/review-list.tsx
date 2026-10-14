"use client";

import * as React from "react";
import { Loader2, Search } from "lucide-react";
import { toast } from "sonner";

import { useConfirm } from "@/components/shell/confirm-dialog";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { formatPhone } from "@/lib/phone";

import { searchContactsQuick } from "../../contacts/actions";
import { resolveReview } from "./actions";

export type ReviewItem = {
  id: string;
  source: "unite" | "sanoflow";
  /** sync_reviews.entity: contact, appointment … */
  entity: string;
  /** What to do, for Sanoflow import items. */
  hint: string | null;
  /** Allowed actions for Sanoflow items; null = the Unite set. */
  actions: Array<"link" | "dismiss"> | null;
  key: string;
  reason: string;
  status: string;
  createdAt: string;
  incoming: { pin: string | null; name: string; phone: string | null; dob: string | null };
  waitingAppointments: number;
  candidates: Array<{
    id: string;
    name: string;
    phone: string | null;
    pin: string | null;
    dob: string | null;
    matchedOn: string;
  }>;
};

const REASONS: Record<string, string> = {
  no_match: "No patient in Pulse matches",
  shared_phone:
    "This phone number belongs to someone else in Pulse (probably a family member). Link as a dependant or create a separate patient",
  multiple_phone_matches: "More than one patient has this phone number",
  multiple_external_id_matches: "More than one patient has this Unite PIN",
  multiple_name_dob_matches: "More than one patient has this name and date of birth",
  multiple_matches: "More than one patient matches",
  appointment_contact_not_found: "No patient in Pulse for this appointment",
  appointment_slot_taken: "The doctor is busy at this time in Pulse",
};

function ReviewCard({ item, canResolve }: { item: ReviewItem; canResolve: boolean }) {
  const [ask, askDialog] = useConfirm();
  const [pending, startTransition] = React.useTransition();
  const [q, setQ] = React.useState("");
  const [found, setFound] = React.useState<
    Array<{ id: string; name: string; phone: string | null }>
  >([]);

  React.useEffect(() => {
    if (q.trim().length < 2) {
      setFound([]);
      return;
    }
    let cancelled = false;
    const h = setTimeout(() => {
      void searchContactsQuick(q.trim()).then((res) => {
        if (!cancelled && res.ok)
          setFound(
            res.data.rows.map((r) => ({
              id: r.id,
              name: r.full_name || "Unnamed",
              phone: r.phone_e164 ? formatPhone(r.phone_e164) : null,
            })),
          );
      });
    }, 250);
    return () => {
      cancelled = true;
      clearTimeout(h);
    };
  }, [q]);

  async function run(input: Parameters<typeof resolveReview>[0], confirmText?: string) {
    if (confirmText && !(await ask(confirmText))) return;
    startTransition(async () => {
      const res = await resolveReview(input);
      if (res.ok) toast.success(res.message);
      else toast.error(res.error);
    });
  }

  const open = item.status === "open";
  const sanoflow = item.source === "sanoflow";
  const mayLink = !sanoflow || !!item.actions?.includes("link");
  return (
    <Card>
      <CardHeader className="flex flex-row items-start justify-between gap-3">
        <div>
          {sanoflow ? (
            <>
              <CardTitle className="text-base">
                Sanoflow {item.entity.replace(/_/g, " ")}{" "}
                <Badge variant="outline">{item.key}</Badge>
              </CardTitle>
              {item.hint && <p className="text-muted-foreground text-xs">{item.hint}</p>}
            </>
          ) : (
            <>
              <CardTitle className="text-base">
                {item.incoming.name || "Unnamed patient"}{" "}
                {item.incoming.pin && <Badge variant="outline">Unite {item.incoming.pin}</Badge>}
              </CardTitle>
              <p className="text-muted-foreground text-xs">
                {[item.incoming.phone, item.incoming.dob && `DOB ${item.incoming.dob}`]
                  .filter(Boolean)
                  .join(" · ") || "No phone or date of birth sent"}
              </p>
            </>
          )}
        </div>
        <div className="flex flex-col items-end gap-1 text-right">
          <Badge variant="secondary">{REASONS[item.reason] ?? item.reason}</Badge>
          {item.waitingAppointments > 0 && (
            <span className="text-muted-foreground text-xs">
              {item.waitingAppointments} appointment{item.waitingAppointments === 1 ? "" : "s"}{" "}
              waiting
            </span>
          )}
        </div>
      </CardHeader>
      <CardContent className="flex flex-col gap-4">
        {item.candidates.length > 0 && (
          <ul className="divide-y rounded-md border text-sm">
            {item.candidates.map((c) => (
              <li key={c.id} className="flex items-center justify-between gap-3 px-3 py-2">
                <span>
                  <span className="font-medium">{c.name}</span>
                  <span className="text-muted-foreground block text-xs">
                    {[
                      c.phone,
                      c.pin && `PIN ${c.pin}`,
                      c.dob && `DOB ${c.dob}`,
                      `matched on ${c.matchedOn.replace("_", " ")}`,
                    ]
                      .filter(Boolean)
                      .join(" · ")}
                  </span>
                </span>
                {open && canResolve && mayLink && (
                  <span className="flex flex-wrap justify-end gap-2">
                    <Button
                      size="sm"
                      variant="outline"
                      disabled={pending}
                      onClick={() => run({ id: item.id, action: "link", contactId: c.id })}
                    >
                      Link to this patient
                    </Button>
                    {!sanoflow && item.reason === "shared_phone" && item.incoming.name && (
                      <Button
                        size="sm"
                        variant="outline"
                        disabled={pending}
                        onClick={() =>
                          run(
                            { id: item.id, action: "create_dependant", guardianId: c.id },
                            `Create ${item.incoming.name} as a dependant of ${c.name}? Reminders will go to ${c.name}'s number.`,
                          )
                        }
                      >
                        Create as their dependant
                      </Button>
                    )}
                  </span>
                )}
              </li>
            ))}
          </ul>
        )}

        {open && canResolve && (
          <div className="flex flex-col gap-2">
            {mayLink && (
              <div className="relative">
                <Search className="text-muted-foreground absolute top-2.5 left-2.5 size-4" />
                <Input
                  className="pl-8"
                  placeholder="Link to a different patient: search by name or phone"
                  value={q}
                  onChange={(e) => setQ(e.target.value)}
                />
              </div>
            )}
            {mayLink && found.length > 0 && (
              <ul className="divide-y rounded-md border text-sm">
                {found.map((f) => (
                  <li key={f.id} className="flex items-center justify-between gap-3 px-3 py-2">
                    <span>
                      <span className="font-medium">{f.name}</span>
                      <span className="text-muted-foreground"> {f.phone}</span>
                    </span>
                    <Button
                      size="sm"
                      variant="outline"
                      disabled={pending}
                      onClick={() => run({ id: item.id, action: "link", contactId: f.id })}
                    >
                      Link
                    </Button>
                  </li>
                ))}
              </ul>
            )}
            <div className="flex flex-wrap gap-2">
              {!sanoflow && (
                <Button
                  size="sm"
                  disabled={pending}
                  onClick={() =>
                    run(
                      { id: item.id, action: "create" },
                      "Create a new patient from the details Unite sent?",
                    )
                  }
                >
                  {pending && <Loader2 className="animate-spin" />} Create new patient
                </Button>
              )}
              <Button
                size="sm"
                variant="ghost"
                disabled={pending}
                onClick={() =>
                  run(
                    { id: item.id, action: "dismiss" },
                    sanoflow
                      ? "Dismiss this item? Nothing is booked or linked, and later import runs will not raise it again."
                      : "Dismiss this item? Its appointments stay unlinked.",
                  )
                }
              >
                Dismiss
              </Button>
            </div>
          </div>
        )}
      </CardContent>
      {askDialog}
    </Card>
  );
}

export function ReviewList({ items, canResolve }: { items: ReviewItem[]; canResolve: boolean }) {
  if (items.length === 0)
    return (
      <p className="text-muted-foreground rounded-xl border border-dashed p-10 text-center text-sm">
        Nothing to review here.
      </p>
    );
  return (
    <div className="flex flex-col gap-4">
      {items.map((i) => (
        <ReviewCard key={i.id} item={i} canResolve={canResolve} />
      ))}
    </div>
  );
}
