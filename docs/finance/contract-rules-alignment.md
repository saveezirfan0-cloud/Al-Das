# Contract Generator terms and Pulse doctor pay: alignment (M2)

Date: 14 Oct 2026. Status: **analysis only, nothing implemented.** This note feeds docs/40 §2 (L3 doctor contribution =
revenue − doctor pay − variable cost − doctor fixed cost) and phase M2 ("contract terms for every doctor").

Sources:
- The Contract Generator IT handover (14 Oct 2026, 14 pages, cited as "CG §n"). The handover itself is not kept in the
  repository.
- `lib/finance/revshare.ts`, `lib/finance/revshare-server.ts` and `supabase/migrations/20261101000100_finance_revenue_share.sql`
  (20F).
- `lib/finance/profitability.ts`, `lib/finance/profit-server.ts` and `fin_cost_doctor_comp` in
  `supabase/migrations/20261021000100_finance_blueprint.sql` (F8).
- `docs/finance/cost-csv.md`.
- `docs/39_UNITE_REPORTS_PLAN.md` (23A categories).

Every AED figure below is an **illustration**: the handover's examples or synthetic numbers. None of them is a real
person's pay.

## 1. What the generator records

The generator is a contract-drafting tool. CG §1 says that Finance owns monthly collections, attribution, direct costs,
provisions, category proportions and settlement. Its own monthly calculator was cancelled. Percentages are stored as
`20`, not `0.20` (CG §3.1).

| Contract (CG §2) | Internal id | Pay formula (CG §3) | Fields (CG §4) |
|---|---|---|---|
| Fixed Salary, ordinary | `fixed-salary` | S = basic + housing + transport + telephone + other allowance; pay = S (§3.2) | five salary components (server recomputes S) |
| Fixed Salary, **GP profile** (automatic when resolved) | `fixed-salary` | S + incentive. T = round(S × m), m default 3 (range 0.1–20); E = max(0, R − T), allocated by category mix R_c/R; consultations 10 %, procedures 10 % after direct costs, laboratory 20 % after outsourced lab costs (§3.7) | `gpIncentiveThresholdMultiplier`, `gpConsultationPercent`, `gpProcedurePercent`, `gpLaboratoryPercent` |
| Fixed Salary, **Gynaecology profile** (only if `incentiveEnabled`) | `fixed-salary` | S + incentive above T (default AED 165,000), allocated by mix: retail 10 %, investigations 20 % (tests + radiology unless split), consultations/procedures 50 %; inpatient surgery 75 % after-hours / 50 % scheduled, **outside** the threshold pool (§3.6) | `incentiveEnabled`, `incentiveThresholdAed`, category and surgery fields |
| Revenue Sharing Employment, salary-backed | `revenue-sharing` | pay = **max(S, V)**, V = Σ N_c × p_c. Salary and share are alternatives, never S + V. The illustration is S 28,000 and V 30,000, so pay = 30,000, not 58,000 (§3.3) | `revenueSharePercent`, `revenueInvestigationsPercent`, `revenueRetailPercent`, `revenueInsuranceProvisionPercent`, `revenuePatientFacilitationPolicy` |
| Revenue Sharing Employment, share only | `revenue-sharing` + `revenueShareOnly` | fixed package = 0; pay = V. Statutory rights (WPS, leave, insurance) remain; no threshold (§3.4) | as above, salary components all 0 |
| Independent Practitioner Revenue Sharing | `revenue-sharing-practitioner` | Σ N_c × p_c. The primary % is negotiated (50 % is only an example). Investigations (lab, radiology, diagnostics) default to 20 % when missing, and an explicit 0 is kept. Retail is optional and starts at 10 %. Facilitation is a policy reference (§3.5) | as above; `minimumGuaranteeAed` = clinic revenue **target** |
| Offer Letter | `offer-letter` | proposed terms only; never the GP or Gynae schedules (§3.9) | proposed salary and share fields |
| Aesthetics Practitioner Agreement | `aesthetics-practitioner` | practitioner % × Net Collected Revenue. Clinic % = 100 − practitioner %. The form starts at 60 %. Optional clinic commitment (AED) is payable **to** the clinic; its shortfall is not calculated (§3.8) | `practitionerRevenueSharePercent`, `practitionerClinicCommitmentAed` |
| Dental Practitioner Agreement | `dental-practitioner` | as Aesthetics; NCR is net of materials, implants, components and external lab (§3.8) | as Aesthetics |

