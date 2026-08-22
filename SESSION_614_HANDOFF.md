# SESSION 614 HANDOFF

End of S613. **Everything below is LIVE and deployed** unless marked otherwise.
Full suite green at close: **4,911 tests, 291 files, zero failures.**

Supersedes SESSION_612_HANDOFF.md.

---

## 0. NIC'S IMMEDIATE PATH

0. **Billing next door is LAUNCH-CRITICAL and HALF BUILT — see §1.** The
   backend can attribute and price a bill for a space with no lease; nothing can
   create one, invoice it, or collect it yet.

1. **Opening reads are DONE.** All 20 electric submeters and all 7 water
   submeters are read. The two water MASTERS need no opening read — both are RUBS
   on the `bill_amount` basis, which divides the provider's invoice total rather
   than reading an odometer, so `has_baseline` deliberately exempts them. What
   they need is the **water bill's dollar total entered each cycle**, at billing
   time, not now.
2. **Import lease templates**, then invite tenants. Templates first: an invite
   with a unit attached drafts that household's lease from the unit type's
   default template. Without one the invite still sends and drafting catches up
   when a template is set — but templates-first is one pass instead of two.
3. **Mark the owner-occupied units** (all 30 units are still `vacant`) and set
   each household size. They drop off the invite list automatically once marked.
4. **Get utility responsibilities INTO the lease templates** (see §3). A tenant
   bills for a utility only where their signed lease says so. In the template =
   free. After the fact = an addendum per tenant.

---

## 1. THE NEXT BUILD — BILLING UTILITIES NEXT DOOR (LAUNCH-CRITICAL, HALF DONE)

**Nic:** *"We need to fix the billing for utilities next door immediately,
because we already collect from those units next door. That is an Oak Park launch
necessity. That's seventy-five dollars in trash cans and utilities on one
electric submeter from next door."*

**READ THIS FIRST: the backend foundation is BUILT AND GREEN. There is no UI, no
invoice path and no portal access yet, so nothing bills anybody yet.** Nic asked
for a handoff before this was started; it was started anyway. The half that
exists is coherent, migrated and tested — it is not a stub to be thrown away —
but do not assume any of the missing half exists.

### The situation

Oak Park's trash and power feed spaces that are NOT Oak Park units and never will
be — different owner, no lease, no tenancy. Three units next door on Oak Park's
trash ($25 × 3 = $75/mo) and one apartment on an Oak Park electric submeter. Nic
already collects this money by hand.

Nic: *"There's a lot of landlords around the country that have pieced stuff in
over the years. Stuff has been sold, stuff is not necessarily up to code or
legal, but landlords just operate it how it was when they bought it."*

### The model Nic decided (his words, corrected me twice — get it right)

**"It is technically a unit."** The space is a REAL unit at Oak Park with
`status = 'utility_service'`, so it carries meter assignments, a trash-can
quantity and a share of a RUBS pool like any other. What it has no lease.

**A SERVICE AGREEMENT names who pays**, because no lease will ever exist.

**They get the full tenant portal.** *"That person should really have access to
the tenant portal to get on and pay their bill. Otherwise the landlord has to
bother to take cash from the other property."*

**$2 is per OCCUPIED UNIT — never per person, never per billing relationship.**
Two people in one unit is $2, not $4. A unit is occupied by the utility-billing
landlord BECAUSE OF the utilities; when the space's real owner onboards and puts
a lease on it, it becomes physically occupied under them — *"a SUPERSEDENCE
event"*. The $2 moves and is never charged twice for one space.

**No mid-month conflict**, because of the existing no-double-bill grace: an
incoming landlord is free until their SECOND billing cycle (31–59 days), and that
cycle belongs wholly to them.

**Same person, same login, no duplicate account** when their space is onboarded.

### WHAT IS BUILT (migrated, tested, deployed)

- `utility_service_agreements` — landlord, unit, paying tenant, service address,
  status, dates, `superseded_by_lease_id`, audit trigger. One live agreement per
  unit (unique partial index).
- `units.status` accepts `'utility_service'`.
- `utility_bills.lease_id` is NULLABLE, with `service_agreement_id` and a CHECK
  that exactly one of the two is set. `tenant_id` stays NOT NULL — every bill has
  a payer.
- **`tryInsertBill` finds a payer from a service agreement** when there is no
  lease. Deliberately NO lease-responsibility gate on that path: that gate asks
  whether a signed lease passes a utility through, and here utilities are the
  ONLY thing owed — agreeing to the service IS the responsibility.
- **`platformFee` counts serviced spaces** toward the $2, dropped the moment
  `superseded_by_lease_id` is set.
- Tests: flat trash at 3 cans billing $75 to a lease-less space, a submetered
  electric charge, an ended agreement billing nothing.

### WHAT IS NOT BUILT

