# Session 663 — the marketplace goes out, financing stays in, and the migrations are fixed

**Nothing is deployed.** `gam` and `gam_demo` are both at 1,035 migrations and
identical; every suite that has finished is green.

---

## 1. Financing is held off, and it cannot turn itself on

Nic: *"I think we launch the contractor stuff now just have financing jobs off.
We still take 3 percent... Reserve pool comes later."*

`system_features.job_financing_enabled`, **default FALSE**
(`20261101020000_job_financing_held_closed.sql`). The refusal is in
`services/jobFinancing.canFinance` — the one function every quote runs through —
and not on a route, because financing has no route yet and this is what stops it
growing one that is live the day it is wired. A landlord is told:

> Paying for a job over several months is not open yet. Post the job and take
> bids now — the price you award is what you pay, and nothing here changes it.

Four tests cover the shipping default, including the one that matters: **a
missing flag row is closed, not open.** Absence is never permission.

The 46 arithmetic tests switch the flag on in `beforeEach`, so the price card,
the 25%-of-flat-rent rule and the reserve-pool arithmetic all stay covered for
the day it opens.

---

## 2. The paid top spot — the base formula and the monthly rate schedule

Nic: *"Paid spot per trade per area code should be based on cost of living in
the area. LA/NY prices don't touch Wyoming or Oklahoma. Let's figure a base
formula and a monthly rate schedule."*

### The formula

He set it in three passes: *"based on cost of living… LA/NY prices don't touch
Wyoming or Oklahoma"*, then *"30 bucks in the least expensive areas… about 100
in NY/LA"*, then *"make it cheaper in the cheap area so the curve lands at
100-120"*. The last two are anchors, so the formula is **solved from them**
rather than typed in:

```
monthly = round to the nearest $5 of   $55 x (index / 100) ^ 6
```

$19.31 at the bottom band's middle, $120.73 at the top's. Both the cities he
named land on the same number: New York 112.6 and Los Angeles 113.6 are each
$120, with the band under them at $105.

**What the exponent is actually doing, said plainly:** at the sixth power this
is no longer a price proportional to the cost of living. The index ORDERS the
areas — published fact — and the exponent sets how steeply the price climbs
across that order. The index itself only spans 83.6 to 115.6, because goods cost
nearly the same everywhere and only housing and labor move, so proportional
pricing would put Los Angeles at $75 against Tulsa's $43. The sixth power turns
that 1.38x gap into **6x**, which puts most of the revenue on the expensive
metros where the jobs are bigger and the competition for the one top spot is
fiercer. Deliberate, and written as one number in the migration rather than
buried.

### The schedule

| cost of living | $/month | areas | where that lands |
|---|---|---|---|
| under 86 | **20** | 23 | Monroe LA 83.6 · Enid OK 84.3 · McAllen TX 85.9 |
| 86 – 90 | **25** | 84 | Tulsa 89.2 · rural Oklahoma 87.8 · Albany GA 87.7 |
| 90 – 94 | **35** | 119 | Oklahoma City 90.4 · rural Wyoming 92.7 · Casper 93.8 |
| 94 – 98 | **45** | 77 | Cheyenne 96.5 · rural Texas 97.1 |
| 98 – 102 | **55** | 64 | the US average is 100.0 · rural Arizona 100.7 |
| 102 – 106 | **70** | 43 | Phoenix 103.3 · Chicago 103.6 |
| 106 – 110 | **85** | 18 | New York state 107.9 · Santa Cruz CA 109.9 |
| 110 – 112 | **105** | 6 | San Jose 110.4 · Honolulu 111.0 · Seattle 111.1 |
| 112 and up | **120** | 5 | New York metro 112.6 · Los Angeles 113.6 · Miami 114.2 · San Francisco 115.6 |

$20 in rural Oklahoma is one Angi lead. $120 in Los Angeles is a third of their
monthly package, and joining GAM is free.

### Where the index comes from

**Bureau of Economic Analysis Regional Price Parities, all items, 2024** — the
published figure to three decimals, straight from SARPP (states) and MARPP
(metros) at apps.bea.gov/regional. Nothing is interpolated, smoothed or
estimated. **439 areas**: 388 metro areas plus "the rest of <state>" for
everywhere outside one, which covers the country with no gaps.

### Why the area is a metro and not a telephone area code

One reason, and it is the whole reason: **every price has to trace to a number
somebody else published.** Cost of living is published per metro and per state.
It is not published per area code, and mapping 335 area codes onto metros would
mean inventing the figure that sets the price. A contractor who thinks in area
codes can still be shown their area by typing one — that is a lookup, not the
pricing key — and `marketplace_areas.area_kind` already admits `'area_code'` if
Nic wants the territory redrawn that way.

### The spot is exclusive

One contractor at the top of one trade in one area. That is what "the top of the
list" means and it is what makes it worth anything; the free board stays open to
everybody underneath it. At 25 trades across 439 areas that is about 11,000
sellable spots.