The handover lists six types: the Offer Letter plus five agreements. GP and Gynaecology are profiles inside
`fixed-salary`.

Boundaries:
- **Revenue basis (§3.1):** attributable **collected** revenue, net of VAT, refunds, chargebacks, approved direct costs
  and insurance-rejection provisioning. A cost already netted is never deducted again. Provisioning applies to insurance
  revenue only.
- **Threshold basis (§3.6):** gross versus net is **unresolved**. Finance and HR/legal must confirm it.
- **Rules for any calculator (§8):** never deduct costs twice; never turn a clinic target into guaranteed pay; keep
  contractual configuration in the generator and monthly calculations with Finance.
- **Audit data (§5):** each audit record keeps the type, practitioner details, branch, a normalised `formData` JSON
  snapshot, dates and signature status. The History CSV/ZIP export covers the **latest 100 records** only.
- **Summary columns (§6):** salary and the primary % are integers; the detail lives in `formData`.

## 2. What Pulse has today

**Revenue share (20F).** Payout per doctor and month:

```
payout = max(minimum_guarantee or 0, Σ_c rate_c × net_c × f − Σ_k deduction_k × charges_k, 0)
f      = (base − threshold) / base   when a threshold is set; 0 when base ≤ threshold; otherwise 1
```

- **Rule keys** (closed list, same check in `app.fin_revshare_rule_valid`): `basis` (only `net_revenue`),
  `default_rate`, `category_rates`, `deductions` (`lab`, `referral`, `consumables`, `other`), `threshold` and
  `minimum_guarantee`.
- **Revenue input** (`fin_revshare_inputs`): invoice-line net (after discount, before VAT) by `transaction_date`.
  Lines are grouped by `fin_ref_services.service_category` (`Unmapped` when blank), and the doctor follows
  `doctor_basis`.
- **Not deducted:** refunds, credit notes, write-offs and payments.
- **Rates:** stored as fractions; the form converts `20` to `0.20` (`percentToRate`).
- **Controls:** schemes and runs are maker / checker / approver, bound to a sha256.

**Costs (F8).**
- `fin_cost_doctor_comp` holds ONE amount per doctor and month. It has no component, so salary, variable pay and
  statutory cost are indistinguishable.
- `computeProfitability` subtracts it.
- Profitability does **not** read revenue-share runs, and nothing links the two tables.

## 3. Verdict per contract type

The rule fields are the 20F keys. "p/100" means the generator's stored percentage divided by 100.

**Fixed Salary, ordinary: expressible.**

| Contract | Pulse today | Gap |
|---|---|---|
| pay = S | `fin_cost_doctor_comp.amount` = S; no scheme | statutory costs have no own place (comp is one number) |

**Fixed Salary, GP profile: partly.**

| Contract | Pulse today | Gap |
|---|---|---|
| S | comp row | — |
| T = round(S × m) | `threshold` = T, typed by Finance | must be re-versioned whenever S changes (no link to S) |
| E × mix_c × p_c | `category_rates` {consultations, procedures, laboratory: p/100}, `default_rate` 0 | **equal only without costs** (§4.2); unrated categories still enlarge the base |
| "after direct costs" / "after outsourced lab" | `deductions` {consumables, lab} | deducted in full at a rate, not scaled by f or floored per category (§4.2) |

**Fixed Salary, Gynaecology profile: not expressible** for a doctor with inpatient surgery; partly otherwise.

| Contract | Pulse today | Gap |
|---|---|---|
| S + incentive above T | comp = S; `threshold` = `incentiveThresholdAed` | as GP |
| retail 10 / investigations 20 / consultations-procedures 50 | `category_rates` | needs the category map (§5) |
| inpatient surgery 75 / 50 outside the pool | none | `threshold` applies to every category, and surgery would enlarge the base |
| insurance provision (0 = Finance rate here) | none | no provision key |

**Revenue Sharing, salary-backed: partly.**

| Contract | Pulse today | Gap |
|---|---|---|
| max(S, V) | `minimum_guarantee` = S | none for the max itself; comp must then hold no salary row (H3) |
| V = Σ N_c × p_c | `default_rate` = `revenueSharePercent`/100; `category_rates` investigations/retail; an absent rate falls back to the default | invoiced basis, not collected (H6) |
| net of approved costs | `deductions` at the rate of the category the cost belongs to | one rate per charge kind, not per category; no per-category floor |
| insurance provision; facilitation policy | none | no provision key; no positive policy adjustment |

