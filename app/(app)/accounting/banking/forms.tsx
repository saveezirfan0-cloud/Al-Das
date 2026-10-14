"use client";

import * as React from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";

import {
  DocumentChip,
  OpenDocumentButton,
  uploadFinanceFile,
  type UploadedDocument,
} from "@/components/finance/finance-upload";
import { ActionForm, Field, FormSheet, RunButton, selectClass } from "@/components/finance/forms";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import {
  CHEQUE_TRANSITIONS,
  ENTRY_LABELS,
  ENTRY_KINDS,
  PARTY_KINDS,
  PARTY_LABELS,
  TRANSFER_KINDS,
  TRANSFER_LABELS,
  vatSplit,
  type ChequeAction,
  type EntryKind,
  type PartyKind,
  type TransferKind,
} from "@/lib/accounting/banking";
import { money } from "@/lib/finance/format";

import {
  abandonReceiptUpload,
  cancelBankingItem,
  chequeStep,
  clearPartyFlag,
  closeChequeBook,
  createBankEntry,
  createBankLedger,
  createPettyCashExpense,
  createTransfer,
  finalizeReceiptUpload,
  linkBankLedger,
  openReceipt,
  preparePettyCashCount,
  prepareReceiptUpload,
  registerCheque,
  runBankingSweep,
  saveChequeBook,
  savePettyCashFloat,
  saveStatementBalance,
  signPettyCashCount,
} from "./actions";

/** Forms of the Banking pages (Phase 22F). Every action re-checks accounting.banking.manage on the server. */

export type Option = { id: string; label: string };
export type LedgerOpt = { id: string; code: string; name: string; control?: string | null };
export type TaxOpt = { id: string; code: string; name: string; kind: string; rate: number };
export type BranchOpt = { code: string; name: string };

const ledgerLabel = (l: LedgerOpt) => `${l.code} · ${l.name}`;

function useDone(close: () => void) {
  const router = useRouter();
  return () => {
    close();
    router.refresh();
  };
}

function Select({
  name,
  options,
  placeholder,
  defaultValue,
  required,
  value,
  onChange,
}: {
  name: string;
  options: Option[];
  placeholder?: string;
  defaultValue?: string;
  required?: boolean;
  value?: string;
  onChange?: (v: string) => void;
}) {
  return (
    <select
      name={name}
      className={selectClass}
      defaultValue={value === undefined ? (defaultValue ?? "") : undefined}
      value={value}
      required={required}
      onChange={onChange ? (e) => onChange(e.target.value) : undefined}
    >
      {placeholder !== undefined && <option value="">{placeholder}</option>}
      {options.map((o) => (
        <option key={o.id} value={o.id}>
          {o.label}
        </option>
      ))}
    </select>
  );
}

const ledgerOptions = (ls: LedgerOpt[]) => ls.map((l) => ({ id: l.id, label: ledgerLabel(l) }));
const branchOptions = (bs: BranchOpt[]) =>
  bs.map((b) => ({ id: b.code, label: `${b.code} · ${b.name}` }));
const taxOptions = (ts: TaxOpt[]) => ts.map((t) => ({ id: t.id, label: `${t.code} · ${t.name}` }));

function BranchField({ branches, defaultValue }: { branches: BranchOpt[]; defaultValue?: string }) {
  if (branches.length === 0) return null;
  return (
    <Field label="Branch (optional)">
      <Select
        name="branch_code"
        options={branchOptions(branches)}
        placeholder="No branch"
        defaultValue={defaultValue}
      />
    </Field>
  );
}

/** Shows how a VAT-inclusive amount will split. */
function VatPreview({ amount, tax }: { amount: string; tax: TaxOpt | undefined }) {
  const n = Number(amount.replace(/,/g, ""));
  if (!tax || !Number.isFinite(n) || n <= 0) return null;
  const s = vatSplit(n, tax);
  if (!s || s.vat === 0) return null;
  return (
    <p className="text-muted-foreground text-xs">
      Net {money(s.net)} + VAT {money(s.vat)} (the amount includes VAT).
    </p>
  );
}

// ---- bank accounts ----------------------------------------------------------------------------------------------

