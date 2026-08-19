# Landlord Onboarding Punchlist (S604, Nic — live walkthrough)

Captured during the real Oak Park signup, ordered by severity rather than the
order they were hit.

---

## ✅ SHIPPED — all deployed to production

**Batch 1**
- **Card fee copy said 3.25% + 26¢** (repriced to 3.5% + $0.55 in S603) on a
  screen landlords agree to. Now DERIVED from `PROCESSING_FEES` via new
  `cardFeeLabel()` / `achFeeLabel()` helpers, so a future repricing updates the
  UI automatically instead of leaving stale terms behind.
- **Late-fee LIVE PREVIEW TABLE** — renders before saving, showing what a tenant
  owes on the 5th / grace-end / 10th / 15th / 30th under the current settings.
  Calls the SAME shared helpers the billing job uses (`nextAccrualDate`,
  `computeLateFeeAmount`, `lateFeeStartDate`), so it can never drift from what
  actually bills. In-grace rows labelled.
- **Late-fee EDIT action** — was delete-and-retype only; a pencil now loads the
  row back into the form (the endpoint was already an upsert).
- **Unit subtypes PREFILL from existing units** — most common unit_type on the
  property plus the dominant layout / amp / ownership / rates within it. An RV
  park no longer opens the subtype form defaulted to "apartment", and the rates
  (rent, nightly, weekly) come across too.
- **Bulk-add naming made visible** — the prefix behaviour was only in a
  placeholder that vanished on typing. Live line now shows the real names.
- **"Vacant" no longer looks disabled** — gold instead of grey, both options
  explain themselves.
- **Password confirmation field** with live match/mismatch feedback.
- **EIN + phone formatted and length-capped** as you type.
- **AI agent permissions removed from the property tab.** Component left in the
  codebase — it needs re-homing, not deleting.
- **Properties page blank after signup** — the property WAS created; the
  onboarding wizard never invalidated the react-query `properties` cache, so the
  Properties and Units pages both rendered "Add your first property" off a stale
  empty array. This also blocked "add units".

**Batch 2**
- **Deposit already in custody toggle** (`lease_documents.deposit_already_held`).
  E-signing new leases for EXISTING tenants would have billed 19 Oak Park
  tenants $350 each for deposits already held (~$6,650). The lease still STATES
  the deposit; only the charge is suppressed, by marking the custody row
  `carried_forward` so the existing S516 double-charge guard handles it. 3 tests.
- **Bulk numbering `startAt` + `padWidth`** — a block can be named to match the
  park's real signage (RV 20–36) instead of always continuing after the highest.
  Preview reflects it. 4 tests.
- **Same-utility double-billing guard** — nothing stopped a unit being attached
  to TWO water masters; billing iterates meters, so it would be charged twice
  every cycle, silently. Now blocked with a named error. The one legitimate
  overlap (S558: submeter + RUBS master, so submetered usage is subtracted
  before the split) is explicitly still allowed. 3 tests.

---

## 🟠 STRUCTURAL — decide before more landlords onboard

- **SIGNUP accepts exactly one LLC, with no way to add a second.** A FLOW
  problem, not an architecture one — the DB and portfolio views already handle
  multi-entity (`landlord_members`; each member sees only the entities they
  belong to). But a landlord onboarding two properties under two LLCs hits step
  one with no move: they jam both under one entity (painful to unwind once bank
  accounts and properties attach) or stop. Needs a way to add a second entity
  during signup, and an entity picker when creating each property. **Common, not
  an edge case.**
- **Bank account is collected at step 3, before units exist.** Move it AFTER
  unit entry so the landlord sees what they'll actually be charged — units in,
  occupied vs vacant known, then quote, then bank.
- **ACH fee payer election** — make the toggle available, default BOTH to tenant.
  **Open question: how hard is retroactively charging the fee to the landlord's
  balance?** Easy → make it an option; not → skip.

## 🔵 NEXT BUILD — RETIRE & REPLACE a unit (Nic's design, DECIDED)

**Decision made:** a unit's number is LOCKED once it carries data. *"I wouldn't
allow a rename of a unit after data is on something... making the one physical
unit into two separate database units is probably the safest way to go — retire
it, and have the new unit take its place under the new number."*

**Why:** nothing snapshots `unit_number`. Invoices, payments and bookings all
join by `unit_id` and render the CURRENT value, so a rename retroactively
rewrites how years of records display while executed lease PDFs keep the
original and silently disagree. Nic's point: if data is pulled years later you
should not have to work out when a number changed and what to look for before
that date.

**SHIPPED already:** rename now 409s once the unit has a lease (any status),
payment, booking, deposit, meter link or maintenance request, with a message
pointing at retire+replace. Freshly-created units rename freely. Delete uses the
same probe (`unitHistoryBlocker`). 56 tests green.

**STILL TO BUILD — the retire/replace flow:**
1. Schema: `units.retired_at timestamptz`, `units.superseded_by_unit_id uuid`
   (→ the replacement) and its inverse `replaces_unit_id`. Both nullable.
2. `POST /units/:id/retire` → takes the new number; in ONE transaction:
   creates the replacement inheriting every attribute (type, subtype, rates,
   deposit, RV layout/amp, ownership, features, meters?), stamps
   `retired_at` + links both directions, and returns the new unit.
