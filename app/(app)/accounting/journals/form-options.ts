import "server-only";

import { flattenTree } from "@/lib/accounting/accounts";
import type { JournalOptions } from "@/lib/accounting/accounting-server";
import { can, type MemberLike } from "@/lib/auth/can";

import type { JournalFormOptions } from "./journal-form";

/** What the journal form needs, from the loaded reference data (accounts labelled with their groups). */
export function toFormOptions(
  o: JournalOptions,
  member: MemberLike,
  today: string,
): JournalFormOptions {
  return {
    entities: o.entities
      .filter((e) => e.active)
      .map((e) => ({ id: e.id, name: e.name, is_default: e.is_default })),
    accounts: flattenTree(o.accounts).map((a) => ({
      id: a.id,
      code: a.code,
      name: a.name,
      group: a.path.length ? a.path.join(" / ") : "Top level",
      is_group: a.is_group,
      is_active: a.is_active,
      control: a.control,
      allow_manual: a.allow_manual,
    })),
    taxCodes: o.taxCodes.filter((t) => t.active),
    costCentres: o.costCentres.filter((c) => c.active),
    branches: o.branches,
    doctors: o.doctors,
    payers: o.payers,
    suppliers: o.suppliers,
    canOpening: can(member, "accounting.import"),
    canAdjustment: can(member, "accounting.periods.manage"),
    today,
  };
}
