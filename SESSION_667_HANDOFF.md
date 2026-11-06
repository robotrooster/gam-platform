# Session 667 — the money columns, and the marketplace money leg (paused)

**Nic, 11/4:** *"We just need all the reporting fixed... we can make sure all the
numbers are derived from their original source. We don't want things drifting in
the future. Everything needs to come from the original source."*

That sentence is now a memory ([[gam-one-population-per-figure]]) because it is
the general rule behind every fault below.

---

## What he was looking at, reproduced exactly

Mountain View RV Park Ranch LLC, **October 2026**:

| line | charged | received | owed |
|---|---|---|---|
| Rent | $18,502.00 | $15,755.64 | $955.00 |
| Utilities | $1,728.93 | $1,478.19 | $0.00 |
| Home/trailer | $333.33 | $333.33 | $0.00 |
| Late fees | $590.00 | $265.00 | $310.00 |

His complaint: *"the math is not deriving right... every line is actually
wrong."*

**October's arithmetic is right.** Every dollar of each gap has a name:

| line | charged − received | owed | the difference is |
|---|---|---|---|
| Rent | $2,746.36 | $955.00 | $589.00 credit + $1,202.36 paid ahead |
| Utilities | $250.74 | $0.00 | $236.04 credit + $14.70 paid ahead |
| Late fees | $325.00 | $310.00 | $15.00 credit |

The credits are ONE resident (RV 39, $840.24 total) whose October
rent, electric and three late fees were paid **in Square** and recorded as an
account credit. That is correct by his own 10/17 directive
([[gam-offplatform-square-stays-off-books]]): Square money is reconciled by the
bookkeeper from Square and never logged in GAM, or it double-books. That $840.24
landed in the bank as a Square deposit on 10/13.

**The $971.82 of "Paid ahead, not used yet" is real**: MH 04 ($460, check ref
2107) and MH 06 ($460, cash) both paid November's rent on **October 30**, plus
$51.82 of desk cash. All of it applied to November 1 rent on November 1, so
**today** the balance is $71.00. The figure is the close-of-October balance and
the label never says so.

**There was no double counting anywhere**, which is the thing he specifically
asked to have checked.

---

## All five faults are closed. What was wrong, and what it reads now.