**Revenue Sharing, share only, and Independent Practitioner: partly.**

| Contract | Pulse today | Gap |
|---|---|---|
| V = Σ N_c × p_c (investigations default 20, an explicit 0 kept) | as above, with no `minimum_guarantee`; an explicit 0 must be typed as a category rate of 0 | collected basis; provision; facilitation |
| `minimumGuaranteeAed` (target) | **nothing** | must never be entered anywhere in a scheme (H1) |

**Offer Letter: not applicable.** It is proposed terms and never a pay basis; the signed contract supersedes it.

**Aesthetics and Dental: partly.**

| Contract | Pulse today | Gap |
|---|---|---|
| p × NCR, clinic = 100 − p | `default_rate` = p/100; `deductions` {consumables, lab, other} = p/100. This gives p × (R − C), floored at 0 overall | collected basis (H6) |
| clinic commitment (payable to the clinic) | none | comparison base and deduction order are undefined (CG §3.8); do not invent them |
| equipment, workshop and staffing schedules | none | schedule text, not formulas |

## 4. Hazards

### 4.1 Hazard list

| # | Hazard | Rule |
|---|---|---|
| H1 | `minimumGuaranteeAed` is a **legacy name** for the clinic net revenue **target** (CG §4). Mapping it to revshare `minimum_guarantee` would turn a target into guaranteed pay (CG §8). | Never map it. If Pulse ever needs it, it is a doctor revenue target, outside schemes. |
| H2 | `DEFAULT_RULE` deducts lab and referral at **100 %** (`revshare.ts`). The contracts reduce the category base, so the doctor bears the cost at the category rate (20 % lab, for example). | Every scheme sets deductions explicitly. Example D in §4.2 shows the default zeroing an incentive. |
| H3 | Salary-backed pay is max(S, V), not S + V (CG §3.3). With `minimum_guarantee` = S the run payout already contains S. | The comp table must not also carry S for that doctor, or L3 counts S twice. |
| H4 | The GP and Gynae incentive is **on top of** S, above a threshold. Putting S in `minimum_guarantee` there would wrongly produce max(S, incentive). | GP/Gynae: S goes in comp only; the scheme has no guarantee. |
| H5 | The revshare threshold applies to **all** of a doctor's categories (base = total net). That includes Gynae inpatient surgery (to be excluded, CG §3.6) and categories with no incentive rate (GP retail and radiology). | Not expressible today; proposal P1. |
| H6 | Pulse pays on **invoiced** net by invoice date; contracts pay on **collected** net (CG §3.1, §3.8 NCR). | `fin_payments` is per invoice, not per line or category. Insurance cash arrives months later through remittance. Credit notes, write-offs and refunds are not netted in `fin_revshare_inputs`. Blocked on OQ-148. |
| H7 | Insurance provision has no place in Pulse pay. L2 (expected denials) is a clinic measure, not the doctor's basis. | Provision applies to insurance revenue only, never cash or retail (CG §3.1). Needs a payer split of inputs (P4). |
| H8 | Costs counted twice: `fin_cost_services` unit cost feeds L3 direct cost, and the same lab or consumable cost entered as a `fin_doctor_charges` row also reduces pay. L3 must subtract the clinic's cost once. Pay reduction is a separate effect. | The same cost is never also netted in N_c (CG §3.1). OQ-150 fixes which source holds each cost. |
| H9 | Zero semantics. A generator category with no rate means "no separate clause"; a Pulse category with no rate falls back to the default rate. Gynae provision 0 means "Finance rate"; the general provision field's 0 means 0 (CG §3.6, §4). | Enter every agreed rate explicitly, including 0. |
| H10 | Percent scale: the generator stores 20, Pulse stores 0.20. | A raw copy of 20 fails closed (rate > 1 is refused). Never copy summary integer columns (CG §6). |
| H11 | Rounding: the generator helper uses JavaScript two-decimal rounding and `Math.round` for T; Pulse rounds half away from zero on integers. | Equal for positive amounts in practice. Finance approves one policy (CG §6). |
| H12 | Mid-month start or end, salary changes and amendments. Schemes start on the first of a month. | Proration of S and T is undefined (OQ-156). |

### 4.2 Worked example: threshold allocation (synthetic GP, CG §3.7 illustration S = 20,000, m = 3, so T = 60,000)

