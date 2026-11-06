# Session 664 handoff — the November 1 billing emergency

**Everything below is APPLIED to production.** The bills were repaired live on
Nic's instruction while residents were ringing him. Nothing is deployed to the
frontends; the API changes need a restart to take effect.

---

## What went wrong on the 1st, and why

Three unrelated causes at three parks, all surfacing the same morning.

### Country Acres — one meter held twelve households' rent

Lot 21's water meter had been replaced. On 10/28 the new head read **6** against
the old one's 5901, so the read was flagged "below the previous reading" — a
check that had been **switched off the day before** (10/31, the fat-finger
flag), but this read predated the change and the flag was already on the row.

Country Acres reviews its utility bills before they go out
(`landlords.review_utility_bills`), and an unapproved reading round holds every
invoice on the property **whole, rent included** (the three holds in
`jobs/invoiceGeneration`, S534/S558/S652). So one flagged read on one lot stopped
all twelve households from being billed. The only thing that went out was the
trailer payments, which ride their own bill — which is exactly why Troy on lot 22
saw $75 and nothing else, and why others saw a bare $100 or $200.

He was told **once**, in the app, on 10/28, and never again: he has 96
notification preference rows and **not one of them emails**. Both preference
gates were working exactly as designed. Nic found out from tenants.

### Oak Park — the master water bill had not arrived

The 16 spots on the two RUBS masters got no invoice at all, because without the
water company's master bill nobody's share could be computed, and the hold is
deliberately whole rather than sending rent with a hole in it. Nic entered both
masters at 09:37 that morning, which closed the round and wrote the October
water bills; they then needed an invoice to ride.

Separately, lots 4, 6 and 8 were billed no water. Those are **absentee** spots —
leases on spaces used like a vacation home, almost never occupied — and their
meters legitimately never turn. They had been marked **broken** instead, which
bills nothing and asks nobody. Lot 6's `46` was a mistyped read; it still reads
4600.

### Mountain View — a resident billed a month after he left

Tyler Schroeder had been gone about a month and the front desk never checked him
out. At 07:00 the bill run saw an active lease with no end date and billed him
November: $589 rent + $18.48 electric. Nic ended the tenancy from the register at
09:40. **Ending a lease does not pull a bill already issued**, so $607.48 stayed
standing.

Nothing was lost by that — it is a charge that was never owed, not income that
went missing. The cost is a wrong receivable, a bill addressed to someone who had
left, and cleanup by hand. The danger runs the other way: a charge nobody owes,
left on the books, is a charge somebody might collect.

---

## The repair that was applied

`apps/api/src/scripts/nov1_billing_repair.ts` — ran dry first, then applied.

| | |
|---|---|
| Tyler's bill | Voided whole: $589 rent off, $18.48 electric **washed** on Nic's call. Bill reads $0, status void, and it handed its due date back. RV 20's electric **baselined at 38013** so the next resident starts from there. |
| Country Acres lot 21 | Meter marked replaced with **6** as the baseline going forward. October water billed at **September's usage — 10,000 gal / $165.00**, on Nic's instruction ("bill them the water the same usage as last month"), because a cycle cannot be measured across two different heads. Flag cleared. |
| Country Acres round | **Signed off on Nic's word** rather than waiting for Blue — `completeReadingRun(run, nic, { approve: true })`. 4 bills created, $655.05 issued. |
| Oak Park lot 6 | October read corrected **46 → 4600**. |
| Oak Park lots 4, 6, 8 | Marked **"meter works, nobody using it"** (`markMeterWorksNoUse`) — the absentee flag. Zero reads now bill $0 with no flag and no estimate. |
| Reruns | `backfillInvoices` for both landlords: Country Acres **+11 invoices**, Oak Park **+16**. |

**Platform-wide verification after the repair:** every active lease on the
platform has a November bill except Mountain View 50 and 51, which are
**hibernating snowbirds** (paused 9/19) and correctly skipped. No other landlord
had an unapproved round. **Zero** flagged meter reads remain anywhere.

### Three things that looked wrong and are not

- **Country Acres lot 6 and Oak Park RV 03 show $0 owed.** Work trade. The rent
  is on the bill at full value but suspended while the hours are worked, settled
  at month close. Same for seven Mountain View bills.
