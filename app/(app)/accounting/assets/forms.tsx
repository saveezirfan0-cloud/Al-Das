"use client";

import { useRouter } from "next/navigation";

import { ActionForm, Field, FormSheet, RunButton, selectClass } from "@/components/finance/forms";
import { Input } from "@/components/ui/input";

import {
  cancelDisposal,
  deleteAsset,
  postDisposal,
  prepareDisposal,
  saveAsset,
  saveAssetClass,
} from "./actions";

/** Drawers and buttons of the Fixed assets page. Each server action checks the permission again. */

export type ClassOption = {
  id: string;
  code: string;
  name: string;
  life_months: number;
  method: string;
  residual_pct: number;
  active: boolean;
  cost_account_id: string;
  accum_account_id: string;
  expense_account_id: string;
  disposal_account_id: string;
};
export type LedgerOption = { id: string; code: string; name: string; nature: string };
export type InvoiceChoice = { id: string; label: string; left: number };

export type AssetFormValue = {
  id: string;
  code: string;
  classId: string;
  description: string;
  branchCode: string | null;
  department: string | null;
  acquisitionDate: string;
  inServiceDate: string;
  cost: number;
  residual: number;
  lifeMonths: number;
  method: string;
  supplierInvoiceId: string | null;
  openingAccumulated: number;
  locked: boolean;
};

