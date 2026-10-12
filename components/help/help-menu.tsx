"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { useEffect, useState } from "react";
import {
  BookOpen,
  CirclePlay,
  CircleQuestionMark,
  GraduationCap,
  Keyboard,
  MessageSquareText,
  Sparkles,
} from "lucide-react";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
} from "@/components/ui/sheet";
import { clipForPath } from "@/lib/help/clips";
import { guideForPath } from "@/lib/help/guides";
import { newestId, unseenCount, WHATS_NEW } from "@/lib/help/whats-new";

import { FeedbackDialog } from "./feedback-dialog";
import { OPEN_SHORTCUTS_EVENT, ShortcutsDialog } from "./shortcuts-dialog";

const SEEN_KEY = "pulse:whats-new-seen";

function readSeen(): string | null {
  try {
    return localStorage.getItem(SEEN_KEY);
  } catch {
    return null; // private window or blocked storage: show everything as new, never fail
  }
}
function writeSeen(id: string | null) {
  try {
    if (id) localStorage.setItem(SEEN_KEY, id);
  } catch {
    // ignore
  }
}

/**
 * The "?" button on every page. It opens the clip and the one-page guide that match the page you are on, with
 * links to the Training page, what's new, the keyboard cheat sheet and the feedback form.
 */
export function HelpMenu({
  roleName,
  videos,
}: {
  roleName: string;
  videos: Record<string, string>;
}) {
  const pathname = usePathname();
  const [open, setOpen] = useState(false);
  const [shortcuts, setShortcuts] = useState(false);
  const [feedback, setFeedback] = useState(false);
  const [unseen, setUnseen] = useState(0);
  const [showNew, setShowNew] = useState(false);

  useEffect(() => {
    setUnseen(unseenCount(readSeen()));
  }, []);

  const clip = clipForPath(pathname, roleName);
  const guide = guideForPath(pathname);
  const videoUrl = clip ? (videos[clip.id] ?? null) : null;

  function openNew() {
    setShowNew(true);
    writeSeen(newestId());
    setUnseen(0);
  }

  return (
    <>
      <Button
        variant="ghost"
        size="icon"
        className="relative"
        onClick={() => {
          setShowNew(false);
          setOpen(true);
        }}
        aria-label="Help for this page"
        title="Help for this page"
      >
        <CircleQuestionMark />
        {unseen > 0 && (
          <span
            className="bg-primary absolute top-1.5 right-1.5 size-2 rounded-full"
            aria-label={`${unseen} new`}
          />
        )}
      </Button>

      <Sheet open={open} onOpenChange={setOpen}>
        <SheetContent side="right" className="w-full overflow-y-auto sm:max-w-md">
          <SheetHeader>
            <SheetTitle>{showNew ? "What's new" : guide.title}</SheetTitle>
            <SheetDescription>
              {showNew ? "Recent changes to Pulse." : guide.purpose}
            </SheetDescription>
          </SheetHeader>
          <div className="flex flex-col gap-5 px-4 pb-6 text-sm">
            {showNew ? (
              <>
                <ul className="flex flex-col gap-4">
                  {WHATS_NEW.map((n) => (
                    <li key={n.id}>
                      <p className="font-medium">{n.title}</p>
                      <p className="text-muted-foreground text-xs">{n.date}</p>
                      <p className="mt-1">{n.body}</p>
                    </li>
                  ))}
                </ul>
                <Button variant="outline" size="sm" onClick={() => setShowNew(false)}>
                  Back to help for this page
                </Button>
              </>
            ) : (
              <>
                <section aria-label="Training clip">
                  <h3 className="text-muted-foreground mb-2 text-xs font-semibold uppercase">
                    Watch
                  </h3>
                  {clip ? (
                    <div className="flex items-start gap-3 rounded-lg border p-3">
                      <CirclePlay className="text-muted-foreground mt-0.5 size-5 shrink-0" />
                      <div className="min-w-0">
                        <p className="font-medium">{clip.title}</p>
                        <p className="text-muted-foreground text-xs">
                          {clip.minutes} min · {clip.summary}
                        </p>
                        {videoUrl ? (
                          <a
                            href={videoUrl}
                            target="_blank"
                            rel="noopener noreferrer"
                            className="mt-1 inline-block underline"
                          >
                            Watch the clip
                          </a>
                        ) : (
                          <Badge variant="outline" className="mt-1">
                            Coming soon
                          </Badge>
                        )}
                      </div>
                    </div>
                  ) : (
                    <p className="text-muted-foreground">There is no clip for this page yet.</p>
                  )}
                </section>

                <section aria-label="Guide">
                  <h3 className="text-muted-foreground mb-2 text-xs font-semibold uppercase">
                    How to
                  </h3>
                  <ol className="list-decimal space-y-1.5 pl-5">
                    {guide.steps.map((s) => (
                      <li key={s}>{s}</li>
                    ))}
                  </ol>
                  <h3 className="text-muted-foreground mt-4 mb-2 text-xs font-semibold uppercase">
                    Watch out for
                  </h3>
                  <ul className="list-disc space-y-1.5 pl-5">
                    {guide.watchOut.map((s) => (
                      <li key={s}>{s}</li>
                    ))}
                  </ul>
                </section>

                <nav aria-label="More help" className="flex flex-col gap-1 border-t pt-4">
                  <Button variant="ghost" className="justify-start" asChild>
                    <Link href="/help/training" onClick={() => setOpen(false)}>
                      <GraduationCap /> Training videos and guides
                    </Link>
                  </Button>
                  <Button variant="ghost" className="justify-start" onClick={openNew}>
                    <Sparkles /> What&apos;s new
                    {unseen > 0 && <Badge className="ml-auto">{unseen}</Badge>}
                  </Button>
                  <Button
                    variant="ghost"
                    className="justify-start"
                    onClick={() => window.dispatchEvent(new Event(OPEN_SHORTCUTS_EVENT))}
                  >
                    <Keyboard /> Keyboard shortcuts
                    <kbd className="bg-muted ml-auto rounded border px-1.5 font-mono text-xs">
                      ?
                    </kbd>
                  </Button>
                  <Button
                    variant="ghost"
                    className="justify-start"
                    onClick={() => setFeedback(true)}
                  >
                    <MessageSquareText /> Send feedback
                  </Button>
                  <Button variant="ghost" className="justify-start" asChild>
                    <Link href="/help/training#guides" onClick={() => setOpen(false)}>
                      <BookOpen /> All guides
                    </Link>
                  </Button>
                </nav>
              </>
            )}
          </div>
        </SheetContent>
      </Sheet>

      <ShortcutsDialog open={shortcuts} onOpenChange={setShortcuts} />
      <FeedbackDialog open={feedback} onOpenChange={setFeedback} />
    </>
  );
}