**What is NOT built: buying one.** The price card, the resolver, the picker and
the read endpoints are done and tested (20 service tests + 7 route tests). A
contractor who has won nothing has no GAM balance to net a monthly charge
against, so charging for a spot needs a rail that does not exist yet — and it is
the same rail as item 4 below.

---

## 3. The migrations are fixed — two squashes, and one of them was a real break

### The six job-financing drafts → one

Three of them could not be re-run against the finished table: two narrowed the
`payments` CHECK to values the final rows no longer satisfy, and one guarded its
INSERT on a note string a later file replaced, so a second pass duplicated five
brackets. On Nic's go-ahead the applied rows were deleted, the six files
replaced by one that states the agreed 34-bracket table absolutely, and the file
re-applied. **`NOT_DOUBLE_APPLY_SAFE` no longer names any of them** — the replay
test now covers `20261101004000` like every other file, and passes.

Every bracket was verified against the formula before the file was written:
`round5(job_max x 0.0235 x (payments - 1))`, 34 rows, 0 mismatches.

### The insurance projection — and this one was actually broken

`20261101002000` + its `…002100` fix both attach a trigger to
`insurance_policies`, **a table created by `…010000` — eight timestamps later.**
It worked on `gam` only because of the order the files were written that evening:
010000 was applied at 17:01 when it was the only pending file, and 002000 did not
exist until 17:40. Filename order and the order they ran were not the same thing.

So any other database could not catch up. **`gam_demo` was 24 migrations behind
and stopped dead** on "relation insurance_policies does not exist", because a
database with both files pending runs them in FILENAME order.

Fix-forward cannot reach this: the problem is a file that cannot run, and no
later file makes an earlier one run sooner. The two were deleted and re-issued
as `20261101011000_contractor_insurance_projection.sql`, after the table they
depend on, carrying their final content (COUNT(*) > 0, not a literal beside
MAX()) and fully idempotent.

**`gam_demo` is now caught up and level with `gam`** — 1,035 migrations each,
439 areas each, the projection trigger on both.

**The lesson, now in memory:** when several migrations are written in one
session the timestamps must be assigned in DEPENDENCY order, not in the order
the work happened — and `DB_NAME=gam_demo npm run db:migrate` is the only thing
that proves it, because the demo database walks the chain in filename order and
`gam` never will.

---

## 4. The contractor's side had never been deployed — now it is wired

Found while adding tests to it. The contractor's half of the marketplace lives
in `apps/business`, and that app had **no Vercel project and no entry in
deploy.sh's `FRONTENDS` list.** It had never shipped once. Landlords could post
a job and no contractor had anywhere to go, which made the marketplace half a
product.

