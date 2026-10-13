"use client";

import dynamic from "next/dynamic";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useCallback, useEffect, useMemo, useRef, useState, useTransition } from "react";
import {
  ClipboardList,
  Hourglass,
  Loader2,
  Printer,
  QrCode,
  RefreshCw,
  Search,
  StickyNote,
} from "lucide-react";
import { formatInTimeZone } from "date-fns-tz";
import { toast } from "sonner";

import { getVideoJoinLink } from "@/app/(app)/appointments/actions";
import { searchContactsQuick } from "@/app/(app)/contacts/actions";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Input } from "@/components/ui/input";
import { Sheet, SheetContent, SheetHeader, SheetTitle } from "@/components/ui/sheet";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Textarea } from "@/components/ui/textarea";
import {
  boardSection,
  confirmation,
  groupByHour,
  reminderHint,
  summariseBoard,
  waitingMinutes,
  type BoardSection,
} from "@/lib/front-desk/board";
import {
  CHECKIN_LABELS,
  isCheckinState,
  nextCheckinState,
  type CheckinState,
} from "@/lib/front-desk/checkin";
import type { BoardRow, PatientCardData } from "@/lib/front-desk/server";
import { isTypingTarget } from "@/lib/help/shortcuts";
import { useIsPhone } from "@/lib/hooks/use-media-query";
import { formatPhone } from "@/lib/phone";
import { cn } from "@/lib/utils";

import {
  addHandoverNote,
  getPatientCard,
  markNoShow,
  removeFromWaitlist,
  resolveHandoverNote,
  setCheckin,
} from "./actions";
import type { DeskCan, DeskData, DeskOptions } from "./types";
import { WalkInDialog } from "./walk-in-dialog";

const OFFER_FAILURE_HINT: Record<string, string> = {
  window_closed_no_template:
    "The 24-hour window is closed and no offer template is set (Settings, Front desk).",
  no_whatsapp: "This patient has no WhatsApp number.",
  no_channel: "No active WhatsApp number can send the template.",
  template_variables_unmapped: "The offer template has variables that are not mapped.",
  queue_failed: "The message could not be queued.",
};

// Loaded when a patient is picked, not with the board.
const PatientCardView = dynamic(() => import("./patient-card").then((m) => m.PatientCardView), {
  ssr: false,
  loading: () => <p className="text-muted-foreground text-sm">Loading the patient card…</p>,
});

type Filter = "all" | "expected" | "in_clinic" | "finished" | "no_show";

const FILTERS: Array<{ key: Filter; label: string }> = [
  { key: "all", label: "All" },
  { key: "expected", label: "To come" },
  { key: "in_clinic", label: "In clinic" },
  { key: "finished", label: "Finished" },
  { key: "no_show", label: "No-shows" },
];

function matchesFilter(section: BoardSection, f: Filter): boolean {
  switch (f) {
    case "all":
      return section !== "cancelled";
    case "expected":
      return section === "expected" || section === "late";
    case "in_clinic":
      return section === "waiting" || section === "with_doctor";
    case "finished":
      return section === "done" || section === "checked_out";
    case "no_show":
      return section === "no_show";
  }
}

const SECTION_BADGE: Partial<
  Record<
    BoardSection,
    { label: string; variant: "secondary" | "warning" | "success" | "outline" | "destructive" }
  >
> = {
  late: { label: "Late", variant: "warning" },
  waiting: { label: "Waiting", variant: "secondary" },
  with_doctor: { label: "With doctor", variant: "success" },
  done: { label: "Done", variant: "outline" },
  checked_out: { label: "Checked out", variant: "outline" },
  no_show: { label: "No-show", variant: "destructive" },
};

