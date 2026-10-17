"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";

import { recordAudit } from "@/lib/audit";
import { can } from "@/lib/auth/can";
import { requireMember } from "@/lib/auth/session";
import {
  DENIED,
  dbMessage,
  fail,
  firstIssue,
  todayIn,
  uuid,
  type ActionResult,
} from "@/lib/finance/action-support";
import { aliasInText, normalizeAlias, proposeAlias } from "@/lib/finance/match-keys";
import { CLOSE_REASON_CODES, ITEM_REF_PATTERN } from "@/lib/finance/match-close-reasons";
import { ruleHistory, ruleMayAuto } from "@/lib/finance/match-rule-gate";
import {
  acceptedRows,
  loadMatching,
  optionFingerprint,
  type MatchingView,
} from "@/lib/finance/match-v2-server";
import { AUTO_CAPABLE_RULES } from "@/lib/finance/match-v2-types";
import { redactText } from "@/lib/redact";
import { createAdminClient } from "@/lib/supabase/admin";

/**
 * Insurer payment matching (matching engine v2). Every action recomputes from the database: nothing a browser sends
 * (amounts, items, options) is trusted, only ids and a fingerprint of what the person was shown. Running, accepting,
 * rejecting, allocating and undoing need finance.matching.manage; approving a payer name, switching an automatic rule
 * on and writing an item off need finance.matching.approve (the Finance Manager). The database refuses over-allocation,
 * allocation to a closed item and any edit of a decision, whatever this code does. Audit rows hold ids, counts and rule
 * names only.
 */

const MANAGE = "finance.matching.manage";
const APPROVE = "finance.matching.approve";
const CHANGED = "This suggestion has changed. Reload the page and look again.";
const NO_ACCOUNT = "Set up the bank account that receives insurers' payments first (Bank reconciliation, Accounts).";

async function gate(perm: string) {
  const member = await requireMember();
  return can(member, perm) ? member : null;
}
type Member = NonNullable<Awaited<ReturnType<typeof gate>>>;

const refresh = () => revalidatePath("/finance/matching");
const fresh = (member: Member): Promise<MatchingView> =>
  loadMatching(createAdminClient(), member.orgId, todayIn(member.org.timezone));
const sumOf = (xs: readonly number[]) => Math.round(xs.reduce((t, x) => t + Math.round(x * 100), 0)) / 100;
const itemRef = z.string().regex(ITEM_REF_PATTERN, "Choose an item.");
const rule = z.enum(["reference", "payer_sum", "amount_date"]);
const DB_CHANGED = "The bank credit or the item changed in the meantime (already allocated, or closed). Reload and look again.";

function unexpected(what: string, err: unknown): ActionResult<never> {
  console.error(`[finance] matching ${what} failed`, { error: redactText(err, 100) });
  return fail("Something went wrong. Nothing was changed; try again.");
}

// ---------------------------------------------------------------------------
// Matching
// ---------------------------------------------------------------------------

/** Applies every suggestion the engine marks automatic (a switched-on rule, exactly one option, nothing competing). */
export async function runMatching(): Promise<ActionResult<{ applied: number; failed: number; proposals: number }>> {
  const member = await gate(MANAGE);
  if (!member) return fail(DENIED);
  try {
    const view = await fresh(member);
    if (!view.account) return fail(NO_ACCOUNT);
    const admin = createAdminClient(member.userId);
    let applied = 0;
    let failed = 0;
    let amount = 0;
    const byRule: Record<string, number> = {};
    for (const s of view.suggestions.filter((x) => x.auto && x.options.length === 1)) {
      const rows = acceptedRows(member.orgId, member.userId, s, s.options[0], true);
      const { error } = await admin.from("fin_match_decisions").insert(rows);
      if (error) {
        failed += 1;
        continue;
      }
      applied += 1;
      amount = sumOf([amount, ...rows.map((r) => r.amount)]);
      byRule[s.rule] = (byRule[s.rule] ?? 0) + 1;
    }
    const proposals = view.suggestions.filter((x) => !x.auto).length;
    await recordAudit(admin, {
      orgId: member.orgId,
      userId: member.userId,
      action: "finance.matching.run",
      entity: "fin_match_decisions",
      diff: { applied, failed, proposals, amount, byRule },
    });
    refresh();
    return {
      ok: true,
      data: { applied, failed, proposals },
      message:
        applied === 0
          ? `Nothing matched automatically. ${proposals} proposal(s) wait for a person.`
          : `${applied} matched automatically. ${proposals} proposal(s) wait for a person.`,
    };
  } catch (err) {
    return unexpected("run", err);
  }
}

