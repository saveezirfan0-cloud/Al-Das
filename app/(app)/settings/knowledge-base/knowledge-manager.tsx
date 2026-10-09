"use client";

import { useEffect, useRef, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { FileUp, Globe, Loader2, Plus, RefreshCw, Trash2 } from "lucide-react";
import { toast } from "sonner";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { createClient } from "@/lib/supabase/client";

import { addFileSource, addUrlSource, createGroup, deleteGroup, deleteSource, prepareKbUpload, recrawlSource, setSourceGroup } from "./actions";

type Group = { id: string; name: string; description: string | null };
type Source = {
  id: string;
  group_id: string | null;
  kind: string;
  name: string;
  url: string | null;
  status: string;
  error: string | null;
  chunk_count: number;
  last_ingested_at: string | null;
};

const NONE = "__none__";
const STATUS_BADGE: Record<string, "secondary" | "warning" | "success" | "destructive"> = {
  pending: "secondary",
  processing: "warning",
  ready: "success",
  failed: "destructive",
};

export function KnowledgeManager({ groups, sources }: { groups: Group[]; sources: Source[] }) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [url, setUrl] = useState("");
  const [groupId, setGroupId] = useState(NONE);
  const [newGroup, setNewGroup] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [uploading, setUploading] = useState(false);
  const fileInput = useRef<HTMLInputElement>(null);

  // Sources are processed in the background: poll while any is still in flight.
  const inFlight = sources.some((s) => s.status === "pending" || s.status === "processing");
  useEffect(() => {
    if (!inFlight) return;
    const t = setInterval(() => router.refresh(), 5000);
    return () => clearInterval(t);
  }, [inFlight, router]);

  function act(fn: () => Promise<{ ok: boolean; message?: string; error?: string }>, onOk?: () => void) {
    setError(null);
    startTransition(async () => {
      const r = await fn();
      if (r.ok) {
        if (r.message) toast.success(r.message);
        onOk?.();
      } else setError(r.error ?? "Something went wrong.");
    });
  }

  async function upload(file: File) {
    setError(null);
    setUploading(true);
    try {
      const prep = await prepareKbUpload({ filename: file.name, size: file.size });
      if (!prep.ok) throw new Error(prep.error);
      const { error: upErr } = await createClient()
        .storage.from("kb-files")
        .uploadToSignedUrl(prep.data.path, prep.data.token, file, { contentType: file.type || "application/octet-stream" });
      if (upErr) throw new Error(upErr.message);
      const r = await addFileSource({ path: prep.data.path, mime_type: file.type || undefined, name: file.name, group_id: groupId === NONE ? null : groupId });
      if (!r.ok) throw new Error(r.error);
      toast.success(r.message);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Upload failed.");
    } finally {
      setUploading(false);
      if (fileInput.current) fileInput.current.value = "";
    }
  }

  const groupName = (id: string | null) => groups.find((g) => g.id === id)?.name ?? "—";

  return (
    <div className="flex flex-col gap-6">
      <Card>
        <CardHeader>
          <CardTitle>Knowledge sources</CardTitle>
          <CardDescription>
            Web pages and files (PDF, text, Markdown, HTML, CSV, up to 20 MB). Suggested Reply only states facts found here, so keep fees, hours and policies current.
          </CardDescription>
        </CardHeader>
        <CardContent className="flex flex-col gap-4">
          <form
            className="flex flex-col gap-2 md:flex-row md:items-end"
            onSubmit={(e) => {
              e.preventDefault();
              act(() => addUrlSource({ url, group_id: groupId === NONE ? null : groupId }), () => setUrl(""));
            }}
          >
            <div className="grid flex-1 gap-1.5">
              <Label htmlFor="kb-url">Add a web page</Label>
              <Input id="kb-url" value={url} onChange={(e) => setUrl(e.target.value)} placeholder="https://example.com/opening-hours" inputMode="url" />
            </div>
            <div className="grid gap-1.5 md:w-48">
              <Label>Group</Label>
              <Select value={groupId} onValueChange={setGroupId}>
                <SelectTrigger className="w-full">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value={NONE}>No group</SelectItem>
                  {groups.map((g) => (
                    <SelectItem key={g.id} value={g.id}>
                      {g.name}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <Button type="submit" disabled={pending || !url.trim()}>
              {pending ? <Loader2 className="animate-spin" /> : <Globe />} Add page
            </Button>
            <input ref={fileInput} type="file" className="hidden" accept=".pdf,.txt,.md,.markdown,.html,.htm,.csv" onChange={(e) => e.target.files?.[0] && upload(e.target.files[0])} />
            <Button type="button" variant="outline" disabled={uploading} onClick={() => fileInput.current?.click()}>
              {uploading ? <Loader2 className="animate-spin" /> : <FileUp />} Upload file
            </Button>
          </form>
          {error && (
            <p className="text-destructive text-sm" role="alert">
              {error}
            </p>
          )}

          {sources.length === 0 ? (
            <p className="text-muted-foreground rounded-xl border border-dashed p-8 text-center text-sm">
              No sources yet. Add your opening hours, services and fees pages to ground Suggested Reply.
            </p>
          ) : (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Source</TableHead>
                  <TableHead>Group</TableHead>
                  <TableHead>Status</TableHead>
                  <TableHead className="text-right">Sections</TableHead>
                  <TableHead className="w-24" />
                </TableRow>
              </TableHeader>
              <TableBody>
                {sources.map((s) => (
                  <TableRow key={s.id}>
                    <TableCell className="max-w-xs">
                      <div className="truncate font-medium">{s.name}</div>
                      {s.url && <div className="text-muted-foreground truncate text-xs">{s.url}</div>}
                      {s.status === "failed" && s.error && <div className="text-destructive text-xs">{s.error}</div>}
                    </TableCell>
                    <TableCell>
                      <Select value={s.group_id ?? NONE} onValueChange={(v) => act(() => setSourceGroup(s.id, v === NONE ? null : v))}>
                        <SelectTrigger size="sm" className="h-8 w-36" aria-label={`Group for ${s.name}`}>
                          <SelectValue>{groupName(s.group_id)}</SelectValue>
                        </SelectTrigger>
                        <SelectContent>
                          <SelectItem value={NONE}>No group</SelectItem>
                          {groups.map((g) => (
                            <SelectItem key={g.id} value={g.id}>
                              {g.name}
                            </SelectItem>
                          ))}
                        </SelectContent>
                      </Select>
                    </TableCell>
                    <TableCell>
                      <Badge variant={STATUS_BADGE[s.status] ?? "secondary"}>{s.status}</Badge>
                    </TableCell>
                    <TableCell className="text-right tabular-nums">{s.chunk_count}</TableCell>
                    <TableCell>
                      <div className="flex justify-end gap-1">
                        <Button variant="ghost" size="icon-sm" aria-label={`Re-crawl ${s.name}`} disabled={pending || s.status === "processing"} onClick={() => act(() => recrawlSource(s.id))}>
                          <RefreshCw />
                        </Button>
                        <Button
                          variant="ghost"
                          size="icon-sm"
                          aria-label={`Delete ${s.name}`}
                          disabled={pending}
                          onClick={() => {
                            if (confirm(`Delete “${s.name}” and its sections?`)) act(() => deleteSource(s.id));
                          }}
                        >
                          <Trash2 />
                        </Button>
                      </div>
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          )}
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Groups</CardTitle>
          <CardDescription>Group sources (for example “Services”, “Fees”) and limit Suggested Reply to some groups.</CardDescription>
        </CardHeader>
        <CardContent className="flex flex-col gap-3">
          <form
            className="flex gap-2"
            onSubmit={(e) => {
              e.preventDefault();
              act(() => createGroup({ name: newGroup }), () => setNewGroup(""));
            }}
          >
            <Input value={newGroup} onChange={(e) => setNewGroup(e.target.value)} placeholder="New group name" aria-label="New group name" maxLength={80} className="max-w-xs" />
            <Button type="submit" variant="outline" disabled={pending || !newGroup.trim()}>
              <Plus /> Add group
            </Button>
          </form>
          <ul className="flex flex-wrap gap-2">
            {groups.map((g) => (
              <li key={g.id} className="flex items-center gap-1 rounded-md border px-2 py-1 text-sm">
                {g.name}
                <Button
                  variant="ghost"
                  size="icon-xs"
                  aria-label={`Delete group ${g.name}`}
                  onClick={() => {
                    if (confirm(`Delete the group “${g.name}”? Its sources are kept.`)) act(() => deleteGroup(g.id));
                  }}
                >
                  <Trash2 />
                </Button>
              </li>
            ))}
            {groups.length === 0 && <li className="text-muted-foreground text-sm">No groups yet.</li>}
          </ul>
        </CardContent>
      </Card>
    </div>
  );
}
