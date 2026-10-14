"use client";

import { Pencil, Plus, Trash2 } from "lucide-react";
import { toast } from "sonner";

import { ActionForm, Field, FormSheet, selectClass } from "@/components/finance/forms";
import { ConfirmDialog } from "@/components/shell/confirm-dialog";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import {
  ROOM_KIND_LABEL,
  ROOM_KINDS,
  WEEKDAY_LABELS,
  formatTime,
  weekdayLabel,
  type RoomKind,
} from "@/lib/capacity/rooms";

import { addRotaRow, deleteRoom, deleteRotaRow, saveRoom } from "./actions";

export type RotaView = {
  id: string;
  weekday: number;
  startMin: number;
  endMin: number;
  doctor: string;
  stale: boolean;
};
export type RoomView = {
  id: string;
  name: string;
  kind: string;
  monthlyCost: number | null;
  active: boolean;
  rota: RotaView[];
};
export type BranchView = {
  id: string;
  name: string;
  doctors: { id: string; name: string }[];
  rooms: RoomView[];
};

const kindLabel = (k: string) => ROOM_KIND_LABEL[k as RoomKind] ?? k;
const aed = (v: number) =>
  v.toLocaleString("en-GB", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const weeklyHours = (rota: RotaView[]) =>
  Math.round((rota.reduce((s, r) => s + (r.endMin - r.startMin), 0) / 60) * 10) / 10;

function RoomFields({ room, branchId }: { room?: RoomView; branchId: string }) {
  return (
    <>
      {room ? (
        <input type="hidden" name="id" value={room.id} />
      ) : (
        <input type="hidden" name="location_id" value={branchId} />
      )}
      <Field label="Name">
        <Input name="name" defaultValue={room?.name ?? ""} maxLength={80} required />
      </Field>
      <Field label="Kind">
        <select name="kind" defaultValue={room?.kind ?? "consultation"} className={selectClass}>
          {ROOM_KINDS.map((k) => (
            <option key={k} value={k}>
              {ROOM_KIND_LABEL[k]}
            </option>
          ))}
        </select>
      </Field>
      <Field
        label="Monthly cost (AED)"
        hint="Rent and running cost of the room per month. Leave it empty when it is not known: an unknown cost is never counted as 0."
      >
        <Input
          name="monthly_cost"
          inputMode="decimal"
          defaultValue={room?.monthlyCost ?? ""}
          placeholder="Unknown"
        />
      </Field>
      <label className="flex items-center gap-2 text-sm">
        <input type="checkbox" name="active" defaultChecked={room?.active ?? true} /> In use
      </label>
    </>
  );
}

function RotaEditor({ branch, room }: { branch: BranchView; room: RoomView }) {
  return (
    <div className="flex flex-col gap-3">
      {room.rota.length === 0 ? (
        <p className="text-muted-foreground text-sm">Nobody is on this room&apos;s rota yet.</p>
      ) : (
        <ul className="flex flex-col gap-1" aria-label={`Rota for ${room.name}`}>
          {room.rota.map((r) => (
            <li
              key={r.id}
              className="flex flex-wrap items-center justify-between gap-2 rounded-md border px-3 py-1.5 text-sm"
            >
              <span className="tabular-nums">
                <span className="inline-block w-10 font-medium">{weekdayLabel(r.weekday)}</span>
                {formatTime(r.startMin)}–{formatTime(r.endMin)}
                <span className="ml-2">{r.doctor}</span>
                {r.stale && (
                  <Badge variant="warning" className="ml-2">
                    No longer at this branch
                  </Badge>
                )}
              </span>
              <Button
                type="button"
                variant="ghost"
                size="sm"
                aria-label={`Remove ${weekdayLabel(r.weekday)} ${formatTime(r.startMin)} to ${formatTime(r.endMin)}, ${r.doctor}`}
                onClick={async () => {
                  const res = await deleteRotaRow(r.id);
                  if (res.ok) toast.success(res.message ?? "Removed");
                  else toast.error(res.error);
                }}
              >
                <Trash2 aria-hidden />
              </Button>
            </li>
          ))}
        </ul>
      )}
      {branch.doctors.length === 0 ? (
        <p className="text-muted-foreground text-xs">
          No doctor works at {branch.name} yet. Link doctors to the branch under Settings,
          Appointment rules.
        </p>
      ) : (
        <ActionForm action={addRotaRow} submitLabel="Add to rota" variant="secondary">
          <input type="hidden" name="room_id" value={room.id} />
          <div className="grid gap-3 sm:grid-cols-2">
            <Field label="Doctor">
              <select name="specialist_id" className={selectClass} required defaultValue="">
                <option value="" disabled>
                  Choose…
                </option>
                {branch.doctors.map((d) => (
                  <option key={d.id} value={d.id}>
                    {d.name}
                  </option>
                ))}
              </select>
            </Field>
            <Field label="Day">
              <select name="weekday" className={selectClass} defaultValue="1">
                {WEEKDAY_LABELS.map((label, i) => (
                  <option key={label} value={i + 1}>
                    {label}
                  </option>
                ))}
              </select>
            </Field>
            <Field label="From">
              <Input name="start" type="time" defaultValue="09:00" required />
            </Field>
            <Field label="To">
              <Input name="end" type="time" defaultValue="13:00" required />
            </Field>
          </div>
        </ActionForm>
      )}
    </div>
  );
}

function RoomRow({ branch, room }: { branch: BranchView; room: RoomView }) {
  return (
    <li className="flex flex-col gap-2 rounded-lg border p-3">
      <div className="flex flex-wrap items-start justify-between gap-2">
        <div>
          <p className="font-medium">
            {room.name}
            {!room.active && (
              <Badge variant="outline" className="ml-2">
                Not in use
              </Badge>
            )}
          </p>
          <p className="text-muted-foreground text-xs">
            {kindLabel(room.kind)} ·{" "}
            {room.monthlyCost === null
              ? "Monthly cost unknown"
              : `AED ${aed(room.monthlyCost)} a month`}{" "}
            · {weeklyHours(room.rota)} rota hours a week
          </p>
        </div>
        <div className="flex gap-1">
          <FormSheet
            trigger={
              <>
                <Pencil aria-hidden /> Rota
              </>
            }
            title={`${room.name}: weekly rota`}
            description="Which doctor uses this room, on which day and when. A room cannot be on the rota twice at the same time."
            variant="outline"
            size="sm"
          >
            {() => <RotaEditor branch={branch} room={room} />}
          </FormSheet>
          <FormSheet trigger="Edit" title={`Edit ${room.name}`} variant="ghost" size="sm">
            {(close) => (
              <ActionForm action={saveRoom} submitLabel="Save room" onDone={close}>
                <RoomFields room={room} branchId={branch.id} />
              </ActionForm>
            )}
          </FormSheet>
          <ConfirmDialog
            trigger={
              <Button variant="ghost" size="sm" aria-label={`Delete ${room.name}`}>
                <Trash2 aria-hidden />
              </Button>
            }
            title={`Delete ${room.name}?`}
            description="The room and its whole weekly rota are removed. To keep the history of a room that is closing, untick In use instead."
            confirmLabel="Delete room"
            destructive
            onConfirm={() => deleteRoom(room.id)}
          />
        </div>
      </div>
    </li>
  );
}

export function RoomsEditor({ branches }: { branches: BranchView[] }) {
  return (
    <div className="flex flex-col gap-6">
      {branches.map((b) => (
        <Card key={b.id}>
          <CardHeader className="flex flex-row flex-wrap items-start justify-between gap-2">
            <div>
              <CardTitle className="text-base">{b.name}</CardTitle>
              <CardDescription>
                {b.rooms.length === 1 ? "1 room" : `${b.rooms.length} rooms`}
              </CardDescription>
            </div>
            <FormSheet
              trigger={
                <>
                  <Plus aria-hidden /> Add room
                </>
              }
              title={`Add a room to ${b.name}`}
              variant="outline"
              size="sm"
            >
              {(close) => (
                <ActionForm action={saveRoom} submitLabel="Add room" onDone={close}>
                  <RoomFields branchId={b.id} />
                </ActionForm>
              )}
            </FormSheet>
          </CardHeader>
          <CardContent>
            {b.rooms.length === 0 ? (
              <p className="text-muted-foreground text-sm">No rooms at this branch yet.</p>
            ) : (
              <ul className="flex flex-col gap-2">
                {b.rooms.map((r) => (
                  <RoomRow key={r.id} branch={b} room={r} />
                ))}
              </ul>
            )}
          </CardContent>
        </Card>
      ))}
    </div>
  );
}