- **Mountain View 50 / 51 unbilled.** Hibernating.
- **Lot 28's departing resident.** October's $24.75 water had already folded into
  their $764.35 final figure on 10/31 (the arrears trigger built that day).

---

## What was built so it cannot happen again

### 1. The month-end reminder that ignores notification preferences

New notification type **`utility_review_blocks_billing`**, declared
`critical: true` in `packages/shared/src/notificationCatalog.ts`. That is the
entire opt-out override: `createNotification` forces both channels on for a
critical type, and the settings page renders the row locked with `whyAlways`
under it. No bypass code, no new flag.

New job **`remindReviewLandlordsBeforeBilling()`** in
`services/utilityReadingRuns.ts`, wired into the 7am Phoenix block in
`jobs/scheduler.ts`.

- Fires from the **cycle month's last business day** onward, measured in the
  **property's own timezone** (Country Acres is Chicago; the reading crons run on
  Phoenix). Uses the timezone-aware `lastBusinessDay` in `packages/shared` — there
  were already two of these helpers and a third must not be written.
- Catches what the existing daily nag does not: `finishSettledReadingRuns` only
  speaks for a `double_check` run whose flags have all gone (`countFlaggedOnRun
  > 0` takes `waiting++; continue` and says nothing), and never for a run still
  `open`. Both hold invoices identically, because the hold reads
  `status <> 'completed' AND approved_at IS NULL`. Approval is that nullable
  column — **there is no `approved` status**.
- One per round per day.

**Deliberate departure from the spec, needs Nic's nod or veto.** He asked for
the last business day "plus any following days that are still at the end of the
month". That is the right place to start and the wrong place to stop — an October
round still unapproved on November 5th is still holding twelve households. So the
chase continues while the round is unapproved, and once the month turns the mail
changes from a warning to a count ("3 households have no bill"). **Clamp it back
to month end if he wants.**

`services/monthEndReviewReminder.test.ts` — 10 tests. The load-bearing one is the
**contrast case**: the same landlord, the same "no to both channels", an ordinary
utility notice writes *nothing at all*, while this one gets through. That is what
makes "the row exists" mean something.

### 2. Ending a tenancy takes back what was billed past it

New `services/leaseEndPullBack.ts` → `pullBackChargesPastLeaseEnd(client, { leaseId, endsOn? })`.

- Voids **rent, fee and late-fee** rows due **on or after** the day the tenancy
  ended, re-totals the bill around anything still real, and voids a bill left
  with nothing live on it (status void, $0, due date handed back).
- **NEVER forgives arrears.** A row due *before* that day is left completely
  alone. Someone who leaves on the 20th still owes that month. This is the line
  the tests hold hardest.
- **Utilities are deliberately untouched.** They bill in arrears, so a line dated
  after the departure can still be real usage from before it — Tyler's October
  gallons arrived on a November bill. A due-date rule would give away usage
  people genuinely had. **See the open question below.**
- Keep-everything: voided with a reason, never deleted. Each void on its own
  savepoint, so a row another record points at stays put and is reported in
  `kept` with an admin notification, instead of failing the whole move-out.
- Idempotent.

**Wired into two paths, and deliberately not a third:**