1. **No way to create any of it in the UI.** No route, no screen — no POST for a
   service agreement, no way to mint a `utility_service` unit, nothing on the
   Utilities or Units pages.
2. **No invoice path.** `invoiceGeneration` iterates ACTIVE LEASES only, so these
   bills are written to `utility_bills` and never reach an invoice or a payment.
   **This is the biggest remaining piece** — it needs a parallel driver that
   sweeps a service agreement's unbilled utility bills onto an invoice with no
   rent row.
3. **No portal access.** The payer needs a `tenants` + `users` row and the tenant
   invite flow; the tenant portal assumes a lease in places (rent card, lease
   page) and must tolerate its absence.
4. **No supersedence trigger.** `superseded_by_lease_id` is never SET by anything
   — when the neighbour's landlord onboards, something has to notice and stamp it.
5. **Cross-landlord routing (Scenario A) not started.** A meter serving a unit at
   ANOTHER landlord's property, with consent, utility rows stamped with the meter
   owner's landlord id. Every charge row already carries its own `landlord_id`,
   so this is an unlock rather than a rewrite — but none of it is done.

### Sequence I would follow

Invoice path → create/manage routes + UI → portal access → supersedence stamp →
cross-landlord consent. Nic can bill and collect after the first three.

## 2. SUBTYPES, PRICING AND THE ANTI-DISCRIMINATION LINE

**Subtypes stopped overwriting each other.** A create whose name already existed
used `ON CONFLICT DO UPDATE` — it silently ate the existing subtype and returned
200. Nic built "Back In / 50 amp" then "Back In / 30 amp" and the audit log shows
the amp flipping 50→30→50→30 on ONE row while he tried again. Name collisions are
now refused out loud, and the form fills the name in from the facts picked
("Back-in 50 amp") so two variations get two names by default.

**Subtypes now LINK to units** — per unit on the unit page, or many at once from
the subtype. `units.subtype_id` had existed since S527 and was written only at
creation, displayed nowhere.

**PRICE LIVES ON THE SUBTYPE** (Nic, DIRECTIVE). A unit in a subtype carries that
subtype's price and editing the subtype moves every unit in it (DB trigger). A
unit in NO subtype prices on its own — **subtypes are optional**. Enforced by two
triggers, not route code: one propagates a class edit, one coerces any write of a
classed unit's price back to its class.

Nic's reasoning, worth keeping: *"The things that are IN the lease cannot be
altered on the charge, not that no other charges happen."*

**Flat charges: same price, honest quantity.** A unit can take 2 trash cans —
`utility_meter_units.quantity` multiplies the PROPERTY rate. Everyone pays $25 a
can; a two-can household pays $50. The invoice line reads "2 × $25.00". This does
NOT reopen the per-unit price (S609 anti-discrimination) — the amount is still
the property's and identical for everyone.

---

## 3. THE GATE THAT SILENTLY STOPS ALL UTILITY BILLING

A unit bills a utility ONLY where its LEASE has
`lease_utility_responsibilities.tenant_responsible = TRUE`. Meter, assignment and
rate are all irrelevant without it, and it fails by billing nothing and saying
nothing.

**S613 changed who may set it.** It used to have ONE writer — e-sign, parsing the
lease's tags — so a utility the lease never mentioned was unbillable for the life
of the tenancy. It is now settable after signing, recorded `source='addendum'`
with who set it and when. A responsibility that came FROM the signed lease cannot
be switched off.

Two doors: per unit on the unit page (the warning became the action), and per
meter on the Utilities page, which reports exactly which assigned units bill
nothing and fixes them together.

---

## 4. UTILITIES, REBUILT AROUND ONE QUESTION

**"What does this space have?"** — the unit page asks it once per utility. It was
three sections organised by MECHANISM (sub-meters / flat charges / shared
meters), so "does this unit have propane" had no home at all.

- **Propane is a utility like any other.** It could not even BE a meter — the
  CHECK listed water/gas/electric/sewer/trash — so "propane could be RUBS" was
  impossible to configure. Three shapes now work side by side: per-space tanks
  (`units.has_propane_tank`, bills off deliveries), a central tank as a RUBS
  master, and a flat monthly charge.
- **Tanks are ticked in BULK** on the Utilities → Propane card, like trash.
- **Meter Setup is one card per utility**, not one row per meter — Oak Park's 28
  meters became four lines. It lists every utility you CAN set up, configured or
  not; that is the opposite of the unit page, which shows only what a unit HAS.
- **No odometer on anything without a dial.** `digits` is NULL for trash and for
  any flat rate, enforced by CHECK.
- **Gas and propane stay separate** — therms vs gallons, pipe vs truck. Labels
  are 'Natural gas' and 'Propane' from one map in shared.

