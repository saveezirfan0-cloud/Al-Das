/**
 * Matching engine v2 (docs/46 section 3): the shared shapes. Pure types only; the rules live in match-v2.ts,
 * the key and text helpers in match-keys.ts and the automatic-matching gate in match-rule-gate.ts.
 *
 * Words: an ITEM is one insurer payment (key `ins|<ref key>`), a LINE is one bank credit, an ALLOCATION is part of a line
 * assigned to part of an item. One line can pay several items and one item can be paid by several lines.
 */

export type MatchRule = "reference" | "payer_sum" | "amount_date";
/** Only these two may ever match without a person; `amount_date` only proposes, whatever the settings say. */
export const AUTO_CAPABLE_RULES = ["reference", "payer_sum"] as const satisfies readonly MatchRule[];
export type AutoRule = (typeof AUTO_CAPABLE_RULES)[number];
export const RULE_LABELS: Record<MatchRule, string> = {
  reference: "Payment reference on the bank line",
  payer_sum: "Payer and amount (one payment or a set)",
  amount_date: "Amount and date only",
};

/** fin_ref_finance_settings.match_* and bank_* (loaded, never defaulted in code). */
export type MatchSettings = {
  toleranceAmount: number; // bank_amount_tolerance
  tolerancePct: number; // bank_amount_tolerance_pct (percent)
  windowDays: number; // bank_date_window_days: how far AFTER the bank line an item's date may fall
  refMinLength: number; // match_ref_min_length
  setMaxItems: number; // match_set_max_items
  itemLookBackDays: number; // match_item_look_back_days: how far BEFORE the bank line an item's date may fall
};

export type OpenItem = {
  ref: string; // `ins|<ref key>` or `ins|batch:<uuid>`
  label: string; // the payment reference as written, or a batch label; for display
  payerKey: string | null; // upper-case payer code
  refKeys: string[]; // normalised keys that identify it on a bank narrative (empty: cannot be matched by reference)
  date: string; // receipt date, else remittance date (yyyy-mm-dd)
  total: number;
  allocated: number; // sum of active accepted allocations
  open: number; // total - allocated (> 0 for items handed to the engine)
};

export type OpenLine = {
  id: string;
  valueDate: string;
  amount: number;
  allocated: number; // sum of active accepted allocations
  open: number; // amount - allocated (> 0 for lines handed to the engine)
  text: string; // reference + description, already redacted
};

export type ApprovedAlias = { id: string; payerKey: string; alias: string };

export type Allocation = {
  lineId: string;
  itemRef: string;
  amount: number; // taken from the line and given to the item
  itemTotal: number;
};

/** One way of applying a suggestion: a set of allocations decided together. */
export type SuggestionOption = {
  allocations: Allocation[];
  lineLeft: number; // line open amount after this option
  itemsLeft: number; // sum of the items' open amounts after this option
  score: number; // 0-100, for sorting and display
  reasons: string[];
  aliasId: string | null; // the approved alias that recognised the payer, if that is how it matched
};

export type Suggestion = {
  lineId: string;
  rule: MatchRule;
  options: SuggestionOption[]; // one option = unambiguous; several = a person chooses
  /** true only when: exactly one option, the rule is switched on for automatic matching, no other suggestion competes. */
  auto: boolean;
};

export type MatchInput = {
  lines: readonly OpenLine[]; // credits with something left to explain
  items: readonly OpenItem[]; // items with something left to receive
  aliases: readonly ApprovedAlias[]; // approved only
  rejected: ReadonlySet<string>; // `${itemRef}|${lineId}` pairs a person rejected (and not undone)
  autoRules: ReadonlySet<AutoRule>;
  settings: MatchSettings;
};

/** The history of one rule in one month, from fin_match_decisions (see match-rule-gate.ts). */
export type RuleMonth = { rule: MatchRule; month: string; right: number; wrong: number };
