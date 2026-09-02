# Session 635 handoff — RUBS rebuilt on Nic's model; one meter per unit per utility

## Theme
S634 closed with the RUBS allocation model rejected outright, not just its data.
This session rebuilt it, enforced the second directive that came with it, and
re-cut Oak Park's August water.

## The two directives

> "The RUBS system needs to bill off of the total dollar amount divided by
> occupancy off the master bill. Submeters bill off of the gallons usage after.
> RUBS portion is divided out first. The RUBS people eat the full bill.
> Submeter is extra."

> "The same unit cannot have two meter types for the same utility. It can't be
> part of one RUBS system and one submeter system. It could be one in one for
> separate utilities, but not for the same utility."

## Shipped

**The pool is the whole bill.** `services/utilityBilling.ts` — the carve-out is
gone: no `excludedUsage`, no `excludedDollars`, no clamp, no "usage is needed to
subtract submeters" guard. The RUBS units divide the master bill (or master usage
× rate) whole; submetered units bill their own gallons on top. Three helpers that
existed only to price the carve-out were deleted
(`submeterCycleUsageForExclusion`, `submeterConsumptionRate`,
`estimateForUnresolvedSubmeter`).

**One meter per unit per utility.** Migration
`20260901210000_one_meter_type_per_unit_per_utility.sql` — two DB triggers
(`trg_one_meter_per_unit_utility` on the link table,
`trg_meter_utility_retype` on the meter). Enforced in the database rather than at
~call sites, per the units-wide-rules precedent. Both route guards in
`routes/utility.ts` narrowed from "one of each KIND" to "one, full stop", with
the readable error.

**Backfill (no meter deleted).** Oak Park's MH 03–09 sat on both Master 22658
Main and their own submeters — the S558 shape. The master links were removed; the
submeters, readings and history are untouched. The "duplicate 6-digit submeters"
I reported in S634 were **not duplicates**: they are Country Acres - Mattoon
units that share a unit_number with Oak Park's. No action needed there.

**A defect the new rule exposed.** `blendedRateForUnit` resolved a submeter's
master through the shared `utility_meter_units` membership — the exact link now
banned — so every blended-rate submeter would have silently fallen back to the
property rate (or zero). Rewritten to resolve by PROPERTY: SUM(bill) ÷ SUM(usage)
across the property's blended masters. Identical figure on a one-master property.

**Landlord UI.** The "Take them out of the pool by" picker is removed — it no
longer changed any number, and a dead lever reads as a real one. The submeter
RATE picker stays (still a real choice). `usageOptional` no longer depends on
`hasSubmeteredUnits`: a bill-total master never needs a usage figure now.
`rubs_exclusion_mode` is marked dead config in `packages/shared` — column and
enum kept so nothing fails to load, nothing reads either.

## Oak Park, August water — re-cut

The old model had billed **$0.00 to every RUBS unit**: MH 09's submeter was keyed
`22100 → 227700`, which priced a $2,056 carve-out against a $94.01 bill and the
clamp floored the pool.

| | before | after |
|---|---|---|
| Master 22658 Main | $0.00 to everyone | $94.01 recovered exactly ($5.22/occupant) |
| Master 22720 (Back Row) | $74.79 | $74.79 (no submeters — unchanged) |
| RV 02 invoice | $641.40 | **$646.62** (water $5.22 added) |
| RV 03 invoice | $0.00 owed | $0.00 owed — water $5.22 suspended under the work trade |
| RV 03 settlement basis | $682.35 / $17.06 per hour | **$687.57 / $17.19 per hour** |

Stale `suspended_utility_charges` needed cancelling first: the hold insert is
`ON CONFLICT DO NOTHING` against the partial unique, so regenerating bills left
eleven $0.00 holds standing. They are cancelled (never deleted) and re-derived.

## NEEDS NIC

**MH 09's water read is wrong** — `227700`, almost certainly `22770`. The reading
is now flagged for double-check and its $2,056 held charge is cancelled, so it
cannot bill anyone; it re-derives when the real number is entered. Only Nic can
supply it.

**Mountain View invites** — seven were sent naming an MH space when the resident
belongs on the matching RV space. The `pending_tenant_intents` rows were switched
(MH 07→RV 07, 08→08, 16→16, 17→17, 18→18, 20→20, 23→23); none had been accepted.
The invite EMAIL names the space, so those seven are holding an email that says
MH. Re-send is Nic's call.

## Consequence worth knowing
At Oak Park the mobile homes' water physically comes through Master 22658 Main,
yet they now pay their own gallons while the RV spots split the whole $94.01. The
landlord collects the bill in full plus the submeter usage. That is exactly what
"the RUBS people eat the full bill, submeter is extra" directs — noted here so it
is a decision on the record, not a surprise on a statement.

## Tests
`services/utilityBilling.test.ts` — the S558/S605/S607 exclusion describe replaced
with the S634 model, including the Oak Park regression (a wildly wrong submeter
read cannot move the RUBS bills) and four one-meter-per-utility cases.
`routes/utilityReadingRuns.test.ts` — the carve-out describes rewritten to the new
arithmetic; the S558 invoice gate INVERTED (a neighbour's unread submeter no
longer holds someone else's invoice). `routes/utility.test.ts` — the
"ALLOWS submeter + RUBS master" test inverted to BLOCKS.
226 tests across the five utility suites green; 213 across the eight other
meter-touching suites.