Every figure below was verified against the three live companies' real books —
**nine company-months, and 18 slices once each property is cut out on its own**
(the emailed monthly report is built per property, so a figure that only tied
company-wide would still have reached a landlord's PDF wrong). Zero that do not
tie.

### 1. ✅ A bill held for work trade was this month's money (the OPEN month only)

**I was wrong about this one first and the correction matters.** I told him work
trade was inside October's Charged and was "the bulk of the gap." It is not.
Mountain View is `books_work_trade_method = 'left_out'`, so once a month
settles, `projectWorkTrade` debits the very income sub-lines the charge
credited; the pair nets to zero inside the Charged column (and where both land
on the same day, `chargedEvents`' own `HAVING SUM(credit - debit) <> 0` drops
the two rows outright). October's $18,502.00 was ALREADY net of $3,478.00.

The violation was the **open month only**: November carried $3,647.68 of
labor-covered rent and electric in both Charged and Owed with nothing posted to
offset it. One predicate, `NOT_WORK_TRADE_HELD`, now covers all four figures it
touches so they cannot drift apart: the income it charges, the income listed by
account on the books P&L, the receivable it leaves open, and the proof strip's
`billed` term.

**It also repaired a number that had been going out wrong since the ledger
shipped.** The monthly property report — the portal page and the PDF emailed on
the 2nd — printed **"Covered by work trade: $0.00"** for every company, because
`beside` is filled only from the received array and a work-trade posting moves
no cash. It now prints $3,615.76 for Mountain View October, matching the proof
strip's own work-trade term to the cent, which is how we know it reads the same
money rather than making a second guess at it.

**The trap that nearly shipped with it:** `ledgerParity` carried an *explained*
reason for the old difference. Fix one half without the other and parity fails,
`ledgerLiveCompanyIds` drops the company, and **every report for Mountain View
and Oak Park silently reverts off the books onto the money records** — still
rendering, now answering a different question. Both halves moved together and
`ledgerParity.test.ts` now fails if anyone reintroduces one alone.

### 2. ✅ The Charged breakdown was structurally dead on the books path

`moneyViewFrom` has carried four buckets for Charged since the records path was
built (`MoneyTie.charged`) and **the ledger path filled none of them**: ledger
charged facts were built with `part: null`, so every report a company on the
books could open returned `collected $0 + clearing $0 + owed $0 + other <the
whole total>` — a total with every part empty, which explains nothing. That is
why the page showed him three numbers and said nothing about how they relate.

Fixed by a fourth kind of out-of-column ledger fact, `ledger: 'part'`, built
from **the same income facts that make the Charged column**, each bill's total
split by what its own receivable did. Mountain View, October, his own lines:

| line | charged | = collected | + clearing | + owed at Oct 31 | + settled without money |
|---|---|---|---|---|---|
| Rent | $18,502.00 | $16,958.00 | $0.00 | $955.00 | $589.00 |
| Utilities | $1,728.93 | $1,492.89 | $0.00 | $0.00 | $236.04 |
| Late fees | $590.00 | $265.00 | $0.00 | $310.00 | $15.00 |
| Home/trailer | $333.33 | $333.33 | $0.00 | $0.00 | $0.00 |

His own *"nothing maths out exactly right except for the home and trailer
payments"* is the proof of the shape: that is the one line with nothing in the
fourth bucket.

**`other` is a residual on purpose**, so the four can never fail to add back to
Charged — which means asserting that they do is worth nothing. The honesty
check is therefore a different one: `chargedPartFacts` computes `other` a
SECOND time, per group, from independent sources — the receivable's own
non-money credits (`billFates`) plus that group's income that was not a charge
(`chargedOffsets`, a read of its own) — and returns the difference as `drift`.
The two agree **to the cent on all three companies across every slice
measured**. `chargedEvents` logs `[CHARGED PARTS DRIFT]` on every charged
report when it is non-zero, because an invariant checked only against fixtures
is not checked (his 11/4 directive).

**As of the period's END, not today** — his 11/3 rule that a card headed with a
month must not carry a figure from outside it. October's card says what October
looked like on October 31 and never moves again. The records path reads each
bill's status *today*; that is the one place the two paths answer different
questions, and the period-end reading is the correct one for a month's card.

### 3. ✅ Two different questions were both called "Owed"

The **Owed column** is the whole receivables balance at the period's end, every
unpaid bill including months before this one. It has to be: the proof strip ties
to it and so does the nightly parity check. The **owed bucket** is this
period's charges only. At Mountain View the two coincide ($1,265.00 — nothing
carried in), which is exactly why **a fix validated only against Mountain View
would look right and ship broken**: Oak Park's October column is $8,694.17
against a bucket of $4,187.30, and TruBlu $4,413.50 against $2,734.30. Now
saved as a memory ([[gam-two-kinds-of-owed]]).

The column keeps its meaning; the page now says which is which, and the proof
strip accounts for the difference in words: *"Owed $4,506.87 at the end of Sep
30, 2026 + billed $13,767.50 − received against bills $8,959.53 − credits given
$12.47 − work trade $560.31 − paid from money paid ahead $47.89 = owed
$8,694.17 at the end of Oct 31, 2026."*

### 4. ✅ Labels that lied — one fixed, one REJECTED on the evidence

*"It's showing paid ahead, not used yet... $971.82. That does not seem
accurate."* It was accurate — two residents paid November's rent on October 30 —
and the figure is a **balance on the period's last day** where everything beside
it is a flow through the period. Undated it reads as today's money, and today it
is $71.00. It now reads **"Paid ahead, not used yet on Oct 31, 2026."** (The tax
route has dated this figure since it was built; this says it everywhere else.)

**The "Credits given" relabel was dropped, and the reason is worth keeping.**
The plan was to say "paid outside GAM" using `tenant_credits.issued_by_landlord`.
Every live credit row predates the migration that added that column, so they all
read `false` as the **un-backfilled default**, not as a statement about who
issued them. Labeling off it would assert something the data does not support.
Saved as [[gam-credit-issuer-flag-is-unbackfilled]]. Do not revive it until the
rows are backfilled.

### 5. ✅ The explanation was computed and thrown away

- **The charged sentence is back on the books path.** It had been dropped
  because the buckets were all zero, so it read "$0.00 is collected, $0.00 is
  still owed" with the whole total in a bucket called *other* — worse than
  silence. Each report now carries three sentences: what the received money was
  for, what became of what was charged, and the proof strip.
- **`other`'s wording was simply untrue.** It said "has no outcome yet." It is
  money that was never going to BE money, and it now says so: *"settled without
  money (a credit you gave, work trade, or a balance written off)."*
- **Every row that fails his own check now explains itself on its own row**, and
  only those rows: the page shows the breakdown when `charged − received ≠ owed`
  and stays silent when the subtraction works, because a note on every row is
  noise. Four component tests hold the exact rendered sentence.
