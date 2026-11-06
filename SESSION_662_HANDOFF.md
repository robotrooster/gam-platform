# Session 662 handoff — the contractor marketplace, and five date bugs

**Nothing is deployed.** Every migration is applied to `gam`, the suites are green,
and the tree is ready to ship when you say so.

---

## The contractor marketplace, end to end

Your dictated vision, built: a landlord posts a job, contractors bid privately,
the landlord picks one, and GAM takes 3% of the **finished** price off the
contractor's payout.

**Where to look:** landlord portal → Operations → **Contractor Bids**. The
contractor's side is the business portal → **Job bids**.

### What it is NOT

The business portal is a subscription for running your own shop; the marketplace
is a cut of won work. You corrected me mid-build and the separation is now
structural: a contractor is its own entity (`contractors`), not a `businesses`
row, and the marketplace nav entry carries **no feature flag** so it can never
drift behind the subscription.

### The settled rules

| | |
|---|---|
| GAM's cut | **3% of the finished price**, off the **contractor's** payout — you confirmed both. A `marketplace_cut_rates` price card, not a constant. |
| When it's earned | Only on a **finished** job. Nothing on a posting, a bid, or an award. One `marketplace_job_cut` row on `platform_revenue_ledger`. |
| Rate snapshot | Taken at **award** — the deal the contractor accepted. A later re-price never reaches back. The **amount** is what it actually finished at. |
| Insured / bonded | **Per job.** Nothing inherited from the property. A contractor who doesn't meet it can still bid; the landlord sees the gap named in red and may award anyway. |
| Bids | **Private.** No count, no "lowest so far", no spread — to anyone. That privacy is the product. |
| Joining | **Free.** Position is sold, presence never is. |

### The board is anonymous

A browsing contractor gets **city and state only**. Not the park name — "Oak Park
Estates, Mesa AZ" is one search from the front gate — and not the street, zip,
landlord or unit. The card says *"address when you win it"* so it doesn't read as
missing data. The full address, zip and space number arrive the moment they win.

Two separate queries (`BOARD_SELECT` / `AWARDED_SELECT`) rather than one with
fields blanked, so no single query could hand the address to a browser.

**The first version leaked the park name.** The tests now try to *find* identity
in the payload rather than checking a field is absent, which is how it slipped
through.

---

## Job financing

**No maximum job size.** The monthly payment may not exceed **25% of monthly flat
rent** — and flat rent only, no utility bill-back, no late fees, no monthly
ongoing lease fee, because all three can move. Short stays and the register count
at their **worst month out of the last six complete ones**: a park that takes
nothing in July gets nothing from stays, because a plan has to survive July.

Your own example is a test by name: one unit at $800 carries $200/month, so $400
over two payments or $800 over four, and a $20,000 roof is unreachable.

### The price

A **flat fee per month that GAM's money is out** — $235 on a $10,000 job, which is
$0.05 per dollar of GAM's money per month.

```
fee = 0.0235 x job x (payments - 1)
```

**(payments − 1), not payments.** You asked whether four payments should just be
double two; it's **triple**. GAM's money is out one month *fewer* than there are
payments, because the first payment lands the day the job finishes and the last
squares it up: 2 → 1 month, 4 → 3, 6 → 5, 12 → 11.

A flat per-month fee is exactly right because the **average outstanding is the
same 0.47 of the job whatever the plan length** — a 2-payment plan hands half
back on day one, a 6-payment plan a sixth but for five times as long, and those
cancel. Only duration differs, so no plan length subsidises another. That was the
weakness you spotted in the four-payment plan.

**Plan lengths 2, 4, 6, 12** — six and twelve on jobs over $5,000 only, enforced
by a DB CHECK. **FlexDeposit is untouched**; it keeps its own curve for its own
purpose, and the two land close at the bottom anyway ($70 vs $67 on a $1,000 job
over four payments).

| $10,000 job | fee | each payment |
|---|---|---|
| 2 payments | $235 | $5,117.50 |
| 4 payments | $705 | $2,676.25 |
| 6 payments | $1,175 | $1,862.50 |
| 12 payments | $2,585 | $1,048.75 |

One consequence nobody chose directly: the rate is **flat in job size**, so a
$20,000 job costs exactly twice a $10,000 one. No volume discount, unlike FlexPay
and FlexDeposit which taper. That follows from "flat fee per month."

### The reserve pool — the one real blocker

`financingOutlay()` states on every quote what GAM must front:

| plan | GAM fronts, on a $10,000 job |
|---|---|
| 2 payments | $4,582.50 (46%) |
| 4 payments | $7,023.75 (70%) — your 70% |
| 6 payments | $7,837.50 (78%) |

Ten concurrent $10,000 jobs on four payments needs about **$70,200** standing by.
**Where that money comes from is not decided** — GAM capital, ring-fenced
revenue, or a raise. Until it is, financing cannot launch however well the
affordability rule works.

---

## Five date bugs, one root cause

Hardening the determinism guard found a family of bugs. Two were live product
defects:

- **The Master Schedule's "today" marker was a day ahead every evening** from
  5pm. A front-desk person checking the evening's arrivals was reading the next
  day's column.
