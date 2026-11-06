# Session 666 — two live UI regressions, and the per-property books engine

## What Nic brought

1. **Blue cannot scroll any tab** on his Chromebook. Left column scrolls, page content does not.
2. **The Mountain View desk computer cannot drag reservations** on the master schedule; Nic's Mac can.
3. **Credit save-up should be a per-property choice** — Mountain View may save up, Oak Park and Country Acres may not.
4. **The per-property books engine** — "the data exists for every property… let's work on stuff."

Nic also corrected two things worth keeping:
- **No browser-support floor.** "I am not making building decisions off of Blue's Chromebook… we're going to build a product that works with modern technology." The dvh fix stands on its own as a regression we shipped, not an accommodation.
- **Don't stop to deploy each item.** "why are you deploying the drag fix when we still have other stuff to build… we need to keep getting stuff done." Deploys are fine, but they do not gate the next piece of work.

---

## 1. Blue's scrolling — OURS, not Chrome's (shipped, verified live)

His Chromebook is auto-update-expired and sits on **Chrome 103** — found in the
API log: 747 requests from `X11; CrOS x86_64 14816.131.0 … Chrome/103`. `dvh`
arrived in Chrome 108, and a unit a browser does not know is not approximated —
**the whole declaration is dropped.**

On 10/30 `.app-shell` and `.main-content` changed from `height:100vh` to
`height:100dvh`. On Chrome 103 the shell then had no height at all, grew past a
body that is `height:100%` + `overflow:hidden`, and the browser clipped
everything below the fold **with no scrollbar anywhere**. The sidebar kept
working because it is anchored `top:0;bottom:0` rather than by a height — which
is exactly the split Nic described.

**Verified from the Vercel deployment history**, not inferred: every production
landlord build from **Fri Oct 30 11:24 PM** onward carried `100dvh`; the one
before it carried `100vh`. Blue first hit it on Monday. I initially told Nic the
break was three days old by the CSS comment date and then that it matched his
"yesterday" — both were guesses; the deployment history is the answer.

**Fix:** one `--vh` token per portal, declared in `vh` and upgraded to `dvh`
behind `@supports (height: 1dvh)`. Modern browsers still get `dvh` and the
phone address-bar behaviour it was added for. Applied across landlord, tenant,
pos and storefront, inline styles included (a React style object cannot hold two
same-named keys, which is why it is a custom property and not a duplicate
declaration).

**Guard:** `apps/landlord/src/styles/viewportHeight.test.ts` fails the build on
any bare `dvh` length outside the token, and on a portal that reads `var(--vh)`
without declaring it. Proved it fails by reintroducing the bug.

Confirmed live by fetching the stylesheet production serves: `.app-shell{height:var(--vh)}`,
`--vh:100vh` with the `@supports` upgrade, and the only remaining `dvh` behind
that guard.

## 2. The schedule drag — Firefox, not rendering (shipped)

The desk computer loads the master schedule on **Windows Firefox 157/158**
(12 loads in the logs); Nic's Mac is Safari 26. The reservation bar carried
`userSelect: 'none'`, and in Gecko the drag gesture runs through the selection
machinery — content marked unselectable cannot start a native HTML5 drag.
WebKit and Blink decoupled those years ago, which is why it looked like a
rendering fault on one machine. The mark was dead weight: S575 moved the guest
names to the floating overlay, so the bar carries no text to protect.

**Not reproduced** — Firefox is not available on this machine. This is the only
difference I can find on that code path and the fix costs nothing, but the
confirmation is Nic clicking a bar on that computer.

Two defects fixed in the same pass:
- The grab position was read from `e.nativeEvent.offsetX`, which is relative to
  the event's **target** (the ack dot or the stated-stay ring when the grab
  lands on one) while the width it was compared against is the bar's — and
  Firefox reports `offsetX` as 0 on dragstart, so every grab there read as the
  left edge and turned a move into a resize. Now `clientX` minus the bar's own
  `getBoundingClientRect().left`.