const acceptSchema = z.object({
  lineId: uuid,
  rule,
  optionIndex: z.number().int().min(0).max(20),
  expect: z.string().max(2000), // fingerprint of what the person saw (optionFingerprint)
});

/** A person accepts one option of a proposal. The server finds it again on fresh data and applies exactly that. */
export async function acceptSuggestion(
  input: z.input<typeof acceptSchema>,
): Promise<ActionResult> {
  const member = await gate(MANAGE);
  if (!member) return fail(DENIED);
  const parsed = acceptSchema.safeParse(input);
  if (!parsed.success) return fail(firstIssue(parsed.error));
  const v = parsed.data;
  try {
    const view = await fresh(member);
    const suggestion = view.suggestions.find((s) => s.lineId === v.lineId && s.rule === v.rule);
    const option = suggestion?.options[v.optionIndex];
    if (!suggestion || !option || optionFingerprint(option) !== v.expect) return fail(CHANGED);
    const admin = createAdminClient(member.userId);
    const rows = acceptedRows(member.orgId, member.userId, suggestion, option, false);
    const { error } = await admin.from("fin_match_decisions").insert(rows);
    if (error) return fail(error.code === "23514" || error.code === "23505" ? DB_CHANGED : dbMessage(error, DB_CHANGED));

    // learning under control: the narrative's words are PROPOSED as a name for the payer; a Finance Manager approves them
    let proposed = false;
    const line = view.lines.find((l) => l.id === v.lineId);
    const payers = new Set(
      option.allocations
        .map((a) => view.items.find((i) => i.ref === a.itemRef)?.payerKey)
        .filter((p): p is string => !!p),
    );
    if (line && payers.size === 1 && !option.aliasId) {
      const payer = [...payers][0];
      const covered = view.aliases.some(
        (a) => a.payerKey === payer && a.status !== "retired" && aliasInText(line.text, a.alias),
      );
      const candidate = covered ? null : proposeAlias(line.text, view.settings.refMinLength);
      const alias = candidate ? normalizeAlias(candidate) : null;
      if (alias) {
        const { error: aliasError } = await admin
          .from("fin_payer_aliases")
          .upsert(
            { org_id: member.orgId, payer_key: payer, alias, status: "proposed", proposed_by: member.userId },
            { onConflict: "org_id,payer_key,alias", ignoreDuplicates: true },
          );
        proposed = !aliasError;
      }
    }
    await recordAudit(admin, {
      orgId: member.orgId,
      userId: member.userId,
      action: "finance.matching.accepted",
      entity: "fin_match_decisions",
      entityId: v.lineId,
      diff: {
        rule: suggestion.rule,
        option: v.optionIndex,
        options: suggestion.options.length,
        items: rows.length,
        amount: sumOf(rows.map((r) => r.amount)),
        aliasProposed: proposed,
      },
    });
    refresh();
    return {
      ok: true,
      message: proposed
        ? "Matched. The words on the bank line were proposed as a name for the payer; a Finance Manager can approve them."
        : "Matched.",
    };
  } catch (err) {
    return unexpected("accept", err);
  }
}

const rejectSchema = z.object({ lineId: uuid, itemRefs: z.array(itemRef).min(1).max(40) });

/** A person says these items do not belong to this bank line; the pair is never proposed again (until undone). */
export async function rejectSuggestion(input: z.input<typeof rejectSchema>): Promise<ActionResult> {
  const member = await gate(MANAGE);
  if (!member) return fail(DENIED);
  const parsed = rejectSchema.safeParse(input);
  if (!parsed.success) return fail(firstIssue(parsed.error));
  const v = parsed.data;
  try {
    const view = await fresh(member);
    const suggestion = view.suggestions.find((s) => s.lineId === v.lineId);
    if (!suggestion) return fail(CHANGED);
    const offered = new Set(suggestion.options.flatMap((o) => o.allocations.map((a) => a.itemRef)));
    const refs = [...new Set(v.itemRefs)];
    if (refs.some((r) => !offered.has(r))) return fail(CHANGED);
    const already = new Set(view.rejections.map((r) => `${r.itemRef}|${r.lineId}`));
    const rows = refs
      .filter((r) => !already.has(`${r}|${v.lineId}`))
      .sort()
      .map((r) => ({
        org_id: member.orgId,
        bank_line_id: v.lineId,
        item_ref: r,
        item_total: view.items.find((i) => i.ref === r)!.total,
        amount: 0,
        rule: suggestion.rule,
        score: 0,
        reasons: [] as string[],
        decision: "rejected",
        auto: false,
        decided_by: member.userId,
      }));
    const admin = createAdminClient(member.userId);
    if (rows.length > 0) {
      const { error } = await admin.from("fin_match_decisions").insert(rows);
      if (error && error.code !== "23505") return fail(dbMessage(error, "That could not be saved."));
    }
    await recordAudit(admin, {
      orgId: member.orgId,
      userId: member.userId,
      action: "finance.matching.rejected",
      entity: "fin_match_decisions",
      entityId: v.lineId,
      diff: { rule: suggestion.rule, items: rows.length },
    });
    refresh();
    return { ok: true, message: "Rejected. This pair will not be proposed again." };
  } catch (err) {
    return unexpected("reject", err);
  }
}