3. A retired unit must: keep all history, never appear in add-lease / booking /
   available-unit pickers, never be billed the per-unit platform fee, and stay
   visible in reports with a "retired" marker and a link to its successor.
   **Audit every list query for the `retired_at IS NULL` filter** — missing one
   is how a retired unit silently keeps getting billed or booked.
4. Open sub-questions: do utility meters follow the new unit automatically?
   Does an ACTIVE lease block retirement (probably yes — end or transfer first)?
   Should the successor inherit the subtype link?

## 🟠 BULK NUMBERING — remaining gaps

`startAt` + `padWidth` shipped. Still open:
- **Letter suffixes (14A) can't be generated** — the pattern only produces a
  trailing integer, so those go in individually.
- **Duplicate numbers across unit types need distinct prefixes.** `RV 01` +
  `MH 01` is fine; bare `1` for both an RV spot and a mobile home is REJECTED
  (uniqueness is the whole string, type not considered). Many parks number
  mobile homes and RV spots 1..N independently — document the prefix convention
  at bulk-add, or make uniqueness (property, unit_type, number), which is a
  schema change needing thought.

## 🟠 UTILITY SETUP AT ONBOARDING

- **RUBS is not offered at signup, only a metered rate.** The engine fully
  supports `submeter | rubs | master_bill_to_landlord` with four allocation
  methods, and `utilityBilling.ts` has the whole master-meter path built
  (including S558 metered exclusion). The onboarding utility step only asks for
  a per-unit rate, silently assuming submetering. **Oak Park hit this
  immediately** — RV sites submeter ELECTRIC but bill WATER as RUBS. Workaround:
  skip water at signup, configure on the utilities page after.
- **Opening meter read: the CAPABILITY exists, the REQUIREMENT is unexplained.**
  `POST /meters/:id/readings` accepts an arbitrary `readingDate` +
  `billingCycleMonth`, so a baseline can be backdated. But NOTHING SAYS IT IS
  REQUIRED: a submeter with one reading bills nothing — the engine returns "no
  prior reading — first cycle baseline, no bill produced" and stays silent. A
  landlord entering only the end-of-August read gets NO August bill and no
  warning. Needs a baseline prompt at meter creation and a visible "no baseline
  — will not bill" state. Bulk unit-add should offer it per unit.

## 🟠 MIGRATION DATA

- **No way to carry a tenant's OUTSTANDING BALANCE onto the platform.** No
  opening-balance entry point. Needs one, plus **a toggle for whether the
  carried balance accrues late fees** (Nic: a tenant on a catch-up plan
  shouldn't be fined for arrears from the old system; default probably "no late
  fees on carried balance", landlord-overridable). Check whether
  `reconciliation_until` (the 21-day window that already lets a landlord mark a
  first GAM invoice paid off-platform) should be extended rather than building a
  parallel mechanism.

## 🟠 LATE FEES — reference (fixes shipped)

`PropertyLateFeeSection.tsx` defaults `accrualFrom` to `due_date_inclusive`,
which is CORRECT — it is the Arizona rule for mobile home / RV: $5 per day after
the grace period, retroactive to the 1st, so a tenant paying on the 10th owes
$50. Verified against the real helpers:

```
grace gate opens 09-06
due_date_inclusive  first=09-01 last=09-10 days=10 TOTAL=$50  <- AZ
due_date            first=09-02 last=09-10 days=9  TOTAL=$45
grace_end           first=09-07 last=09-10 days=4  TOTAL=$20
```

Do NOT change the default. The ENGINE was always correct and flexible; the UI
was what failed — the flat-fee suppression only became visible after entering an
ongoing amount, and "grace" means something different in retroactive mode with
nothing explaining it. Preview table + live description + edit all shipped.

## 🟡 FORM CORRECTNESS

- **Business name asked twice** — initial signup page, then again on the business
  profile after 2FA. Remove from the initial page; keep it next to the EIN.
- **Mailing address optional, NO physical address field.** Want both, with a
  "same as" toggle, both mandatory, validated against real addresses.
- **Property type is single-select.** Mixed-use needs multiple (Oak Park is
  majority RV long-term but not exclusively).
- **Step 1 → step 2 retypes the same data.** Toggle on step 1 for "more than one
  business entity / more than one property"; if NOT toggled, the first property
  inherits the LLC name.

## 🟡 BULK UNIT ADD

- **Security Deposit is easy to miss** — it IS on step 2 (Pricing) but sits below
  rent and lot rent, and on RV below nightly/weekly/monthly, so all 19 Oak Park
  spots saved with `security_deposit = 0.00`. Not a blocker (the real deposit
  comes from the LEASE) but the unit value pre-fills the lease field, so a 0
  means retyping on every lease. Consider moving it next to rent, or a "no
  deposit set" hint on review.
- **Initial status is uniform across the batch**, but a bulk of identical spots
  usually has mixed occupancy. Either allow per-unit status on a review step, or
  rely on the shipped guidance (always vacant; leases flip it).

## 🟢 FLOW / SPEED

- **After signup + activation, land on "add a unit"**, not the dashboard.