The month's revenue is consultations 50,000, procedures 30,000 and laboratory 20,000, so R = 100,000. Rates are 10 %,
10 % and 20 %.

**No costs.** The contract gives E = 40,000. Each category earns E × (R_c / R) × p_c:

| Category | Contract | Revshare (threshold 60,000) |
|---|---|---|
| Consultations | 40,000 × 0.5 × 0.10 = 2,000 | f = 0.4; 50,000 × 0.10 × 0.4 = 2,000 |
| Procedures | 40,000 × 0.3 × 0.10 = 1,200 | 30,000 × 0.10 × 0.4 = 1,200 |
| Laboratory | 40,000 × 0.2 × 0.20 = 1,600 | 20,000 × 0.20 × 0.4 = 1,600 |
| Total | **4,800** | **4,800** |

The two are identical because (R − T) × (R_c / R) × p_c = ((R − T) / R) × R_c × p_c = f × R_c × p_c. The CG §3.6
Gynae illustration also matches: 0.175 × each category gives 17,500 / 8,750 / 4,375 / 4,375. **This holds only if R is
the same set of categories as Pulse's base** (H5).

**With costs** (consumables 6,000 on procedures, outsourced lab 8,000):

| Reading | Calculation | Incentive |
|---|---|---|
| A. Generator helper (CG §6: gross excess ratio, costs allocated pro rata, per-category zero floor) | 0.10 × 20,000 + 0.10 × 0.4 × 24,000 + 0.20 × 0.4 × 12,000 | 3,920.00 |
| B. Threshold on revenue net of costs (the other CG §3.6 reading) | R′ = 86,000, f′ = 26,000/86,000; f′ × (5,000 + 2,400 + 2,400) | 2,962.79 |
| C. Revshare today, deductions consumables 10 %, lab 20 % | 4,800 − (600 + 1,600) | 2,600.00 |
| D. Revshare with `DEFAULT_RULE` deductions (lab 100 %) | 4,800 − 8,000, floored | 0.00 |

The same contract gives four answers. Pulse cannot reproduce A or B until P2 exists **and** OQ-149 and OQ-150 are
answered.

## 5. Category map: Unite item type (23A `CAT:<category>`) to contract category

Finance maps every item in `fin_ref_services.service_category` (`/finance/settings`). Rates apply to those names.

| Unite | Contract category (proposed) | Ambiguity |
|---|---|---|
| SERVICE | consultations / medical services | Does it include nursing, dressings and certificates? |
| PROCEDURES | procedures | Gynae inpatient surgery and after-hours vs scheduled are not distinguishable by item type (OQ-153) |
| TEST | investigations (lab) | GP "laboratory" vs Gynae "investigations"; in-house vs outsourced |
| RADIOLOGY | investigations (radiology) | Billed under the referring doctor (docs/39 §1.2). GP has no radiology rate but radiology may enlarge the GP base (H5) |
| DRUGS | none stated | Revenue category, retail, or a direct cost of procedures (CG §3.1 lists medicines as a cost) |
| RETAIL PRODUCT | retail | — |
| VACCINE | none stated | procedure, medical service or retail? |
| PACKAGES / Package | none (two spellings) | A package mixes categories; split it by item, or one rate per package? |
| DENTAL PROCEDURES | dental NCR | — |
| INTRAVENOUS THERAPY | none stated | procedure or aesthetics; the drugs inside are a cost |
| HOME HEALTHCARE | none stated | Which doctor? A nursing service? |
| OTHER SERVICES | none stated | — |
| NO | unmapped | Fail closed: stays `Unmapped`; no rate applies until mapped |

## 6. Recommended minimal integration for M2

1. **Terms enter Pulse as revenue-share schemes, typed by Finance from a one-page terms sheet that HR issues per signed
   contract or amendment.** Reasons:
   - The existing 20F path is already maker (Finance), checker (Finance Manager) and approver (CEO). It is bound to a
     sha256, versioned by `effective_from`, and enforced in SQL.
   - There are a few dozen doctors, and terms change rarely.
   - The History CSV/ZIP is the wrong source: it holds personal details, covers the latest 100 records, mixes in offers
     and unsigned drafts, and carries `minimumGuaranteeAed` and ×100 percentages.
   - The scheme `note` records `CG <record id> · <contract type> · formData sha256 <12 chars>`.
   - Revisit with a fixed-field terms CSV (dry run, unknown columns refused) only if amendments become frequent.