const manualSchema = z.object({
  lineId: uuid,
  itemRef,
  amount: z
    .number()
    .positive("Enter an amount above zero.")
    .max(1e11)
    .refine((n) => Math.abs(n * 100 - Math.round(n * 100)) < 1e-6, "Use at most two decimals."),
});

/** Records by hand that part of a bank credit paid part of an insurer payment. */
export async function allocateManually(input: z.input<typeof manualSchema>): Promise<ActionResult> {
  const member = await gate(MANAGE);
  if (!member) return fail(DENIED);
  const parsed = manualSchema.safeParse(input);
  if (!parsed.success) return fail(firstIssue(parsed.error));
  const v = parsed.data;
  try {
    const view = await fresh(member);
    const line = view.lines.find((l) => l.id === v.lineId);
    const item = view.openItems.find((i) => i.ref === v.itemRef);
    if (!line) return fail("That bank credit has nothing left to explain.");
    if (!item) return fail("That payment is not open (it may be paid, closed or matched in the monthly run).");
    const cents = Math.round(v.amount * 100);
    if (cents > Math.round(line.open * 100)) return fail(`The bank credit has only ${line.open.toFixed(2)} left.`);
    if (cents > Math.round(item.open * 100)) return fail(`The payment has only ${item.open.toFixed(2)} left to receive.`);
    const admin = createAdminClient(member.userId);
    const { error } = await admin.from("fin_match_decisions").insert({
      org_id: member.orgId,
      bank_line_id: v.lineId,
      item_ref: v.itemRef,
      item_total: item.total,
      amount: cents / 100,
      rule: "manual",
      score: 0,
      reasons: ["Allocated by hand"],
      decision: "accepted",
      auto: false,
      decided_by: member.userId,
    });
    if (error?.code === "23505")
      return fail("This credit is already allocated to that payment. Undo that allocation first, then allocate the new amount.");
    if (error) return fail(dbMessage(error, DB_CHANGED));
    await recordAudit(admin, {
      orgId: member.orgId,
      userId: member.userId,
      action: "finance.matching.allocated",
      entity: "fin_match_decisions",
      entityId: v.lineId,
      diff: { rule: "manual", amount: cents / 100 },
    });
    refresh();
    return { ok: true, message: "Allocated." };
  } catch (err) {
    return unexpected("allocate", err);
  }
}

/** Takes back a decision (an allocation or a rejection). Nothing is deleted: the row is marked undone and stays in the history. */
export async function undoDecision(input: { id: string }): Promise<ActionResult> {
  const member = await gate(MANAGE);
  if (!member) return fail(DENIED);
  const id = uuid.safeParse(input?.id);
  if (!id.success) return fail("Choose a decision.");
  try {
    const admin = createAdminClient(member.userId);
    const { data: row } = await admin
      .from("fin_match_decisions")
      .select("id, item_ref, decision, rule, auto, undone_at")
      .eq("org_id", member.orgId)
      .eq("id", id.data)
      .maybeSingle();
    if (!row || row.undone_at) return fail("That decision is already undone.");
    if (row.decision === "accepted") {
      // a write-off was sized on the allocations at the time; taking one back would leave the write-off wrong
      const { data: closure } = await admin
        .from("fin_item_closures")
        .select("id")
        .eq("org_id", member.orgId)
        .eq("item_ref", row.item_ref)
        .is("undone_at", null)
        .maybeSingle();
      if (closure) return fail("This payment is closed. Reopen it first, then undo the allocation.");
    }
    const { data, error } = await admin
      .from("fin_match_decisions")
      .update({ undone_at: new Date().toISOString(), undone_by: member.userId })
      .eq("org_id", member.orgId)
      .eq("id", id.data)
      .is("undone_at", null)
      .select("id");
    if (error) return fail(dbMessage(error, "That could not be undone."));
    if (!data || data.length === 0) return fail("That decision is already undone.");
    await recordAudit(admin, {
      orgId: member.orgId,
      userId: member.userId,
      action: "finance.matching.undone",
      entity: "fin_match_decisions",
      entityId: id.data,
      diff: { decision: row.decision, rule: row.rule, auto: row.auto },
    });
    refresh();
    return { ok: true, message: "Undone." };
  } catch (err) {
    return unexpected("undo", err);
  }
}

