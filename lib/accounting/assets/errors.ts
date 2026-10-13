import { rpcErrorMessage } from "@/lib/accounting/errors";

/**
 * The HINT codes of the fixed-asset functions and guards (migration 20261109000500) as sentences. Anything else falls
 * back to the ledger's own sentences (lib/accounting/errors.ts), then to the caller's. Never the database message.
 */
export const ASSET_ERRORS: Record<string, string> = {
  class_accounts:
    "Choose an asset ledger for cost, another asset ledger for accumulated depreciation, an expense ledger for depreciation and an income or expense ledger for gains and losses.",
  asset_in_use:
    "Depreciation is already posted for this asset, so its cost, life, method and dates no longer change (and it cannot be deleted).",
  asset_disposed: "This asset is disposed of; nothing more is charged or changed.",
  asset_unknown: "An asset is unknown or belongs to another entity.",
  asset_not_in_service: "An asset is not in service in that month yet.",
  invoice_over_capitalised: "The assets linked to this bill would cost more than its net amount.",
  schedule_accounts:
    "A prepayment pairs an expense with an asset ledger, an accrual an expense with a liability, and deferred revenue an income with a liability.",
  schedule_in_use: "Releases are posted for this schedule. Cancel it and enter a new one instead.",
  schedule_unknown: "A schedule is unknown or does not belong in this run.",
  later_month_posted:
    "A later month is already posted, and it already caught up on this one. Run the latest month instead.",
  future_month: "A future month cannot be run yet.",
  over_depreciated: "An asset would be depreciated below its residual value.",
  same_person: "A different person from the one who prepared it must post it.",
  hash_mismatch: "It changed since you opened it. Reload and review it again.",
  wrong_status: "That is not possible in its current state. Reload the page.",
  disposal_date: "The disposal date is between the acquisition date and today.",
  disposal_stale:
    "Depreciation was posted since the disposal was prepared. Prepare the disposal again.",
  proceeds_account: "Choose the ledger the proceeds go to.",
  before_ledger_start:
    "The date is before the ledger start date. It waits until the start date allows it.",
};

export function assetErrorMessage(
  err: { code?: string; hint?: string | null } | null | undefined,
  fallback: string,
): string {
  if (err?.hint && ASSET_ERRORS[err.hint]) return ASSET_ERRORS[err.hint];
  return rpcErrorMessage(err, fallback);
}