deploy.sh's own comments describe this failure twice already — S651 for
admin-ops and books ("a surface this script does not know about is a surface
that silently falls behind") and again for the storefront — and both of those
were merely STALE. This one was never there at all.

**Nic picked both doors** ("Both, one app"), so it is wired as one deployment
with two names:

| | |
|---|---|
| Vercel project | `gam-business` (`prj_P3Cgt41jKS462Yu1jTd3aPSptLpk`) |
| primary | **business.goldassetmanagement.com** |
| second door | **contractors.goldassetmanagement.com** |

Both verified against DNS on creation — the apex was already on Vercel. Two
domains on one project means Vercel aliases both to the production deployment,
so the second door needs nothing of its own in deploy.sh and cannot drift.

Also landed, because without them the deploy would have shipped a broken app:

- `apps/business/.env.production` → `VITE_API_URL=https://api.goldassetmanagement.com`.
  The frontends build LOCALLY and ship prebuilt ([[gam-vercel-deploy-prebuilt]]),
  so each one reads its API host from its own env file at build time. Without
  it the bundle looks for the API on localhost and shows a contractor nothing.
  `VITE_MAP_STYLE_URL` is the only other variable the app reads and it has a
  working default that no portal overrides.
- `apps/business/vercel.json` — the SPA rewrite, same as every other portal.
- `apps/business/.vercel/project.json` — the link deploy.sh looks for before it
  will build an app at all.
- the `FRONTENDS` entry.

**Proven, not assumed:** `npx vercel build --prod` in apps/business completes,
and the built bundle contains `https://api.goldassetmanagement.com` and zero
occurrences of `localhost:4000`. The next `bash deploy.sh` ships it.

`apps/listings` is still in the old position — no project, no domain — and has
nobody waiting on it.

---

## 5. apps/business has tests now — it had none

Zero test files, in the app that had just been given a surface where a
contractor reads what they keep and places a price nobody else may see. It now
has its own `vitest.config.ts` (mirroring landlord's and tenant's: esbuild for
the JSX, the shared alias, jsdom, TZ pinned to Phoenix) and a first suite of 10
on `ContractorBidsPage`:

- **the board is anonymous** — the town and state render; the park name, the
  street, the zip, the landlord's name and the unit number are each asserted
  ABSENT even when the payload is made to carry them, which is the screen's half
  of a promise the API keeps with two separate selects;
- **bids stay private** — no bid count, no low bid, no spread, no "outbid"
  language reaches the page, and no request the screen makes could carry another
  contractor's price;
- **the cut is read, never assumed** — set the price card to 4.5% and the screen
  says 4.5% and never 3%, on the board AND on the sign-up copy.

deploy.sh runs and gates it beside the API, tenant, landlord and register
suites, so the screen can no longer change without something having looked at
it.

---

## 6. The money leg is what stands between here and a launch

A finished job records GAM's 3% on `platform_revenue_ledger` and **moves no
money.** Nic decided the shape on 10/31:

> "Contractors will be paid directly out of disbursement amounts from that said
> landlord. That way it's less money transfers pulling, debiting from a
> landlord's bank."

So the landlord's next payout should carry the job out of it, GAM keep its 3%,
and the contractor's net reach their Connect account. None of that is wired.
Until it is, a landlord pays their contractor the ordinary way and GAM's cut is
recorded without being collected, which breaks both "every cent through GAM" and
"GAM never absorbs".

**The pieces that exist:** `contractors.stripe_connect_*` columns;
`landlord_gam_charges` + `netAgainstDisbursement` (the netting rail that already
takes GAM's own fees out of a payout, partial amounts and all);
`platform_transfer_intents` for the outbound leg.

**The question it needs answered first,** because it is a bookkeeping decision
and not a plumbing one: `landlord_gam_charges` is *what the landlord owes GAM*
and feeds GAM's own books as revenue. A contractor's $9,700 is a pass-through,
not GAM's money. So either it rides that table under a kind the books exclude,
or it gets a table of its own. **That is one question for Nic, and it decides the
shape of the build.**

---

## 7. A bug class, closed properly

`services/marketplacePlacement.placementSchedule` had the schedule coming back
**0, 102, 108, 112, 86, 90, 94, 98** — every row correct, the whole list out of
order. `SELECT index_min::text … ORDER BY index_min` sorts the OUTPUT column, so
a number sorts as text. A test caught it before it reached a screen.

`test/orderByNamesTheColumn.test.ts` was supposed to be the guard for exactly
this and had **three holes**:

1. It only matched an explicit self-alias, `x::text AS x`. A cast with no alias
   keeps the column's name just the same. **That is how
   `services/subleaseAllocation` drew tenant credit balances down in LEXICAL
   order — '900.00' ahead of '1000.00' — while its `ORDER BY balance DESC` said
   largest-first.** Real money code, shelved subsystem, genuine bug.
2. It skipped test files, where a text-ordered amount passes today and breaks
   the day somebody changes a fixture from $200/$300 to $40/$100.
3. It flagged every cast type, so turning (2) on buried the real hits under
   dozens of `amount::float` sites that sort numerically and are correct.

All three closed; eight sites fixed (two production, six latent in tests); the
guard is green. The one case deliberately NOT claimed: a `timestamptz` cast to
text sorts by its clock reading before its offset, so the one hour a year the
offset changes it can invert — column type is not knowable from source text.

---

## What else is open

See `LAUNCH.md` — rewritten tonight with the marketplace section, and two stale
items corrected:

- **"Mountain View and TruBlu have no fee-debit bank path"** — CLOSED 10/29 by
  Nic and moved to the decided-NO list so it stops being re-proposed.
- **PM readiness item 3, "the management company cannot charge what it
  priced"** — **stale and wrong.** `jobs/monthlyFeeAccrual.ts` reads
  `pm_fee_plans` and writes `pm_monthly_fee_accruals`, `services/allocation.ts`
  routes the cut, `services/ownerStatement.ts` puts it on the statement. Zero
  rows on `gam` means nobody has set a fee plan up, not that nothing computes
  one. What survives is much smaller and real: **two of the seven fee types,
  `leasing_fee` and `maintenance_markup_pct`, are stored and never computed** —
  allocation.ts says so in a comment and the trigger was never written. A
  company pricing its work either way collects nothing, silently.

---

## Verified

- API suite: **880 files, 16,635 tests, zero failures** — run again after the
  re-price. An earlier run came back with two, both the same cause and both the
  guards working: a new money table (`marketplace_placement_rates`) has to be
  declared either journaled or deliberately not, and either booked or named as
  excluded with a reason. A price list is neither — the money is a spot actually
  bought — so it is now named in both, with the why.
- Landlord **1,417** · tenant **380** · register **15** · **business 10** (its
  first ever, now gated by deploy.sh). Every frontend suite green.
- `npx vercel build --prod` in apps/business completes and the bundle points at
  the production API, with no localhost left in it.
- Marketplace routes 64/64 · placement service 20/20 · financing 46/46 ·
  migration replay 14/14 · order-by guard 2/2 · ledger guards 42/42.
- All eight frontends typecheck clean: landlord, business, tenant, pos, books,
  admin-ops, listings, admin.
- `gam` and `gam_demo` level at 1,035 migrations.
