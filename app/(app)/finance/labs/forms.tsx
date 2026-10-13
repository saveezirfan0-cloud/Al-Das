"use client";

import * as React from "react";
import { useRouter } from "next/navigation";
import { Loader2, Upload } from "lucide-react";
import { toast } from "sonner";

import { ActionForm, Field, RunButton, selectClass } from "@/components/finance/forms";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";

import {
  importProviderFile,
  postStatement,
  removeProviderFile,
  reopenStatement,
  reviewStatement,
  saveLabReason,
} from "./actions";

type ProviderOption = { id: string; name: string; fileKind: string };
type FormatOption = { id: string; kind: string; name: string };

export function UploadForm({
  providers,
  formats,
  month,
}: {
  providers: ProviderOption[];
  formats: FormatOption[];
  month: string;
}) {
  const router = useRouter();
  const [providerId, setProviderId] = React.useState(providers[0]?.id ?? "");
  const [pending, start] = React.useTransition();
  const form = React.useRef<HTMLFormElement>(null);
  const kind = providers.find((p) => p.id === providerId)?.fileKind;
  const layouts = formats.filter((f) => f.kind === kind);
  return (
    <form
      ref={form}
      className="flex flex-col gap-3"
      onSubmit={(e) => {
        e.preventDefault();
        const fd = new FormData(e.currentTarget);
        start(async () => {
          const res = await importProviderFile(fd);
          if (res.ok) {
            toast.success(res.message ?? "Imported");
            form.current?.reset();
            if (res.data) router.push(`/finance/labs/${res.data.statementId}`);
          } else toast.error(res.error);
        });
      }}
    >
      <div className="grid gap-3 sm:grid-cols-2">
        <Field label="Provider">
          <select
            name="provider_id"
            className={selectClass}
            value={providerId}
            onChange={(e) => setProviderId(e.target.value)}
            required
          >
            {providers.map((p) => (
              <option key={p.id} value={p.id}>
                {p.name}
              </option>
            ))}
          </select>
        </Field>
        <Field label="Month of service">
          <Input type="month" name="month" defaultValue={month} required />
        </Field>
        <Field
          label="Layout"
          hint={
            layouts.length === 0
              ? "Add a layout for this provider's files in Settings first."
              : undefined
          }
        >
          <select name="format_id" className={selectClass} required>
            {layouts.map((f) => (
              <option key={f.id} value={f.id}>
                {f.name}
              </option>
            ))}
          </select>
        </Field>
        <Field label="File (.csv or .xlsx, up to 5 MB)">
          <Input name="file" type="file" accept=".csv,.xlsx" required />
        </Field>
      </div>
      <div>
        <Button type="submit" disabled={pending || layouts.length === 0 || !providerId}>
          {pending ? <Loader2 className="animate-spin" /> : <Upload />} Upload
        </Button>
      </div>
    </form>
  );
}

export function RemoveFileButton({ statementId, fileId }: { statementId: string; fileId: string }) {
  return (
    <RunButton
      variant="ghost"
      confirm="Remove this file and all its lines from the statement?"
      action={() => removeProviderFile({ statement_id: statementId, file_id: fileId })}
    >
      Remove
    </RunButton>
  );
}

function ReasonFields({ reasons }: { reasons: Array<[string, string]> }) {
  return (
    <>
      <select name="code" className={selectClass} required defaultValue="">
        <option value="" disabled>
          Reason...
        </option>
        {reasons.map(([k, label]) => (
          <option key={k} value={k}>
            {label}
          </option>
        ))}
      </select>
      <Input name="note" placeholder="Note (no patient details)" maxLength={200} />
    </>
  );
}

/** The reason for one item, or (with `list`) for every item of a list that has none yet. */
export function ReasonForm({
  statementId,
  itemKey,
  list,
  reasons,
}: {
  statementId: string;
  itemKey?: string;
  list?: "not_billed" | "not_on_file";
  reasons: Array<[string, string]>;
}) {
  return (
    <ActionForm
      action={saveLabReason}
      submitLabel={list ? "Apply to all without a reason" : "Save"}
      variant="outline"
      className="sm:flex-row sm:items-center"
    >
      <input type="hidden" name="statement_id" value={statementId} />
      {itemKey && <input type="hidden" name="item_key" value={itemKey} />}
      {list && <input type="hidden" name="list" value={list} />}
      <ReasonFields reasons={reasons} />
    </ActionForm>
  );
}

export function ReviewButton({
  statementId,
  disabled,
}: {
  statementId: string;
  disabled: boolean;
}) {
  const router = useRouter();
  return (
    <ActionForm
      action={reviewStatement}
      submitLabel="Mark reviewed"
      disabled={disabled}
      onDone={() => router.refresh()}
    >
      <input type="hidden" name="statement_id" value={statementId} />
    </ActionForm>
  );
}

export function PostButton({
  statementId,
  hash,
  label,
}: {
  statementId: string;
  hash: string;
  label: string;
}) {
  const router = useRouter();
  return (
    <RunButton
      variant="default"
      confirm="Post these costs to the doctors' charges for the month?"
      action={() => postStatement({ statement_id: statementId, hash })}
      onDone={() => router.refresh()}
    >
      {label}
    </RunButton>
  );
}

export function ReopenButton({ statementId, posted }: { statementId: string; posted: boolean }) {
  const router = useRouter();
  return (
    <RunButton
      variant="outline"
      confirm={
        posted
          ? "Reopen this statement? Its posted doctor charges are removed until it is posted again."
          : "Reopen this statement? The review is withdrawn."
      }
      action={() => reopenStatement({ statement_id: statementId })}
      onDone={() => router.refresh()}
    >
      Reopen
    </RunButton>
  );
}
