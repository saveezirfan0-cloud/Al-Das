import { CirclePlay } from "lucide-react";

import { PageHeader } from "@/components/shell/page-header";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { requireMember } from "@/lib/auth/session";
import {
  CLIPS,
  clipsForRole,
  clipStatuses,
  readHelpSettings,
  type ClipStatus,
} from "@/lib/help/clips";
import { GUIDES } from "@/lib/help/guides";
import { SHORTCUT_GROUPS } from "@/lib/help/shortcuts";
import { WHATS_NEW } from "@/lib/help/whats-new";

export const metadata = { title: "Training" };

function ClipRow({ status }: { status: ClipStatus }) {
  const { clip, url } = status;
  return (
    <li className="flex items-start gap-3 py-3">
      <CirclePlay className="text-muted-foreground mt-0.5 size-5 shrink-0" />
      <div className="min-w-0 flex-1">
        <p className="font-medium">{clip.title}</p>
        <p className="text-muted-foreground text-sm">{clip.summary}</p>
        <p className="text-muted-foreground mt-1 text-xs">
          {clip.minutes} min · for {clip.roles.includes("all") ? "everyone" : clip.roles.join(", ")}
        </p>
      </div>
      {url ? (
        <a
          href={url}
          target="_blank"
          rel="noopener noreferrer"
          className="shrink-0 text-sm underline"
        >
          Watch
        </a>
      ) : (
        <Badge variant="outline" className="shrink-0">
          Coming soon
        </Badge>
      )}
    </li>
  );
}

export default async function TrainingPage() {
  const member = await requireMember();
  const videos = readHelpSettings(member.org.settings).videos;
  const mine = clipsForRole(member.roleName);
  const mineIds = new Set(mine.map((c) => c.id));
  const others = CLIPS.filter((c) => !mineIds.has(c.id));
  const recorded = Object.keys(videos).length;

  return (
    <div className="flex flex-col gap-6">
      <PageHeader
        title="Training"
        description={`Videos and one-page guides. ${recorded} of ${CLIPS.length} clips are recorded so far; the rest say Coming soon.`}
      />

      <Card>
        <CardHeader>
          <CardTitle>For your role: {member.roleName}</CardTitle>
          <CardDescription>Start here.</CardDescription>
        </CardHeader>
        <CardContent>
          <ul className="divide-y">
            {clipStatuses(mine, videos).map((s) => (
              <ClipRow key={s.clip.id} status={s} />
            ))}
          </ul>
        </CardContent>
      </Card>

      {others.length > 0 && (
        <Card>
          <CardHeader>
            <CardTitle>For other roles</CardTitle>
            <CardDescription>Useful to see how your colleagues work.</CardDescription>
          </CardHeader>
          <CardContent>
            <ul className="divide-y">
              {clipStatuses(others, videos).map((s) => (
                <ClipRow key={s.clip.id} status={s} />
              ))}
            </ul>
          </CardContent>
        </Card>
      )}

      <section id="guides" aria-label="Guides" className="scroll-mt-4">
        <h2 className="mb-3 text-lg font-semibold">One-page guides</h2>
        <div className="grid gap-4 md:grid-cols-2">
          {GUIDES.map((g) => (
            <Card key={g.id}>
              <CardHeader>
                <CardTitle className="text-base">{g.title}</CardTitle>
                <CardDescription>{g.purpose}</CardDescription>
              </CardHeader>
              <CardContent className="text-sm">
                <ol className="list-decimal space-y-1 pl-5">
                  {g.steps.map((s) => (
                    <li key={s}>{s}</li>
                  ))}
                </ol>
                <p className="text-muted-foreground mt-3 text-xs font-semibold uppercase">
                  Watch out for
                </p>
                <ul className="list-disc space-y-1 pl-5">
                  {g.watchOut.map((s) => (
                    <li key={s}>{s}</li>
                  ))}
                </ul>
              </CardContent>
            </Card>
          ))}
        </div>
      </section>

      <section id="whats-new" aria-label="What's new" className="scroll-mt-4">
        <h2 className="mb-3 text-lg font-semibold">What&apos;s new</h2>
        <ul className="grid gap-3">
          {WHATS_NEW.map((n) => (
            <li key={n.id} className="rounded-lg border p-3 text-sm">
              <p className="font-medium">
                {n.title}{" "}
                <span className="text-muted-foreground text-xs font-normal">{n.date}</span>
              </p>
              <p className="mt-1">{n.body}</p>
            </li>
          ))}
        </ul>
      </section>

      <section id="shortcuts" aria-label="Keyboard shortcuts" className="scroll-mt-4">
        <h2 className="mb-3 text-lg font-semibold">Keyboard shortcuts</h2>
        <div className="grid gap-4 md:grid-cols-3">
          {SHORTCUT_GROUPS.map((g) => (
            <div key={g.title} className="rounded-lg border p-3">
              <h3 className="mb-2 text-sm font-semibold">{g.title}</h3>
              <ul className="grid gap-1.5 text-sm">
                {g.items.map((i) => (
                  <li key={i.does} className="flex items-center justify-between gap-3">
                    <span>{i.does}</span>
                    <span className="flex shrink-0 gap-1">
                      {i.keys.map((k) => (
                        <kbd
                          key={k}
                          className="bg-muted rounded border px-1.5 py-0.5 font-mono text-xs"
                        >
                          {k}
                        </kbd>
                      ))}
                    </span>
                  </li>
                ))}
              </ul>
            </div>
          ))}
        </div>
      </section>
    </div>
  );
}