| path | |
|---|---|
| `processLeaseEnds` (`jobs/scheduler.ts`) | **The one Nic actually used** — the register's "finish check-out" calls it directly, and the 2am sweep is the same function. Gated `!handOff`: a renewal or same-household new lease ends a lease without anybody leaving, and the open items were just moved to the successor. Its own connection and transaction. Never fails the ending. |
| `terminateInTx` (`services/leaseTermination.ts`) | Early termination. This path only ever *added* money (the fee) and left a future month owed. |
| ~~`cascadeLeaseEnd`~~ (`lib/unwindIssuedLease.ts`) | **Excluded, and nine tests are why.** That cascade serves "They never moved in", Discard and Cancel reservation, whose settled rules (decisions #46.4 and #53) say the opposite: zero ONLY the move-in bill and leave a later bill, a deliberate "Charge an amount", and GAM's own declined-card fee **still owed** — in those words, in the confirm. Never moving in and moving out are different events. Converging them is a question for Nic, not a refactor. |

`services/leaseEndPullBack.test.ts` — 7 tests, including Tyler's exact case.

### 3. A dial a unit or two off is no longer called "stuck or swapped"

Nic: *"when it rolls back by 1 or 2 or forward by 1 or 2, don't flag it. It's
essentially the same meter read... And it's 1 number off."*

The closing-read flag in `services/registerFinalUtility.ts` said "the dial barely
moved, **or went backwards**... the meter may be stuck **or swapped**" — two wrong
claims. A swap shows a wholly different figure; a genuine reversal is a steady
month-after-month descent. Within the margin there is one honest reading: the dial
did not turn. Reworded. The flag stays, because a meter not turning on a space
somebody pays for is the question worth asking.

**Already correct and verified, not rebuilt:** `readingBarelyMoved`
(`READING_BARELY_MOVED_UNITS`, 10/24) already treats ±1–2 as not moving, and
10/31 wired it into `stuckOnOccupied`. Mountain View RV 25 (steady descent since
2022, wiring) and RV 39 (heavy user, 786 kWh, `expected_monthly_usage` set) were
both settled on 10/31 and need nothing.

---

## NOT BUILT — next session starts here

### A. The absentee-or-broken question (Nic's #2, agreed, not started)

His spec for the end-of-month checklist, close to verbatim: *"Hey, these meters
haven't moved, and you have a lease or some usage somewhere in the system."* So
the queue is **meters that did not move AND the space has a lease or usage** —
which drops an empty spot out by construction.

The three answers already exist in `services/meterRepair.ts` and want surfacing
as a question: `markMeterWorksNoUse` (absentee), `markMeterRepaired` (replaced,
needs the new odometer), `markMeterReadsStand` (it was reading fine, bill its own
reads). The high-usage confirmation (`high_use_confirmed_at`) is the UI pattern to
mirror — Nic described what he wants as "kind of the opposite of high users".

**There is a real backlog of 16 waiting**, all but one on occupied spaces:

| | |
|---|---|
| Never moved, 3 months identical — almost certainly absentee | Mountain View 4, 7, 8, 14, 40, 52; Oak Park lots 3, 9 and RV 20, 27, 31; Country Acres 24 |
| Moved down — look at these | Mountain View 39 (56000 → 54099, a round-number pointer misread), Oak Park RV 35 (113 → 103) |
| Only one read, nothing to compare | Country Acres 18 |
| **Empty spot, should never have been flagged** | **Mountain View 6** (40000 → 39999, one unit, nobody there) |

Mountain View 6 is a genuine small bug: `stuckOnOccupied` correctly requires
occupancy, but the **closing-read** path in `registerFinalUtility.ts:~1415` sets
`looks_broken_at` with no occupancy check, so a move-out read on a space nobody
takes afterwards leaves a flag behind. Its live `looks_broken_reason` still carries
the old wording.

**Country Acres 18 — ask Nic.** He wondered whether it is the eviction. GAM has
**no eviction tracking at all** (no table; it is still a LAUNCH.md item), so the
system cannot know. The lease reads active 8/1/2026–8/1/2031 with no move-out
mark, so GAM thinks she is there. If she has gone and Lou never ended the lease,
it is the Tyler shape again — and the pull-back now handles the money once
somebody ends it.

### B. CLOSED — the departure money rules already exist; do not touch them

I raised the final utility cycle as an open question. **Nic, 11/1: "we already
have rules for the wash don't change things."** He is right, and this is recorded
so nobody reopens it.

The rules are settled and written down: `gam-wash-is-stays-only` (the wash is
stays and RV month-to-month only; every other lease bills; three gates — money
actually arrived, at least one night used, left before the month ran out),
`gam-departure-money-fork` (half the paid nights or more used = wash, fewer =
pro-rate; a resident is priced monthly ÷ days in that month and owes no lodging
tax; the leaving day is never charged), and `gam-wash-nets-the-lodging-tax`.

**They are already reachable per-lease — no booking involved:**
`GET /api/leases/:id/departure-money` and
`POST /api/leases/:id/departure-money/adjust`, both taking a lease id and a
`leftOn`, through `services/departureReprice.ts` (`repriceDeparture`,
`adjustUnpaidDepartureBill`), with `services/earlyDepartureWash.ts` reading the
same fork so the two cannot disagree. It is a desk action, deliberately.

**Why the new pull-back cannot collide with it**, which is the thing to keep
straight:

- `departureReprice` owns the **partial month the departure falls inside** — the
  month they part-used, re-priced or washed, late fees voided.
- `leaseEndPullBack` owns **whole periods entirely after the leaving day** — a
  month nobody was there for any of, which was never owed at all.

A mid-month departure's bill is due *before* the leaving day, so the pull-back
does not touch it and the reprice handles it. Tyler's November bill was due
*after* his leaving day, so there was no partial month to price — he owed nothing
for November, and the pull-back voids it whole. Complementary by the due-date
boundary, not overlapping.

`earlyDepartureForPayer` (`services/utilityBilling.ts:~3026`) is still gated on a
booking, so the automatic final-utility path does not fire for a lease. That is
**left exactly as it is**: the desk route above is how these are settled, and the
rule is Nic's, already made.

### B2. Pre-GAM income history — decided, foundation built, rest to do

Blue asked where he types September's income for Country Acres — money residents
already paid before the park migrated — without billing anybody again.

**The existing answer, for anyone with a lease:** landlord portal → **Payments →
"Import payment history"** (gated on `payments.import_history`; the route is
`/payment-history-onboarding`, reachable only from that button). CSV, with a GAM
template and presets for Buildium, AppFolio, DoorLoop, Yardi, RentManager,
Propertyware, Rentec, TenantCloud and Square. It validates every row first, then
writes **settled** `payments` rows dated the day they actually paid **with no
invoice attached** — so no bill, no pull, no late fee, per tenant and per space
and typed. Income reports count settled payments by `settled_at`, so September
lands in September. **Nobody has ever run it: zero imported payments in
production.** Have Blue do one tenant as a test file first. The first files per
platform also raise a super-admin review banner by design.

**The gap Nic then named, and it is real.** *"We also need to have it not gated
on leases, because income that happened for a property may not attach to a lease.
If it's an RV park or a short-term stay situation, it needs to be this unit
brought this much money, attributed to this person's contact information. To
their customer, their GAM customer profile that we're making."*

That is not a validation flag. `payments` has **no** column for a person who is
not a tenant — no customer, guest or profile reference — and all 876 rows carry
both a lease and a tenant. Lease-less income has never existed in GAM.

**And the obvious route is a trap.** Importing historical stays as reservations
would write past NIGHTS, and `unit_occupancy_nights` is exactly what GAM's own
per-unit fee is computed from — so the operator would be billed a subscription
fee on income earned before they joined. It also cuts against the 10/21 sealing
rule ([[gam-nights-cannot-be-rewritten]]), whose purpose is that history cannot
be rewritten to change GAM's fee.

**Nic's two decisions, 11/1:**
1. **Its own history record** — unit + customer profile + date + amount + type.
   Never a lease, never a reservation, never billable by GAM, never collectible.
2. **Landlord and GAM only** — never shown to the person it names. Figures
   hand-entered off an old paper ledger must not reach a customer who could
   dispute them.

**BUILT:** migration `20261101180000_pre_gam_income_history.sql`, applied to
**both** `gam` and `gam_demo` (both now at **1036**). `pre_gam_income_history`:
required `unit_id`, optional `customer_profile_id` (an operator reading a
three-year-old sheet may have the space, date and amount but no legible name —
the income is still the unit's, so the row is kept with `payer_name/phone/email`
verbatim), `occurred_on`, `amount`, `income_type`, method, reference,
`import_batch_id` so a whole bad file can be voided together, soft-void columns,
and the audit trigger because it holds money. Declared in
`LEDGER_EXCLUDED_TABLES` with its reason. Ledger and migration-replay guards
green.

**FINISHED AND TESTED — Blue can import old records now.**

| | |
|---|---|
| The record | `pre_gam_income_history`, both DBs (1036). Unit required; person optional; `import_batch_id` so one bad file is one undo; soft-void; audit trigger. |
| Writing it | `services/preGamIncome.ts` — `recordPreGamIncome`, `voidPreGamIncomeBatch`, `preGamIncomeSummary`. |
| The person | Resolved through the EXISTING identity rule: a `pos_customers` row for the company, then `resolveProfile` — so same three-point matching, same refusal to guess between two candidates, one profile platform-wide. **Found before created** (`pos_customers` is unique on landlord + email, so the same guest on four lines of one sheet reuses one record — creating blindly threw on line 2 and took the file down). |
| Nobody identified | Fine, by design. Under three points GAM does not claim to know who it is; the income records against the space and the written name is kept. |
| Two who both match | Caught and recorded against the space with no person, not a failed import. A GAM admin attaches them later. |
| The import | Validate no longer refuses a lease-less line — it matches the **space** (property + number, inside the company) and warns, per line, what will happen before commit. Commit branches: lease rows to the rent rail, the rest to the history record. Two further guards downstream had to be narrowed the same way (`missing resolved lease info`, `references a lease not owned by this landlord`). |
| The CSV | New `payer_phone` column, 11th in the canonical set, aliased across all ten platforms (`phone`, `Phone Number`, `Mobile`, `Cell`…) and in the downloadable template's example row. |
| **The P&L counts it** | Nic, 11/1: *"Pnl needs to count all money from books recorded… still show all the books in one place."* `/reports/monthly-pl` adds it into `gross.total` as its own line, **"Collected before GAM"**, plus `preGamIncomeByUnit`. Also on `/reports/monthly-statement` and a dedicated `/reports/pre-gam-income`. |
| Why its own line | The ledger rebuild must be able to account for every figure on the statement, and this money is outside the period the ledger covers. Named, the gap between statement and ledger IS this line and can be explained. Unnamed, they would simply disagree. |
| The screen | Banner says what went where ("4 payments against leases, and 9 recorded as past income for their spaces (7 matched to a customer, 2 against the space alone). Nobody was billed — this is money you already collected."), points at the P&L, and lists any refused line with its reason. **No silent drops.** |

**Tests:** `services/preGamIncome.test.ts` (9) and `routes/preGamIncomeImport.test.ts` (8, through the real HTTP routes). The first assertion is that no charge, invoice, utility bill, reservation or occupancy night is created — because the whole feature is wrong if it can ask anyone for anything. Also covered: one profile for a repeat payer, "Mike" alone creating nobody, no double-count of the same line, another company's space refused, a whole batch undone, and the P&L arithmetic (rent 450 + 589 before GAM = 1039).

**Two existing tests were rewritten, not deleted** — they pinned the old refusal ("No active lease… Onboard the tenant first") in two files. Each now holds the replacement rule: with no lease AND no space it still refuses, and the message says to add the space.

### B2b. Typing it in by hand — BUILT (11/1)

I had called a single-entry screen "a convenience, not a blocker." **Wrong, and
Nic corrected it:** *"Build the way to type manual stuff in. People switching to
gam may not use software so lots of stuff may go in manual."* An operator coming
off a paper ledger has no file to upload at all, so the CSV alone leaves exactly
the people who most need the help with no way in.

**Landlord portal → Payments → "Type in past payments"** (`/type-in-past-payments`).

| | |
|---|---|
| Backend | `GET …/payment-history/spaces` (every space and who is on it, one call), `POST …/payment-history/manual`, `POST …/payment-history/undo`. |
| Both destinations | A resident → a settled payment on their lease, no invoice. A bare space → the space's past income with the payer matched to a GAM customer. Same two rails as the import. |
| Built for paper | The space is the first field. **The date, kind and method stay put between saves** — only space and amount clear — so twelve lots is: pick, type, Enter. Every saved line lists underneath with Undo, because the mistake this invites is keying the wrong lot and noticing two rows later. |
| Says which way before saving | Not only after. The two destinations are different things and the operator should know which they are about to write. |
| Not an agent action | Declared in `actionGap.ts` with the reason: every figure is on paper only the operator is holding, and these rows are income on their books. The guard that forced that declaration is working as designed. |

**Verified in the browser against the live demo data**, not just in tests: the
page loads real spaces with resident names, switches to "who paid" for a bare
space, and a save returned *"$589.00 recorded as past income for Sunset Palms RV
Resort RV 02, from Dale Okafor. Nobody was billed."* The P&L then showed it as
"Collected before GAM" with the per-space breakdown. My two verification rows
were voided out of `gam_demo` afterwards.

**Two real defects the browser found that tests had not:**

1. **No duplicate guard on manual entry.** Every manual save is its own batch, so
   the import's per-file unique index cannot see the line typed a minute ago —
   the same $589 on the same space and day landed twice. Somebody losing their
   place on a ledger is the normal case here, not the edge one. Now refused in
   plain words, with a way through for a genuine second payment of the same
   amount that day: put the check number in Reference.
2. **A space with a lease but nobody named on it read "(nobody on it)"** while
   still offering to put money on that lease. Copper Canyon House 01 is exactly
   that shape in the demo data. Three states now, not two.

Also found and fixed: a duplicate rent payment on the same lease and date was
surfacing the constraint name as a 500. The database guard is right — it is how
an operator working down a sheet double-counts a month — so it now explains
itself instead.

**Still undone:** nothing blocking. The screen handles one payment at a time and
the file handles a bulk export; between them an operator with software, a
spreadsheet or a shoebox all have a way in.

### B3. A handwritten sheet cannot be imported, and the OCR is down

Nic asked about importing a handwritten sheet of paper. **There is no path, and
the OCR GAM has is the wrong tool.** `services/licenceFrontOcr.ts` (10/29) runs
Tesseract locally — deliberately on GAM's own machine, since a licence photo is
the one category hardest to defend sending out — to read the **printed** front of
a driver's licence, and treats it as a pre-fill with a human checking it, never
the source of truth. Tesseract is trained on printed type and cannot read
handwriting; a hand-ruled page of handwritten figures in columns is close to the
hardest case there is, and a misread digit in a money import is worse than no
import.

**Defect found: that OCR cannot run at all.** `apps/api/tessdata/` does not exist
on the machine, so the engine rejects every job
(`ENOENT … tessdata/eng.traineddata.gz`). It fails soft by design, so nothing
looks broken — every guest ID silently goes to human verification instead. Small
fix (put the language data on the box), separate concern, worth doing.

**What was offered instead:** Nic photographs the sheet, Claude transcribes it
into the CSV, he checks it before Blue commits. Twelve lots is minutes and no
build, and it keeps a person on every figure — the same posture the licence OCR
already takes. A self-serve version needs a local vision model plus mandatory
confirmation of every number, which is a real build and still would not remove
the review. **Not started; needs his go-ahead and a shape.**

### D. Three pre-existing test failures that fire on the 1st of a month

**Proved not ours** — they fail identically with the new hook disabled. Last
night's suite was green on 10/31; these are month-boundary landmines.

- `routes/esign-new-lease.test.ts` ×2 — the renewal hand-off wait. The test needs
  the old lease to have an *unmade* bill, and on the 1st `unbilledDueDates`
  returns empty, so the hand-off proceeds and the old lease expires. The product
  rule is intact; the test cannot create its premise today.
- `routes/rentRoll.test.ts` ×1 — the checked-in guest's row on the Payments page.

Everything else passes: **16,645 of 16,654**, and the full set of money and
determinism guards is green (ledger source facts, ledger coverage, ORDER BY,
determinism, migration double-apply, notification catalog).

---

## Standing facts worth not relearning

- **The holds are per-property, not per-unit, once a landlord reviews first.**
  One flagged read anywhere on the property keeps the round out of `completed`,
  and the review hold then catches every unit on it. That is the shape of the
  whole incident.
- **Trailer payments ride their own bill by design.** A household on a home-sale
  contract has two bills: rent-and-water, and the trailer payment. Not a defect.
- **No lease on the platform has a `source_booking_id`** — 82 of 82 active are
  e-signed with none. So the shortened-stay machinery (`syncLeaseWithBookingDates`,
  `healLeaseEnd`, `pastEndAttemptedCharges`, `routes/stayCheckOut`) has **never
  run for a real resident**. Do not plan around generalizing it for coverage; the
  gap was the whole floor, which is why the pull-back is lease-keyed.
- Country Acres belongs to **TruBlu**, not Nic. Every write in the repair script
  is scoped to a named company.
