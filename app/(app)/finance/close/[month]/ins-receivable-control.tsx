import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Table, TableBody, TableCell, TableRow } from "@/components/ui/table";
import { insReceivableSection, readControls } from "@/lib/finance/close-controls";
import type { ClosePack } from "@/lib/finance/close-pack";
import type { CloseRecord } from "@/lib/finance/close-server";
import { snapshotStatus, STATUS_LABEL } from "@/lib/finance/insurance-receivable-control";

import { ExplainInsReceivableForm } from "../close-controls";

/**
 * docs/48: Diligence insurance receivable beside Tally's insurer receivable at the month end, read from the frozen
 * snapshot (never from live data), with the preparer's explanation when the two differ.
 */
export function InsReceivableControl({
  pack,
  close,
  month,
  canExplain,
  noteText,
}: {
  pack: ClosePack;
  close: CloseRecord;
  month: string;
  /** finance.close.manage, and the pack still waits for the finance sign-off */
  canExplain: boolean;
  /** the stored explanation (also when it was written for an earlier build), to start the form from */
  noteText: string | null;
}) {
  const controls = readControls(pack.controls);
  if (!controls) return null;
  const section = insReceivableSection(controls);
  const status = snapshotStatus(controls);
  const note = close.sign.insNote ?? null;
  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex flex-wrap items-center gap-2 text-base">
          Insurance receivable control
          {status && (
            <Badge
              variant={
                status === "agrees" ? "success" : status === "differs" ? "warning" : "outline"
              }
            >
              {STATUS_LABEL[status]}
            </Badge>
          )}
        </CardTitle>
        <CardDescription>
          Diligence (claimed less remitted less approved write-offs) beside Tally&apos;s insurer
          receivable at the month end, frozen with this pack. The Tally figure is only as fresh as
          the last Tally pull.
        </CardDescription>
      </CardHeader>
      <CardContent className="flex flex-col gap-4 text-sm">
        <Table>
          <TableBody>
            {section.rows.map(([k, v], i) => (
              <TableRow key={`${i}-${k}`}>
                <TableCell className="text-xs whitespace-pre-wrap">{k}</TableCell>
                <TableCell className="text-right text-xs tabular-nums">{v}</TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
        {status === "differs" && (
          <div className="flex flex-col gap-2">
            <div className="font-medium">Explanation</div>
            {note?.state === "given" ? (
              <>
                <p className="whitespace-pre-wrap">{note.text}</p>
                <p className="text-muted-foreground text-xs">
                  Written by {note.by ?? "a member"}
                  {note.at ? ` on ${new Date(note.at).toLocaleDateString("en-GB")}` : ""}. The
                  person who signs for Finance reviews it and must be someone else.
                </p>
              </>
            ) : (
              <p className="text-muted-foreground">
                {note?.state === "stale"
                  ? "The explanation was written for an earlier build of this pack. Explain this build before Finance signs."
                  : "Finance cannot sign until the preparer explains the difference."}
              </p>
            )}
            {canExplain && close.hash && (
              <ExplainInsReceivableForm
                id={close.id}
                month={month}
                hash={close.hash}
                current={noteText}
              />
            )}
          </div>
        )}
      </CardContent>
    </Card>
  );
}