- The grab-hand cursor appeared for staff who may not edit reservations, on a
  bar that is `draggable={false}` for them.

**Guard:** three tests in `SchedulePage.colors.test.tsx`, including one that
fails if any draggable bar carries `user-select: none`. Proved it fails.

## 3. Credit save-up — already built; values set

`properties.credit_save_up_allowed` shipped 10/26 with the toggle on each
property's page and **all four payment paths** reading it: the resident's app
(`rentCharge`/`payments`), the front desk (`manualPaymentSettle` →
`RecordPaymentWindow`), the card reader (`readerChoiceParams`), and the agent
(`recordCashPayment`). Nothing to build.

Country Acres was already `false`. **Set Oak Park to `false`; Mountain View
stays `true`.** The desk folds across the bills a credit would pay, so the
"Save it for later" button disappears only when every target property says no.

---

## 4. Per-property books — step 1 and the engine, done and green

`PER_PROPERTY_BOOKS_PLAN.md` was **rewritten** against the code after eight
agents verified it. Read that file, not this section, for the remaining work.

**Eight agents verified the 11/2 plan.** It was wrong in ways that would have
cost a session each: `ledgerSourceDiff.ts` does not exist (it is `diffSource`
inside `ledgerEngine.ts`); its consumer is `ledgerCheck.ts`, not
`ledgerParity.ts`, and with repair on a gate divergence is a nightly re-post
loop plus a notice each run, not a report; `books_fixed_assets.property_id` and
`books_loans.property_id` are **nullable and forced NULL** when the cost splits
by units, so those readers need a company-MIN fallback and are not clean swaps;
and `tenant_declared_deposits` has no `property_id` at all.

**Three things the plan missed that would have been silent:**
- `projectOpening` answered an unrecognized source id with `return []`, and an
  opening that returns no lines **supersedes the one on the books** — a
  composite id would have taken the balance sheet's opening away with nothing
  failing.
- `markOpening`'s outbox insert cast the whole source id `x::uuid`, which throws
  on every per-property key.
- `books_loans_asset_guard` reads the books start through `landlords` and the
  plan never named it. Found by asking the database which functions mention
  `books_start` instead of reading the plan's list.

**And one the plan asserted that is not true any more:** "every existing opening
item reads as stale for all three live companies" — `books_opening_items` holds
**zero rows**, as do `books_fixed_assets`, `books_loans`,
`books_period_closes` and `ledger_close_balances`. There is exactly **one**
opening posting platform-wide (Mountain View, 2026-09-01, two property-scoped
lines).

### Shipped
- **Three migrations.** The company's date is now a derived mirror of
  `MIN(properties.books_start_date)` (loop-freedom verified against every
  trigger on both tables); the two asset/loan guards moved to the property;
  `ledger_source_errors.property_id` so a parked source names the property it
  waits on; and one statement-level trigger so a property's date change marks
  the opening **once**.
- **The posting gate is per LINE.** Safe because `ledger_postings_balanced()`
  groups by `property_id` — verified against the live data: of 2,660 postings
  not one names two properties, no per-property group is unbalanced, and the
  minimum group is two lines. The plan missed that the same trigger refuses a
  posting with fewer than two lines, so the gate drops the whole posting when
  the remainder is too small to be one.
- **One opening per property, plus one for the company's own.** Bank items have
  no property, so they land in the company's opening, whose day IS the company's
  earliest — which makes the stale-item test come out right with **no special
  case**.
- **The drain fans a company-level opening mark out to its properties.** TEN
  trigger functions and a route queue an opening by the bare company id;
  teaching each would be ten places to get right now and one more per future
  projector, and getting it wrong is silent. One place instead.

### Still to do (all behaviourally inert today)
Every remaining reader is identical today because **every company with books
holds exactly one property**, so the company's earliest IS its property's. They
diverge the moment a second property has a different date, which is why they are
owed **before the next purchase, not before this deploy**: `loansAssets`,
`booksVendorsLoans`, `booksSettings` opening-item entry (where `kind='other'`
has no way to name a property — a new wire field, not a swap), the three
`ledger_capture_books_fixed_assets_*` keyset functions, and the UI, which must
never ship ahead of the engine.