export function LinkLedgerForm({
  bankAccountId,
  current,
  ledgers,
}: {
  bankAccountId: string;
  current: string | null;
  ledgers: LedgerOpt[];
}) {
  const router = useRouter();
  return (
    <ActionForm
      action={linkBankLedger}
      submitLabel="Link"
      variant="outline"
      className="flex-row items-end"
      onDone={() => router.refresh()}
    >
      <input type="hidden" name="bank_account_id" value={bankAccountId} />
      <Select
        name="account_id"
        options={ledgerOptions(ledgers)}
        placeholder="Not linked"
        defaultValue={current ?? ""}
      />
    </ActionForm>
  );
}

export function CreateLedgerButton({
  bankAccountId,
  suggestedCode,
  suggestedName,
}: {
  bankAccountId: string;
  suggestedCode: string;
  suggestedName: string;
}) {
  return (
    <FormSheet
      trigger="Create ledger"
      title="Create this account's ledger"
      description="A new ledger in the chart of accounts, marked as a bank control account and linked to this bank account."
      variant="outline"
      size="sm"
    >
      {(close) => <CreateLedgerForm {...{ bankAccountId, suggestedCode, suggestedName, close }} />}
    </FormSheet>
  );
}

function CreateLedgerForm({
  bankAccountId,
  suggestedCode,
  suggestedName,
  close,
}: {
  bankAccountId: string;
  suggestedCode: string;
  suggestedName: string;
  close: () => void;
}) {
  const done = useDone(close);
  return (
    <ActionForm action={createBankLedger} submitLabel="Create and link" onDone={done}>
      <input type="hidden" name="bank_account_id" value={bankAccountId} />
      <Field label="Group">
        <select name="group" className={selectClass} defaultValue="bank">
          <option value="bank">Bank Accounts (a current or savings account)</option>
          <option value="od">Bank OD A/c (an overdraft or credit line)</option>
        </select>
      </Field>
      <Field label="Code">
        <Input name="code" defaultValue={suggestedCode} maxLength={20} required />
      </Field>
      <Field label="Name">
        <Input name="name" defaultValue={suggestedName} maxLength={120} required />
      </Field>
    </ActionForm>
  );
}

export function StatementBalanceButton({
  bankAccountId,
  today,
}: {
  bankAccountId: string;
  today: string;
}) {
  return (
    <FormSheet
      trigger="Statement balance"
      title="Closing balance on the statement"
      description="Type the balance the bank printed for a date (minus when overdrawn). The position compares it with the books on that date."
      variant="ghost"
      size="sm"
    >
      {(close) => (
        <StatementBalanceForm bankAccountId={bankAccountId} today={today} close={close} />
      )}
    </FormSheet>
  );
}

function StatementBalanceForm({
  bankAccountId,
  today,
  close,
}: {
  bankAccountId: string;
  today: string;
  close: () => void;
}) {
  const done = useDone(close);
  return (
    <ActionForm action={saveStatementBalance} onDone={done}>
      <input type="hidden" name="bank_account_id" value={bankAccountId} />
      <Field label="Date">
        <Input type="date" name="as_of" defaultValue={today} required />
      </Field>
      <Field label="Balance">
        <Input name="balance" inputMode="decimal" required />
      </Field>
    </ActionForm>
  );
}

export function SweepButton() {
  const router = useRouter();
  return (
    <RunButton action={runBankingSweep} onDone={() => router.refresh()}>
      Post what is due
    </RunButton>
  );
}

// ---- transfers --------------------------------------------------------------------------------------------------

export function TransferButton({
  accounts,
  floats,
  branches,
  today,
}: {
  accounts: LedgerOpt[];
  floats: Option[];
  branches: BranchOpt[];
  today: string;
}) {
  return (
    <FormSheet
      trigger="New transfer"
      title="Contra: move money between accounts"
      description="Between two bank accounts, cash deposited in or withdrawn from a bank, or a petty cash top-up. It posts as a Contra voucher."
    >
      {(close) => <TransferForm {...{ accounts, floats, branches, today, close }} />}
    </FormSheet>
  );
}

