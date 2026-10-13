import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Table, TableBody, TableCell, TableRow } from "@/components/ui/table";
import {
  CONTROLS_SCOPE,
  controlSections,
  NOT_CAPTURED,
  readControls,
} from "@/lib/finance/close-controls";
import type { ClosePack } from "@/lib/finance/close-pack";

/** The Board pack controls and matters, read from the frozen snapshot (never from live data). */
export function ControlsSummary({ pack }: { pack: ClosePack }) {
  const controls = readControls(pack.controls);
  const matters = Array.isArray(pack.matters) ? pack.matters : [];
  return (
    <>
      <Card>
        <CardHeader>
          <CardTitle className="text-base">Matters needing attention</CardTitle>
          <CardDescription>
            {controls
              ? `From the control summary frozen with this pack: ages and workflow states as at ${controls.as_of}, payables as at ${controls.month_end}.`
              : NOT_CAPTURED}
          </CardDescription>
        </CardHeader>
        {controls && (
          <CardContent className="text-sm">
            {matters.length === 0 ? (
              <p className="text-muted-foreground">None found by the checks below.</p>
            ) : (
              <ul className="list-disc space-y-1 pl-5">
                {matters.map((m) => (
                  <li key={m.key}>{m.text}</li>
                ))}
              </ul>
            )}
          </CardContent>
        )}
      </Card>
      {controls && (
        <div className="grid gap-4 lg:grid-cols-2">
          {controlSections(controls).map((sec) => (
            <Card key={sec.title}>
              <CardHeader>
                <CardTitle className="text-base">{sec.title}</CardTitle>
              </CardHeader>
              <CardContent>
                <Table>
                  <TableBody>
                    {sec.rows.map(([k, v], i) => (
                      <TableRow key={`${i}-${k}`}>
                        <TableCell className="text-xs whitespace-pre-wrap">{k}</TableCell>
                        <TableCell className="text-right text-xs tabular-nums">{v}</TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              </CardContent>
            </Card>
          ))}
        </div>
      )}
      <ul className="text-muted-foreground list-disc space-y-1 pl-5 text-xs">
        {CONTROLS_SCOPE.map((n) => (
          <li key={n}>{n}</li>
        ))}
      </ul>
    </>
  );
}
