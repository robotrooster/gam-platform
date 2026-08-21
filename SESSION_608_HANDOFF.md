# SESSION 608 HANDOFF

Written at the end of S607. Everything below is **live and deployed** unless
marked otherwise.

---

## 0. NIC'S IMMEDIATE PATH

1. **Master 22658 needs units.** It has **zero** assigned, so it bills nothing at
   all. Assign every unit that water line feeds — all 19 RV spots *and* the 8
   mobile homes (the submetered ones fall out of the split automatically).
2. **Set the master's basis.** It is on `usage_rate` + `occupant_count` today.
   `occupant_count` gives a vacant unit a basis of 0 and an empty park a basis
   sum of 0, so the pool under-recovers or produces nothing. For the intended
   setup switch the meter card to **"The utility bill"** + **"Equal split —
   rented units only"**.
3. **The apartment does not exist as a unit yet.** Oak Park has 8 `mobile_home`
   + 19 `rv_spot` and nothing else. Add it, then assign it to the master like
   any other unit — nothing in the system restricts RUBS by unit type.
4. **Opening reads.** All 28 meters have **zero** readings. The 19 RV electric
   submeters bill nothing on their first cycle without one. A `bill_amount`
   master needs no opening read — it records a period total, not an odometer.
5. **Water responsibility per lease** (see §3) — a unit only bills for a utility
   its lease marks tenant-responsible.

Reading runs open on the **last business day** — Mon **Aug 31** for the August
cycle — or open one early from the Utilities page.

---

## 1. THE BUG THAT WAS HOLDING RENT

The reading-entry route applied **odometer rules to RUBS master totals**. A
master's entry is a period total, not a dial: any month the park used *less*
water than the month before computed as a wrapped odometer and set
`needs_review`. `flagHold` in `invoiceGeneration.ts` then held the **whole
invoice, rent included**, for every unit on that master until a human cleared
it. Every autumn, Oak Park's rent would have stopped going out.

- Below-previous / rollover logic is now **submeter-only**.
- Masters got the guard they actually need: a total above
  `MASTER_TOTAL_JUMP_FACTOR` (**10×**, Nic — widened from 5 because a leak or a
  seasonal fill moves a pool legitimately) of the master's own previous total is
  flagged. It is catching a slipped digit, not a busy month.
- A flagged master total no longer bills. It was generating bills off the
  suspect number, and the per-cycle UNIQUE made the landlord's correction a
  silent no-op.
- The digit cap no longer applies to masters — a big park clears 999,999 gal in
  a month and the total was unenterable.

---

## 2. RUBS PRICED FROM THE BILL (Nic, DIRECTIVE)

> "You're allowed to take the total dollar value of the bill and divide it out,
> not just the gallons usage. On a bill with low gallon usage and then your base
> fee, you're not recouping that."

Correct, and the statutes agree — A.R.S. § 33-2107(C)(1) and § 33-1314.01(B)
both limit recovery to the landlord's **actual charges** and let him recover
*all* of them. Billing gallons × a chosen rate left every service charge and tax
with the landlord.

**`utility_meters.rubs_basis`** — per-master choice, **defaults to
`usage_rate`**, so every existing master is untouched:

- `usage_rate` — usage × property rate + base fee. Unchanged behaviour.
- `bill_amount` — the cycle entry takes **two** numbers off the utility bill,
  total usage and total dollars. Blended rate = dollars ÷ usage.

**GAM does not enforce legality (Nic, DIRECTIVE).** *"We are not enforcing
legality, because then we have to stay current on laws and everything that
changes. We offer the flexibility for all the different options to be billed in
all the ways that are common use."* Nothing added this session gates a landlord:
every option is selectable, the prevailing-rate cap is opt-in and unset by
default, and there is **no unit_type restriction anywhere** — RUBS on an
apartment or a mobile home is permitted regardless of what any statute says. The
only hard block on meter assignment is the pre-existing double-billing clash
check (one master per utility per unit), which is data integrity, not law.

A first cut of blended mode zeroed the meter's `base_fee`, `sewer_rate` and tax
rate on the theory that the provider's charges were already inside the dollar
bill. That silently removed the **admin/margin lever** every RUBS biller
charges. Corrected: **blended mode substitutes the RATE and nothing else.**
Anything configured on the meter is the landlord's own layer and rides on top.
Left at 0/unset — Oak Park's case — the pool recovers exactly the bill.