export function FrontDeskWorkspace({
  data,
  options,
  can,
}: {
  data: DeskData;
  options: DeskOptions;
  can: DeskCan;
}) {
  const router = useRouter();
  const isPhone = useIsPhone();
  const [pending, startTransition] = useTransition();
  const [filter, setFilter] = useState<Filter>("all");
  const [walkInOpen, setWalkInOpen] = useState(false);
  const [tab, setTab] = useState("patient");
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [card, setCard] = useState<PatientCardData | null>(null);
  const [cardLoading, setCardLoading] = useState(false);
  const [sheetOpen, setSheetOpen] = useState(false);
  const searchRef = useRef<HTMLInputElement>(null);
  const tz = options.timezone;
  const now = useMemo(() => new Date(), [data]); // eslint-disable-line react-hooks/exhaustive-deps

  const refresh = useCallback(() => router.refresh(), [router]);

  // Keep the board current without anyone pressing anything.
  useEffect(() => {
    const id = setInterval(() => {
      if (document.visibilityState === "visible") router.refresh();
    }, 60_000);
    return () => clearInterval(id);
  }, [router]);

  // Desk shortcuts. Bare keys never fire while someone is typing.
  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (e.ctrlKey || e.metaKey || e.altKey) return;
      if (isTypingTarget(document.activeElement as HTMLElement | null)) return;
      if (e.key === "/") {
        e.preventDefault();
        setTab("patient");
        searchRef.current?.focus();
      } else if (e.key.toLowerCase() === "n" && can.contacts) {
        e.preventDefault();
        setWalkInOpen(true);
      } else if (e.key.toLowerCase() === "r") {
        router.refresh();
      }
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [can.contacts, router]);

  const loadCard = useCallback(
    async (contactId: string) => {
      setSelectedId(contactId);
      setCardLoading(true);
      setTab("patient");
      if (isPhone) setSheetOpen(true);
      const r = await getPatientCard(contactId);
      setCardLoading(false);
      if (r.ok && r.data) setCard(r.data);
      else if (!r.ok) {
        setCard(null);
        toast.error(r.error);
      }
    },
    [isPhone],
  );

  const summary = useMemo(
    () => summariseBoard(data.rows, now, data.lateGraceMin),
    [data.rows, now, data.lateGraceMin],
  );
  const visible = useMemo(
    () => data.rows.filter((r) => matchesFilter(boardSection(r, now, data.lateGraceMin), filter)),
    [data.rows, filter, now, data.lateGraceMin],
  );
  const groups = useMemo(() => groupByHour(visible, tz), [visible, tz]);

  function act(fn: () => Promise<{ ok: boolean; message?: string; error?: string }>) {
    startTransition(async () => {
      const r = await fn();
      if (!r.ok) toast.error(r.error ?? "That did not work.");
      else if (r.message) toast.success(r.message);
    });
  }

  const cardPanel = (
    <PatientPanel
      card={card}
      loading={cardLoading}
      options={options}
      can={can}
      searchRef={searchRef}
      onPick={loadCard}
      onChanged={() => {
        refresh();
        if (selectedId) void loadCard(selectedId);
      }}
    />
  );

  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h2 className="text-xl font-semibold tracking-tight">
            {data.date === data.today ? "Today" : "Board"} ·{" "}
            {formatInTimeZone(new Date(`${data.date}T12:00:00Z`), "UTC", "EEEE d MMMM")}
          </h2>
          <p className="text-muted-foreground text-sm">
            {summary.total} appointment{summary.total === 1 ? "" : "s"}
            {summary.cancelled > 0 && ` · ${summary.cancelled} cancelled`}
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          {can.contacts && (
            <WalkInDialog
              options={options}
              canBook={can.appointments}
              open={walkInOpen}
              onOpenChange={setWalkInOpen}
              onDone={(id) => {
                refresh();
                void loadCard(id);
              }}
            />
          )}
          <Button size="sm" variant="outline" asChild>
            <Link href="/front-desk/qr">
              <QrCode /> Desk QR
            </Link>
          </Button>
          <Button size="sm" variant="outline" asChild>
            <Link href="/front-desk/end-of-day">
              <Printer /> End of day
            </Link>
          </Button>
          <Button size="sm" variant="ghost" onClick={refresh} aria-label="Refresh the board">
            <RefreshCw className={cn(pending && "animate-spin")} />
          </Button>
        </div>
      </div>

      <ul
        className="grid grid-cols-2 gap-2 sm:grid-cols-4 xl:grid-cols-8"
        aria-label="Today at a glance"
      >
        <Stat label="To come" value={summary.expected} />
        <Stat label="Late" value={summary.late} tone={summary.late ? "warn" : undefined} />
        <Stat label="Waiting" value={summary.waiting} />
        <Stat label="With doctor" value={summary.withDoctor} />
        <Stat label="Done" value={summary.done + summary.checkedOut} />
        <Stat
          label="Unconfirmed"
          value={summary.unconfirmed}
          tone={summary.unconfirmed ? "warn" : undefined}
        />
        <Stat label="No-shows" value={summary.noShow} tone={summary.noShow ? "alert" : undefined} />
        <Stat label="Walk-ins" value={summary.walkIns} />
      </ul>

      <div className="grid gap-4 lg:grid-cols-[minmax(0,1fr)_24rem]">
        <section aria-label="Appointments" className="min-w-0">
          <div className="mb-3 flex flex-wrap gap-1" role="tablist" aria-label="Filter the board">
            {FILTERS.map((f) => (
              <Button
                key={f.key}
                size="xs"
                variant={filter === f.key ? "default" : "outline"}
                role="tab"
                aria-selected={filter === f.key}
                onClick={() => setFilter(f.key)}
              >
                {f.label}
              </Button>
            ))}
          </div>

          {groups.length === 0 ? (
            <p className="text-muted-foreground rounded-xl border border-dashed p-10 text-center text-sm">
              Nothing here for this view.
            </p>
          ) : (
            <div className="flex flex-col gap-4">
              {groups.map((g) => (
                <div key={g.hour}>
                  <h3 className="text-muted-foreground mb-1 text-xs font-semibold">{g.hour}</h3>
                  <ul className="divide-y rounded-lg border">
                    {g.rows.map((r) => (
                      <BoardLine
                        key={r.id}
                        row={r}
                        now={now}
                        graceMin={data.lateGraceMin}
                        tz={tz}
                        canManage={can.appointments}
                        selected={selectedId === r.contact_id}
                        disabled={pending}
                        compact={isPhone}
                        onOpen={() => r.contact_id && void loadCard(r.contact_id)}
                        onCheckin={(to) => act(() => setCheckin({ appointmentId: r.id, to }))}
                        onNoShow={() => {
                          if (confirm("Mark this patient as a no-show?"))
                            act(() => markNoShow(r.id));
                        }}
                      />
                    ))}
                  </ul>
                </div>
              ))}
            </div>
          )}
        </section>

        <aside className="min-w-0" aria-label="Patient, slots, waiting list and notes">
          <SidePanels
            data={data}
            options={options}
            can={can}
            tab={isPhone && tab === "patient" ? "slots" : tab}
            setTab={setTab}
            onPick={loadCard}
            searchRef={searchRef}
            cardPanel={isPhone ? null : cardPanel}
          />
          {isPhone && (
            <Sheet open={sheetOpen} onOpenChange={setSheetOpen}>
              <SheetContent side="bottom" className="max-h-[85svh] overflow-y-auto p-4">
                <SheetHeader className="p-0 pb-2">
                  <SheetTitle>Patient</SheetTitle>
                </SheetHeader>
                {cardPanel}
              </SheetContent>
            </Sheet>
          )}
        </aside>
      </div>
    </div>
  );
}