// ---------------------------------------------------------------------------
// Payer names
// ---------------------------------------------------------------------------

const decideAliasSchema = z.object({ id: uuid, decision: z.enum(["approve", "retire"]) });

/** The Finance Manager approves a proposed payer name (it is then used by the rules) or retires one. */
export async function decideAlias(input: z.input<typeof decideAliasSchema>): Promise<ActionResult> {
  const member = await gate(APPROVE);
  if (!member) return fail(DENIED);
  const parsed = decideAliasSchema.safeParse(input);
  if (!parsed.success) return fail(firstIssue(parsed.error));
  const v = parsed.data;
  try {
    const admin = createAdminClient(member.userId);
    const { data, error } = await admin
      .from("fin_payer_aliases")
      .update({
        status: v.decision === "approve" ? "approved" : "retired",
        decided_by: member.userId,
        decided_at: new Date().toISOString(),
      })
      .eq("org_id", member.orgId)
      .eq("id", v.id)
      .in("status", v.decision === "approve" ? ["proposed"] : ["proposed", "approved"])
      .select("id");
    if (error) return fail(dbMessage(error, "That could not be saved."));
    if (!data || data.length === 0) return fail("That name was already decided. Reload the page.");
    await recordAudit(admin, {
      orgId: member.orgId,
      userId: member.userId,
      action: v.decision === "approve" ? "finance.matching.alias_approved" : "finance.matching.alias_retired",
      entity: "fin_payer_aliases",
      entityId: v.id,
    });
    refresh();
    return { ok: true, message: v.decision === "approve" ? "Approved. The rules use this name now." : "Retired." };
  } catch (err) {
    return unexpected("alias", err);
  }
}

const proposeSchema = z.object({
  payerKey: z.string().trim().min(1, "Enter the payer.").max(60),
  alias: z.string().trim().min(1, "Enter the words.").max(120),
});

/** A person proposes the words that identify a payer on the bank statement (a Finance Manager approves them). */
export async function proposeAliasManually(input: z.input<typeof proposeSchema>): Promise<ActionResult> {
  const member = await gate(MANAGE);
  if (!member) return fail(DENIED);
  const parsed = proposeSchema.safeParse(input);
  if (!parsed.success) return fail(firstIssue(parsed.error));
  const alias = normalizeAlias(parsed.data.alias);
  if (!alias) return fail("Use 3 to 60 letters or digits, for example the payer's name as the bank writes it.");
  const payerKey = parsed.data.payerKey.toUpperCase();
  try {
    const admin = createAdminClient(member.userId);
    const { data, error } = await admin
      .from("fin_payer_aliases")
      .upsert(
        { org_id: member.orgId, payer_key: payerKey, alias, status: "proposed", proposed_by: member.userId },
        { onConflict: "org_id,payer_key,alias", ignoreDuplicates: true },
      )
      .select("id");
    if (error) return fail(dbMessage(error, "That could not be saved."));
    if (!data || data.length === 0) return fail("That name is already in the list for this payer.");
    await recordAudit(admin, {
      orgId: member.orgId,
      userId: member.userId,
      action: "finance.matching.alias_proposed",
      entity: "fin_payer_aliases",
      entityId: data[0].id,
    });
    refresh();
    return { ok: true, message: "Proposed. A Finance Manager approves it before it is used." };
  } catch (err) {
    return unexpected("alias propose", err);
  }
}

// ---------------------------------------------------------------------------
// Automatic rules
// ---------------------------------------------------------------------------

const ruleSchema = z.object({ rule: z.enum(AUTO_CAPABLE_RULES), enabled: z.boolean() });