Nic on the shape of the tenant's bill: *"if they see it nickel and dimed as
separate charges — here's the water rate, here's the fee for the water —
they're not gonna like it... that just needs to have a blended rate on the back
end to include any fee."* The provider's service charge and taxes ride **inside**
the blended rate, and every component — including any landlord layer — collapses
into a single `charge_amount`. **The tenant always sees one line.**

**How a master shares its line with submetered units is TWO independent
settings** (Nic: *"we're going for flexibility here, and I think you keep
forgetting that"* — both were first shipped as universal rules and corrected to
options, each defaulting to prior behaviour):

| Setting | Options | Default |
|---|---|---|
| `rubs_submeter_rate` | `property_rate` — the landlord's published rate · `blended` — the master's dollars ÷ usage | `property_rate` |
| `rubs_exclusion_mode` | `usage` — subtract measured usage, price the remainder · `dollars` — subtract what those units were actually invoiced | `usage` |

The two carve-outs **agree** whenever submeters bill at the blended rate. They
diverge exactly when the landlord publishes a separate submeter rate — which is
Oak Park's case, and why the option exists. Nic: *"we set the utility rate at a
penny per gallon for submeter usage for water... we need to subtract not the
usage from the pool for the RUBS, but the remaining dollar amount. That way it
still zeros out."*

**Oak Park's intended combination is `property_rate` + `dollars`**: mobile homes
pay a published penny a gallon, and the spaces divide whatever dollars that
leaves of the real bill. The setup card warns when `property_rate` + `usage` are
paired, since that combination leaves part of the bill unrecovered.

**Allocation menu is 7** — widened to 9, then trimmed to 7 by Nic in the same
session. `equal_split` REMOVED ("that's a stupid method, nobody's ever gonna opt
to do that" — and the recovery tests proved it: it hands a vacant unit a full
share that bills to nobody, costing the landlord a third of a $900 bill;
`rented_spaces` is the same idea done correctly). `weighted_occupancy` REMOVED
("too complicated for what we're doing"). The drop migration refuses to run if
any meter still uses either. `utility_bills.allocation_method` is deliberately
NOT constrained — history must keep saying how a bill was actually calculated.

**Oak Park's pick: `occupant_count`.** Nic: *"all signers on the lease are
counted in occupancy unless they report to the office for move out — it puts the
responsibility on the tenant to keep the landlord informed."* Verified this works
as intended: `v_lease_active_tenants` counts every `lease_tenants` row with
`status='active'`, primary and co-tenant alike, so an occupant only leaves the
count when the office formally removes them.