- **The dashboard's income card is one population now.** It printed "of $X
  charged: $Y collected, $Z still owed" built from three unrelated reads —
  `collected` a flow through the month, `clearing` hardcoded `0`, `stillOwed`
  the cumulative balance. A test literally encoded `amount 1300, collected 400,
  stillOwed 1200`: 400 + 0 + 1200 = 1600 against a total of 1300. All four
  figures now come from the same `part` facts and add back to the total; 18
  income cards checked on production, 0 that do not tie.

### The bug my own verification could not see

Worth recording as a method lesson, not just a fix. The first cut of the part
facts pooled every income line with **no bill behind it** — a register sale, a
stay, other income all share the same null lease and null payment — into ONE
group dated on its earliest day. Two separate production diagnostics said it
tied, on nine company-months and 18 per-property slices, **because both read one
month at a time and within one month the pooling is invisible.**

`/reports/summary` reads **twelve** months in one call and slices the facts back
into months afterwards; the landlord dashboard reads six. On that read the
pooled fact landed its whole amount in the first month with books: **+$1,100.96
into September 2026, −$949.49 out of October, −$151.47 out of November.** A
consumer audit of every code path that walks the billed facts found it and
measured it. The fix: a no-bill fact now gets its own fact on its own day and is
never pooled, a bill's group is keyed by month as well, and `billFates` reads a
fate **per month-end** — the same list `owedSnapshots` already reads the
receivables at, so a month's buckets and its Owed column are as of the same day.

The drift check had the same disease: formulated over the whole period, it fired
$8,458.87 on a six-month read. It is now computed **per group**, where the
identity actually holds, and a fourth diagnostic
(`diagPartsMultiMonth.ts`) exists specifically to exercise the long-read slice
that the other three cannot reach. Three unit tests on `chargedPartFacts` lock
the grain in.

### Fixed in passing (each one found while in the file)

- **A proof-strip regression I caused myself**, within an hour: an earlier patch
  this session used the `ledger === 'proof'` branch as its anchor and *replaced*
  it instead of inserting before it, so every strip read `billed $0.00`. The
  diagnostic script caught it on the next run.
- **A permission leak I was about to introduce.** `viewForViewer` dropped tie
  sentence **index 1** by position, which was only ever right because the books
  path happened to put its proof strip there. Adding the charged sentence back
  would have shifted the owed-naming strip past the filter and shown on-site
  staff the figure decisions #25 removes. Replaced with `tieTextNoOwed`, chosen
  where the sentences are written. Three test assertions that matched the strip
  by array index were changed to match it by content, for the same reason.
- **`dropOwed` now strips `parts` too.** The four buckets add back to Charged,
  so leaving them would have handed a staff viewer the owed figure by
  subtraction.
- **Paid-ahead money on hand was presented as "(beside the total)"** in the
  books' Ledger Statements — the one presentation `booksMoney.splitBeside`
  exists to prevent, because that money is already counted *inside* the total on
  the day it arrived. It now gets its own line with the counted-note, as the
  P&L page has always shown it.
- **A false mechanism claim in my own 11/3 directive comment** (it said the
  `HAVING` drops the settled pair; it nets them in the column instead).
- **A guard against a silent money bug**: `REPORT_LINES` and `ASIDE_LINES` must
  stay disjoint or the out-of-column facts start landing in `beside` figures
  with nothing failing. The near-misses are real — `creditsGiven` beside
  `creditsYouGave`, `workTradeDiscount` beside `workTrade`. Now asserted.

### Not a bug — checked and dismissed with evidence

- **The `POSTING_FLAGS_SQL` posting-level test** was on the open list as a
  latent bug: it decides "paid-ahead or credit given" with `bool_or` across the
  whole posting rather than per line. **Not reachable.** Production holds 64
  `credit_use` postings; every one is exactly two lines with exactly one credit
  kind, because `creditSide()` picks one role per branch. And a realized swap
  would move no total — both terms enter the strip's sum with the same sign, so
  the blast radius is two display labels. **Do not "fix" it to line level:** the
  `ob` flag must stay posting-level or four real "Balance carried over" rows at
  TruBlu stop classifying as openings. What *is* undefended is `creditSide()`
  returning one role — nothing asserts it.

---

## State of the tree — NOT DEPLOYED

