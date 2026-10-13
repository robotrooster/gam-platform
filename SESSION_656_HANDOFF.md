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
