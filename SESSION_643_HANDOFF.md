# SESSION 643 HANDOFF — read this FIRST

Supersedes `SESSION_642_HANDOFF.md`, which was written partway through S642 and
then overtaken by the rest of the day. Durable decisions live in the memory
system (auto-loads via MEMORY.md); this file is the pointer to where the
**money** and the **live product** stand right now.

**Date:** 2026-09-14 (one long session) · **Repo:** ~/gam · **Branch:** main
**State at close:** main = origin/main, tree clean, all surfaces deployed.

---

## THE THREE THINGS THAT MATTER MOST

### 1. Pushed ≠ deployed, and it silently reverted a live fix
Ben (Benjamin Layton, therobotrooster@gmail.com — Nic's friend) pushed 9 commits to
GitHub on **Sept 5–6**. Nobody on this Mac pulled them. One was a fix Nic had taken
heat over: a tenant could not page through a lease without filling every required
field first, and a resident refused to sign until she could read the whole thing.

**It was deployed around Sept 5, then a later deploy from this Mac — built from a tree
that never had Ben's commit — shipped the pre-fix bundle over the top.** Proven by
bundle hash: the 5-day-old deployment is byte-identical to the 10-day-old one from
before the fix. Every tenant since hit the lock again.

Fixed and live now. But the mechanism is unaddressed: `deploy.sh` ships **this Mac's
working tree**, and pushing to GitHub deploys nothing.

**Do:** add a guard refusing to deploy when local is behind `origin/main`, then move
deploys to CI. Ben already has a `ci.yml` on his branch.

### 2. I failed two deploys by editing files mid-run
The test gate picks up whatever is in the tree when it runs. Twice today it caught my
half-written tests and correctly blocked everything. **Start a deploy only when done
touching files.** Drafting in the scratchpad while one runs works well.

### 3. A third "failure" was infrastructure, not code
`sorry, too many clients already` — Postgres connection exhaustion mid-suite. Eight
failures across unrelated suites is the signature. All passed in isolation; a rerun
with no code change went green. Don't chase these as regressions.

---

## SHIPPED AND LIVE TODAY

**Calvin Curtis** had two accounts — the invited one (lease, invoice, $520.20) and a
self-registered one he made after his link dead-ended. Merged by moving the EMAIL onto
the account holding the lease, never the reverse: `tenants(id)` is referenced by 56
tables and `lease_document_signers.user_id` binds a signed lease to its signer. He
signed in and paid $520.20 the same day.

**Tenant accounts have exactly two doors now.** An invite, or the screening form.
"Create account" sat beside the sign-in box and had never once been used by a resident
on purpose — only in error, by Calvin. Account creation now happens *inside* the
screening form (email + password, no name), and the standalone signup page is deleted.
The screener's **matched legal name** becomes the account's name when the report lands.

**Rent-collected emails** stated the lease's base rent, not the money. Calvin paid
$495 rent + $25.20 electricity on one intent and the landlord was told "$495.00". Now
sums the whole event and itemises it.

**Three dashboard figures reconciled.** The $460 gap between admin and landlord was one
in-flight ACH payment — three copies of one query, now one definition. `$20k` was
`$19,700.14` rounded. And "gross/obligations/fees" put a Stripe-only number beside an
all-rails number: **69% of September's money never touched Stripe.**

**Processing margin is now visible.** September: $199.12 charged, $109.65 to Stripe,
**$84.87 kept (42.6%)**. Costs are captured nightly from Stripe's balance transactions.
Stripe bills **unbundled**, so no cost attaches to an individual charge — margin is
exact by month, never per payment.

**Bank balance refresh** was running 4×/day, every day: $9.30 in August on ONE account
against $0.30 for the transaction feed it exists for. Now once daily on banking days —
1,460 calls/year → ~251.

**Landlord referral programme withdrawn** entirely (page, nav, route, 2 cards, 2
endpoints). One referral existed, Nic's own, zero commission ever accrued. The sales-rep
commission engine stays.

**Admin KPI** "Unpaid Invoices" → **"Held for Landlords"** ($3,101.82 collected, not
yet paid out).

---

## DEPOSIT TRUST — the largest piece, all preventative

Nic takes his **first real deposit within days** (Arizona RV spot, screened applicant).

| | |
|---|---|
| States with a rule | **50** — Oregon had none; California had NO residential rule at all |
| Illinois | apartments were **owed interest** with no rule modelled — 765 ILCS 715/2 |
| Size gates | count what the statute counts: **homes** for parks, **units** for buildings |
| Custody | 26 supported · 21 blocked · 3 unresearched, **fail-closed on silence** |
| GAM-held | accrues monthly, **pays annually as a tenant credit** (new) |
| Landlord-held | **flagged with an estimate, never paid** by GAM |

**`blocked` was hiding three obstacles** behind one word — this was Nic's catch, he
remembered 45–47 states being viable:
- `vehicle_unconfirmed` (8: DE GA ID IL MO ND PA TN) — a federally-insured FBO likely
  satisfies these. Idaho's text literally describes GAM's posture.
- `in_state_depository` (9: CT FL MA MI NC NH NY OK WA) — needs a bank in that state.
- `pooling_restricted` (4: AK CO KY ME) — a single pooled trust may not be allowed.
  **Column sub-accounts may unlock these.**

→ **26 today, 34 once the FBO is confirmed.**

**Arizona specifics** (Nic's own): RV spaces owe **0%** (A.R.S. § 33-2121) and the act
only applies **over 180 consecutive days**; below that no deposit statute reaches it at
all (§ 33-1308(4) excludes transient recreational lodging). Mobile homes owe **5%**
(§ 33-1431(B)) — Nic has **26 MH units at Mountain View, 8 at Oak Park**. Utility
deposits are **not** a separate legal category: § 33-2121 applies the one deposit to
"accrued rent, including utilities, and damages".

**Mattoon (IL, Country Acres)** — 11 mobile-home spaces of ~30 slabbed, ~21 homes
actual. Under Illinois' 25-**home** gate, so nothing owed. Illinois is custody-blocked,
so Nic holds those deposits and gets the advisory instead.

---

## OPEN — ordered by what bites first

1. **Column sandbox** *(Nic: "save for tomorrow")*. Read-only balance reconciliation is
   built and **dormant until `COLUMN_API_KEY` is set**. Assumptions flagged and
   env-overridable (`COLUMN_API_BASE`, `COLUMN_AUTH_STYLE`) — never run against a live
   sandbox. **Explore sub-accounts first**: they decide whether AK/CO/KY/ME open up.
2. **FlexPay float + reserve — DONE this session, numbers to revisit with real data.**
   Float target = 30% of active-lease rent + 20% utilities = **$7,804.08** today.
   Default reserve = **10% of that = $780.41**, sized as BUFFER MONTHS not expected
   loss: at 3% one bad month forces pausing enrolment, at 10% there is ~a quarter's
   cushion to see a trend and taper deliberately. Fabricated $4,200 / $26,750 balances
   (seeded 2026-05-15, never moved) zeroed to $0 — the truth, and the only way "can we
   fund 30% demand" is answerable. **Revisit the 20% utility uplift after a summer**
   (September measured 12.5%, but Arizona July AC is the peak the float must survive)
   **and the 10% reserve once real loss data exists.**
   Funding mechanics (Nic): GAM funds by the GRACE DEADLINE — the 5th in AZ, initiated
   by the 3rd — not the 1st, because the tenant was entitled to that grace anyway.
   Repayment lands the 15th-20th, so exposure is 10-15 days. That shortens RISK, not
   the target: every tenancy shares the cycle, so the float is fully deployed the 5th
   to the 20th and recycles month-to-month, never within a month.
3. **Pool yield rate is a 3.5% placeholder.** Does not affect what tenants are owed;
   does make GAM's spread figures fictional. Insert a new `effective_month` row.
4. **Home-recording screen** — `mobile_homes` is written only by the lease parser, so
   the "record the homes" to-do has nowhere to go.
5. **Annual index refresh** — IL, CT, NM track passbook rates as of Dec 31. No owner.
6. **California city ordinances** — SF, LA, Santa Monica, Berkeley, West Hollywood,
   Hayward require deposit interest state law doesn't. No city-level modelling exists.
7. **Card cost model is conservative by ~64%** — real blended rate 1.94% + $0.57 vs
   modelled 2.9% + $0.26. Let 2–3 months accumulate before repricing; 8 transactions is
   a thin sample.
8. **Ben:** the `gcp-migration` branch (18 files overlap, `landlords.ts` 16 commits to
   1), CI deploys, the deploy guard, and the listings site (`apps/listings`, complete,
   never deployed, needs a domain).

---

## DECISIONS THIS SESSION

- **Card gate stands.** Nic reversed himself when reminded Stripe bills per
  authorization: tenants add a card at the moment of payment, one auth for both.
  **Cards ARE stored on the screening charge** — that auth is already happening.
- **Deposit interest pays annually everywhere** anything is owed. Every state requires
  payment at termination; 8 also require it annually. Paying annually in a
  termination-only state is not a violation. One rule, not thirteen.
- **GAM never gates on legality.** Nic declined enforcing A.R.S. § 33-2121(C): "we give
  landlords the ability to run their properties how they want… it's up to the landlord
  to enforce." Track, never block.
- **Agents stay on the Mac** — re-affirmed against the GCP plan, which moves LLM work to
  DeepInfra and overrides the no-third-party-AI rule. Nic's instruction is newer.
- **Pricing:** not going free. A flat **$10/month per Connect account** to cover Connect
  fees, bank linking (~$10/mo/account in Financial Connections), and misc monthly costs.

## GOTCHAS WORTH KEEPING

- **`gam_test` is built from a schema-only dump.** Migration-seeded reference data does
  not exist there. Hit four times today; two tests were passing **vacuously** on empty
  tables, which reads as coverage and is worse than failing. Seed in the test, or verify
  against prod in a script.
- **`apps/marketing/vercel.json` is decorative.** `package-output.js` writes the real
  `.vercel/output/config.json` and the deploy is `--prebuilt`. A redirect added only to
  vercel.json silently never fires.
- **Only one vitest at a time** — the lock is real and the failures it prevents look
  like genuine regressions.
