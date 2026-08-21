# SESSION 611 HANDOFF

Written at the end of S609/S610. **Everything below is LIVE and deployed** unless
it says otherwise. Full suite green at close: **4,843 tests, zero failures.**

---

## 0. NIC'S IMMEDIATE PATH — FINISHING OAK PARK

1. **Set the master's split.** Two changes on Master 22658: priced-from →
   *the utility bill*, and take-submeters-out-by → *their invoiced dollars*.
   Split method (occupancy) and submeter rate (published penny/gallon) are
   already right.
2. **Assign its units.** The master has **zero** units, so it bills nothing at
   all. All 19 RV spots and the 8 mobile homes — the submetered ones fall out of
   the split automatically. Use "+ add units…" for the checkbox picker.
3. **Trash.** Add meter → Trash → **Flat rate**. It takes its amount from the
   property trash rate ($25, already set), so there is no amount to type. Assign
   the units that use your cans; anyone hauling their own you leave off, or
   switch off from their unit page.
4. **Mark the owner-occupied units.** They are currently marked *vacant*, which
   is not cosmetic — see §3. Set the household size on each.
5. **Opening reads.** All 28 meters still have zero readings. The 19 RV electric
   submeters bill nothing on their first cycle without one.
6. **Water responsibility per lease.** A unit only bills for a utility its lease
   marks tenant-responsible. That flag, not the meter, decides.

---

## 1. WHAT SHIPPED — MONEY

**Tenant autopay.** Tenants schedule rent on the due date or a day 1–28, charged
through the same code as the Pay button. Charges the live balance at run time;
nothing is forecast. Cannot charge twice — the month is claimed before the charge
is attempted. On failure it stays on, tells both sides, and disarms after two in
a row. The landlord sees THAT a payment is scheduled and can never change the
day — that abuse is why it is a tenant-owned table.

**Pay ahead, no cap.** A tenant can pay any amount above their balance. GAM holds
it and releases each month as the invoice comes due. Nic reversed an early
lease-term ceiling: utilities aren't known until a meter is read, so any cap
lands wrong at the end of every lease.

**Prepaid money now actually reaches the landlord.** It never did — bills were
marked paid by prepaid credit and nothing told the payout side anything was
earned, so the money sat on GAM's books permanently. Live via shortened RV stays.
Fixed and covered by tests.

**Late fees and landlord-billed fees go to the landlord.** Only rent and
utilities were ever split out; everything else settled with no owner share and
stopped on GAM's books. Every charge now records whose money it is at creation —
`entry_description` could not carry it, because a landlord's hand-billed fee and
a GAM subscription are both written as `SUBSCRIP`. GAM keeps only: ACH
return/retry, card decline, the manual-payment fee, and opt-in products.

**Work trade covers the whole invoice, propane included.** `(hours ÷ target) ×
(rent + utilities + fees + propane)`. Propane was exempt and is no longer — Nic
gives seasonal help their winter propane, and running it through the credit
records the value given against the work done on one document. Propane is taken
LAST, so a partial month covers living costs before a one-off fill.

---

## 2. WHAT SHIPPED — UTILITIES

**Meters are editable, locked by USE not by existence.** Everything is editable
until a meter has actually measured or billed something; after that the utility
and billing method freeze. Locking at creation made a setup typo unfixable during
the exact phase where typos happen.

**Flat-rate charges are set at the PROPERTY, not the meter** (Nic, anti-
discrimination): *"If you're billing a flat rate per unit, it needs to not be
editable. It needs to be set at the property level the same way late fees are."*
An editable-per-meter amount is a mechanism for billing two identical units
differently for the same service. A test sets a meter-level amount and proves it
changes nothing.

**Unit assignment is a checkbox picker**, showing only units that can actually be
picked — taken ones are gone, not greyed. Same rule the server enforces. One bad
unit no longer discards the rest of a selection.

**Propane deliveries.** One master bill, several tanks: the price once, then
gallons per tank, blanks skipped. All-or-nothing, so a bad line never leaves six
tanks recorded and two missing against an invoice that has to reconcile. Warns
when a tenant still owes on an earlier fill, because a new fill accelerates it.

**Per-unit control of shared charges**, on the unit page — every property meter
with a switch for whether this unit is billed. Trash opt-out lives here.

---

## 3. OWNER-OCCUPIED UNITS — READ THIS BEFORE MARKING ANY

Nic found this by reasoning about it before it could hurt anyone.

An owner-occupied unit has no lease, so it scored **zero** in a RUBS split and
contributed nothing to the divisor — which means the remaining TENANTS' shares
summed to the whole bill. **The owner's own water was being paid for by the
paying tenants**, invisibly: every tenant's bill looked entirely reasonable.

Now the unit takes a real share (household size, default 1) and that share is
**withheld — billed to nobody** and recorded in its own ledger, so
"billed out + kept back = the pool" reconciles exactly. That is the audit answer:
*"if there's ever an audit, the landlord can provide, hey, these utilities were
not factored into being billed back to people."*

**Oak Park's owner-occupied units are currently marked VACANT** because there was
no way to mark them otherwise. That is now settable at unit creation and on the
unit page. Until they are marked, their usage still lands on the tenants.