2. **Fields Pulse needs** (and nothing else):
   - generator record id, contract type, `doctor_dha_id`, signed on, effective from / to
   - S (total only)
   - `revenueShareOnly`, `revenueSharePercent`, `revenueInvestigationsPercent` (and the split tests / radiology rates
     when enabled), `revenueRetailPercent`, `revenueInsuranceProvisionPercent` (null = Finance rate)
   - `incentiveEnabled`, `incentiveThresholdAed`, the Gynae category and surgery rates
   - `gpIncentiveThresholdMultiplier`, `gpConsultationPercent`, `gpProcedurePercent`, `gpLaboratoryPercent`
   - `practitionerRevenueSharePercent`, `practitionerClinicCommitmentAed`, settlement day
   - `minimumGuaranteeAed`, recorded as "clinic target, not pay"
   - **Never needed:** a name beyond `fin_ref_doctors`, nationality, passport, Emirates ID, DOB, address, bank details
     or the salary components.
3. **Fail closed.** A doctor whose terms the vocabulary cannot express gets **no** approved scheme. They appear under
   "no approved scheme" in the run with their revenue and charges, and Finance settles them outside Pulse. No scheme
   approximates a contract.
4. **Fixed salary and statutory cost** go through the compensation CSV (`finance.costs.compensation`) with a new
   `component` column (proposal):
   - `salary`: S, prorated per OQ-156.
   - `fixed_cost`: visa, DHA licence, medical insurance and malpractice spread monthly, plus the gratuity accrual. Payroll
     supplies these figures; Pulse never computes gratuity.
   - Unique per doctor, month and component.
   - **Variable pay** for L3 is the payout line of an approved run (`fin_revshare_lines`), never retyped into comp.
   - A doctor with `minimum_guarantee` has no `salary` row (H3).
   - Until the month's run is approved, L3 shows pay as Provisional ("variable pay pending").
5. **Pulse must not:**
   - calculate doctor pay before Finance approves the basis (OQ-148 to OQ-152)
   - treat any figure as final before `fin_cost_periods` approval (Provisional, as today)
   - import offers
   - write anything back to the generator
   - redefine contract terms (CG §8: configuration stays in the generator, calculation with Finance)

## 7. Smallest vocabulary additions (proposal only; `revshare-2`)

Rules for any of these:
- The TS schema and `app.fin_revshare_rule_valid` change together, with parity tests on the shared synthetic fixtures.
- v1 rules keep their meaning.
- A redefined shared function starts from its last definition.

| # | Key | Formula | Needed for |
|---|---|---|---|
| P1 | `threshold_exclude: [category]` | base = Σ_{c∉X} net_c; f from that base; earned_c = rate_c × net_c for c ∈ X, rate_c × net_c × f otherwise | Gynae inpatient surgery (75 / 50 as two categories); unrated categories kept out of R (H5) |
| P2 | `cost_links: {kind: category}` + `threshold_basis: 'gross' \| 'net'` | Linked charges C_c reduce their category instead of being deducted at a rate. gross: f = max(0, ΣR_c − T)/ΣR_c, earned_c = rate_c × max(0, f × (R_c − C_c)). net: R′_c = max(0, R_c − C_c), f = max(0, ΣR′_c − T)/ΣR′_c, earned_c = rate_c × f × R′_c. With no threshold: rate_c × max(0, R_c − C_c) | GP and Gynae "after costs", salary-backed V, Aesthetics/Dental NCR; only after OQ-149 and OQ-150 |
| P3 | `basis: 'net_collected'` | net_c = collections allocated to category c for the month (rule from OQ-148), less refunds and chargebacks, excluding VAT | every revenue-share contract. This is mostly **data work** in `fin_revshare_inputs` (allocate `fin_payments` and remittance to lines), not just a key |
| P4 | `insurance_provision: rate` | net_c = self-pay_c + insurance_c × (1 − rate); inputs split by payer type (`inv_type`) | revenue sharing and Gynae with a provision (OQ-152) |

Not proposed (left to Finance, entered as an `other` charge only once OQ-154 defines them): the clinic-commitment
shortfall, facilitation-policy payments, workshop splits and staffing deductions. GP T needs no key: Finance types
round(S × m), and a new scheme version follows any change of S.

## 8. Proposed open questions (for `docs/audit/open-questions.md`)

