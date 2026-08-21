# SESSION 614 HANDOFF

End of S613. **Everything below is LIVE and deployed** unless marked otherwise.
Full suite green at close: **4,911 tests, 291 files, zero failures.**

Supersedes SESSION_612_HANDOFF.md.

---

## 0. NIC'S IMMEDIATE PATH

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

## 1. THE NEXT BUILD — UTILITY CUSTOMERS ACROSS PROPERTY LINES

**Designed with Nic this session, NOT built.** Read this before touching it; the
fee model is subtle and I got it wrong twice in conversation before he corrected
me.

### The situation

Oak Park's power and trash cross the property line. An apartment next door
(family-owned) draws Oak Park's electric; three units next door use Oak Park's
trash. Nic: *"There's a lot of landlords around the country that have pieced
stuff in over the years. Stuff has been sold, stuff is not necessarily up to code
or legal, but landlords just operate it how it was when they bought it. We should
have some smoothness to those potential hiccups."*

### The model Nic decided

**One person, one portal, one balance.** A utility-only customer gets a REAL
tenant portal account and pays their own bill — *"otherwise the landlord has to
bother to take cash from the other property."* Not a statement emailed out; the
portal.

**The $2 is per OCCUPIED UNIT — never per person, never per billing
relationship.** Two people in one unit is $2, not $4. A unit is "occupied" by the
utility-billing landlord BECAUSE OF the utilities; when a lease is later put in
place by the landlord who owns that space, it becomes physically occupied under
them. Nic: *"Think of it as being occupied by the first landlord because of
utilities, and then being occupied physically on the system because of a lease,
as a SUPERSEDENCE event."*

**The handoff has no mid-month conflict**, because of the existing no-double-bill
grace (`gam-no-double-bill-grace`): a newly onboarded landlord is free until
their SECOND billing cycle — 31 to 59 days. That second period belongs wholly to
the incoming landlord and comes off the utility-billing landlord. One $2, one
owner, no proration, no overlap.

**Same person, same login, no duplicate account** when their space is onboarded.

### What already exists in our favour

- **Every charge row on an invoice carries its own `landlord_id`.** Rent and
  electric are separate `payments` rows and money routes per row, so "one
  balance, two destinations" is an unlock rather than a rewrite.
- `payments.revenue_owner` ('landlord' | 'gam') is a DIFFERENT axis — GAM's cut
  vs the landlord's. It does not distinguish two landlords. Don't overload it.

### What has to be built

- A meter's served units may only be units at its own property. Cross-property
  service needs the other landlord's **consent** (accept/decline) — nobody
  attaches a meter to someone else's tenant unilaterally.
- Utility rows stamp the **meter owner's** landlord id, not the lease's.
- A billable party with a portal, a meter and no lease.
- The $2 follows the unit: utility landlord when no lease exists, the space's
  landlord once one does, never both.

**Nic has NOT scheduled this.** He dismissed the timing question — do not start
it without him saying so.

---

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
| Units | 30, **all `vacant`** — owner-occupied ones not yet marked |
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
`..160000_meter_reading_multiplier`.

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