`declaredDepositExpiry` and `ledgerTenantChecks` are **already done** — the
first because reading the company's date there would judge a resident on a bank
match that could never have happened, which is a strike on a real payment
history.

---

## 5. The month close went per-property too — Nic chose it

I put the fork to him and recommended the cheap option. He answered **"number
1"**: the close becomes per-property. Built the same session.

A close row now names a property (NULL = the company's own slice, the same split
the opening uses). `ledger_closed_through` takes a property; the per-line guard
asks about the line's own property and names it when refusing.

**The one thing that would have been catastrophic and silent:** the guard reads
the line's property, so if it had shipped while `closeMonth` still wrote a single
company-level row, that row's `property_id` would be NULL and the close would
have covered only the property-less lines. Closing November would have stopped
protecting the rent — no error, no finding, a month that says closed and accepts
postings. So the service writes one sibling row per property in the same action,
and closing behaves exactly as it does today.

Three readers had to learn that "the close" means the primary row, or the
balance snapshot (which hangs off the primary) and "the latest close" (which was
now a sibling) disagree and every closed month reads as drift. Three existing
tests caught that within a minute of the change, which is the system working.

Nothing is closed anywhere on the platform — `books_period_closes` held zero rows
— so none of this changed a number.

## Not ours

`business.goldassetmanagement.com` has no Cloudflare record, so it is the one
failing step on every deploy. Nic's.

---

# 6. The dashboard's three "still owed" figures — BUILT 11/3

Nic: *"It needs to be a grand fucking total of every outstanding money owed to
us. So how can 14,000 dollars in this month be higher than the total outstanding
from the other months? ... it's going to be confusing to fucking everybody. It
doesn't flow good. It doesn't fit. We need a different better layout."*

## What was wrong

Three figures, each individually correct, with nothing forcing them to nest —
and a card headed "This month" carrying a CUMULATIVE balance. The $14,391
decomposed exactly into FIVE things, only the first of which is this month's
owed:

```
 7,691.66  this month, actually owed
+  615.00  earlier months
+1,701.92  money clearing at the bank   (already paid — never owed)
+3,647.68  work trade                   (hours pay it — never charged, never owed)
+  735.15  (a figure that moved during the diagnosis — ten charges settled at
            Mountain View at 12:57 while this was being traced)
```

## What was built

- **`monthMoneyBuckets`** (`apps/api/src/lib/rentCollected.ts`) — one month's
  money from ONE population of charges, so `charged = collected + clearing +
  stillOwed` to the cent, work trade is beside them and in neither, and
  `stillOwed + earlierOwed` is exactly `outstandingBalanceOf().outstanding`.
  Takes the month as its first day and derives the end in SQL so a caller
  cannot pass a window that disagrees with itself.
- **The dashboard route** sends it as `month_money`.
- **The money card** reads it: Owed is this month's, and the note is a
  subtraction that subtracts. The old one mixed a month FLOW, a hardcoded `0`
  and a cumulative BALANCE and was **$218.76 out** — `billedPartsAddUp` existed
  to catch exactly that and returned false on the real reply, because it was
  only ever run against hand-typed numbers.
- **The Outstanding card** is UNCHANGED in value (it was right) and now shows
  this month and earlier months as sub-lines. Its label stopped saying "open",
  which silently meant *payable right now*.
- **Work trade** has its own line saying it is in neither figure.

## Four invariants, pinned by tests that check no dollar figure

`apps/api/src/lib/monthMoneyBuckets.test.ts` (4) and one end-to-end card test in
`apps/landlord/src/pages/DashboardPage.test.tsx`. They deliberately assert
RELATIONSHIPS, not amounts, because the amounts move as residents pay:
the parts add up to charged; work trade is in neither charged nor owed; clearing
is charged but never owed; and this month + earlier months === Outstanding, so
this month can never be the larger number.

## Two things I got wrong, corrected

