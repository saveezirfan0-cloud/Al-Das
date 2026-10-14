"use client";

import * as React from "react";
import { useRouter } from "next/navigation";
import { Link2, Loader2 } from "lucide-react";
import { toast } from "sonner";

import { OptionSelect } from "@/app/(app)/enquiries/option-select";
import { Button } from "@/components/ui/button";
import type { LinkSuggestion } from "@/lib/organisation/doctor-links";
import type { DoctorFinanceLink, Option } from "@/lib/organisation/types";

import { loadDoctorFinanceLinkAction, saveDoctorFinanceLinkAction } from "./actions";

type Kind = "finance" | "report";

const WHY = { licence: "same licence number", name: "same name" } as const;

type What = { one: string; many: string };

function hint(s: LinkSuggestion, label: string | null, what: What): string {
  switch (s.status) {
    case "match":
      return `Suggested: ${label} (${WHY[s.reason]}).`;
    case "ambiguous":
      return `Several ${what.many} match this doctor; pick the right one.`;
    case "taken":
      return `The matching ${what.one} (${label}) is linked to another doctor.`;
    default:
      return `No matching ${what.one} found.`;
  }
}

/**
 * The doctor drawer's Finance link (finance.reference.manage): which finance doctor (DHA id) and which Unite report
 * name are this doctor. With settings.manage as well, a person confirms a suggestion, picks another or clears it. The
 * buttons are type="button": the section sits inside the profile form.
 */
export function DoctorFinanceLinkSection({
  doctorId,
  canManage,
}: {
  doctorId: string;
  canManage: boolean;
}) {
  const router = useRouter();
  const [data, setData] = React.useState<DoctorFinanceLink | null>(null);
  const [error, setError] = React.useState<string | null>(null);
  const [pending, startTransition] = React.useTransition();
  const [reload, setReload] = React.useState(0);

  React.useEffect(() => {
    let live = true;
    setError(null);
    void loadDoctorFinanceLinkAction(doctorId).then((res) => {
      if (!live) return;
      if (res.ok) setData(res.data);
      else setError(res.error);
    });
    return () => {
      live = false;
    };
  }, [doctorId, reload]);

  function save(kind: Kind, value: string | null) {
    startTransition(async () => {
      const res = await saveDoctorFinanceLinkAction(doctorId, { kind, value });
      if (!res.ok) return void toast.error(res.error);
      toast.success(res.message ?? "Saved.");
      setReload((n) => n + 1);
      router.refresh();
    });
  }

  return (
    <section className="grid gap-3" aria-labelledby="doc-finance">
      <h3 id="doc-finance" className="flex items-center gap-1.5 text-sm font-semibold">
        <Link2 aria-hidden className="size-4" /> Finance link
      </h3>
      {error ? (
        <p className="text-muted-foreground text-sm">{error}</p>
      ) : !data ? (
        <p className="text-muted-foreground flex items-center gap-2 text-sm" role="status">
          <Loader2 aria-hidden className="size-4 animate-spin" /> Loading the finance link…
        </p>
      ) : (
        <>
          <LinkRow
            kind="finance"
            title="Finance doctor (DHA id)"
            what={{ one: "finance doctor", many: "finance doctors" }}
            linked={data.finance && { value: data.finance.dhaId, ...data.finance }}
            suggestion={data.suggestions.finance}
            suggestedLabel={data.suggestedLabels.finance}
            options={data.financeOptions}
            canManage={canManage}
            pending={pending}
            onSave={save}
          />
          <LinkRow
            kind="report"
            title="Name in the Unite report"
            what={{ one: "report name", many: "report names" }}
            linked={data.report && { value: data.report.key, ...data.report }}
            suggestion={data.suggestions.report}
            suggestedLabel={data.suggestedLabels.report}
            options={data.reportOptions}
            canManage={canManage}
            pending={pending}
            onSave={save}
          />
        </>
      )}
    </section>
  );
}

function LinkRow({
  kind,
  title,
  what,
  linked,
  suggestion,
  suggestedLabel,
  options,
  canManage,
  pending,
  onSave,
}: {
  kind: Kind;
  title: string;
  what: What;
  linked: { value: string; label: string; missing: boolean } | null;
  suggestion: LinkSuggestion;
  suggestedLabel: string | null;
  options: Option[];
  canManage: boolean;
  pending: boolean;
  onSave: (kind: Kind, value: string | null) => void;
}) {
  const [pick, setPick] = React.useState<string | null>(null);
  return (
    <div className="grid gap-1.5 text-sm">
      <span className="font-medium">{title}</span>
      {linked ? (
        <p>
          {linked.label}
          {linked.missing && (
            <span className="text-muted-foreground">
              {" "}
              (
              {kind === "finance"
                ? "not in the finance reference now"
                : "not in the current report"}
              )
            </span>
          )}
        </p>
      ) : (
        <p className="text-muted-foreground">
          Not linked. {hint(suggestion, suggestedLabel, what)}
        </p>
      )}
      {canManage && (
        <div className="flex flex-wrap items-center gap-2">
          {!linked && suggestion.status === "match" && (
            <Button
              type="button"
              size="sm"
              disabled={pending}
              onClick={() => onSave(kind, suggestion.value)}
            >
              Confirm suggestion
            </Button>
          )}
          {options.length > 0 && (
            <>
              <OptionSelect
                className="w-56"
                ariaLabel={`${title}: choose`}
                placeholder={linked ? "Change to…" : "Choose…"}
                allowNone={false}
                value={pick}
                options={options}
                onChange={setPick}
              />
              <Button
                type="button"
                size="sm"
                variant="outline"
                disabled={pending || !pick || pick === linked?.value}
                onClick={() => pick && onSave(kind, pick)}
              >
                Link
              </Button>
            </>
          )}
          {linked && (
            <Button
              type="button"
              size="sm"
              variant="ghost"
              disabled={pending}
              onClick={() => onSave(kind, null)}
            >
              Clear
            </Button>
          )}
        </div>
      )}
    </div>
  );
}
