"use client";

import { useState, useTransition } from "react";
import { GraduationCap, Loader2 } from "lucide-react";
import { toast } from "sonner";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";

import { saveVideoLinks, setTrainingMode } from "./actions";

export function TrainingSettings({
  isTraining,
  orgName,
  clips,
  videos,
}: {
  isTraining: boolean;
  orgName: string;
  clips: Array<{ id: string; title: string; roles: string[] }>;
  videos: Record<string, string>;
}) {
  const [confirm, setConfirm] = useState("");
  const [links, setLinks] = useState<Record<string, string>>(videos);
  const [pending, startTransition] = useTransition();

  function toggle() {
    startTransition(async () => {
      const r = await setTrainingMode({ enabled: !isTraining, confirm });
      if (r.ok) {
        toast.success(r.message);
        setConfirm("");
        window.location.reload();
      } else toast.error(r.error);
    });
  }

  function saveLinks() {
    startTransition(async () => {
      const r = await saveVideoLinks(links);
      if (r.ok) toast.success(r.message);
      else toast.error(r.error);
    });
  }

  return (
    <div className="flex flex-col gap-6">
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <GraduationCap className="size-5" /> Training mode
            {isTraining ? (
              <Badge variant="warning">On</Badge>
            ) : (
              <Badge variant="outline">Off</Badge>
            )}
          </CardTitle>
          <CardDescription>
            In training mode every page shows a banner and{" "}
            <strong>no WhatsApp message is ever sent</strong>: messages appear in the thread as
            sent, but nothing reaches Meta or a patient. Use it on a practice workspace filled with
            made-up patients by running{" "}
            <code className="bg-muted rounded px-1">DEMO_RESET_OK=1 pnpm demo:reset</code> on a
            developer machine pointed at a demo database.
          </CardDescription>
        </CardHeader>
        <CardContent className="flex flex-col gap-3">
          {!isTraining && (
            <p className="rounded-md bg-amber-50 p-3 text-sm text-amber-900 dark:bg-amber-950/40 dark:text-amber-200">
              <strong>{orgName}</strong> is the workspace you are in now. If it is your real clinic,
              switching this on stops every reminder, reply and campaign from going out until you
              switch it off again. Only do this on a practice workspace.
            </p>
          )}
          <div className="grid max-w-sm gap-1">
            <Label htmlFor="training-confirm">
              Type <strong>{isTraining ? "GO LIVE" : "TRAINING"}</strong> to{" "}
              {isTraining ? "send messages for real again" : "switch it on"}
            </Label>
            <Input
              id="training-confirm"
              autoComplete="off"
              value={confirm}
              onChange={(e) => setConfirm(e.target.value)}
            />
          </div>
          <div>
            <Button
              variant={isTraining ? "default" : "destructive"}
              disabled={pending || confirm.trim() !== (isTraining ? "GO LIVE" : "TRAINING")}
              onClick={toggle}
            >
              {pending && <Loader2 className="animate-spin" />}{" "}
              {isTraining ? "Switch training mode off" : "Switch training mode on"}
            </Button>
          </div>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Training videos</CardTitle>
          <CardDescription>
            Paste the link (https) to each recorded clip. A clip without a link shows &ldquo;Coming
            soon&rdquo; on the Training page and behind the ? button.
          </CardDescription>
        </CardHeader>
        <CardContent className="flex flex-col gap-3">
          {clips.map((c) => (
            <div key={c.id} className="grid gap-1">
              <Label htmlFor={`clip-${c.id}`} className="flex flex-wrap items-center gap-2">
                {c.title}
                <span className="text-muted-foreground text-xs font-normal">
                  {c.roles.join(", ")}
                </span>
              </Label>
              <Input
                id={`clip-${c.id}`}
                type="url"
                inputMode="url"
                placeholder="https://…"
                value={links[c.id] ?? ""}
                onChange={(e) => setLinks((p) => ({ ...p, [c.id]: e.target.value }))}
              />
            </div>
          ))}
          <div>
            <Button onClick={saveLinks} disabled={pending}>
              {pending && <Loader2 className="animate-spin" />} Save video links
            </Button>
          </div>
        </CardContent>
      </Card>
    </div>
  );
}