function TransferForm({
  accounts,
  floats,
  branches,
  today,
  close,
}: {
  accounts: LedgerOpt[];
  floats: Option[];
  branches: BranchOpt[];
  today: string;
  close: () => void;
}) {
  const done = useDone(close);
  const [kind, setKind] = React.useState<TransferKind>("transfer");
  const byControl = (c: string) => accounts.filter((a) => a.control === c);
  const fromList =
    kind === "cash_deposit"
      ? byControl("cash")
      : kind === "cash_withdrawal"
        ? byControl("bank")
        : accounts;
  const toList =
    kind === "cash_deposit"
      ? byControl("bank")
      : kind === "cash_withdrawal"
        ? byControl("cash")
        : accounts;
  return (
    <ActionForm action={createTransfer} submitLabel="Save and post" onDone={done}>
      <Field label="Kind">
        <select
          name="kind"
          className={selectClass}
          value={kind}
          onChange={(e) => setKind(e.target.value as TransferKind)}
        >
          {TRANSFER_KINDS.map((k) => (
            <option key={k} value={k}>
              {TRANSFER_LABELS[k]}
            </option>
          ))}
        </select>
      </Field>
      <Field label="Date">
        <Input type="date" name="transfer_date" defaultValue={today} required />
      </Field>
      <Field label="From">
        <Select
          name="from_account_id"
          options={ledgerOptions(fromList)}
          placeholder="Choose"
          required
        />
      </Field>
      {kind === "petty_cash_topup" ? (
        <Field label="Float">
          <Select name="float_id" options={floats} placeholder="Choose" required />
        </Field>
      ) : (
        <Field label="To">
          <Select
            name="to_account_id"
            options={ledgerOptions(toList)}
            placeholder="Choose"
            required
          />
        </Field>
      )}
      <Field label="Amount">
        <Input name="amount" inputMode="decimal" required />
      </Field>
      <Field label="Reference (optional)" hint="A deposit slip or transfer reference.">
        <Input name="reference" maxLength={60} />
      </Field>
      <Field label="Narration">
        <Input name="narration" maxLength={300} required />
      </Field>
      <BranchField branches={branches} />
    </ActionForm>
  );
}

export function CancelButton({
  kind,
  id,
  today,
  label = "Cancel",
}: {
  kind: "transfer" | "entry" | "expense";
  id: string;
  today: string;
  label?: string;
}) {
  return (
    <FormSheet
      trigger={label}
      title="Cancel"
      description="A posted item is reversed on the date you choose (on or after its own date); nothing is deleted."
      variant="ghost"
      size="sm"
    >
      {(close) => <CancelForm kind={kind} id={id} today={today} close={close} />}
    </FormSheet>
  );
}

function CancelForm({
  kind,
  id,
  today,
  close,
}: {
  kind: string;
  id: string;
  today: string;
  close: () => void;
}) {
  const done = useDone(close);
  return (
    <ActionForm
      action={cancelBankingItem}
      submitLabel="Cancel it"
      variant="destructive"
      onDone={done}
    >
      <input type="hidden" name="kind" value={kind} />
      <input type="hidden" name="id" value={id} />
      <Field label="Reversal date">
        <Input type="date" name="date" defaultValue={today} required />
      </Field>
      <Field label="Reason">
        <Input name="reason" maxLength={300} required />
      </Field>
    </ActionForm>
  );
}

// ---- bank entries -----------------------------------------------------------------------------------------------

export type LinePrefill = {
  id: string;
  bank_account_id: string;
  value_date: string;
  amount: number; // signed
  reference: string | null;
};

export function EntryButton({
  banks,
  ledgers,
  taxCodes,
  branches,
  today,
  line,
}: {
  banks: Option[];
  ledgers: LedgerOpt[];
  taxCodes: TaxOpt[];
  branches: BranchOpt[];
  today: string;
  line?: LinePrefill;
}) {
  return (
    <FormSheet
      trigger={line ? "Create entry" : "New bank entry"}
      title={line ? "Create an entry from this statement line" : "Bank entry"}
      description="Bank charges, interest and direct debits or credits that no other part of Pulse posts. A statement line used here counts as matched in the bank reconciliation."
      variant={line ? "outline" : "default"}
      size={line ? "sm" : "default"}
    >
      {(close) => <EntryForm {...{ banks, ledgers, taxCodes, branches, today, line, close }} />}
    </FormSheet>
  );
}