A VACANT unit taking no share stays correct and deliberate — it draws nothing,
and the AZ RV statute names rented-spaces as the basis.

---

## 4. STILL TO DO

**Propane billing model should be a property-level choice (Nic, THIS SESSION —
not built).** *"Propane should be set up to set the option at the property level.
That's just how we operate it. That's not how every property is gonna operate it.
So if it's just a one off charge or whatever or a submetered thing, we need to
have all that flexibility."*

Today there is exactly ONE propane model: per-unit tank fills priced per gallon.
Oak Park's shape (separate tanks, one master invoice, split by each tank's
gallons) fits it. Two shapes that do NOT:

- **A one-off charge** — no gallons, just an amount. Closest today is a
  landlord-billed lease fee, which does not read as propane anywhere.
- **Submetered propane** — a central tank feeding several homes through meters.
  The math already works as a `gas` meter billed per gallon, BUT the tenant's
  invoice hardcodes **"therms"** for gas, so it would print the wrong unit on a
  billable document. Needs the gas unit to be therms-or-gallons.

Nothing was deleted to make Oak Park's shape work — the single-fill API is
untouched; only the redundant one-tank-at-a-time SCREEN went, and a single tank
is a delivery with one line.

**Onboarding flow revamp (Nic will design).** *"It still feels clunky... there's
a lot of good parts, but they don't fit together smoothly yet."* Three concrete
symptoms found this session, all the same shape — **one decision, two places, or
a setting wired to nothing**:

- Sub-meters can be created from the unit page AND the Utilities page
- The property trash rate read by nothing until this session
- Sub-meters were on the unit page all along but below the listing block, so
  "can't find it" and "doesn't exist" looked identical

That is the pattern worth designing against: one place per decision, and every
setting visibly connected to something that bills.

**Financed sales scope.** The code offers financed sale on RV spots as well as
mobile homes; Nic said mobile-home only. NOT changed — it is a money workflow and
he said it mid-explanation, so it needs confirming as a directive.

**Smaller:**
- `prevailing_residential_rate` has no UI field (API + engine only)
- Trash is charged separately under the MH lease — confirm the flat-rate meter
  matches what the lease says once it exists

---

## 5. TWO REAL BUGS FOUND BY GUARD TESTS

Both were caught by tripwires that exist to fail when someone adds something
without declaring it. Worth knowing they work.

- **A landlord could bill the same inherited debt twice.** "One carried balance
  per lease" was checked and then written with nothing in between — two clicks or
  a retry and both pass. Now enforced by the database.
- **A replaced unit silently lost its water fixture count**, and would then
  contribute zero to a fixture-count split — under-billing that unit and
  over-billing every neighbour on the same meter.

The same guard caught `owner_household_size` this session and asked whether it
survives a renumbering. It does — retire-and-replace is the same space with the
same people.

---

## 6. THE INTERMITTENT WHITE SCREEN — FIXED

React #310 on the property page. Three data hooks, then an early return while
loading, then a fourth hook below it: cold load ran three hooks then four, and
React refuses when the count grows. Warm cache had no loading pass, so it looked
random. It only bit on a hard reload or the first visit of the day.

Guarded by **`npm run lint:hooks`** across all twelve front-ends — currently
zero. That check is the only thing that catches this class; it is invisible to
typechecking and to every test we have. **Run it before deploying a frontend.**

---

## 7. HOW TO WORK WITH NIC (read before writing to him)

- **He does not read code.** Describe what a PERSON experiences and what it costs
  them. No column names, no route names as explanation.
- **Don't ask what he has already answered.** He described the propane delivery
  flow in full and was then asked to pick between three versions of it: *"I
  already said the flow that I want, so I don't know why you were asking
  questions."* Pause for genuine design decisions, not for confirmation.
- **When he pushes back, check whether the disagreement is about behaviour or
  about the sentence.** Twice this session the code was right and the wording
  was muddled.
- **He is right about scale.** Greyed-out rows were defended as "clearer than a
  missing row" — true at three units, useless at twenty-seven.
- **Verify before claiming something is missing.** The sub-meter editor existed;
  it was just unfindable. Check the DATA MODEL, not two likely files.

---

## 8. FILES

**New this session:** `services/rentCharge.ts`, `services/prepaidRelease.ts`,
`services/propaneFill.ts`, `jobs/autopayRunner.ts`, `routes/tenantAutopay.ts`,
`apps/tenant/src/pages/AutopayCard.tsx`,
`apps/admin/src/components/RentVolumeMonitor.tsx`, plus test files.

**Migrations applied** (dev `gam`, schema.sql regenerated):
`20260819210000_autopay_failure_tracking`,
`20260819220000_payment_revenue_owner`,
`20260819230000_carried_balance_one_per_lease`,
`20260820100000_owner_use_household_size`,
`20260820110000_owner_use_absorptions`.

**Tests:** `cd apps/api && DB_NAME=gam_test npx vitest run` — **never without
DB_NAME, it wipes the dev database.** Full run ~6.5 minutes.

**Deploy:** `bash ~/gam/deploy.sh` — ships every surface and verifies.