1. I proposed making Outstanding the grand total by **adding the clearing money
   in** ($9,042 → $10,744). That breaks `openBalances.inFlightRowSql`: clearing
   money is *"Already paid — never owed and never late (decisions #29)"*.
   **Outstanding was correct all along.**
2. I flagged a conflict between Nic's "short hours bill in December" and
   `workTradeSettlement.ts`'s "never bills a shortfall". There was none — the
   code already keys on `tracks_hours`, exactly as he said. See
   `[[gam-work-trade-is-never-that-months-money]]`.

## Note on the parity guard

`financials/incomeBasis.ts` must be byte-identical in `apps/landlord` and
`apps/books`. I changed one word in the landlord copy, the deploy's
`financials-parity.test.ts` refused to ship, and nothing went out until both
were synced. Edit both, always.

## Closed on this screen

Property health used the bare word "owed" for its own question (this month's
rent, invoiced − paid) ten lines from a table using "Owed" to mean the
all-months balance. It now reads **"Rent still owed"**, and the subtraction
beneath it ends "= $X of this month's rent still owed"
(`financials/incomeBasis.ts` `RENT_HEALTH_FIGURE_LABEL`, both apps). The word
no longer means two things on one screen.

---

# EMERGENCY FIX, same day — the Reports tab filters by company or property

**Nic, 11/3, on his way out:** *"The financials tab, when you click on the
reports tab at the top of that page, it filters and down by the bottom, it
shows you a breakdown per month. But there's no filter to sort that monthly
itemized monthly breakdown by property. Or by company. So you can't choose
TruBlu Management or Oak Park Motel and RV until after you click into a
specific month. And we want to be able to review yearly style thing, the one
that's on that page filtered by a company."*

## What it does