function EntryForm({
  banks,
  ledgers,
  taxCodes,
  branches,
  today,
  line,
  close,
}: {
  banks: Option[];
  ledgers: LedgerOpt[];
  taxCodes: TaxOpt[];
  branches: BranchOpt[];
  today: string;
  line?: LinePrefill;
  close: () => void;
}) {
  const done = useDone(close);
  const kinds = line
    ? ENTRY_KINDS.filter((k) =>
        line.amount > 0
          ? k === "interest_received" || k === "direct_credit"
          : !(k === "interest_received" || k === "direct_credit"),
      )
    : ENTRY_KINDS;
  const [amount, setAmount] = React.useState(line ? Math.abs(line.amount).toFixed(2) : "");
  const [tax, setTax] = React.useState("");
  return (
    <ActionForm action={createBankEntry} submitLabel="Save and post" onDone={done}>
      {line && <input type="hidden" name="bank_line_id" value={line.id} />}
      <Field label="Bank account">
        {line ? (
          <>
            <input type="hidden" name="bank_account_id" value={line.bank_account_id} />
            <Input value={banks.find((b) => b.id === line.bank_account_id)?.label ?? ""} readOnly />
          </>
        ) : (
          <Select name="bank_account_id" options={banks} placeholder="Choose" required />
        )}
      </Field>
      <Field label="Kind">
        <select name="kind" className={selectClass} defaultValue={kinds[0]}>
          {kinds.map((k: EntryKind) => (
            <option key={k} value={k}>
              {ENTRY_LABELS[k]}
            </option>
          ))}
        </select>
      </Field>
      <Field label="Date">
        <Input
          type="date"
          name="entry_date"
          defaultValue={line?.value_date ?? today}
          readOnly={!!line}
          required
        />
      </Field>
      <Field label="Amount (as on the statement)">
        <Input
          name="amount"
          inputMode="decimal"
          value={amount}
          readOnly={!!line}
          onChange={(e) => setAmount(e.target.value)}
          required
        />
      </Field>
      <Field label="Account" hint="Bank and card charges, interest, a loan ...">
        <Select name="account_id" options={ledgerOptions(ledgers)} placeholder="Choose" required />
      </Field>
      <Field label="Tax code (optional)">
        <Select
          name="tax_code_id"
          options={taxOptions(taxCodes)}
          placeholder="No VAT"
          value={tax}
          onChange={setTax}
        />
      </Field>
      <VatPreview amount={amount} tax={taxCodes.find((t) => t.id === tax)} />
      <Field label="Reference (optional)">
        <Input name="reference" maxLength={60} defaultValue={line?.reference ?? ""} />
      </Field>
      <Field label="Narration">
        <Input name="narration" maxLength={300} required />
      </Field>
      <BranchField branches={branches} />
    </ActionForm>
  );
}

// ---- petty cash -------------------------------------------------------------------------------------------------

export function FloatButton({
  float,
  branches,
  people,
  suggestedCode,
}: {
  float?: {
    id: string;
    name: string;
    branch_code: string | null;
    imprest_amount: number;
    custodian_id: string | null;
    active: boolean;
  };
  branches: BranchOpt[];
  people: Option[];
  suggestedCode: string;
}) {
  return (
    <FormSheet
      trigger={float ? "Edit" : "New float"}
      title={float ? `Edit ${float.name}` : "New petty cash float"}
      description="Each float has its own cash ledger under Cash-in-Hand. Top it up with a petty cash transfer."
      variant={float ? "ghost" : "default"}
      size={float ? "sm" : "default"}
    >
      {(close) => <FloatForm {...{ float, branches, people, suggestedCode, close }} />}
    </FormSheet>
  );
}

