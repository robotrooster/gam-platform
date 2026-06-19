# SESSION 505 HANDOFF

## Theme
GAM-for-Business backlog completion + **business bookkeeping by reusing the
GAM Books engine**. Worked the S503 "still open (business backlog)" list in
order. Agent work stayed out of scope (separate parallel window owns it).

> Window scope note: this is the GAM-for-Business / portal-feature window.
> Agent / CS-agent / guest-agent work (profiles.ts, tools/index.ts, Track A)
> is handled in the OTHER window — do not touch here.

## Shipped (in backlog order)

### #1 Per-line discounts — FINISHED (was half-built)
Recon flipped the S503 framing: backend + migration (`20260618190000`) + PDF +
email were already done by a prior session, but the frontend was incomplete
and breaking tsc (`setDiscType`/`setDiscValue` unused on QuotesPage; nothing
wired on InvoicesPage).
- `QuotesPage.tsx`: added the per-line discount control (None / % off / $ off)
  to the add-line modal.
- `InvoicesPage.tsx`: added per-line discount type/value to the form line
  model + submit payload + live subtotal preview + per-line net display
  (new `FormLine`/`blankLine`/`lineNet` helpers).
- Tests: `businessInvoices.test.ts` +4 (percent, fixed clamp, stack w/ code &
  scaled tax, percent>100→400); `businessQuotes.test.ts` +3 (percent, fixed
  w/ tax on net, percent>100→400).

### #2 Customer CSV import on CustomersPage
- Extracted the wizard's private parser to `apps/business/src/lib/customerCsv.ts`
  (single source), repointed `OnboardingWizard.tsx`.
- `CustomersPage.tsx`: "Import CSV" button + result modal (created/skipped/
  per-row errors) → existing `POST /business-customers/import`.

### #3 Customer-portal link revoke (the off-switch)
- Backend NEW: `revokeCustomerPortalTokens()` in
  `services/customerPortalTokens.ts` + `POST
  /business-customers/:id/revoke-portal-access` (owner-scoped, 404 cross-tenant).
  Earlier note "no button" was actually "no endpoint either" — built both.
- `CustomersPage.tsx`: "Revoke link" row action (confirm + result).
- Tests: `businessCustomers.test.ts` +3 (revoke kills resolution / idempotent
  revoked:0 / cross-tenant 404). Suite 41.

### #6 Business bookkeeping — reuse GAM Books (Nic decision)
Full arc, all four steps:
1. **Data foundation** — migration `20260619120000_books_business_owner_scope.sql`:
   nullable `business_id` (FK businesses) + `*_one_owner` CHECK
   (`num_nonnulls(landlord_id,business_id)<=1`) + partial index on all 9
   owner-scoped Books tables (books_accounts/bills/contractors/employees/
   transactions/vendors, journal_entries, payroll_runs, bank_reconciliations).
   Additive, no backfill.
2. **Route re-scope** — `books.ts`: `landlordScope` → `ownerScope(user)`
   returning `{col,id}` (business_id for business_owner, else landlord_id). 32
   scope sites + 48 `landlord_id`→`${col}` conversions. **Byte-identical SQL
   for landlords** (col='landlord_id') ⇒ zero regression by construction.
   Landmines kept landlord-only + blocked from business via `blockBusinessOwner`:
   `/reports/owner-statements`, `/rent-roll`, `/tax/summary`; bookkeeper section
   untouched (already role-gated). Rent/disbursement subqueries inside pl +
   cash-flow stay `landlord_id` (return 0 for a business — correct).
3. **Auth** — `requireBooksRead/Write` admit `business_owner` (with businessId).
4. **UI + seed + feature**:
   - New `bookkeeping` BusinessFeature (shared + label + desc); migration
     `20260619140000_business_feature_bookkeeping.sql` extends enabled_features
     CHECK. Off by default; owner enables in Settings → Features (auto-appears).
   - `BookkeepingPage.tsx` (route `/bookkeeping`, nav item gated on feature):
     **P&L** (date range), **Expenses** (list + add + EDIT + DELETE transactions),
     **Accounts** (chart of accounts list + seed + add).
   - `POST /books/accounts/seed` branches: `BUSINESS_COA` (Service Revenue /
     COGS / Fuel / etc.) for business_owner, `LANDLORD_COA` for landlords.
   - **P&L reflects REAL revenue**: business pl auto-pulls completed POS sales +
     collected invoices (`gamBusinessRevenue`), mirroring landlord gamRentIncome
     and the businessReports revenue definition so surfaces agree. Folded into
     net profit in the UI; backend totalIncome/netIncome stay journal-only
     (no landlord change).
   - **Transaction edit/delete**: `PATCH`/`DELETE /books/transactions/:id`
     (owner-scoped; safe in-place — books_transactions have NO balance
     side-effect, unlike journal entries). Fills an add-only gap for landlords
     too.
   - Tests: `books-business-scope.test.ts` (NEW, 7): scoped CRUD, two-way
     isolation, P&L auto-revenue (incl. excludes drafts), landlord pl
     gamBusinessRevenue=0, edit/delete + cross-owner 404, landmine 403s.

## Decisions (Nic)
- **#4 Multi-location: SKIPPED.** Recon mapped it (~25 tables); no spec; Nic
  chose to skip. Still open if revisited.
- **#6 bookkeeping: REUSE the GAM Books engine**, not a separate ledger.
- Agent work permanently out of scope in this window.

## Migrations applied
- `20260619120000_books_business_owner_scope.sql`
- `20260619140000_business_feature_bookkeeping.sql`

## Validation
- API + apps/business tsc clean; apps/business vite build clean.
- Touched suites all green together (259 tests across 9 files): books-* (141),
  books-business-scope (7), businessInvoices (43), businessQuotes (34),
  businessCustomers (41). Landlord Books behavior unchanged (regression net).
- **Run the full suite from `apps/api`** (singleFork); root `npx vitest`
  clobbers gam_test.

## Deferred / next
- **Business payroll / 1099 / vendors / bills / journal UI** — the Books engine
  is already business-scoped (API works); no business UI for these yet. P&L /
  Expenses / Accounts were the requested first slice.
- Per [[project_business_bookkeeping_reuse_books]] memory for the full state.
- Multi-location (#4) if revisited — needs a scoping spec first.
- Tax-purity refinement: business P&L revenue currently includes sales tax
  (matches Reports page for consistency); a future pass could net out tax via
  the Sales Tax Payable account.

## Memory updated
`project_business_bookkeeping_reuse_books` (full arc state),
`feedback_agent_work_out_of_scope_this_window`, MEMORY.md index.