The live API on :4000 is `dist/index.js`, **started Nov 3 16:38 and serving
real traffic** (the log shows residents and staff hitting it from outside).
Nothing in this session is live. Deploying is Nic's call
([[gam-never-deploy-without-goahead]], [[feedback-build-one-fix-deploy-repeat]]).

What is verified, as of the end of this session:

- **Production figures:** 72 slices across four read-only diagnostics — every
  month per company, every property on its own, every income card, and the
  month slices cut out of a 12- and a 6-month read — **0 that do not tie, 0
  drift warnings.**
- **Tests:** the API's full suite is **888 files / 16,736 tests, all passing,
  zero failures** (509s). For comparison, the 11/3 deploy log shows that suite
  at "2 failed | 16,724 passed (16,726)" — both of those now pass. The landlord
  portal is green too (82 files, 1,440 tests). API, landlord and books all
  typecheck clean.
- **Parity:** all four landlord/books file pairs are byte-identical
  (`financials/incomeBasis.ts`, `financials/ReportsPage.tsx`,
  `bookkeeping/LedgerStatements.tsx`, `bookkeeping/booksMoney.ts`).
- **Tests that had to change, and why.** Eleven assertions moved. Four in
  `rentHealth.test.ts` encoded the money card still charging a work-trade-held
  bill ($2,509 → $2,049, 40% → 49%) — that is the 11/3 directive, and the test
  comments said "that card is unchanged", which it no longer is. Two in
  `reportsOnTheLedger.test.ts` encoded a card whose own figures did not add up
  (stillOwed 1200 against a total of 1300). Three matched the proof strip by
  array index and now match it by content. The rest are the new `other` field
  on the income card's shape.

---

## Two decisions waiting on Nic

1. **`monthMoneyBuckets` — the dashboard's month card — is still a second
   population.** Its own three figures are exact to the cent and tie to the
   Outstanding card, so it is not broken; it answers a slightly different
   question. Folding it onto the income facts would **move a number he sees**: it
   counts every `payments` row that is not GAM's, so a $112.50 security deposit
   due 2026-11-01 sits inside its Charged today and would vanish; and it nets
   every applied credit off every bucket where the income facts keep paid-ahead
   money inside Charged ($976.23 in November). Its `earlierOwed` has no
   counterpart on the income facts at all, and the Outstanding card's "this
   month is a slice" sub-line reads it. **His call whether the card's Charged
   should change.**
2. **The emailed monthly property report has no paid-ahead line**, because that
   report is built per property and the paid-ahead balance that exists is
   company-wide. Adding it needs a per-property figure that does not exist yet —
   a small new read, and a new line on a landlord's PDF.

---

## The marketplace money leg — PAUSED mid-build, deliberately

Nic approved it: *"Contractors will be paid directly out of disbursement amounts
from that said landlord. That way it's less money transfers pulling, debiting
from a landlord's bank."* Then the reports problem interrupted
([[feedback-fix-the-interrupt-then-return]]).

**State:** a finished job records GAM's 3% on `platform_revenue_ledger` and
moves no money. `contractorNet` is computed at `services/marketplace.ts:466`
and returned only for display.

**What was established, which is the expensive part and should not be redone:**

- The money system knows exactly two payees. BOTH tables carry an XOR CHECK:
  `held_payout_items_one_payee` and `platform_transfer_intents_one_payee`,
  `(landlord_id IS NULL) <> (business_id IS NULL)`. A contractor is
  deliberately neither — migration `20261101000000` states it: *"a contractor is
  its own entity with its own money model, NOT a `businesses` row."*
- Widening ONE table is worse than widening neither: the held line writes
  happily and the payout then fails with the money already claimed.
- Everything downstream is already generic: `lockHeldItems` filters on payee and
  nothing else, so a new source type is swept automatically;
  `createPmCompanyTransfer` takes a bare `acct_*`.
- **`reconcileBusinessHeldFunds` (`heldPayouts.ts:246-278`) is the template to
  clone**, but ADD the available-balance cap the landlord path has — the
  business path has none, which is the exact S650 failure.
- **The written migration is parked** at
  `/private/tmp/claude-501/-Users-nicholasrhoades/3eb7bc06-4d6f-4ff4-b4e3-38f9c9e5c452/scratchpad/marketplace-paused/20261104093000_a_contractor_is_a_payee.sql`
  — moved out of the migrations folder so a reports deploy cannot apply a schema
  change for an unbuilt feature.