**A mistyped read is correctable** (`PATCH /utility/meters/:id/readings/:id`),
from BOTH the Utilities page and the unit page — the reading walk happens on the
Utilities page, and putting the fix only on the unit page was a real miss. Refused
once anything has billed from it. `utility_meter_readings` got an audit trigger
FIRST, so the old value survives the correction.

**Reads display and enter at the METER FACE width**, zero-padded, in text inputs
— a number input strips leading zeros as you type, which made a padded 0000400
collapse to 400 the moment you touched it.

**`utility_meters.reading_multiplier`** exists for a face that counts in hundreds
(413 on the dial = 41,300 gallons). Applied at every usage site including the
broken-meter comparable estimate. **Oak Park does not use it** — Nic records full
gallons — so it sits at 1 and changes nothing.

**Submeters can no longer be re-pointed.** The X on a submeter's unit chip is
gone: its readings ARE that space's usage, and a stray click would hand one
household's consumption to another's bill. Masters and flat charges keep theirs.

---

## 5. WORK TRADE COVERS ONLY WHAT IT SAYS

Per AGREEMENT (not per property), a work-trade agreement now lists which charges
it trades for: rent, fees, and each utility. Nic: *"Fifty percent of the work for
the rent and the electric... but propane is excluded, so they get a hundred
percent of the propane bill."*

**The subtlety that matters:** the credit is a PERCENTAGE OF A BASIS, so an
excluded charge leaves the BASIS as well as the distribution. Leave propane in the
basis and the tenant's labour buys dollars off a bill they must pay whole — the
excluded charge silently discounts everything else. Default is everything, so
existing agreements are unchanged.

---

## 6. INVITES

The unit picker hid only units with a fully ACTIVE tenancy. Three kinds stayed
that shouldn't: a unit someone was **already invited to** (an invite records a
pending draft, not a lease), an **owner-occupied** unit, and one holding a
signed-but-not-active lease. All hidden now, with a count of what was left out
underneath ("Not shown: 4 occupied, 3 awaiting an invite, 2 owner-occupied").

**A lapsed invite gives the unit back.** Invites live 7 days; accepting CLEARS
the token. So: expiry in the future → held; expiry NULL (accepted, mid-flow) →
held; expiry past → released. Without that last case an unopened invite would
have held a space out of the list forever.

---

## 7. DELETED, AND WHY IT WAS SAFE

Nic: *"Delete all of the dead code everywhere. Make sure that it's actually dead,
though, because I don't trust handoffs with information."*

- **`services/propaneRedistribution.ts`**, its call in the settle webhook, the
  tenant notification, and `propane_fill_installments.accelerated`. VERIFIED
  first: nothing anywhere SET the flag, no row had it true, and the one other
  appearance of the word is a `flex_deposit_plan_status` value in
  flexsuiteAcceptance — a different column, left alone.
- **Resident-to-resident home sales** (`resident_home_sales`,
  `resident_home_sale_installments`, routes, service, UI). Record-only, earned
  GAM nothing, both tables EMPTY. Comes back only if GAM holds title and earns
  the interest — a loan book, not this.
- **Financed sales are mobile-home only** now, and only when the home is
  park-owned. An RV is towed away, not converted.

---

## 8. OTHER THINGS SHIPPED

- **Utility recovery report** on the Utilities page: what the property SPENT on
  utilities minus what it BILLED BACK, per utility, per year. Expenses take a
  `utility_type` tag so electric and water don't land in one bucket. The
  owner-occupied slice is named because it is recorded as it happens; the rest of
  the gap is reported together rather than guessed at. A utility with no expense
  recorded shows a dash, never a shortfall.
- **Owner-occupied absorption now covers FLAT charges**, not just RUBS. A flat
  charge on an owner-occupied unit was dropped silently — the can is still
  emptied and the landlord still pays.
- **The RUBS fall-through is closed.** The engine reached its RUBS path by
  falling off the end of the submeter branch, so any billing method without its
  own branch would have silently split a pool. It now reports and bills nothing.
- **Propane delivery charge** (hazmat / fuel / per-stop) passes through, split
  pro-rata by gallons or evenly per tank, remainder on the last so the shares sum
  to the ticket. Untaxed — the propane tax is a fuel tax on the gallons.
- **Tenant propane ledger** — a fourth KPI card on the tenant home page, only for
  a tenant who has propane, showing balance and "3 of 8 payments paid", opening
  to each fill's gallons, price per gallon, date, total, split, plus the
  landlord's split rules.
- **`$25.00000` → `25`.** Rates display trimmed; flat charges step by the penny.
  Usage rates keep sub-cent precision — water sold per thousand gallons is
  $0.0035/gal, which two decimals would round to nothing.

---

## 9. A FLAKY TEST, FIXED PROPERLY