function FloatForm({
  float,
  branches,
  people,
  suggestedCode,
  close,
}: {
  float?: {
    id: string;
    name: string;
    branch_code: string | null;
    imprest_amount: number;
    custodian_id: string | null;
    active: boolean;
  };
  branches: BranchOpt[];
  people: Option[];
  suggestedCode: string;
  close: () => void;
}) {
  const done = useDone(close);
  return (
    <ActionForm action={savePettyCashFloat} onDone={done}>
      {float && <input type="hidden" name="id" value={float.id} />}
      <Field label="Name">
        <Input name="name" defaultValue={float?.name ?? ""} maxLength={80} required />
      </Field>
      <BranchField branches={branches} defaultValue={float?.branch_code ?? ""} />
      <Field label="Float amount" hint="The amount it is topped back up to.">
        <Input
          name="imprest_amount"
          inputMode="decimal"
          defaultValue={float ? float.imprest_amount.toFixed(2) : ""}
          required
        />
      </Field>
      <Field label="Custodian (optional)">
        <Select
          name="custodian_id"
          options={people}
          placeholder="Nobody named"
          defaultValue={float?.custodian_id ?? ""}
        />
      </Field>
      {!float && (
        <Field label="Ledger code">
          <Input name="code" defaultValue={suggestedCode} maxLength={20} required />
        </Field>
      )}
      {float && (
        <label className="flex min-h-11 items-center gap-2 text-sm">
          <input type="checkbox" name="active" defaultChecked={float.active} /> Active
        </label>
      )}
    </ActionForm>
  );
}

export function ExpenseButton({
  floats,
  ledgers,
  taxCodes,
  branches,
  today,
}: {
  floats: Option[];
  ledgers: LedgerOpt[];
  taxCodes: TaxOpt[];
  branches: BranchOpt[];
  today: string;
}) {
  return (
    <FormSheet
      trigger="New expense"
      title="Petty cash expense"
      description="Paid out of a float. Attach the receipt (a photo is fine)."
    >
      {(close) => <ExpenseForm {...{ floats, ledgers, taxCodes, branches, today, close }} />}
    </FormSheet>
  );
}

function ExpenseForm({
  floats,
  ledgers,
  taxCodes,
  branches,
  today,
  close,
}: {
  floats: Option[];
  ledgers: LedgerOpt[];
  taxCodes: TaxOpt[];
  branches: BranchOpt[];
  today: string;
  close: () => void;
}) {
  const done = useDone(close);
  const [doc, setDoc] = React.useState<UploadedDocument | null>(null);
  const [amount, setAmount] = React.useState("");
  const [tax, setTax] = React.useState("");
  return (
    <ActionForm action={createPettyCashExpense} submitLabel="Save and post" onDone={done}>
      <Field label="Float">
        <Select name="float_id" options={floats} placeholder="Choose" required />
      </Field>
      <Field label="Date">
        <Input type="date" name="expense_date" defaultValue={today} required />
      </Field>
      <Field label="Amount paid (VAT included)">
        <Input
          name="amount"
          inputMode="decimal"
          value={amount}
          onChange={(e) => setAmount(e.target.value)}
          required
        />
      </Field>
      <Field label="Expense account">
        <Select name="account_id" options={ledgerOptions(ledgers)} placeholder="Choose" required />
      </Field>
      <Field label="Tax code (optional)">
        <Select
          name="tax_code_id"
          options={taxOptions(taxCodes)}
          placeholder="No VAT"
          value={tax}
          onChange={setTax}
        />
      </Field>
      <VatPreview amount={amount} tax={taxCodes.find((t) => t.id === tax)} />
      <Field label="Receipt number (optional)">
        <Input name="reference" maxLength={60} />
      </Field>
      <Field label="Narration">
        <Input name="narration" maxLength={300} required />
      </Field>
      <BranchField branches={branches} />
      <input type="hidden" name="document_id" value={doc?.id ?? ""} />
      {doc ? (
        <DocumentChip doc={doc} onRemove={() => setDoc(null)} />
      ) : (
        <ReceiptUpload onUploaded={setDoc} />
      )}
    </ActionForm>
  );
}