**Allocation menu originally widened 5 → 9** (Nic: *"a wider window scope for available
options, and we narrow it on our property setup"*). Added `fixture_count`,
`unit_type_weight`, `weighted_occupancy` and `hybrid` (a percentage blend of two
other bases, each side normalised to shares FIRST so square footage in the
hundreds cannot swamp a headcount in the ones). Config lives on
`utility_meters.rubs_weights` (jsonb) with a plain-input editor — no JSON typing.
New per-unit field `units.water_fixture_count`; a unit missing the data a basis
needs contributes 0 and is reported skipped rather than taking a free share.
Self-referential `hybrid` config is guarded against recursion.

**`rented_spaces` allocation** — equal share across only the **leased** units.
§ 33-2107(C)(4) mandates that basis for RV spaces, and it closes a quiet leak in
`equal_split`: a vacant unit took a share that then found no tenant and was
never billed, leaving the landlord short on a bill already paid.

**`property_utility_rates.prevailing_residential_rate`** — optional ceiling on
what a *submetered* tenant may be charged (§ 33-1413.01(B), § 33-2107(B)(3)). A
park master sits on a bigger meter with a bigger service charge, so a blended
rate can land above what a house pays. Where set, the charge is held to it and
**the landlord absorbs the difference** — the pool still subtracts the uncapped
amount, so the shortfall is never pushed onto neighbouring spaces. Unset = no
cap; it never blocks a bill.

**Bill format:** `utility_bills.reading_start_date` / `reading_end_date` now
stamped and rendered on the invoice line. Both statutes require the opening and
closing readings **and their dates**; we snapshotted the readings and dropped
the dates, so no bill we produced was compliant on its face.

**No state-specific logic shipped.** Per CLAUDE.md, every one of these is a
landlord-configurable option with state-neutral UI copy. The AZ citations live
only in code/migration comments as rationale.

---

## 3. THE LEASE TEMPLATES — READ, NOT CHANGED

Nic is not changing leases. Reporting what the two uploads in `~/Downloads` say,
because the lease governs what can be billed:

- **`Oak Park Motel and RV - Mobile Home Rental Agreement.pdf`** § 9 — trash,
  water, electricity, propane charged separately; **"Water and electricity will
  be charged via separate meters for each user"**; **sewer IS included in rent**.
  → Matches the 8 MH submeters exactly. **Do not set a sewer rate on water** —
  the lease includes it. That closes the sewer question from earlier.
- **`Oak Park Motel and RV - Apartment Rental Agreement.pdf`** § 10 —
  **landlord pays water, sewer and trash**; tenant holds their own APS electric
  and gas accounts. → No GAM utility billing at all under this form.

**Nic's decision (S607): water WILL be billed for the RV spaces and for the
apartment, and the apartment goes in the RUBS pool.** The apartment form as
written puts water on the landlord and there is no RV-space form among the
uploads; Nic is aware and is not changing leases. The system does not police
this — `lease_utility_responsibilities` is a landlord-set flag, so marking water
tenant-responsible on those leases is all that is required to bill.

Practical consequence: **every unit that should bill water needs
`tenant_responsible = TRUE` for water on its lease.** That flag, not the meter
setup, is what decides whether a bill is produced.

Also note § 33-2107 only reaches RV spaces rented **>180 consecutive days**
(§ 33-2101(A)); short-term guests are outside it entirely, which matches the
existing "short-term stays don't bill" design.

---

## 4. FIXED IN PASSING

`PropertyOwnershipTab.tsx` had 6 `camelCase ?? snake_case` fallback reads. The
API camelizes every response globally (`index.ts:240`), so the snake_case
branches were dead code — but `wireContract.test.ts` counts them and its
baseline is 0, so **that suite was already red before this session**. Fallbacks
removed, baseline back to 0.

---

## 4b. MONEY & FEE WORK SHIPPED THIS SESSION (all live)

Beyond the utility work in §1–§2:

- **Verified bank becomes the default.** On verification the bank is promoted to
  the tenant's default payment method — card had been keeping it, so a tenant who
  waited three days to verify a bank kept paying card rates. Disclosed on screen.
- **The $10 cash/check/money-order fee is now disclosed to tenants at all.** It
  never was: a code comment claimed the portal disclosed it and nothing did.
- **Every way to pay is priced on the tenant's screen** before they choose —
  bank / card / cash, from the SAME formula that charges (`processingFeeFor`).
- **The waiver rule changed** (Nic): free on a tenant's FIRST payment, only if
  that payment is off-platform. No 21-day property window — that clock burned
  down during the landlord's setup. Card first = no waiver later.
- **Landlord may absorb the fee, per property.** It MOVES the charge (posts to
  `platform_revenue_ledger`, nets out of their payout), it does not erase it.
  Visible to them on Disbursements only when they are actually absorbing it.
- **Platform fee LOCKED to the landlord** — UI, API and a DB CHECK. GAM's volume
  discounts must never reach a tenant's bill.
- **Fee settings are per-PROPERTY, never per-tenant** (anti-discrimination). A
  test inspects the schema and fails if that ever changes.
- **Credits apply to the open balance immediately** (was: next invoice only).
  Forgiving a late fee left it blocking the tenant's whole payment.
- **One-off charges** — `POST /leases/:id/charge`, amount + required description,
  with a Charge button on each active lease. Tenant sees the landlord's wording,
  not a bank code (`chargeLabel`).
- **Both Terms documents corrected** — they described the deleted 21-day rule and
  never mentioned the landlord-covers option. Dated 2026-08-19.

---

## 5. FILES TOUCHED

- `packages/shared/src/index.ts` — `MASTER_TOTAL_JUMP_FACTOR` (10),
  `rented_spaces` added to the existing `RUBS_ALLOCATION_METHODS` single source,
  new `RUBS_BASES`
- `apps/api/src/services/utilityBilling.ts` — blended rate, prevailing-rate cap,
  `rented_spaces` basis, sewer parity on RUBS, needs_review hold, reading dates
- `apps/api/src/routes/utility.ts` — `billAmount` on cycle entry, master typo
  guard, digit cap lifted for masters, `rubsBasis` + `prevailingResidentialRate`
  write paths, shared-enum import
- `apps/api/src/services/utilityReadingRuns.ts` — `rubs_basis` on the walk payload
- `apps/api/src/jobs/invoiceGeneration.ts` — read dates on the invoice line
- `apps/landlord/src/pages/UtilityMetersPage.tsx` — basis picker, allocation
  option, master field hints, bill-amount field in the walk
- `apps/landlord/src/pages/PropertyOwnershipTab.tsx` — dead fallbacks removed

**Migrations applied (dev `gam` + schema.sql regenerated):**
`20260819100000_rubs_dollar_billing.sql`,
`20260819110000_rubs_basis_choice.sql`,
`20260819120000_utility_bill_rate_precision.sql` (numeric(10,4) → (14,6); a
blended rate is derived, not typed, and 4dp no longer reproduced the charge).

**Tests:** 172 passing across 7 suites (`cd apps/api && DB_NAME=gam_test npx
vitest run …` — the globalSetup that rebuilds `gam_test` lives in
`apps/api/vitest.config.ts`, so running from the repo root silently skips it).
12 new regression tests cover the false-flag fix, the master typo guard, exact
bill recovery, the submeter blended rate, the prevailing-rate cap, `usage_rate`
non-regression, and the read-date stamp.

**Deployed:** API + landlord live.

---

## 6. NEXT SESSION SHOULD TARGET

**The two money builds in §7 and §8 — start each in fresh context.** Both move
real money on a schedule and both are specified below with the decisions already
made, so neither needs re-litigating.

Smaller open items:
- Trash is charged separately under the MH agreement — no `flat_rate` trash
  meter exists at Oak Park yet (Nic's data entry).
- `prevailing_residential_rate` has no UI field (API + engine only). Optional.
- **UNVERIFIED:** a credit is applied to open charges on the LEASE (S607) and to
  the invoice's own rows at generation. Not traced: whether an unpaid charge from
  a PRIOR invoice is carried onto the new invoice, or stays on the old one. Only
  matters for reporting, not for the tenant's balance (which is lease-wide).

---

## 7. TENANT AUTOPAY — PARTIALLY BUILT, NOTHING CHARGES YET

Nic (DIRECTIVE): tenants must be able to schedule rent, and **the pull day is the
tenant's alone**. *"The landlord should not be pulling the strings on when the
money gets moved. That could be used the wrong way with a landlord pushing the
date back and getting extra late fees."* Landlord gets **visibility only** — no
landlord route may write to `tenant_autopay`. That abuse vector is why it is its
own table rather than a column on `leases`.

There was **no autopay of any kind** before this — every tenant logged in and
pressed Pay Now every month.

**LANDED (tested, deployed, inert):**
- `tenant_autopay` table — `pull_day` NULL = due date, else 1–28 (28 because
  29–31 do not exist every month and a schedule that skips February is worse
  than none). `projected_late_fee_cents` snapshots what the tenant was shown.
- `services/autopayProjection.ts` — REDUCED to date arithmetic only.
  A late-fee projection was built and then **removed the same session** (Nic):
  *"We don't need to make it all complicated and show somebody what their bill
  will be exactly."* It was a snapshot of a moving number — the balance changes
  between choosing a day and the charge landing (another accrual tick, a utility
  bill joining the invoice, a waived fee), so any advance figure is a promise the
  system cannot keep. **Autopay reads the live outstanding balance at run time.**
  `projected_late_fee_cents` dropped in `20260819180000`.
- The tenant is told the true thing rather than the falsely precise one: picking
  a day after the due date means late fees per their lease, and the charge is the
  full outstanding balance at the moment it runs.

**NOT BUILT — no money moves yet:**
- Routes (tenant read/write; landlord READ-ONLY — see the rule below)
- The charge runner (daily cron)
- Tenant UI (day picker)
- Landlord visibility row

### Decisions already made — do not re-open

1. **The pull day is the tenant's alone.** No landlord write path, ever. A
   landlord who could move the date could manufacture late fees. This is why the
   setting is its own table rather than a column on `leases`.
2. **Landlord gets visibility only** — "autopay scheduled for the 9th" so they do
   not read silence as non-payment and serve a notice.
3. **No projection.** Charge the LIVE outstanding balance at run time. A figure
   shown in advance is a promise the system cannot keep (the balance moves).
   The tenant is told the rule instead: picking a day after the due date means
   late fees per their lease, and the charge is the full balance when it runs.
4. **Pay-in-full still applies.** Autopay charges the whole balance, never part.
5. **Late fees are a separate clock.** Scheduling day 9 does not avoid them and
   is not meant to — the point is avoiding a failed pull and an overdraft.

### What has to be built

- Tenant screen: turn it on, pick "on the due date" or a day 1–28, pick a method
  (or leave it following their default).
- The daily job: find leases with autopay due today, charge the live balance.
  Must be idempotent per cycle — `last_run_cycle` exists for this.
- Failure handling: a failed pull needs a retry posture and a tenant notice.
  Nothing here is decided yet; treat it as an open question for Nic.
- Landlord read-only surface.

**Design settled with Nic:** FlexPay is NOT in conflict — it is the paid tier for
tenants whose late fees exceed $25/mo, and free scheduled autopay *identifies*
them (a tenant picking the 9th is declaring when their benefits land). Landlords
with $10 late fees were never FlexPay's market. Autopay is a FlexPay funnel, not
a competitor.

**No state-specific logic**: the projection is arithmetic over the landlord's own
configured late-fee fields. Notice periods (AZ is 5 days for nonpayment under
§ 33-1368(B) and § 33-2143(E)) are deliberately NOT encoded anywhere.


---

## 8. PAY-AHEAD / ROLLING BALANCE — NOT BUILT

**Nic's goal, in his words:** *"We hold anything paid ahead that we'd need to
possibly give back to a tenant on move out. It's gonna be hard to claw back from
a landlord... And the goal is to become the bank, to keep balances on file, to
start positioning ourselves with that end goal in mind."*

He has tenants who like to run two or three months ahead. Today they **cannot**.

### The decisions already made — do not re-open

1. **Overpayment is allowed.** `payments.ts` currently rejects it, but the
   comment there (*"no pay-ahead — the UI has no amount field"*) records a
   MISSING INPUT BOX, not a policy. Nic confirmed he never decided against it.
2. **Under-payment stays blocked.** That one IS a standing directive — a partial
   can reset a landlord's eviction clock. Do not touch it.
3. **GAM HOLDS the prepaid money.** It is NOT disbursed to the landlord on
   arrival. It releases as each month becomes due. Rationale: a tenant who moves
   out in month two needs it back, and clawing it back from a landlord is as hard
   as clawing it back from a tenant.

### What already exists (reuse, do not rebuild)

- `lease_prepaid_credits` — amount_original / amount_remaining, fed today from a
  remittance's `unapplied_amount` (webhooks.ts) and by bookingLeaseBilling.
- `services/creditApplication.ts` (S607) — the ONE implementation of "draw
  credits down against open charges, oldest first." Handles full and partial
  coverage, splits a partly-covered charge, banks the remainder. Use it.
- Consumption at invoice generation is already wired.

### What has to be built

- Tenant pay screen: an amount field, defaulting to the balance, that accepts
  MORE than the balance and explains what the extra does.
- Lift the overpayment rejection in `pay-balance` — carefully, without touching
  the under-payment guard beside it.
- Route the surplus into `lease_prepaid_credits`.
- **The payout side is the real work:** prepaid money must be withheld from the
  landlord's batch and released as each month comes due. Check
  `services/landlordPassthrough.ts` — today anything `platform_held=true` goes
  out on the Tuesday batch. This needs a "not yet earned" concept.
- Tenant + landlord visibility: a credit balance both sides can see.

---

## 9. HOW THIS SESSION COMMUNICATED (read before writing to Nic)

Nic pulled me up on this and he was right. He does not read code and does not
want implementation vocabulary — no "camelize", no route names, no column names
as explanation. Describe what a PERSON experiences and what it costs them. File
references are fine when he asks where something lives; they are not an
explanation on their own.

Three times this session the CODE was right and my WORDING was wrong (the manual
fee scoping, twice, and the free-first rule). When he says "you keep scoping this
wrong," check whether the disagreement is about behaviour or about the sentence
describing it — usually it was the sentence.

Verify before claiming something does not exist. I told him there was no way to
post a credit; `tenant_credits` had been there since S577 with a
`late_fee_refund` category. He remembered a button I had not looked for. Search
the DATA MODEL, not two likely files.
