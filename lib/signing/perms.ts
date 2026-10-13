/** Who may hold a personal signing certificate (pure; also read by the Settings menu): the people who verify or approve vouchers or sign the close. */
export const SIGNING_PERMS = [
  "finance.vouchers.check",
  "finance.vouchers.approve_dept",
  "finance.vouchers.approve_ceo",
  "finance.close.signoff.finance",
  "finance.close.signoff.ceo",
] as const;
