import type { AccountNature } from "@/lib/accounting/accounts";

/**
 * TallyPrime's 28 predefined groups (15 primary, 13 sub-groups), seeded as Pulse system groups by acc_seed_chart() under
 * the same names so imported Tally ledgers land under the same parent. Tally knows four natures (Assets, Liabilities,
 * Income, Expenses) and puts Capital Account under liabilities; Pulse keeps five and calls Capital Account and Reserves &
 * Surplus equity, and stores the Tally name in tally_group so the import maps either way. `grossProfit` is Tally's
 * "affects gross profit" flag. A database test keeps this list equal to the seeded rows.
 */
export type TallyGroup = {
  code: string;
  name: string;
  parent: string | null;
  nature: AccountNature;
  tallyNature: "Assets" | "Liabilities" | "Income" | "Expenses";
  grossProfit: boolean;
};

export const TALLY_GROUPS: readonly TallyGroup[] = [
  {
    code: "G-CAP",
    name: "Capital Account",
    parent: null,
    nature: "equity",
    tallyNature: "Liabilities",
    grossProfit: false,
  },
  {
    code: "G-CA",
    name: "Current Assets",
    parent: null,
    nature: "asset",
    tallyNature: "Assets",
    grossProfit: false,
  },
  {
    code: "G-CL",
    name: "Current Liabilities",
    parent: null,
    nature: "liability",
    tallyNature: "Liabilities",
    grossProfit: false,
  },
  {
    code: "G-DEXP",
    name: "Direct Expenses",
    parent: null,
    nature: "expense",
    tallyNature: "Expenses",
    grossProfit: true,
  },
  {
    code: "G-DINC",
    name: "Direct Incomes",
    parent: null,
    nature: "income",
    tallyNature: "Income",
    grossProfit: true,
  },
  {
    code: "G-FA",
    name: "Fixed Assets",
    parent: null,
    nature: "asset",
    tallyNature: "Assets",
    grossProfit: false,
  },
  {
    code: "G-IEXP",
    name: "Indirect Expenses",
    parent: null,
    nature: "expense",
    tallyNature: "Expenses",
    grossProfit: false,
  },
  {
    code: "G-IINC",
    name: "Indirect Incomes",
    parent: null,
    nature: "income",
    tallyNature: "Income",
    grossProfit: false,
  },
  {
    code: "G-INV",
    name: "Investments",
    parent: null,
    nature: "asset",
    tallyNature: "Assets",
    grossProfit: false,
  },
  {
    code: "G-LOAN",
    name: "Loans (Liability)",
    parent: null,
    nature: "liability",
    tallyNature: "Liabilities",
    grossProfit: false,
  },
  {
    code: "G-MISC",
    name: "Misc. Expenses (ASSET)",
    parent: null,
    nature: "asset",
    tallyNature: "Assets",
    grossProfit: false,
  },
  {
    code: "G-PUR",
    name: "Purchase Accounts",
    parent: null,
    nature: "expense",
    tallyNature: "Expenses",
    grossProfit: true,
  },
  {
    code: "G-SAL",
    name: "Sales Accounts",
    parent: null,
    nature: "income",
    tallyNature: "Income",
    grossProfit: true,
  },
  {
    code: "G-SUSP",
    name: "Suspense A/c",
    parent: null,
    nature: "liability",
    tallyNature: "Liabilities",
    grossProfit: false,
  },
  {
    code: "G-BR",
    name: "Branch / Divisions",
    parent: null,
    nature: "liability",
    tallyNature: "Liabilities",
    grossProfit: false,
  },
  {
    code: "G-BANK",
    name: "Bank Accounts",
    parent: "G-CA",
    nature: "asset",
    tallyNature: "Assets",
    grossProfit: false,
  },
  {
    code: "G-BOD",
    name: "Bank OD A/c",
    parent: "G-LOAN",
    nature: "liability",
    tallyNature: "Liabilities",
    grossProfit: false,
  },
  {
    code: "G-CASH",
    name: "Cash-in-Hand",
    parent: "G-CA",
    nature: "asset",
    tallyNature: "Assets",
    grossProfit: false,
  },
  {
    code: "G-DEP",
    name: "Deposits (Asset)",
    parent: "G-CA",
    nature: "asset",
    tallyNature: "Assets",
    grossProfit: false,
  },
  {
    code: "G-TAX",
    name: "Duties & Taxes",
    parent: "G-CL",
    nature: "liability",
    tallyNature: "Liabilities",
    grossProfit: false,
  },
  {
    code: "G-ADV",
    name: "Loans & Advances (Asset)",
    parent: "G-CA",
    nature: "asset",
    tallyNature: "Assets",
    grossProfit: false,
  },
  {
    code: "G-PROV",
    name: "Provisions",
    parent: "G-CL",
    nature: "liability",
    tallyNature: "Liabilities",
    grossProfit: false,
  },
  {
    code: "G-RES",
    name: "Reserves & Surplus",
    parent: "G-CAP",
    nature: "equity",
    tallyNature: "Liabilities",
    grossProfit: false,
  },
  {
    code: "G-SECL",
    name: "Secured Loans",
    parent: "G-LOAN",
    nature: "liability",
    tallyNature: "Liabilities",
    grossProfit: false,
  },
  {
    code: "G-STOCK",
    name: "Stock-in-Hand",
    parent: "G-CA",
    nature: "asset",
    tallyNature: "Assets",
    grossProfit: false,
  },
  {
    code: "G-CRED",
    name: "Sundry Creditors",
    parent: "G-CL",
    nature: "liability",
    tallyNature: "Liabilities",
    grossProfit: false,
  },
  {
    code: "G-DEBT",
    name: "Sundry Debtors",
    parent: "G-CA",
    nature: "asset",
    tallyNature: "Assets",
    grossProfit: false,
  },
  {
    code: "G-UNSL",
    name: "Unsecured Loans",
    parent: "G-LOAN",
    nature: "liability",
    tallyNature: "Liabilities",
    grossProfit: false,
  },
];

/** The Pulse nature for a Tally group name (an imported ledger's parent), or null when it is not a predefined group. */
export function natureForTallyGroup(name: string): AccountNature | null {
  const g = TALLY_GROUPS.find((x) => x.name.toLowerCase() === name.trim().toLowerCase());
  return g?.nature ?? null;
}