function ReceiptUpload({ onUploaded }: { onUploaded: (doc: UploadedDocument) => void }) {
  const input = React.useRef<HTMLInputElement>(null);
  const [busy, setBusy] = React.useState(false);
  return (
    <div>
      <input
        ref={input}
        type="file"
        accept="image/*,application/pdf,.heic,.heif"
        className="hidden"
        onChange={async (e) => {
          const file = e.target.files?.[0];
          if (!file) return;
          setBusy(true);
          try {
            const { doc, message } = await uploadFinanceFile(file, {
              prepare: prepareReceiptUpload,
              finalize: finalizeReceiptUpload,
              abandon: abandonReceiptUpload,
            });
            onUploaded(doc);
            toast.success(message ?? "Receipt attached.");
          } catch (err) {
            toast.error(err instanceof Error ? err.message : "Upload failed");
          } finally {
            setBusy(false);
            if (input.current) input.current.value = "";
          }
        }}
      />
      <button
        type="button"
        className="text-primary min-h-11 text-sm underline"
        disabled={busy}
        onClick={() => input.current?.click()}
      >
        {busy ? "Uploading…" : "Attach the receipt"}
      </button>
    </div>
  );
}

/** Opens a stored receipt through the banking permission (the open is logged). */
export function ReceiptOpen({ id }: { id: string }) {
  return <OpenDocumentButton id={id} label="Receipt" open={openReceipt} />;
}

export function CountButton({
  floatId,
  floatName,
  today,
}: {
  floatId: string;
  floatName: string;
  today: string;
}) {
  return (
    <FormSheet
      trigger="Count"
      title={`Count ${floatName}`}
      description="Count the cash in the box. Pulse takes the book balance on the count date; someone else signs the count."
      variant="outline"
      size="sm"
    >
      {(close) => <CountForm floatId={floatId} today={today} close={close} />}
    </FormSheet>
  );
}

function CountForm({
  floatId,
  today,
  close,
}: {
  floatId: string;
  today: string;
  close: () => void;
}) {
  const done = useDone(close);
  return (
    <ActionForm action={preparePettyCashCount} submitLabel="Save count" onDone={done}>
      <input type="hidden" name="float_id" value={floatId} />
      <Field label="Count date">
        <Input type="date" name="count_date" defaultValue={today} required />
      </Field>
      <Field label="Cash counted">
        <Input name="counted" inputMode="decimal" required />
      </Field>
      <Field label="Explanation" hint="Required when the count differs from the book.">
        <Textarea name="explanation" maxLength={500} />
      </Field>
    </ActionForm>
  );
}

export function SignCountButton({ id, sha256 }: { id: string; sha256: string }) {
  const router = useRouter();
  return (
    <RunButton
      action={() => signPettyCashCount({ id, sha256 })}
      confirm="Sign this count? You confirm the cash counted and the explanation. A signed count is final."
      onDone={() => router.refresh()}
    >
      Sign
    </RunButton>
  );
}

// ---- cheques ----------------------------------------------------------------------------------------------------

export function ChequeBookButton({ banks }: { banks: Option[] }) {
  return (
    <FormSheet
      trigger="Add cheque book"
      title="Cheque book"
      description="The leaves' first and last numbers. Issued cheques take the next leaf."
      variant="outline"
      size="sm"
    >
      {(close) => <ChequeBookForm banks={banks} close={close} />}
    </FormSheet>
  );
}

function ChequeBookForm({ banks, close }: { banks: Option[]; close: () => void }) {
  const done = useDone(close);
  return (
    <ActionForm action={saveChequeBook} onDone={done}>
      <Field label="Bank account">
        <Select name="bank_account_id" options={banks} placeholder="Choose" required />
      </Field>
      <Field label="First number" hint="Leading zeros are kept (for example 000101).">
        <Input name="first_number" inputMode="numeric" maxLength={12} required />
      </Field>
      <Field label="Last number">
        <Input name="last_number" inputMode="numeric" maxLength={12} required />
      </Field>
    </ActionForm>
  );
}

export function CloseBookButton({ id }: { id: string }) {
  const router = useRouter();
  return (
    <RunButton
      action={() => closeChequeBook({ id })}
      confirm="Close this cheque book? No more cheques can be taken from it."
      onDone={() => router.refresh()}
    >
      Close
    </RunButton>
  );
}

export type ChequePrefill = {
  voucher_id: string;
  voucher_no: string;
  amount: number;
  payee: string;
  supplier_id: string | null;
  cheque_no: string;
  date: string;
};