| ID | Question | Where it comes from | Live value today | Proposed | Owner | Blocking? | Blocks |
|---|---|---|---|---|---|---|---|
| OQ-148 | **Revenue basis for doctor pay.** The contracts pay on collected net (VAT, refunds, chargebacks excluded). Pulse has invoiced net by invoice date. How are collections (patient payments, insurance remittance) allocated to doctor and category, and does pay follow the service month or the collection month? | CG §3.1, §3.8 | invoiced net (`fin_revshare_inputs`) | pro rata to invoice lines; collection month; refunds netted when refunded | Finance Manager / HR / legal | Yes (M2) | M2 doctor pay, P3 |
| OQ-149 | **Threshold basis (GP and Gynae).** Is the pool gross revenue with costs allocated pro rata (generator helper) or revenue net of costs? Does R include categories with no incentive rate (GP retail, radiology)? | CG §3.6, §3.7, §6 | revshare: gross, all categories, costs not scaled | written rule with a worked example signed by both | Finance Manager / HR / legal | Yes (GP, Gynae) | P1, P2 |
| OQ-150 | **Direct costs per category.** Which costs reduce which category (consumables and medicines to procedures, outsourced lab to laboratory, dental materials and lab, aesthetic devices), at the category rate rather than in full, and is each held once (`fin_doctor_charges` or `fin_cost_services`, never both for the same cost)? | CG §3.1, §3.7, §3.8 | default rule deducts lab and referral at 100 % | cost linked to its category (P2) | Finance Manager | Yes (M2) | P2, L3 |
| OQ-151 | **Category map.** Map Unite SERVICE, PROCEDURES, TEST, RADIOLOGY, DRUGS, RETAIL PRODUCT, VACCINE, PACKAGES/Package, DENTAL PROCEDURES, INTRAVENOUS THERAPY, HOME HEALTHCARE, OTHER SERVICES and NO to the contract categories (consultations, procedures, investigations, retail, inpatient surgery). How are packages split? | docs/finance/contract-rules-alignment.md §5 | `service_category` per item, many Unmapped | Finance-signed table; NO stays Unmapped | Finance Manager / HR | Yes (M2) | every scheme |
| OQ-152 | **Insurance provision.** Rate per doctor or the Finance rate, applied to insurance revenue only, and how is it trued up when remittance and denials arrive? Confirm that Gynae "0 = Finance rate" differs from the general field "0 = 0". | CG §3.1, §3.6, §4 | none in Pulse pay | Finance rate unless the contract states one; quarterly true-up | Finance Manager | Yes (provisioned contracts) | P4 |
| OQ-153 | **Gynae inpatient surgery.** How is an inpatient surgery identified in Unite, and how is after-hours vs scheduled evidenced? Confirm it is excluded from the outpatient pool and from outpatient category shares. | CG §3.6 | not identifiable by item type | dedicated item codes per surgery type, two categories | Finance Manager / HR / legal | Yes (Gynae) | P1 |
| OQ-154 | **Clinic commitment and policy payments (Aesthetics, Dental, revenue sharing).** What is the comparison base and deduction order for a shortfall against `practitionerClinicCommitmentAed`, and how are patient-facilitation, workshop and staffing items recorded? | CG §3.5, §3.8 | not calculated | Finance records each as a charge or a separate payment by hand, with the schedule reference | Finance Manager / legal | No | Aesthetics, Dental settlement |
| OQ-155 | **Terms hand-over.** HR sends Finance the terms sheet (fixed field list, no personal data) for every signed contract and amendment within N working days. Finance enters the scheme, and the Finance Manager checks it against the signed contract. Offers are never entered. | §6 above; CG §5 | none | terms sheet + scheme note with the generator record id | HR / Finance Manager | No | M2 |
| OQ-156 | **Doctor fixed cost and proration.** Payroll supplies salary and fixed cost (visa, DHA licence, insurance, malpractice, gratuity accrual) per doctor and month as separate components. For max(S, V) doctors, pay is the approved run payout with no salary row. How are S and T prorated for a mid-month start, end or salary change? | docs/40 §2 L3; CG §3.3, §3.7 | one comp amount per doctor-month | component column; proration by calendar days | Finance Manager / HR | Yes (L3) | M2 L3 |
| OQ-157 | **Who earns the revenue.** Invoice doctor, ordering or performing (`doctor_basis`)? Radiology and lab are billed under the referring doctor. Does the referrer earn the investigations share? | CG §3.1 "attributable"; docs/39 §1.2 | invoice doctor | per contract type, as Finance signs | Finance Manager / HR | Yes (investigations share) | every scheme |