- **Card-reader installments were raised up to seven hours early**, into the
  wrong month's book — and two at once where a reader was matched late.
- The pay-ahead suggestion was **a month short** every month-end evening.
- The report summary stopped tying to its own P&L.
- The e-sign takeover's `yesterday()` had silently become **the same day** as
  today.

All the same cause: comparing a UTC clock against a local calendar date. UTC
turns over at 5pm Phoenix.

**The guard now catches the whole family.** It had two holes:

1. It decided **line by line**, so hoisting the stringify into a variable walked
   straight past it — which is how the marketplace's most important privacy
   assertion became a coin flip. It now tracks blob variables across the file.
2. It didn't know about UTC calendar days. It now flags a bare `new Date()`
   turned into a day, including through a local (`const d = new Date();
   d.setDate(...)`).

Closing those found **nine more real gambles** across six files, all fixed.

---

## Also shipped tonight

- **Insurance** has one home for all three kinds (resident liability, building,
  vendor/contractor) with a **lapse list**, and a landlord screen. A contractor's
  liability and bond now drive the marketplace's insured gate by DB trigger, so a
  policy is never typed twice. *(The projection had a bug that made every
  contractor read as insured — an aggregate with no `GROUP BY` always returns a
  row.)*
- **Owner statements** render as a PDF, email on the 3rd with delivery
  bookkeeping so a re-run can't double-send, plus an on-demand PDF endpoint and
  the owner's own screen — `/pm/my-statements` had no consumer at all.
- **Passkeys** on tenant, books, business, admin-ops and listings. Admin left
  alone — its `autoComplete="off"` is still your open question.
- **The PM Staff tab now works.** It existed but was read-only, rendered raw
  enums, and its Name column read "—" for every row because it looked for a field
  the API never sends. You can now invite by email, change what someone does, and
  switch them off.
- **A cross-company authorization hole:** any landlord could post a job against
  another landlord's property. `assertPropertyInScope` deliberately doesn't
  refuse a stranger — its own comment says so — so the company check had to be
  added, in the service rather than the route.

---

## Waiting on you

1. **Where the reserve pool's money comes from.** Blocks financing launch.
2. **Paying the contractor out of the landlord's disbursement.** You decided it;
   the rail isn't wired. Today the job and the cut are recorded and no money
   moves.
3. **Paid top-of-list placement** — per trade and per zip. Needs a price. The
   constraint that blocked it is dropped; placement gets its own table with its
   own price card.
4. **The contractor directory** — hire someone you've worked with without an open
   bid. Well-specified, not started.
5. **Re-pricing a job after it's finished.** You said it's a toughie and you'd
   figure it out.
6. **The flat map** cannot be deleted. The globe only paints places GAM is in;
   the flat map paints every area, and at city and ZIP level it's the only one
   that can render at all. Recommendation: leave it and take the item off the
   list.
7. `apps/business` has **no test infrastructure at all** — zero test files. The
   contractor screen is typechecked but never rendered in a test. Adding vitest
   there is a decision about that app's tooling.

---

## Heuristics worth keeping (all in memory)

- **A UTC month comparison against a local calendar date bills in the wrong
  month** from 5pm Phoenix at every month end. Count months on GAM's calendar on
  both sides.
- **`assertPropertyInScope` is not the company gate.** Add the `landlordScopeIds`
  check, in the service.
- **An aggregate with no `GROUP BY` always returns a row**, so a literal beside
  `MAX()` is true over zero rows. Use `COUNT(*) > 0`.
- **Generate a money table with the product's own helper.** Python's `round()`
  breaks ties to even; `Math.round` breaks up. Three brackets were $5 under
  because of it. And never test a rounded figure against a multiple of another
  rounded figure — it magnified a $5 rounding elevenfold and proved nothing.
- **A kept price-card table must be put back by any test that borrows it**, or it
  prices every later test in the file.

---

## Two things found while proving the migrations

**I repeated a documented mistake.** Six migrations were written to the
job-financing price card in one evening as the pricing was worked out live —
exactly what `gam-one-migration-per-agreed-state` warns about. Three of them
cannot be re-run against the final table: two narrow the `payments` CHECK before
6 and 12 existed, and one guards its INSERT on a note string that a later
migration replaced, so it duplicates five brackets.

They are named in `NOT_DOUBLE_APPLY_SAFE` in
`apps/api/src/routes/posPropaneProduct.test.ts` with the reason for each, which
is the sanctioned route — an applied migration is never edited. **To clear it:**
squash `20261101004000` through `20261101009000` into one migration that states
the 34-bracket table absolutely. That needs the applied rows removed and re-run,
which is your call.

**The chain cannot rebuild a database from zero** — and this has nothing to do
with tonight. A replay into an empty database stops at
`20260822220000_str_fee_three_percent.sql`, applied back in August, which writes
a `platform_fee_config` row whose effective window is computed from the date it
runs; today's date is past it, so the row now violates its own CHECK. A new
environment is built from `schema.sql` and caught up, which is what the existing
FlexPay note in that test already assumes. Worth knowing before anyone plans a
from-zero rebuild — that migration would have to be made date-independent first.