**THE DESIGN QUESTION STILL OPEN, and it is his to answer.** The sweep takes a
line whole or not at all, and `owed <= 0` **rolls the whole batch back**. So a
$4,200 job at a park collecting $800 a week means the landlord gets **no payout
at all** — that week and every week — until about six weeks of rent accumulates
and flushes. I offered him the whole-job version before checking this and had
to correct it. The three options put to him (take it in pieces and pay as
collected / whole job with screens / cap what a job can be) have not been
answered; he sent a message instead of picking.

`netAgainstDisbursement` (`landlordGamAccount.ts:215`) already does
partial-with-carry and is the precedent for the "pieces" option — but
`landlord_gam_charges` is "what the landlord owes GAM" and carries a threshold
and a last-resort bank debit, which a contractor pass-through must never
trigger. So it wants its own store with the same collection behavior.

**Also fixed-in-flight and needed either way:** `left_owing_share` is written
(`leftOwingCollection.ts:855`) and handled in NEITHER the projector switch nor
`listSources`, while `ledgerDueFromGamCheck` sums every held item with no
filter. The first real left-owing collection would throw the collecting
landlord's books into a nightly drift alert for exactly their 15% share. Not yet
fixed — it was going to ride along with the marketplace projector work.

### Marketplace decisions he gave on 11/4 (all new, none built)

- **Paid top spot: one zip per COMPANY, total.** A company doing HVAC and
  plumbing can hold the top spot in each trade it does, but **only in one zip
  code**. *"We want to give the little guys a chance. Small business needs to
  thrive, not corporate stuff buying all the spots as advertising space."*
  Price is the area's band ($20 Monroe → $120 New York), one zip's worth.
- **The duplicate-company hole is closed by EIN, not by matching phones.** His
  answer: *"They can make whatever account on GAM they want, but they have to
  verify with a real EIN number."* One verified EIN, one company, one zip.
- **The trade list does not cover his trades.** `CONTRACTOR_TRADES` is just
  `MAINTENANCE_CATEGORIES` reused — general, plumbing, electrical, hvac,
  appliance, landscape, pest, cleaning, roofing, structural, pool, locksmith.
  He named pump, electrician, plumber, **welder**, AC repair, landscaper,
  **framer**, **drywall**, **finish work**. The last four have nowhere to go,
  and the paid spot's exclusivity is defined BY this list, so a missing trade
  means two plumbers under different names. Bring him the list to edit.
- **Contractor directory: build it.** And it is load-bearing, not a nicety —
  "extra work is a new job" only works if a landlord can hand that work to the
  same contractor without running a whole bid again.
- **Re-pricing, his design (11/4):** the bid is the price; the winner goes to
  site for a real estimate; that earns them **one** re-price; the landlord must
  accept it or the bid reopens — or the winner falls out and the runner-up is
  contacted. He asked for feedback and said *"I'm not in that field, so I can't
  really say how the real world works."* My feedback already given: drop the
  "or that day" window (marking complete should BE the commitment, with no
  clock and no timezone to argue about), and an increase over the winning bid
  needs the landlord's agreement while a decrease does not.
- **Job financing pool: GAM operating money only**, with a ceiling. He
  considered rolling FlexDeposit money into a split pool; asked which pile he
  meant, he answered **"GAM's money only"** — the deposit custody balance is NOT
  deployed. Do not raise it again without him.
- **Booking site: a real page builder**, not branding-only. Its own project;
  deliberately not opened mid-marketplace.

---

## Read-only tooling left behind

Four scripts under `apps/api/src/scripts/`. All read-only — they write nothing.
Each answers a question the others cannot, which is the point: the first two
both missed a real bug, and the fourth exists because of it.

| script | what it proves |
|---|---|
| `diagMonthColumns.ts [YYYY-MM]` | both ties, the per-line columns and buckets, `beside` and every tie sentence, per company per month |
| `diagPartsEveryProperty.ts` | the buckets tie on every PROPERTY slice, not just company-wide — the emailed monthly report is built that way |
| `diagIncomeCard.ts` | the dashboard income card's four figures add back to its own total, both scopes |
| `diagPartsMultiMonth.ts` | **the month slices out of a 12- and 6-month read** — the only one that can see a mis-dated fact |

Run as `DB_NAME=gam npx ts-node src/scripts/<name>.ts`. Current state: **72
slices across all four, 0 that do not tie, and 0 drift warnings.**

The assertions are no longer only in a script, which is what the 11/4 directive
asked for and what the two dead frontend guards never were:
`chargedPartFacts` returns its own `drift`, `chargedEvents` logs
`[CHARGED PARTS DRIFT]` on every charged report when it is non-zero, and the
grain is held by unit tests.