export function AssetButton({
  asset,
  classes,
  branches,
  invoices,
}: {
  asset?: AssetFormValue;
  classes: ClassOption[];
  branches: string[];
  invoices: InvoiceChoice[];
}) {
  const router = useRouter();
  const lock = asset?.locked ?? false;
  return (
    <FormSheet
      trigger={asset ? "Edit" : "Add asset"}
      title={asset ? `Edit ${asset.code}` : "Add a fixed asset"}
      description={
        lock
          ? "Depreciation is posted for this asset, so only its description, branch and department can change."
          : "Leave life, method and residual blank to use the class's. From a bill, a blank cost takes what is left of its net amount and a blank date its invoice date."
      }
      variant={asset ? "ghost" : "default"}
      size="sm"
    >
      {(close) => (
        <ActionForm
          action={saveAsset}
          onDone={() => {
            close();
            router.refresh();
          }}
        >
          {asset && <input type="hidden" name="id" value={asset.id} />}
          {lock && asset && (
            <>
              <input type="hidden" name="class_id" value={asset.classId} />
              <input type="hidden" name="acquisition_date" value={asset.acquisitionDate} />
              <input type="hidden" name="in_service_date" value={asset.inServiceDate} />
              <input type="hidden" name="cost" value={asset.cost.toFixed(2)} />
              <input type="hidden" name="residual" value={asset.residual.toFixed(2)} />
              <input type="hidden" name="life_months" value={asset.lifeMonths} />
              <input type="hidden" name="method" value={asset.method} />
              <input
                type="hidden"
                name="supplier_invoice_id"
                value={asset.supplierInvoiceId ?? ""}
              />
              <input
                type="hidden"
                name="opening_accumulated"
                value={asset.openingAccumulated.toFixed(2)}
              />
            </>
          )}
          <Field label="Code" hint="Blank: the next FA- number.">
            <Input name="code" defaultValue={asset?.code ?? ""} maxLength={20} />
          </Field>
          <Field
            label="Description"
            hint="What it is (make, model, serial). Never a patient's details."
          >
            <Input
              name="description"
              defaultValue={asset?.description ?? ""}
              maxLength={200}
              required
            />
          </Field>
          {!lock && (
            <>
              <Field label="Class">
                <select
                  name="class_id"
                  defaultValue={asset?.classId ?? ""}
                  className={selectClass}
                  required
                >
                  <option value="">Choose</option>
                  {classes
                    .filter((c) => c.active || c.id === asset?.classId)
                    .map((c) => (
                      <option key={c.id} value={c.id}>
                        {c.name} ({c.life_months} months)
                      </option>
                    ))}
                </select>
              </Field>
              <Field
                label="From a bill (optional)"
                hint="Links the asset to the supplier invoice; its posting stays with the bill."
              >
                <select
                  name="supplier_invoice_id"
                  defaultValue={asset?.supplierInvoiceId ?? ""}
                  className={selectClass}
                >
                  <option value="">None</option>
                  {invoices.map((i) => (
                    <option key={i.id} value={i.id}>
                      {i.label} - {i.left.toFixed(2)} left
                    </option>
                  ))}
                </select>
              </Field>
              <div className="grid grid-cols-2 gap-3">
                <Field label="Acquired">
                  <Input
                    type="date"
                    name="acquisition_date"
                    defaultValue={asset?.acquisitionDate ?? ""}
                  />
                </Field>
                <Field label="In service" hint="Blank: the acquisition date.">
                  <Input
                    type="date"
                    name="in_service_date"
                    defaultValue={asset?.inServiceDate ?? ""}
                  />
                </Field>
                <Field label="Cost (AED)">
                  <Input
                    name="cost"
                    inputMode="decimal"
                    defaultValue={asset ? asset.cost.toFixed(2) : ""}
                  />
                </Field>
                <Field label="Residual value">
                  <Input
                    name="residual"
                    inputMode="decimal"
                    defaultValue={asset ? asset.residual.toFixed(2) : ""}
                  />
                </Field>
                <Field label="Life (months)">
                  <Input
                    name="life_months"
                    inputMode="numeric"
                    defaultValue={asset ? String(asset.lifeMonths) : ""}
                  />
                </Field>
                <Field label="Method">
                  <select name="method" defaultValue={asset?.method ?? ""} className={selectClass}>
                    <option value="">Class default</option>
                    <option value="straight_line">Straight line</option>
                    <option value="reducing_balance">Reducing balance</option>
                  </select>
                </Field>
              </div>
              <Field
                label="Depreciation before Pulse"
                hint="For an asset already in the books: the accumulated depreciation in Tally's opening balance. Pulse charges only what comes after it."
              >
                <Input
                  name="opening_accumulated"
                  inputMode="decimal"
                  defaultValue={asset ? asset.openingAccumulated.toFixed(2) : "0"}
                />
              </Field>
            </>
          )}
          <div className="grid grid-cols-2 gap-3">
            <Field label="Branch">
              <select
                name="branch_code"
                defaultValue={asset?.branchCode ?? ""}
                className={selectClass}
              >
                <option value="">None</option>
                {branches.map((b) => (
                  <option key={b} value={b}>
                    {b}
                  </option>
                ))}
              </select>
            </Field>
            <Field label="Department">
              <Input name="department" defaultValue={asset?.department ?? ""} maxLength={60} />
            </Field>
          </div>
        </ActionForm>
      )}
    </FormSheet>
  );
}

export function DisposeButton({
  id,
  code,
  today,
  ledgers,
}: {
  id: string;
  code: string;
  today: string;
  ledgers: LedgerOption[];
}) {
  const router = useRouter();
  return (
    <FormSheet
      trigger="Dispose"
      title={`Dispose of ${code}`}
      description="Depreciation runs up to the end of the month before the disposal. Pulse works out the net book value and the gain or loss; someone else with journal approval posts it."
      variant="ghost"
      size="sm"
    >
      {(close) => (
        <ActionForm
          action={(v) => prepareDisposal({ ...v, id })}
          submitLabel="Prepare disposal"
          onDone={() => {
            close();
            router.refresh();
          }}
        >
          <Field label="Disposal date">
            <Input type="date" name="disposal_date" defaultValue={today} max={today} required />
          </Field>
          <Field label="Proceeds (AED)" hint="0 when scrapped or written off.">
            <Input name="proceeds" inputMode="decimal" defaultValue="0" />
          </Field>
          <Field
            label="Proceeds go to"
            hint="The bank, cash or receivable ledger. Needed when there are proceeds."
          >
            <select name="proceeds_account_id" defaultValue="" className={selectClass}>
              <option value="">None</option>
              {ledgers
                .filter((l) => l.nature === "asset")
                .map((l) => (
                  <option key={l.id} value={l.id}>
                    {l.code} {l.name}
                  </option>
                ))}
            </select>
          </Field>
        </ActionForm>
      )}
    </FormSheet>
  );
}