export function ChequeButton({
  banks,
  books,
  ledgers,
  suppliers,
  payers,
  today,
  prefill,
  defaultPayable,
}: {
  banks: Option[];
  books: Array<{ id: string; bank_account_id: string; label: string }>;
  ledgers: LedgerOpt[];
  suppliers: Option[];
  payers: Option[];
  today: string;
  prefill?: ChequePrefill;
  defaultPayable: string | null;
}) {
  return (
    <FormSheet
      trigger={prefill ? "Register" : "Register cheque"}
      title={prefill ? `Cheque for voucher ${prefill.voucher_no}` : "Register a cheque"}
      description="A cheque dated today or earlier posts now; a post-dated cheque posts on its date."
      variant={prefill ? "outline" : "default"}
      size={prefill ? "sm" : "default"}
    >
      {(close) => (
        <ChequeForm
          {...{ banks, books, ledgers, suppliers, payers, today, prefill, defaultPayable, close }}
        />
      )}
    </FormSheet>
  );
}

function ChequeForm({
  banks,
  books,
  ledgers,
  suppliers,
  payers,
  today,
  prefill,
  defaultPayable,
  close,
}: {
  banks: Option[];
  books: Array<{ id: string; bank_account_id: string; label: string }>;
  ledgers: LedgerOpt[];
  suppliers: Option[];
  payers: Option[];
  today: string;
  prefill?: ChequePrefill;
  defaultPayable: string | null;
  close: () => void;
}) {
  const done = useDone(close);
  const [direction, setDirection] = React.useState<"issued" | "received">("issued");
  const [bank, setBank] = React.useState("");
  const [party, setParty] = React.useState<PartyKind>(
    prefill?.supplier_id ? "supplier" : prefill ? "other" : "supplier",
  );
  const bookList = books.filter((b) => b.bank_account_id === bank);
  return (
    <ActionForm action={registerCheque} submitLabel="Register" onDone={done}>
      {prefill && <input type="hidden" name="voucher_id" value={prefill.voucher_id} />}
      <Field label="Direction">
        <select
          name="direction"
          className={selectClass}
          value={prefill ? "issued" : direction}
          disabled={!!prefill}
          onChange={(e) => setDirection(e.target.value as "issued" | "received")}
        >
          <option value="issued">Issued by us</option>
          <option value="received">Received from someone</option>
        </select>
      </Field>
      {prefill && <input type="hidden" name="direction" value="issued" />}
      <Field label={direction === "received" && !prefill ? "Deposited to" : "Drawn on"}>
        <Select
          name="bank_account_id"
          options={banks}
          placeholder="Choose"
          required
          value={bank}
          onChange={setBank}
        />
      </Field>
      {(prefill || direction === "issued") && bookList.length > 0 && (
        <Field label="Cheque book (optional)" hint="Leave the number blank to take the next leaf.">
          <Select
            name="cheque_book_id"
            options={bookList.map((b) => ({ id: b.id, label: b.label }))}
            placeholder="No cheque book"
          />
        </Field>
      )}
      <Field label="Cheque number">
        <Input
          name="cheque_no"
          inputMode="numeric"
          maxLength={12}
          defaultValue={prefill?.cheque_no ?? ""}
        />
      </Field>
      <Field label="Date on the cheque" hint="A later date than today makes it post-dated.">
        <Input type="date" name="cheque_date" defaultValue={prefill?.date ?? today} required />
      </Field>
      <Field label={direction === "received" && !prefill ? "Received on" : "Written on"}>
        <Input type="date" name="recorded_on" defaultValue={today} required />
      </Field>
      <Field label="Amount">
        <Input
          name="amount"
          inputMode="decimal"
          defaultValue={prefill ? prefill.amount.toFixed(2) : ""}
          readOnly={!!prefill}
          required
        />
      </Field>
      <Field label={direction === "received" && !prefill ? "From" : "Payee"}>
        <select
          name="party_kind"
          className={selectClass}
          value={party}
          onChange={(e) => setParty(e.target.value as PartyKind)}
        >
          {PARTY_KINDS.map((k) => (
            <option key={k} value={k}>
              {PARTY_LABELS[k]}
            </option>
          ))}
        </select>
      </Field>
      {party === "supplier" ? (
        <Field label="Supplier">
          <Select
            name="party_ref"
            options={suppliers}
            placeholder="Choose"
            defaultValue={prefill?.supplier_id ?? ""}
          />
        </Field>
      ) : party === "payer" ? (
        <Field label="Payer">
          <Select name="party_ref" options={payers} placeholder="Choose" />
        </Field>
      ) : party === "patient" ? (
        <Field label="Unite PIN" hint="Never the patient's name.">
          <Input name="party_ref" maxLength={20} required />
        </Field>
      ) : null}
      {party !== "patient" && (
        <Field label="Name on the cheque">
          <Input name="party_name" maxLength={120} defaultValue={prefill?.payee ?? ""} />
        </Field>
      )}
      <Field
        label="Other side of the posting"
        hint="Usually supplier payables, a receivable or an expense."
      >
        <Select
          name="counter_account_id"
          options={ledgerOptions(ledgers)}
          placeholder="Choose"
          defaultValue={defaultPayable ?? ""}
          required
        />
      </Field>
      <Field label="Narration (optional)">
        <Input name="narration" maxLength={300} />
      </Field>
    </ActionForm>
  );
}