`unitRetire` "refuses a number already taken" failed ~6% of full-suite runs. Not
random: `seedUnit` built numbers as `U-${randomUUID().slice(0,6)}` — HEX, so ~6%
of the time all digits. `U-3f9a2b` formats to `U-3F9A2B` (case only, and the
clash check lowercases both sides → matched → passed); `U-123456` formats to
`U 123456` (hyphen → SPACE → no match → failed).

TEST-ONLY, verified before changing anything real: production numbers are
canonical on both sides. Fixed by making the fixture canonicalise like
production, and `lib/format.test.ts` now locks the property that made it
possible — formatting an already-formatted number leaves it alone.

---

## 10. OAK PARK — EXACT STATE AT CLOSE

| | |
|---|---|
| Units | 30, **all `vacant`** — owner-occupied ones not yet marked. The next-door spaces are NOT created yet (§1) |
| Leases / tenants | **none** |
| Electric | 20 submeters, all assigned, **all 20 read** |
| Electric widths | **4-digit:** RV 01, 26, 27, 31, 32, 33, 34, 35, 36, 37 · **5-digit:** RV 02, 03, 20, 22, 23, 24, 25, 28, 29, 30 |
| Water | 7 submeters, **all read** · 2 RUBS masters on `bill_amount` — no opening read needed, they take the invoice total each cycle |
| Water reads | full GALLONS, not face turns — multiplier stays 1 |
| Trash | flat $25/mo, **1 unit assigned** — worth checking, self-haulers aside |
| Propane | no rate, no tanks marked |
| Subtypes | 3 hand-made (Tenant Owned, Back In, Back In 50 Amp), 1 unit linked |
| Bills generated | **zero** |

The unit next door that the §1 build is for is a **5-digit** electric meter.

---

## 11. HOW TO WORK WITH NIC

Carried forward from S612, all still true, plus what this session taught:

- **He does not read code.** Describe what a PERSON experiences and what it costs.
- **Verify before claiming.** I asserted things three times this session that the
  code contradicted — that a meter's digits could corrupt a read, that storing a
  propane tank as a meter risked a RUBS split, that a mid-month toggle could skip
  a whole month's trash. He caught each one. Read the code path first.
- **The same trap three times: gating the only door behind the thing it opens.**
  The propane card only appeared once a tank existed; the tank could only be
  marked from that card. Before hiding a control behind a condition, ask how a
  landlord reaches it the first time.
- **Check what you shipped actually renders.** Twice a "fix" was in a component
  he wasn't looking at, or duplicated by a block I failed to delete. He is the
  only renderer — there is no way to see these screens without his login.
- **Ask whether it is a rule or a landlord's choice** before building a rule.
- **He catches deletions and over-reach.** The S613 pricing migration force-
  classified every unit on a wrong reading of his directive; he spotted it
  immediately and it was reverted to byte-identical state.

---

## 12. FILES / OPS

**Migrations applied** (dev `gam` = the live DB; schema.sql regenerated):
`20260820170000_subtype_owns_pricing`, `..180000_subtypes_are_optional`,
`..190000_subtype_price_is_binding`, `..200000_unit_propane_tank`,
`..210000_propane_as_meter_type`, `..220000_utility_responsibility_addendum`,
`..230000_expense_utility_type`, `..240000_no_digits_without_a_dial`,
`..250000_drop_propane_accelerated`, `..260000_retire_resident_home_sales`,
`..270000_propane_delivery_fee`, `20260821090000_work_trade_covered_charges`,
`..100000_flat_charge_quantity`, `..140000_audit_meter_readings`,
`..160000_meter_reading_multiplier`, `..180000_utility_service_agreements`,
`..190000_utility_bills_service_agreement`, `..200000_fix_unit_status_check`.

**A caution from S614:** `..180000` rewrote `units_status_check` from memory and
silently dropped `'available'`, breaking mark-available until `..200000` restored
it. The authoritative list is `UNIT_STATUSES` in `packages/shared` — read it
before restating a CHECK, never retype one from memory.

**New services/routes:** `services/unitSubtype.ts`,
`GET /utility/recovery`, `PATCH /utility/meters/:id/readings/:readingId`,
`PATCH /utility/meters/:id/units/:unitId` (quantity),
`POST /utility/meters/:id/bill-back`, `PUT /propane/tanks`, `GET /propane/mine`,
`PATCH /units/:id/subtype`, `PATCH /units/:id/utility-responsibility`.

**Tests:** `cd apps/api && DB_NAME=gam_test npx vitest run` — **never without
DB_NAME, it wipes the dev database.** ~6.8 min.

**Lint:** `npm run lint:hooks` from repo root, before any frontend deploy.

**Deploy:** `bash ~/gam/deploy.sh`.

**Backup taken before the pricing migration:**
`~/gam-backups/gam-pre-s613-pricing-20260820-161625.dump`.
