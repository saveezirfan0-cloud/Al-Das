"use client";

import { useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { Loader2, Upload } from "lucide-react";
import { toast } from "sonner";

import { Field } from "@/components/finance/forms";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import type { TallyPlanReport } from "@/lib/accounting/tally/plan";
import { createClient } from "@/lib/supabase/client";

import {
  commitTallyImport,
  createTallyUpload,
  discardTallyImport,
  stageTallyImport,
} from "./actions";

/** Upload (signed URL, straight to private storage), dry run, then the commit in steps until nothing is left. */
export function TallyUpload() {
  const input = useRef<HTMLInputElement>(null);
  const router = useRouter();
  const [busy, setBusy] = useState<null | "uploading" | "checking">(null);
  const [opening, setOpening] = useState("");
  const [force, setForce] = useState(false);
  const [duplicate, setDuplicate] = useState<string | null>(null);

  async function onFiles(list: FileList) {
    setDuplicate(null);
    const files = [...list].slice(0, 4);
    try {
      setBusy("uploading");
      const paths: string[] = [];
      for (const file of files) {
        const prep = await createTallyUpload({ filename: file.name, size: file.size });
        if (!prep.ok || !prep.data) throw new Error(prep.ok ? "Upload failed" : prep.error);
        const { error } = await createClient()
          .storage.from("accounting-imports")
          .uploadToSignedUrl(prep.data.path, prep.data.token, file, { contentType: "text/xml" });
        if (error) throw new Error(error.message);
        paths.push(prep.data.path);
      }
      setBusy("checking");
      const res = await stageTallyImport({ paths, opening_date: opening, force });
      if (!res.ok || !res.data) throw new Error(res.ok ? "The dry run failed" : res.error);
      if (res.data.kind === "duplicate") {
        setDuplicate(res.data.committedAt?.slice(0, 10) ?? "earlier");
        return;
      }
      router.push(`/accounting/tally-import?id=${res.data.importId}`);
      router.refresh();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Upload failed");
    } finally {
      setBusy(null);
      if (input.current) input.current.value = "";
    }
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle>Upload Tally&apos;s XML export</CardTitle>
        <CardDescription>
          Choose the All Masters file and the Day Book (vouchers) file together, up to four files of
          200 MB each. The dry run checks everything first and nothing is posted until you commit.
          The files are deleted right after they are read.
        </CardDescription>
      </CardHeader>
      <CardContent className="flex flex-col gap-3">
        <div className="flex flex-wrap items-end gap-3">
          <Field
            label="Opening date (optional)"
            hint="Default: the day before the first voucher's month."
          >
            <Input
              type="date"
              value={opening}
              onChange={(e) => setOpening(e.target.value)}
              className="w-44"
            />
          </Field>
          <label className="flex items-center gap-2 text-sm">
            <input type="checkbox" checked={force} onChange={(e) => setForce(e.target.checked)} />
            Import a file that was imported before
          </label>
        </div>
        <input
          ref={input}
          type="file"
          multiple
          accept=".xml,text/xml,application/xml"
          className="hidden"
          onChange={(e) => e.target.files?.length && onFiles(e.target.files)}
        />
        <div>
          <Button disabled={!!busy} onClick={() => input.current?.click()}>
            {busy ? <Loader2 className="animate-spin" /> : <Upload />}
            {busy === "uploading"
              ? "Uploading…"
              : busy === "checking"
                ? "Running the dry run…"
                : "Choose the files"}
          </Button>
        </div>
        {duplicate && (
          <Alert>
            <AlertTitle>Already imported</AlertTitle>
            <AlertDescription>
              One of these files was imported on {duplicate}. Nothing was changed. Tick the box
              above to import it again (nothing already posted is posted twice).
            </AlertDescription>
          </Alert>
        )}
      </CardContent>
    </Card>
  );
}

export function CommitPanel({
  id,
  status,
  report,
}: {
  id: string;
  status: string;
  report: TallyPlanReport;
}) {
  const router = useRouter();
  const [accept, setAccept] = useState(false);
  const [links, setLinks] = useState(false);
  const [running, setRunning] = useState(false);
  const [progress, setProgress] = useState<{ posted: number; remaining: number } | null>(null);
  const needLinks = report.ledgers.linkByName.length + report.groups.linked.length > 0;
  const blocked = report.blocking.length > 0;

  async function run() {
    setRunning(true);
    let posted = 0;
    try {
      for (let i = 0; i < 10_000; i++) {
        const res = await commitTallyImport({ id, accept_refusals: accept, confirm_links: links });
        if (!res.ok || !res.data) throw new Error(res.ok ? "The commit failed" : res.error);
        posted += res.data.posted;
        setProgress({ posted, remaining: res.data.remaining });
        if (res.data.status === "committed") {
          toast.success("Import committed.");
          break;
        }
      }
      router.refresh();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "The commit failed");
    } finally {
      setRunning(false);
    }
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle>{status === "committing" ? "Continue the commit" : "Commit"}</CardTitle>
        <CardDescription>
          Creates the groups, ledgers and cost centres, posts one opening journal and one journal
          per voucher. Safe to run again: a voucher already posted with the same Tally version is
          never posted twice.
        </CardDescription>
      </CardHeader>
      <CardContent className="flex flex-col gap-3">
        {report.refusedTotal > 0 && (
          <label className="flex items-center gap-2 text-sm">
            <input type="checkbox" checked={accept} onChange={(e) => setAccept(e.target.checked)} />
            Import the rest without the {report.refusedTotal} refused voucher(s)
          </label>
        )}
        {needLinks && (
          <label className="flex items-center gap-2 text-sm">
            <input type="checkbox" checked={links} onChange={(e) => setLinks(e.target.checked)} />
            Link the Tally accounts to the Pulse accounts with the same name (listed above)
          </label>
        )}
        {progress && (
          <p className="text-muted-foreground text-sm">
            {progress.posted} voucher(s) posted, {progress.remaining} still to go.
          </p>
        )}
        <div className="flex flex-wrap gap-2">
          <Button disabled={running || blocked} onClick={run}>
            {running && <Loader2 className="animate-spin" />}{" "}
            {status === "committing" ? "Continue" : "Commit the import"}
          </Button>
          {status === "staged" && (
            <Button
              variant="outline"
              disabled={running}
              onClick={async () => {
                const res = await discardTallyImport(id);
                if (res.ok) {
                  toast.success(res.message ?? "Discarded");
                  router.push("/accounting/tally-import");
                  router.refresh();
                } else toast.error(res.error);
              }}
            >
              Discard the dry run
            </Button>
          )}
        </div>
      </CardContent>
    </Card>
  );
}
