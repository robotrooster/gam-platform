# Session 656 — 2026-10-11 to 10-13: GAM Books on the ledger, Rent Roll, admin metrics — one deploy

Previous handoff file: `SESSION_654_HANDOFF.md` (S655's work is in its commits).

## What shipped (live 10/13, 07:30 Phoenix)

One deploy, every surface, commits `9f778cb`..`9b7da85` on `main`:

- **GAM Books replaces QuickBooks.** Every dollar posts to a double-entry ledger
  within a minute (outbox capture triggers → minute drain), checked nightly
  (04:40 tie-out, 05:10 parity). Reports read the ledger once a company's
  parity shows 0 unexplained; until then they read the money records and say
  why. Books settings (landlord's choice on every operating preference), close
  month, bank reconciliation, opening balances, one vendor list with 1099s,
  loans, fixed assets, payroll employer taxes, custom income/expense
  categories, money out = one record.
- **Bookkeeping lives in the landlord portal** (Bookkeeping menu, GAM Books
  inside). Bookkeepers: one level, a box per property (new properties arrive
  unticked), financials plus tenant names, never contact details.
- **Rent Roll + Payments, one page.** Charged / Paid / Owed side by side;
  green paid, yellow partial, orange paid late, red outstanding, gray due;
  property folders; payment health = one mark per household per bill month,
  all-time; click a name for the tenant payment report.
- **Monthly property report** emailed on the 1st/2nd with a PDF to the
  recipients the landlord picks.
- **Admin:** GAM-money bridge, recurring revenue that follows billing and
  clicks through to properties, Active units counted like billing, Metrics
  page with the state/county heat map (units / money, occupied / all), reader
  order costs (cost first, then markup).
- **Billing on the landlord's signature** for every billed document; the
  exceptions (cross-company residents, no-lease utility payers) wait for the
  resident's acceptance.
- **Work trade:** extra hours banked or paid hourly (Mark paid / Send to
  Books); coverage removal asks the landlord at that moment.
- Legacy "Add Bank Account" form removed; "ready" means a Stripe Connect
  account; Banking opens on the company that still needs one.
- Fix: accept-invite leaked a database connection on every refused link.

## Deploy record

Runbook and logs: `~/gam-backups/deploy-1013/` (backups `gam-predeploy-0521.dump`,
`gam_demo-predeploy-0521.dump`, previous `api-dist-live/`).

- Migrations: 88 applied to `gam` and `gam_demo` (883 total), expand-only.
- One-time scripts applied: 4 open $0 utility lines voided; Gerald Logue's
  $22.47 estimate voided (INV-2026-00076 $517.47 → $495.00) and his meter
  marked "works, tenant uses no power"; ledger source facts backfilled.
  Work-trade basis resync: nothing to do.
- **Not run:** the credit-history rebuild (`oct12_rerate_late_marks.ts`). It
  waits on Nic's answer about the 18 marks with no bill. The 03:00 credit
  nightly does its partial pass meanwhile.
- Ledger rebuilt from scratch for Oak Park (359 posted) and Mountain View
  (326 posted); debits = credits to the cent ($45,701.39 / $121,552.01);
  every property nets $0; integrity 0, drift 0 before and after the new API.
  TruBlu has no books start date (its choice), so nothing posts there yet.
- Two things went wrong and were fixed:
  1. `ledgerCoverage.test.ts` (10,000 payments on one unit) timed out in the
     full single-process suite. Root cause: `sync_unit_delinquency()` read the
     unit's whole payment history for every row written. Fixed with the
     partial index `idx_payments_unit_open_rent` (migration
     `20261014240200`), applied to `gam` and `gam_demo`. Suite then green:
     13,488 API, 273 tenant, 693 landlord.
  2. Every Vercel frontend failed `npm install` (ENOTEMPTY) because
     `node_modules/node_modules` was a symlink to `node_modules` itself,
     made by a verifier agent's repeated `ln -sf …/node_modules node_modules`
     in a scratch probe dir (without `-n`, the second run follows the existing
     link). Link removed; frontends republished with `--skip-tests` on the
     same commit that had just passed every suite.

## Waiting on Nic

- **Credit history:** withdraw the 18 marks with no bill? The 12 permanently
  forked chains; whether an unpaid-past-grace mark shows to other landlords;
  Rent Roll following the 10/6 hand-logged rule; two-space households.
- **Ledger edge cases:** a deleted account's replacement; the closed-month
  record; fix-on-the-day-made mode.
- **Card reader (Q11):** equipment the landlord owns, or an expense per
  piece? One Mountain View charge waits on it.
- Shortened-stay void permission; disputed GAM fee pull handling; flat-rate
  meter charge stop; fixed asset typed by hand; staff "Not rent"; bank void
  of a filed expense; company-level GAM charges default bucket.
- Scratch `*_test` database cleanup (needs OK).

## Waiting on landlords (Books settings page)

- Oak Park: where company-level costs go (1 GAM charge waits).
- Mountain View: how work-trade hours that cover rent count (2 payments wait).
- TruBlu / Country Acres: books start date, and how home sales count.

## Next-morning checks (read-only)

| Phoenix time | Job | Check |
|---|---|---|
| 18:00 tonight (Sun–Thu) | First payout run on the new code | `[auto-payouts]` in the API log; netted GAM fees write `landlord_gam_charge_collections` rows with `derived = false` |
| 03:00 | Credit nightly | `credit-nightly` lines, no errors; about 41 marks written or corrected |
| 04:40 | Ledger tie-out | integrity 0, drift 0 for Oak Park and Mountain View |
| 05:10 | Parity | 0 unexplained for both; reports then read the ledger |

## Not in this deploy (queued)

- Ledger P10 (contract phase), by design.
- L17 hold-for-review money flow in allocation, and the G5 handover facts.

## Noticed, not caused by this deploy

- `GET /api/esign/landlord-pending` answers 403 about 900 times a day (644
  before the deploy on 10/13 alone): some signed-in client polls a page it
  is not allowed to see.

## 10/13 afternoon: second deploy (live 12:16 Phoenix)

Nic answered every open question from the morning (all of them in
`~/gam-nic-answers-2026-10-13.md`), rejected the first combined-page mockup and
described the pages again; his words are in the commit `bf91965` message.
Deploy go-ahead was his ("When it's done, just deploy it too").

Shipped (`8504d2e`..`2cedcb9`):
- **Payments = the open month's Rent Roll; Rent Roll = history; tenant report
  = full history** (`bf91965`). New endpoints GET /api/balances/rent-roll/
  {properties, open-month, history}; the moved-out setting and its routes are
  gone (column `landlords.rent_roll_moved_out` left for a later contract
  migration). Household = lease. The 10/6 hand-logged rule is shared with
  credit history (services/lateness).
- **Credit** (`8b6b91e`): 12 forked chains restarted with a recorded note
  (applied: 114 subjects, 102 whole, 12 whole since a restart, 0 broken); the
  rebuild applied (128 bills changed, 18 marks with no bill withdrawn).
- **Money rules** (`1cb9d98`): disputed GAM pulls reopen as owed
  automatically; "Not rent" for owner + bookkeeper (API only, no bookkeeper
  button yet); bank void voids the filed expense; flat-meter "Stop the flat
  charge too?"; shortened-stay void for booking managers.
- **Readers, GAM side** (`cd42cf2`): dated cost corrections, missing cost in
  the morning email; nothing new booked in GAM's book (open question).
- **Ledger** (`858c1d7`): late closed-month record → replacement account
  (`books_accounts.replaced_from`); disputed pull posts a 'cancellation'.
- Tests: `TEST_APPLY_MIGRATIONS_AFTER=<newest production migration>` makes
  globalSetup apply unapplied migration files on top of schema.sql
  (`8504d2e`); this replaced the per-feature test shims.

Record: `~/gam-backups/deploy-1013b/` (backups `gam-predeploy-1212.dump`,
`gam_demo-predeploy-1212.dump`, previous `api-dist-live/`, logs). Full API
suite 13,581 passed (702 files) on the pending migrations; frontends 1,068
passed; deploy.sh run with --skip-tests on that same commit. Books after:
integrity 0, drift 0; Oak Park $45,701.39, Mountain View $121,571.36.

Open questions for Nic (28, sent by email): `~/gam-backups/deploy-1013b/
questions_for_nic.txt`. Not built (waiting on them): readers in GAM's own
book, the landlord-books equipment expense for readers, Company-column
default, hand-typed asset funding question, day-made for automatic changes,
bank-feed match for a disputed pull's return line.

First bookkeeper invited by Nic 10/13 (Mountain View, full bookkeeping;
invitation aec4a847, pending). When she accepts, set her money-in filing to
"May file any deposit" (Nic chose full bookkeeping).

## 10/13 evening: final deploy (live 16:20 Phoenix)

Nic answered every round-2 question (`~/gam-nic-answers-2026-10-13.md`,
"Afternoon answers") and said "fix all that stuff, do a final deploy."

Shipped (`4e392bd`..`a7d3715`): money rules round 2 (won GAM pull disputes
undo themselves; $15 when Stripe never states its fee; a voided bank deposit
voids its income; shortened-stay voids for owner + property managers), card
readers in GAM's own book as the full purchase (Mountain View: −$331.73 on
9/28, +$87.50 repaid 10/5), a nightly credit chain check (admin email on a
break; the restart note admin-only), GAM Books (every company-level cost to
the Company column by default — Oak Park's $6 posted; reader pieces are
Supplies when collected — Mountain View rebuilt; hand-typed assets name their
funding; automatic changes show on the day), and Payments/Rent Roll round 2
(bookkeepers read both; Outstanding Balances folded into Payments; stay money
and other money coming in; Delinquent tag; phone cards; health by lease).
Tests: API 13,694 (711 files), frontends 1,107. Books after: integrity 0,
drift 0; Oak Park nothing waiting. Record: `~/gam-backups/deploy-1013c/`.

Arturo Melendez, MH 15 (Mountain View): lease drafted into the owner's
"Waiting on you to sign" (document a2f30572…), fields set to Nic's terms
(start 10/01, $460, deposit $0, total due $460); nobody emailed. AFTER NIC
SIGNS: check October is billed once at $460 and that late fees count from
Oct 1 (Nic: "as if billed on time"); the late-bill rule counts from the day
written, so expect to adjust it.

Round-2 open questions (21): `~/gam-backups/deploy-1013c/questions_for_nic.txt`.

## 10/13 night: third deploy (live ~20:22 Phoenix)

Shipped (`e8d066c`..`cf92e44`): team invite path fixed (email link → own
pages; 24h wording; Resend/Withdraw; new account signed in once), round 3
(unfinished documents ERASED not voided unless money touched them — 8 erased
at Mountain View incl. MH 15's five forms; expenses/payroll/loans/assets placed
when logged, no default; Payments/Rent Roll polish incl. pay-link breakdowns,
stays, vacant rows, onboarding "not counted"; small money/credit/reader rules),
admin lifetime metrics (numbers only), birthday emails (landlords only until
the lease-birthdate backfill is applied — Nic's call). Map levels + 3D globe
PARKED at ~/gam-parked/map-globe-1013 (Nic: wait on non-critical; Census files
in ~/gam-geo-raw). Tests: API 13,876, frontends 1,210. Books: integrity 0,
drift 0. Record: ~/gam-backups/deploy-1013d/. Open questions (29):
~/gam-backups/deploy-1013d/questions_for_nic.txt. Arturo's MH 15: Nic signed;
waiting on Arturo.

## 10/14: answers deploy (live ~4:20 pm Phoenix)

Nic answered all 29 questions plus new requests (`~/gam-nic-answers-2026-10-13.md`,
10/14 sections). Shipped `512e96b`..`84be052`: documents deleted not voided
(invites, half-signed, subleases, automatic paths, Discard, 30-day sweep that
skips drafts waiting on the landlord), Payments/Rent Roll answers, desk picks the
bills a payment pays (each bill whole, oldest first per space), front-desk staff
see Payments without totals, returned checks / money orders / tenant check
deposits taken back automatically, money in files itself only on exact matches
(incl. Stripe ST- payouts), payroll place per employee (owner can change),
Mark paid and expense form ask, birthdays (18+, verified, current tenants,
landlord-only edits, read-only for tenants), itemized income by space type with
Detailed/Summary and an itemized monthly PDF. Tests: API 14,025, tenant 279,
landlord 918. Migrations 20261016140000..158000 on gam + gam_demo.
Production one-time steps applied (log `~/gam-backups/deploy-1014/`): late fees
removed for Selene Arvizu, Valentin Flores, Michael Moreno, Billy Miranda; Dump
station register button; MH 3.5 added, MH 11/26 $589, vacant trailers
park-owned, wide tags; Andres Razo's RV 27 stay Aug 1-Sep 1; RV 09 erased; 81
birthdays copied; storage account renamed; Mountain View work trade left_out;
both ledgers rebuilt from scratch (integrity 0, drift 0, pending 0).
PARKED (weekly limit 98%): map levels + 3D globe, faster deploys, admin Metrics
number answers 22-26 — `~/gam-parked/metrics-globe-deployspeed-1014/`.
Open edge-case questions for after the reset: in the follow-up journal
(wf_28a46c97-da9) and the Nic email of 10/14 evening.