const STEP_LABEL: Record<ChequeAction, string> = {
  present: "Presented",
  clear: "Cleared",
  bounce: "Bounced",
  cancel: "Cancel",
  stale: "Stale",
};

export function ChequeStepButton({
  id,
  action,
  today,
  chargeAccounts,
}: {
  id: string;
  action: ChequeAction;
  today: string;
  chargeAccounts?: LedgerOpt[];
}) {
  return (
    <FormSheet
      trigger={STEP_LABEL[action]}
      title={`Cheque: ${STEP_LABEL[action].toLowerCase()}`}
      description={
        action === "bounce" || action === "cancel" || action === "stale"
          ? "A posted cheque is reversed on this date. A bounce also flags the party."
          : `Moves the cheque to ${CHEQUE_TRANSITIONS[action].to}.`
      }
      variant="ghost"
      size="sm"
    >
      {(close) => (
        <ChequeStepForm
          id={id}
          action={action}
          today={today}
          chargeAccounts={chargeAccounts}
          close={close}
        />
      )}
    </FormSheet>
  );
}

function ChequeStepForm({
  id,
  action,
  today,
  chargeAccounts,
  close,
}: {
  id: string;
  action: ChequeAction;
  today: string;
  chargeAccounts?: LedgerOpt[];
  close: () => void;
}) {
  const done = useDone(close);
  return (
    <ActionForm
      action={chequeStep}
      submitLabel="Save"
      variant={action === "bounce" || action === "cancel" ? "destructive" : "default"}
      onDone={done}
    >
      <input type="hidden" name="id" value={id} />
      <input type="hidden" name="action" value={action} />
      <Field label="Date">
        <Input type="date" name="date" defaultValue={today} required />
      </Field>
      {(action === "bounce" || action === "cancel") && (
        <Field label="Reason">
          <Input name="reason" maxLength={300} required />
        </Field>
      )}
      {action === "bounce" && (
        <>
          <Field label="Bank charge for the bounce (optional)">
            <Input name="charge_amount" inputMode="decimal" />
          </Field>
          {chargeAccounts && chargeAccounts.length > 0 && (
            <Field label="Charge account">
              <Select
                name="charge_account_id"
                options={ledgerOptions(chargeAccounts)}
                placeholder="Bank and card charges"
              />
            </Field>
          )}
        </>
      )}
    </ActionForm>
  );
}

export function ClearFlagButton({ id }: { id: string }) {
  return (
    <FormSheet trigger="Clear" title="Clear the flag" variant="ghost" size="sm">
      {(close) => <ClearFlagForm id={id} close={close} />}
    </FormSheet>
  );
}

function ClearFlagForm({ id, close }: { id: string; close: () => void }) {
  const done = useDone(close);
  return (
    <ActionForm action={clearPartyFlag} submitLabel="Clear flag" onDone={done}>
      <input type="hidden" name="id" value={id} />
      <Field label="Reason" hint="For example: paid in cash on 12 March.">
        <Input name="reason" maxLength={300} required />
      </Field>
    </ActionForm>
  );
}
