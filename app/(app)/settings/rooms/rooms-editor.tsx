"use client";

import { Pencil, Plus, Trash2 } from "lucide-react";

import { ActionForm, Field, FormSheet, selectClass } from "@/components/finance/forms";
import { ConfirmDialog } from "@/components/shell/confirm-dialog";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { ROOM_KIND_LABEL, ROOM_KINDS, type RoomKind } from "@/lib/capacity/rooms";

import { deleteRoom, saveRoom } from "./actions";

export type RoomView = {
  id: string;
  name: string;
  kind: string;
  monthlyCost: number | null;
  active: boolean;
};
export type BranchView = {
  id: string;
  name: string;
  rooms: RoomView[];
};

const kindLabel = (k: string) => ROOM_KIND_LABEL[k as RoomKind] ?? k;
const aed = (v: number) =>
  v.toLocaleString("en-GB", { minimumFractionDigits: 2, maximumFractionDigits: 2 });

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
              : `AED ${aed(room.monthlyCost)} a month`}
          </p>
        </div>
        <div className="flex gap-1">
          <FormSheet
            trigger={
              <>
                <Pencil aria-hidden /> Edit
              </>
            }
            title={`Edit ${room.name}`}
            variant="ghost"
            size="sm"
          >
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
            description="The room is removed. To keep a room that is closing on record, untick In use instead."
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
