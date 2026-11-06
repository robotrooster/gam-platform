# Session 665 — 11/2: the collection email, the checker that was wrong, and per-property books

## Theme

A morning question ("what do we have to do?") turned into three things, two of
which were GAM accusing its own operator of not paying and GAM's own nightly
check reporting a money difference that did not exist.

## Shipped, in order (each its own deploy)

### 1. Netting is the first collection route — and every reader knows it now
`landlordGamAccount.NETTING_ROUTE_SQL(l)` is the ONE definition of "GAM can
collect this without a bank pull": claimable unswept `allocation_owner_share` on
a platform-held settled payment, OR any settled payment in 35 days. Both arms
are needed — the first is momentarily empty right after a batch pays out, and a
landlord must not read as uncollectable the morning after being paid.

Used by `uncollectableLandlords()` (the gap — it had NO netting test and is what
mails people), `debitLandlordForCharges` (new outcome `awaiting_netting`, logged
INFO not ERROR), `collectionsBook()` (replacing a per-landlord query inside its
loop — also removes an N+1) and `lockCandidates()`.

**What it was:** Mountain View was mailed "Action needed: we cannot collect your
GAM balance" at 08:00 Sunday 11/1, 6½ hours after the charge was raised, with
$3,410.76 of its own owner-share on GAM's platform balance against $185.50 owed
(18x). Its last seven charges ($269.50) were every one of them netted; zero bank
pulls ever. Oak Park got the same mail 9/26. Both went to
realestaterhoades@gmail.com — Nic's own inbox.

Copy: the sentence "If we cannot collect, portal access is eventually suspended"
is gone from both the email and the in-app notice.
`gamCollections.test.ts` now fails if anyone writes suspend/block/lock/restrict
into landlord-facing collection copy, and asserts a landlord with rent moving is
never notified and never stamped.

Data: both false notices dismissed (not deleted), both `uncollectable_notice_at`
stamps cleared so a notice that genuinely applies later can still go out.

### 2. The nightly parity checker was wrong in two directions
Mountain View's reported $554.05 of unexplained October difference **did not
exist**. The books were $91.52 above the records, all of it named date
disagreements. The $554.05 was the checker's own arithmetic:
- `stayTiming` subtracted every dollar that entered `guest_deposits` in the
  month on the assumption the records billed it the same month. For a ONE-TIME
  PAY LINK they bill it the day the link was SENT. A link sent 9/18 and paid
  10/06 put $589.00 into guest deposits in October that the records had billed
  in September. Now excluded.