function Stat({ label, value, tone }: { label: string; value: number; tone?: "warn" | "alert" }) {
  return (
    <li
      className={cn(
        "rounded-lg border px-3 py-2",
        tone === "warn" &&
          "border-amber-300 bg-amber-50 dark:border-amber-800 dark:bg-amber-950/40",
        tone === "alert" && "border-red-300 bg-red-50 dark:border-red-900 dark:bg-red-950/40",
      )}
    >
      <p className="text-xl leading-none font-semibold tabular-nums">{value}</p>
      <p className="text-muted-foreground mt-1 text-[11px]">{label}</p>
    </li>
  );
}

function BoardLine({
  row,
  now,
  graceMin,
  tz,
  canManage,
  selected,
  disabled,
  compact,
  onOpen,
  onCheckin,
  onNoShow,
}: {
  row: BoardRow;
  now: Date;
  graceMin: number;
  tz: string;
  canManage: boolean;
  selected: boolean;
  disabled: boolean;
  compact: boolean;
  onOpen: () => void;
  onCheckin: (to: CheckinState | null) => void;
  onNoShow: () => void;
}) {
  const section = boardSection(row, now, graceMin);
  const state = isCheckinState(row.checkin_status) ? row.checkin_status : null;
  const next = nextCheckinState(state);
  const badge = SECTION_BADGE[section];
  const conf = confirmation(row);
  const hint = reminderHint(row);
  const waited = waitingMinutes(row, now);
  const closed = section === "cancelled" || section === "no_show";
  const isUnite = row.source === "unite";
  const isVideo = row.visit_mode === "video";

  return (
    <li
      className={cn(
        "flex flex-wrap items-center gap-x-3 gap-y-2 px-3 py-2",
        selected && "bg-accent/40",
      )}
    >
      <span className="w-16 shrink-0 text-sm font-medium tabular-nums">
        {formatInTimeZone(new Date(row.starts_at), tz, "h:mm a")}
      </span>
      <button
        type="button"
        onClick={onOpen}
        disabled={!row.contact_id}
        className="min-w-0 flex-1 text-left disabled:cursor-default"
      >
        <span className="block truncate text-sm font-medium">
          {row.patient_name}
          {row.is_walk_in && (
            <Badge variant="outline" className="ml-2">
              Walk-in
            </Badge>
          )}
        </span>
        {!compact && (
          <span className="text-muted-foreground block truncate text-xs">
            {[row.specialist_name, row.service_name, row.phone ? formatPhone(row.phone) : null]
              .filter(Boolean)
              .join(" · ")}
          </span>
        )}
      </button>
      <span className="flex flex-wrap items-center gap-1">
        {badge && <Badge variant={badge.variant}>{badge.label}</Badge>}
        {isVideo && <Badge variant="outline">Video</Badge>}
        {waited !== null && waited >= 1 && (
          <span className="text-muted-foreground text-xs">{waited} min</span>
        )}
        {!closed && (section === "expected" || section === "late") && (
          <Badge variant={conf === "confirmed" ? "success" : "secondary"}>
            {conf === "confirmed" ? "Confirmed" : "Unconfirmed"}
          </Badge>
        )}
        {hint === "call" && !closed && <Badge variant="warning">Call</Badge>}
        {hint === "waiting_reply" && !closed && (
          <span className="text-muted-foreground text-xs">reminder sent</span>
        )}
      </span>
      {isVideo && !closed && (
        <Button
          size="xs"
          variant="outline"
          disabled={disabled}
          onClick={async () => {
            const r = await getVideoJoinLink({ id: row.id });
            if (r.ok && r.data) window.open(r.data.url, "_blank", "noopener,noreferrer");
            else if (!r.ok) toast.error(r.error);
          }}
        >
          Join
        </Button>
      )}
      {canManage && !closed && (
        <span className="flex items-center gap-1">
          {next && (
            <Button size="xs" disabled={disabled} onClick={() => onCheckin(next)}>
              {CHECKIN_LABELS[next]}
            </Button>
          )}
          {state && (
            <Button
              size="xs"
              variant="ghost"
              disabled={disabled}
              onClick={() => onCheckin(undoTarget(state))}
              aria-label="Undo the last check-in step"
            >
              Undo
            </Button>
          )}
          {!state && section === "late" && !isUnite && (
            <Button size="xs" variant="outline" disabled={disabled} onClick={onNoShow}>
              No-show
            </Button>
          )}
        </span>
      )}
    </li>
  );
}