**Reports → Overview now narrows to one company, or to one property**, from a
single control at the top. **Every figure on the tab narrows together** — the
KPI cards, the by-month chart, the year-to-date curve and the Monthly Breakdown
rows. Narrowing only the table would have left account-wide cards sitting above
a one-company table, which is the same confusion he called out on 10/3 ("three
different balances … that is a huge confusion problem").

The page then **says what it covers**, above the figures and in the Monthly
Breakdown's own heading — and that line PRINTS, because a printed page of
figures has to name its subject.

Clicking a month opens that month's P&L **already on the chosen company**, which
closes the loop on "you can't choose … until after you click into a month".

## One control, not two — and why

Every company he operates holds exactly ONE property (Mountain View RV Park
Ranch LLC → Mountain View RV Ranch; Oak Park Motel and RV LLC → Oak Park Motel
and RV; TruBlu Management LLC → Country Acres). A Company dropdown beside a
Property dropdown would have listed "Oak Park Motel and RV LLC" in one and "Oak
Park Motel and RV" in the other: one answer asked twice, which is exactly the
layout he has already told me reads badly.

So **the companies are the rows**, and a company's properties sit indented
beneath it **only where it holds more than one** — the only case where "the
company" and "the property" are different questions. A single company holding
several parks is a plain property list, like the dashboard's. One company
holding one property is the whole report already, so the control renders
nothing.

## A payout is per COMPANY, and the screen now admits it

`disbursements` carries a `landlord_id`, never a property. Filtered to a
company, "Paid out" is that company's payouts alone — which is the Mountain
View / Oak Park split he reads when two payouts land on the same day. Filtered
to **one property of a company holding several**, there is no such figure, so
the cell prints "—" with "A payout is per company, not per property" on hover,
rather than showing the whole company's money beside one park's income.

## Files

- `apps/api/src/routes/reports.ts` — `GET /reports/summary` takes `landlordId`
  and `propertyId` (the spellings `/monthly-pl` and the dashboard already use).
  A filter can only ever NARROW: it is checked against the viewer's own scope
  (which is also where the control's options come from, so the control can
  never offer a slice the server then refuses), it intersects a team member's
  property assignment rather than replacing it, and a company/property pair
  that disagree is refused rather than one silently winning. The reply carries
  `scope.companies` — the viewer's WHOLE scope, never the narrowed one, or
  choosing a company would collapse the control to that one option with no way
  back. `isAdmin` became `platformWide` at the four sites where that is what it
  actually meant, which is also what lets an admin naming a company read it the
  way its owner does.
- `apps/landlord/src/financials/ReportsPage.tsx` (+ the byte-identical
  `apps/books` copy) — `ScopePicker` and the four helpers behind it.
- `apps/api/src/routes/reportsScopeFilter.test.ts` — 8 tests, through the real
  route on real Postgres.
- `apps/landlord/src/reportsScopePicker1103.test.tsx` — 10 tests, the control's
  shape plus the whole tab end to end.

## What the tests pin, and why they are shaped that way

The server tests assert **relationships between the slices**, not dollar
figures, so they say something true about the rule instead of restating the
fixture:

- **the slices add up to the whole** — company A's figures plus company B's are
  the unfiltered account's, for `thisMonth`, for the year, and for the monthly
  rows. A filter that double-counted, dropped a company, or quietly ignored the
  parameter breaks this one assertion.
- the filter narrows and never widens — another account's company (403), its
  property (403), a mismatched pair (400), a junk parameter (ignored, page
  still loads).
- a payout follows its company and never another one, and reports as absent for
  one property of a multi-property company.
- the options are the whole scope even while narrowed.

## The table is a ROLLING TWELVE now

**Nic, immediately after:** *"12 rows on the table for rolling 12 at a glance."*

The Monthly Breakdown was the last 6 months; it is now this month and the
eleven before it. **Rolling, not a calendar year** — a calendar year shrinks to
one row every January, which is the opposite of a trailing-twelve review.

### The bug that was waiting inside that change

`/summary` read the payout column through **`NOW() - INTERVAL '6 months'`** — a
SECOND copy of the window, sitting beside the `months` the rows are built from.
Widening the rows to twelve without widening that interval would have printed
**$0 Paid out on the six oldest rows**, and nothing on the screen would have
looked wrong. The window now comes from `months` itself (`tableStart`), so the
two cannot drift again, and `reportsScopeFilter.test.ts` pins it: the OLDEST row
in whatever window the server returns has to carry **both its money and its
payout**. That test calibrates off the reply rather than computing a date of its
own, so it cannot rot on a month boundary or in an evening UTC run.

**I proved the guard bites** before shipping: with the interval put back to six
months the new test fails with the oldest row's payout at `+0` against an
expected `250` while its `$444` of income comes through — exactly the silent
half-failure it exists to catch.

### I was wrong about the cost

I told Nic twelve rows would double the per-company expense pass and warned him
off it. **Measured read-only against production**, that pass is 13–34 ms for
both companies at either six or twelve months (it is fully parallel and the
queries are small at this data volume), and the income window is byte-identical
in rows and time because neither company has money before January. **The cost I
flagged does not exist at this scale.** Watch it again at 11k units, not before.

The table now says its own window out loud — "The last 12 months, newest first"
— because a trailing-twelve review is only readable if you know it is twelve and
where it ends.

## One more thing the filter needed

The picker's options are **remembered** (`lastScope`). Without that, a failed
request on a narrowed slice would render the error with no control left to get
back to every company, and only a page reload would recover.

## The gate earned its keep again

The first deploy of the rolling twelve **failed the suite and shipped nothing**:
`routes/reportsReviewFixes.test.ts` carried two bare `expect(...monthly.length)
.toBe(6)` assertions on the window size. They are now 12, with the reason
written beside them.

**How they got missed:** the sweep for stale `monthly.length` expectations was
piped through `head -20`, and that file sorted past line 20. A truncated sweep
reads exactly like a clean one. The redone sweep — no truncation, 40 matches
read — also established the thing that makes the rest of them safe: **widening
the window can only ADD months**, so every test that looks up a specific month
keeps passing, and only length assertions and all-row sums could break. All 11
suites that touch `/reports/summary` were then run together: 248 tests green.
