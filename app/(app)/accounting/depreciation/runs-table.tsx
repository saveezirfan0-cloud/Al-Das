import Link from "next/link";

import { EmptyState } from "@/components/shell/empty-state";
import { Badge } from "@/components/ui/badge";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { RUN_KIND_LABELS, RUN_STATUS_LABELS } from "@/lib/accounting/assets/runs";
import type { RunView } from "@/lib/accounting/assets/server";
import { money } from "@/lib/finance/format";

import { PostRunButton } from "./controls";

/** The runs of one page (server component). Post shows for an approver who did not prepare the run. */
export function RunsTable({
  runs,
  people,
  viewerId,
  canPost,
  basePath,
  selected,
  showKind = false,
}: {
  runs: RunView[];
  people: Map<string, string>;
  viewerId: string;
  canPost: boolean;
  basePath: string;
  selected: string | null;
  showKind?: boolean;
}) {
  const who = (id: string | null, fallback: string) =>
    id ? (people.get(id) ?? "a member") : fallback;
  return (
    <Table>
      <TableHeader>
        <TableRow>
          <TableHead>Month</TableHead>
          {showKind && <TableHead>Run</TableHead>}
          <TableHead>Status</TableHead>
          <TableHead className="text-right">Lines</TableHead>
          <TableHead className="text-right">Total</TableHead>
          <TableHead>Prepared</TableHead>
          <TableHead>Posted</TableHead>
          <TableHead />
        </TableRow>
      </TableHeader>
      <TableBody>
        {runs.length === 0 && (
          <TableRow>
            <TableCell colSpan={showKind ? 8 : 7}>
              <EmptyState
                title="No runs yet"
                description="Prepare a month to see its lines before anyone posts it."
                className="border-0 p-6"
              />
            </TableCell>
          </TableRow>
        )}
        {runs.map((r) => (
          <TableRow key={r.id} className={selected === r.id ? "bg-muted/50" : ""}>
            <TableCell className="whitespace-nowrap">
              {r.periodMonth.slice(0, 7)}
              {r.version > 1 && (
                <span className="text-muted-foreground ml-1 text-xs">v{r.version}</span>
              )}
            </TableCell>
            {showKind && <TableCell className="text-sm">{RUN_KIND_LABELS[r.kind]}</TableCell>}
            <TableCell>
              <Badge
                variant={
                  r.status === "posted" ? "success" : r.status === "draft" ? "outline" : "warning"
                }
              >
                {RUN_STATUS_LABELS[r.status]}
              </Badge>
            </TableCell>
            <TableCell className="text-right">{r.lineCount}</TableCell>
            <TableCell className="text-right tabular-nums">{money(r.total)}</TableCell>
            <TableCell className="text-sm">{who(r.preparedBy, "the monthly job")}</TableCell>
            <TableCell className="text-sm">
              {r.postedAt ? (
                <>
                  {who(r.postedBy, "a member")}
                  {r.postedVersion !== r.version && (
                    <span className="text-muted-foreground text-xs"> (v{r.postedVersion})</span>
                  )}
                  {r.journalId && (
                    <Link
                      href={`/accounting/journals/${r.journalId}`}
                      className="ml-1 text-xs underline"
                    >
                      journal
                    </Link>
                  )}
                </>
              ) : (
                ""
              )}
            </TableCell>
            <TableCell className="text-right whitespace-nowrap">
              <Link href={`${basePath}?run=${r.id}`} className="mr-2 text-sm underline">
                Lines
              </Link>
              {canPost && r.status !== "posted" && r.preparedBy !== viewerId && (
                <PostRunButton
                  id={r.id}
                  hash={r.sha256}
                  label={`${RUN_KIND_LABELS[r.kind].toLowerCase()} for ${r.periodMonth.slice(0, 7)}`}
                />
              )}
            </TableCell>
          </TableRow>
        ))}
      </TableBody>
    </Table>
  );
}