function undoTarget(state: CheckinState): CheckinState | null {
  const order: CheckinState[] = ["arrived", "with_doctor", "done", "checked_out"];
  const i = order.indexOf(state);
  return i <= 0 ? null : order[i - 1];
}

function SidePanels({
  data,
  options,
  can,
  tab,
  setTab,
  onPick,
  searchRef,
  cardPanel,
}: {
  data: DeskData;
  options: DeskOptions;
  can: DeskCan;
  tab: string;
  setTab: (t: string) => void;
  onPick: (id: string) => void;
  searchRef: React.RefObject<HTMLInputElement | null>;
  /** The patient card with its own search box (desktop), or null on a phone where the card opens in a sheet. */
  cardPanel: React.ReactNode;
}) {
  const openNotes = data.notes.filter((n) => !n.resolved_at).length;
  return (
    <Tabs value={tab} onValueChange={setTab} className="gap-3">
      {cardPanel === null && <PatientSearch searchRef={searchRef} onPick={onPick} />}
      <TabsList className={cn("grid w-full", cardPanel === null ? "grid-cols-3" : "grid-cols-4")}>
        {cardPanel !== null && <TabsTrigger value="patient">Patient</TabsTrigger>}
        <TabsTrigger value="slots">Slots</TabsTrigger>
        <TabsTrigger value="waitlist">
          Waitlist{data.waitlist.length ? ` (${data.waitlist.length})` : ""}
        </TabsTrigger>
        <TabsTrigger value="notes">Notes{openNotes ? ` (${openNotes})` : ""}</TabsTrigger>
      </TabsList>
      {cardPanel !== null && <TabsContent value="patient">{cardPanel}</TabsContent>}
      <TabsContent value="slots">
        <SlotsPanel data={data} tz={options.timezone} />
      </TabsContent>
      <TabsContent value="waitlist">
        <WaitlistPanel
          data={data}
          canManage={can.appointments}
          onPick={onPick}
          tz={options.timezone}
        />
      </TabsContent>
      <TabsContent value="notes">
        <NotesPanel data={data} />
      </TabsContent>
    </Tabs>
  );
}