export function PostDisposalButton({ id, hash, code }: { id: string; hash: string; code: string }) {
  const router = useRouter();
  return (
    <RunButton
      variant="default"
      confirm={`Post the disposal of ${code}? The journal removes its cost and depreciation and books the gain or loss. It cannot be undone except by a reversal.`}
      action={() => postDisposal({ id, hash })}
      onDone={() => router.refresh()}
    >
      Post disposal
    </RunButton>
  );
}

export function WithdrawDisposalButton({ id }: { id: string }) {
  const router = useRouter();
  return (
    <RunButton
      variant="ghost"
      action={() => cancelDisposal({ id })}
      onDone={() => router.refresh()}
    >
      Withdraw
    </RunButton>
  );
}

export function DeleteAssetButton({ id, code }: { id: string; code: string }) {
  const router = useRouter();
  return (
    <RunButton
      variant="ghost"
      confirm={`Delete ${code}? Only an asset with no depreciation can be deleted.`}
      action={() => deleteAsset({ id })}
      onDone={() => router.refresh()}
    >
      Delete
    </RunButton>
  );
}

export function ClassButton({ cls, ledgers }: { cls: ClassOption; ledgers: LedgerOption[] }) {
  const router = useRouter();
  const pick = (name: string, value: string, natures: string[]) => (
    <select name={name} defaultValue={value} className={selectClass} required>
      {ledgers
        .filter((l) => natures.includes(l.nature))
        .map((l) => (
          <option key={l.id} value={l.id}>
            {l.code} {l.name}
          </option>
        ))}
    </select>
  );
  return (
    <FormSheet
      trigger="Edit"
      title={`Edit ${cls.name}`}
      description="Life, method and residual are the defaults for new assets; existing assets keep their own. The ledgers apply to every run from now on."
      variant="ghost"
      size="sm"
    >
      {(close) => (
        <ActionForm
          action={saveAssetClass}
          onDone={() => {
            close();
            router.refresh();
          }}
        >
          <input type="hidden" name="id" value={cls.id} />
          <Field label="Name">
            <Input name="name" defaultValue={cls.name} maxLength={80} required />
          </Field>
          <div className="grid grid-cols-3 gap-3">
            <Field label="Life (months)">
              <Input
                name="life_months"
                inputMode="numeric"
                defaultValue={String(cls.life_months)}
                required
              />
            </Field>
            <Field label="Method">
              <select name="method" defaultValue={cls.method} className={selectClass}>
                <option value="straight_line">Straight line</option>
                <option value="reducing_balance">Reducing balance</option>
              </select>
            </Field>
            <Field label="Residual %">
              <Input
                name="residual_pct"
                inputMode="decimal"
                defaultValue={String(cls.residual_pct)}
              />
            </Field>
          </div>
          <Field label="Cost ledger">
            {pick("cost_account_id", cls.cost_account_id, ["asset"])}
          </Field>
          <Field label="Accumulated depreciation ledger">
            {pick("accum_account_id", cls.accum_account_id, ["asset"])}
          </Field>
          <Field label="Depreciation expense ledger">
            {pick("expense_account_id", cls.expense_account_id, ["expense"])}
          </Field>
          <Field label="Gain or loss on disposal ledger">
            {pick("disposal_account_id", cls.disposal_account_id, ["income", "expense"])}
          </Field>
          <label className="flex min-h-11 items-center gap-2 text-sm">
            <input type="checkbox" name="active" defaultChecked={cls.active} /> Active (offered for
            new assets)
          </label>
        </ActionForm>
      )}
    </FormSheet>
  );
}