- Two open reservation links sent 10/24 ($24.50 + $10.45) are billed by the
  records as still-owed and have nothing on the books. `openLinksOwed` is read
  **off the records reader's own events** (`part === 'stillOwed' && category ===
  'stays_and_pay_links'`), never re-queried — the records side carries real
  conditions (one link per booking, expiry, screening-only links) and a second
  hand-written copy of them is what caused the stay bug.
- `chargeCredits` gained `includeOpening`: the opening balance is posted as
  `posting_kind='main'`, `source_type='opening'`, so the `'charge'` filter hid
  it and the reason written for it ("An old balance carried from before GAM is
  opening equity") never fired for the opening POSTING (it does fire for a
  carried-balance BILL — that case was already tested).
- All three helpers gained `ps.role = 'post' AND ps.superseded_at IS NULL`,
  which the reader they are measured against already had.

Verified through the production path: Mountain View September and October both
close at residual **$0.00** (−752.17 = −752.17; +91.52 = +91.52).

### 3. New reason — money that paid an older month's bill
`olderMonthSettlementTiming`: cash can arrive in one month and clear a bill
recorded as settled in another. The books count the cash the day it arrived; the
records count the month of the bill. Both directions, derived from the mechanism
(the two dates on one piece of money) and never from the size of the gap.

This is what Country Acres' $400 was: MH 29 paid $500 toward September, $100
early in September and $400 that reached the bank 10/05. **Nic chose to leave it
in September** — dating it to arrival would put pre-GAM rent in October income
and charge GAM's fee on it.

Also fixed the thing that was wrong either way: the 11/1 arrears script
(`nov1_country_acres_september_arrears.ts`) moved that money but left the
remittance application pointing at the October rent charge it no longer pays —
the only settled-deposit-on-an-unpaid-charge on the platform. Re-pointed at the
September carried balance; `remittance_applications` has `ledger_capture_upd`, so
the books re-projected themselves and re-categorized the $400 from `space_rent`
to `balances_collected`.

### 4. The portal lock is gone (Nic: "rip it out entirely")
Deleted: `services/portalLockSweep.ts` + test, the 09:00 cron, `middleware/auth`'s
402 `ACCOUNT_LOCKED` refusal with `lockedLandlordFor` / `isLockEscapeRoute` /
`LOCK_ESCAPE_ROUTES`, `middleware/accountLock.test.ts`,
`apps/landlord/.../AccountLockScreen.tsx` and its mount, `ACCOUNT_LOCKED_EVENT`
in the landlord and POS api clients, the `gam_portal_lock_warning` /
`gam_portal_locked` catalog entries, and `POST /api/admin/landlords/:id/unlock`.
`landlords.platform_locked_at` / `.platform_locked_reason` stay (NULL on every
company ever) with nothing writing them.

**The trade, stated to him and accepted:** S652 made this a standing rule
precisely so a person would not choose who gets locked out ("choice creates the
opportunity for discrimination"). Removing it puts that back in his hands.

### 5. Per-property books — the foundation only
Migration `20261102140000_property_books_start_date.sql`: `properties
.books_start_date` + `.books_history_start`, CHECK mirroring the landlords one
and `packages/shared BOOKS_HISTORY_STARTS`, each company's date copied onto its
properties, `idx_properties_books_start (landlord_id, books_start_date)`.
Applied to `gam` and `gam_demo`. **Behaviourally inert** — every live company
with books holds exactly one property.

## Where the three sets of books stand

| company | parked sources | unexplained | reports read |
|---|---|---|---|
| Mountain View RV Park Ranch | 0 | 0 | the books |
| Oak Park Motel and RV | 0 | 0 | the books |
| TruBlu (Country Acres) | 0 | 0 | the books |

Country Acres went from **no books at all** this morning to live: first full
rebuild run (454 sources, 0 drift, 0 failed), then its parity check run by hand
rather than waiting for 05:10.

## Next session should target

1. **The per-property engine.** `PER_PROPERTY_BOOKS_PLAN.md` at the repo root has
   the whole thing: the derived company mirror, the per-LINE posting gate, one
   opening per property with a composite `source_id`, the ~40 readers split into
   "must change" and "takes MIN and keeps working", and the ~30 tests. **The UI
   must not ship before the engine** — a date picker the engine ignores is a
   trap. Do it before Nic buys another property.
2. **business + contractors DNS** — Nic's Cloudflare. The only failing step in
   every deploy today.
3. Two stale test mocks still export `ACCOUNT_LOCKED_EVENT`
   (`SchedulePage.promisedSite.test.tsx:61`, `SchedulePage.colors.test.tsx:49`).
   Inert, but drift.
4. 90 one-off dated repair scripts now live in `apps/api/src/scripts/` and are
   compiled into the API build.

## Open questions for Nic

- The month close is company-level (`books_period_closes` has no `property_id`)
  and `ledger_posting_lines_guard()` refuses a line dated on or before the
  closed-through. A property bought in October with an October start cannot post
  if the company is closed through November. **Zero rows in
  `books_period_closes` today**, so this is owed before the first close, not now.

## Landmines found today

- **Backticks inside a SQL comment inside a TS template literal** close the
  literal (TS1005). Hit it for the second time in two days.
- `npx tsc --noEmit -p tsconfig.json` does NOT catch test-file type errors.
  Only `cd apps/api && npm run -s build` (`tsc -b`) does.
- `tsc -b` does not delete orphaned output: `dist/services/portalLockSweep.js`
  survived its source. Cleared by hand.
- `lsof -ti tcp:4000 | head -1` can return **cloudflared**, not the API. Use
  `launchctl list | awk '/com.gam.api$/{print $1}'`.
- A full-suite run can fail a single test with "timeout exceeded when trying to
  connect" under 6 workers with no zombie `ts-node-dev` processes. It passed on
  re-run. Contention, not a defect.