function PatientSearch({
  searchRef,
  onPick,
}: {
  searchRef: React.RefObject<HTMLInputElement | null>;
  onPick: (id: string) => void;
}) {
  const [q, setQ] = useState("");
  const [rows, setRows] = useState<Array<{ id: string; name: string; phone: string | null }>>([]);
  useEffect(() => {
    if (q.trim().length < 2) {
      setRows([]);
      return;
    }
    let cancelled = false;
    const h = setTimeout(() => {
      void searchContactsQuick(q.trim()).then((r) => {
        if (!cancelled && r.ok && r.data)
          setRows(
            r.data.rows.map((x) => ({
              id: x.id,
              name: x.full_name || "Unnamed",
              phone: x.phone_e164 ? formatPhone(x.phone_e164) : null,
            })),
          );
      });
    }, 250);
    return () => {
      cancelled = true;
      clearTimeout(h);
    };
  }, [q]);

  return (
    <div className="flex flex-col gap-2">
      <div className="relative">
        <Search className="text-muted-foreground absolute top-2.5 left-2.5 size-4" />
        <Input
          ref={searchRef}
          className="pl-8"
          placeholder="Find a patient: name or phone (press /)"
          value={q}
          onChange={(e) => setQ(e.target.value)}
          aria-label="Find a patient"
        />
      </div>
      {rows.length > 0 && (
        <ul className="divide-y rounded-md border text-sm">
          {rows.map((r) => (
            <li key={r.id}>
              <button
                type="button"
                className="hover:bg-accent flex w-full items-center justify-between gap-2 px-3 py-2 text-left"
                onClick={() => {
                  onPick(r.id);
                  setQ("");
                }}
              >
                <span className="font-medium">{r.name}</span>
                <span className="text-muted-foreground text-xs">{r.phone}</span>
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

function PatientPanel({
  card,
  loading,
  options,
  can,
  searchRef,
  onPick,
  onChanged,
}: {
  card: PatientCardData | null;
  loading: boolean;
  options: DeskOptions;
  can: DeskCan;
  searchRef: React.RefObject<HTMLInputElement | null>;
  onPick: (id: string) => void;
  onChanged: () => void;
}) {
  return (
    <div className="flex flex-col gap-3">
      <PatientSearch searchRef={searchRef} onPick={onPick} />
      {loading && (
        <p className="text-muted-foreground flex items-center gap-2 text-sm">
          <Loader2 className="size-4 animate-spin" /> Loading the patient…
        </p>
      )}
      {!loading && card && (
        <PatientCardView card={card} options={options} can={can} onChanged={onChanged} />
      )}
      {!loading && !card && (
        <p className="text-muted-foreground rounded-lg border border-dashed p-6 text-center text-sm">
          Search for a patient, or tap a name on the board, to see their card.
        </p>
      )}
    </div>
  );
}

function SlotsPanel({ data, tz }: { data: DeskData; tz: string }) {
  if (data.slots.length === 0)
    return (
      <p className="text-muted-foreground rounded-lg border border-dashed p-6 text-center text-sm">
        No free slots found in the next week. Check working hours under Settings, Appointment rules.
      </p>
    );
  return (
    <ul className="flex flex-col gap-3">
      {data.slots.map((d) => (
        <li key={`${d.specialist_id}-${d.location_id}`} className="rounded-lg border p-3">
          <p className="text-sm font-medium">{d.specialist_name}</p>
          <p className="text-muted-foreground text-xs">
            {d.location_name} ·{" "}
            {d.date === data.today
              ? "today"
              : formatInTimeZone(new Date(`${d.date}T12:00:00Z`), "UTC", "EEE d MMM")}
          </p>
          <div className="mt-2 flex flex-wrap gap-1.5">
            {d.slots.map((s) => (
              <Badge
                key={s.starts_at}
                variant="outline"
                title={formatInTimeZone(new Date(s.starts_at), tz, "h:mm a")}
              >
                {s.label}
              </Badge>
            ))}
          </div>
        </li>
      ))}
    </ul>
  );
}

function WaitlistPanel({
  data,
  canManage,
  onPick,
  tz,
}: {
  data: DeskData;
  canManage: boolean;
  onPick: (id: string) => void;
  tz: string;
}) {
  const [pending, startTransition] = useTransition();
  return (
    <div className="flex flex-col gap-2">
      {!data.offersEnabled && (
        <p className="rounded-md bg-amber-50 p-2 text-xs text-amber-900 dark:bg-amber-950/40 dark:text-amber-200">
          Slot offers are switched off. Patients can be listed, but nobody is messaged when a slot
          opens until an administrator turns it on in Settings, Front desk.
        </p>
      )}
      {data.waitlist.length === 0 ? (
        <p className="text-muted-foreground rounded-lg border border-dashed p-6 text-center text-sm">
          <Hourglass className="mx-auto mb-2 size-5" />
          Nobody is waiting. Add a patient from their card.
        </p>
      ) : (
        <ol className="divide-y rounded-lg border">
          {data.waitlist.map((w, i) => (
            <li key={w.id} className="flex items-center gap-2 px-3 py-2 text-sm">
              <span className="text-muted-foreground w-5 text-xs tabular-nums">{i + 1}</span>
              <button
                type="button"
                className="min-w-0 flex-1 text-left"
                onClick={() => onPick(w.contact_id)}
              >
                <span className="block truncate font-medium">{w.patient_name}</span>
                <span className="text-muted-foreground block truncate text-xs">
                  {[
                    w.specialist_name ?? "Any doctor",
                    w.service_name,
                    w.location_name,
                    w.not_after && `until ${w.not_after}`,
                  ]
                    .filter(Boolean)
                    .join(" · ")}
                </span>
              </button>
              {!w.offer && w.offerFailure && (
                <Badge
                  variant="destructive"
                  title={OFFER_FAILURE_HINT[w.offerFailure] ?? "The offer could not be sent"}
                >
                  Offer not sent
                </Badge>
              )}
              {w.offer && (
                <Badge variant="warning" title="An offer is waiting for an answer">
                  Offer until {formatInTimeZone(new Date(w.offer.expires_at), tz, "h:mm a")}
                </Badge>
              )}
              {canManage && (
                <Button
                  size="xs"
                  variant="ghost"
                  disabled={pending}
                  onClick={() =>
                    startTransition(async () => {
                      const r = await removeFromWaitlist(w.id);
                      if (!r.ok) toast.error(r.error);
                    })
                  }
                >
                  Remove
                </Button>
              )}
            </li>
          ))}
        </ol>
      )}
    </div>
  );
}

function NotesPanel({ data }: { data: DeskData }) {
  const [pending, startTransition] = useTransition();
  const [body, setBody] = useState("");
  const [pinned, setPinned] = useState(false);
  const open = data.notes.filter((n) => !n.resolved_at);
  const done = data.notes.filter((n) => n.resolved_at);

  function add() {
    startTransition(async () => {
      const r = await addHandoverNote({ body, pinned });
      if (r.ok) {
        toast.success(r.message ?? "Added.");
        setBody("");
        setPinned(false);
      } else toast.error(r.error);
    });
  }

  return (
    <div className="flex flex-col gap-3">
      <div className="grid gap-2">
        <Textarea
          rows={3}
          maxLength={2000}
          placeholder="Note for the next shift (no medical details)"
          value={body}
          onChange={(e) => setBody(e.target.value)}
          aria-label="Handover note"
        />
        <div className="flex items-center justify-between">
          <label className="flex items-center gap-2 text-xs">
            <Checkbox checked={pinned} onCheckedChange={(v) => setPinned(v === true)} /> Pin to the
            top
          </label>
          <Button size="sm" onClick={add} disabled={pending || !body.trim()}>
            <StickyNote /> Add note
          </Button>
        </div>
      </div>
      {open.length === 0 && done.length === 0 && (
        <p className="text-muted-foreground rounded-lg border border-dashed p-6 text-center text-sm">
          <ClipboardList className="mx-auto mb-2 size-5" />
          No handover notes.
        </p>
      )}
      <ul className="flex flex-col gap-2">
        {[...open, ...done].map((n) => (
          <li
            key={n.id}
            className={cn(
              "rounded-lg border p-3 text-sm",
              n.resolved_at && "opacity-60",
              n.pinned && !n.resolved_at && "border-amber-300 dark:border-amber-500/30",
            )}
          >
            <p className="whitespace-pre-wrap">{n.body}</p>
            <div className="text-muted-foreground mt-2 flex items-center justify-between text-xs">
              <span>
                {n.author ?? "Someone"} · {new Date(n.created_at).toLocaleString()}
              </span>
              <button
                type="button"
                className="underline"
                disabled={pending}
                onClick={() =>
                  startTransition(async () => {
                    const r = await resolveHandoverNote(n.id, !n.resolved_at);
                    if (!r.ok) toast.error(r.error);
                  })
                }
              >
                {n.resolved_at ? "Reopen" : "Mark done"}
              </button>
            </div>
          </li>
        ))}
      </ul>
    </div>
  );
}