/** Switches a rule's automatic matching on (only when its own record qualifies, checked here on fresh data) or off. */
export async function setRuleAuto(input: z.input<typeof ruleSchema>): Promise<ActionResult> {
  const member = await gate(APPROVE);
  if (!member) return fail(DENIED);
  const parsed = ruleSchema.safeParse(input);
  if (!parsed.success) return fail(firstIssue(parsed.error));
  const v = parsed.data;
  try {
    const admin = createAdminClient(member.userId);
    if (v.enabled) {
      const view = await fresh(member);
      const verdict = ruleMayAuto(ruleHistory(view.decisionRows), v.rule, view.settings);
      if (!verdict.ok) return fail(`This rule cannot match automatically yet. ${verdict.reason}`);
    }
    const { error } = await admin.from("fin_match_rule_status").upsert(
      {
        org_id: member.orgId,
        rule: v.rule,
        auto_enabled: v.enabled,
        set_by: member.userId,
        set_at: new Date().toISOString(),
      },
      { onConflict: "org_id,rule" },
    );
    if (error) return fail(dbMessage(error, "That could not be saved."));
    await recordAudit(admin, {
      orgId: member.orgId,
      userId: member.userId,
      action: "finance.matching.rule_set",
      entity: "fin_match_rule_status",
      diff: { rule: v.rule, enabled: v.enabled },
    });
    refresh();
    return { ok: true, message: v.enabled ? "Automatic matching is on for this rule." : "Automatic matching is off for this rule." };
  } catch (err) {
    return unexpected("rule", err);
  }
}

// ---------------------------------------------------------------------------
// Closing an item
// ---------------------------------------------------------------------------

const closeSchema = z
  .object({
    itemRef,
    kind: z.enum(["write_off", "cancelled"]),
    reasonCode: z.enum(CLOSE_REASON_CODES),
    note: z.string().trim().max(200, "Keep the note under 200 characters.").optional(),
  })
  .refine((v) => v.reasonCode !== "other" || (v.note ?? "").length > 0, {
    message: "Explain the reason in the note.",
    path: ["note"],
  });

/** Closes a payment that will not be paid in full: written off (exactly the remainder) or cancelled (nothing allocated). */
export async function closeItem(input: z.input<typeof closeSchema>): Promise<ActionResult> {
  const member = await gate(APPROVE);
  if (!member) return fail(DENIED);
  const parsed = closeSchema.safeParse(input);
  if (!parsed.success) return fail(firstIssue(parsed.error));
  const v = parsed.data;
  try {
    const view = await fresh(member);
    const item = view.openItems.find((i) => i.ref === v.itemRef);
    if (!item) return fail("That payment is not open (it may be paid, closed or matched in the monthly run).");
    if (v.kind === "cancelled" && item.allocated > 0)
      return fail("Money is already allocated to this payment. Undo the allocations first, or write off the rest.");
    const admin = createAdminClient(member.userId);
    const { error } = await admin.from("fin_item_closures").insert({
      org_id: member.orgId,
      item_ref: v.itemRef,
      item_total: item.total,
      kind: v.kind,
      amount: v.kind === "write_off" ? item.open : 0,
      reason_code: v.reasonCode,
      note: v.note ? v.note : null,
      decided_by: member.userId,
    });
    if (error) return fail(dbMessage(error, "The payment changed in the meantime. Reload and try again."));
    await recordAudit(admin, {
      orgId: member.orgId,
      userId: member.userId,
      action: "finance.matching.item_closed",
      entity: "fin_item_closures",
      diff: { kind: v.kind, reason: v.reasonCode, amount: v.kind === "write_off" ? item.open : 0 },
    });
    refresh();
    return { ok: true, message: v.kind === "write_off" ? "Written off." : "Cancelled." };
  } catch (err) {
    return unexpected("close", err);
  }
}

/** Reopens a closed payment (the closure stays in the history, marked reopened). */
export async function reopenItem(input: { id: string }): Promise<ActionResult> {
  const member = await gate(APPROVE);
  if (!member) return fail(DENIED);
  const id = uuid.safeParse(input?.id);
  if (!id.success) return fail("Choose a closed payment.");
  try {
    const admin = createAdminClient(member.userId);
    const { data, error } = await admin
      .from("fin_item_closures")
      .update({ undone_at: new Date().toISOString(), undone_by: member.userId })
      .eq("org_id", member.orgId)
      .eq("id", id.data)
      .is("undone_at", null)
      .select("id, kind");
    if (error) return fail(dbMessage(error, "That could not be reopened."));
    if (!data || data.length === 0) return fail("That payment is already open.");
    await recordAudit(admin, {
      orgId: member.orgId,
      userId: member.userId,
      action: "finance.matching.item_reopened",
      entity: "fin_item_closures",
      entityId: id.data,
      diff: { kind: data[0].kind },
    });
    refresh();
    return { ok: true, message: "Reopened." };
  } catch (err) {
    return unexpected("reopen", err);
  }
}
