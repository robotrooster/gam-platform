# Per-property books start date — state of the work

**Nic, 11/2:** "If I have one property now and I buy another property later, my
books for that property are going to start from when I bought that property.
Whether or not it's the same LLC is irrelevant. It's a completely separate
business revenue stream."

**Nic, 11/3:** "we need to keep getting stuff done."

Rewritten 11/3 after eight agents verified the 11/2 plan against the code and
the live database. Where the old plan and the code disagreed, the code won and
this says so, because the old plan's line numbers and two of its claims were
wrong in ways that would have cost a session each.

---

## The three facts the design rests on (all re-verified 11/3)

1. **A bank account cannot be split between properties.** `bank_connections`,
   `bank_transactions`, `bank_reconciliations`, `bank_reconciliation_items` have
   no `property_id`. (`bank_deposit_slips` DOES have one — the 11/2 plan said
   otherwise.) So the company keeps a date of its own, and it is the **earliest
   of its properties'**, which is also simply true: a company's books begin when
   its first property's do.

2. **No posting mixes two properties, and each property's slice already
   balances on its own.** Of 2,660 live postings (1,926 `post`, 734 `reversal`)
   not one names two properties. `ledger_postings_balanced()` groups by
   `property_id` with `HAVING sum(debit) <> sum(credit)`, the NULL-property
   group included. **So the gate can be per-LINE with no new schema.**

3. **A posting must have at least two lines.** The same trigger raises on
   `n_lines < 2` — which the 11/2 plan missed. Every per-property group in the
   live data has at least two lines and none is unbalanced, so dropping one
   property's lines cannot unbalance the rest; but a remainder of fewer than two
   lines would be refused, so the gate drops the whole posting in that case
   rather than writing a stub.

**There is nothing to divergence-test against in production.** All three
companies with books hold exactly ONE property, so property date == company date
for every one of them. That is why this is safe to land now and why it must be
landed before the next purchase, not after.

---

## Done and green (11/3)

### Step 1 — the company's date is now derived
- `20261103111500_company_books_start_derived_from_properties.sql`
  - `properties_derive_company_books_start()` + `trg_properties_derive_books_start`
    keeps `landlords.books_start_date` = `MIN(properties.books_start_date)`.
    Fires on INSERT, DELETE, and UPDATE of `books_start_date` or `landlord_id`,
    and re-derives BOTH companies when a property moves between them.
    **No loop:** verified that none of the four triggers on `landlords` writes
    `properties` and none of the seven on `properties` writes `landlords`.
  - `books_start_asset_loan_guard` moved off `landlords` onto `properties` and
    re-keyed to `f.property_id = NEW.id`. Stricter and more correct: today an
    asset at property A can block property B's date.
  - `books_loans_asset_guard` now reads the asset's **property's** date, falling
    back to the company's earliest. **The 11/2 plan never named this one** — it
    was found by asking the database which functions mention `books_start`
    instead of reading the plan's list.
  - Both guarded tables (`books_fixed_assets`, `books_loans`) hold **zero rows**,
    so the re-point cannot refuse anything that works today.
- `bankFeed.setBooksStartDate(landlordId, date, outer?, propertyId?)` writes the
  **property** rows and lets the trigger derive the company's. No `propertyId`
  means every property of the company, which is exactly what this function has
  always meant for a one-property company. Its bank half reads the derived
  company date back, because the date just set may not be the earliest.
- `test/ledgerFixtures.ledgerCompany` sets both properties' dates and takes
  `booksStart2` for a second, different date. **This is the lever**: it is one of
  only two writers of `landlords.books_start_date` in the whole codebase, and
  moving it made most of the suite exercise the real path at once.

### Step 2 — the engine
- `ledgerOwner.LedgerOwnerContext` gains `booksStartByProperty` and the single
  reader `booksStartFor(ctx, propertyId)`. A line that names no property answers
  to the company's earliest; an unknown property answers to it too, on purpose —
  that is the PERMISSIVE answer, so a line we cannot place keeps posting exactly
  as it did, rather than parking real money over a bookkeeping surprise.
- **The gate is per LINE** (`ledgerEngine`, in `postSourceInternal`). Lines whose
  property has not reached its start are dropped and that property's opening is
  marked; the posting is dropped whole only when fewer than two lines survive.
  `suppressed` still counts whole postings only.
- `diffSource` mirrors it exactly. **The 11/2 plan called this
  `ledgerSourceDiff.ts`, a file that does not exist** — it is `diffSource`
  inside `ledgerEngine.ts`, and its consumer is `ledgerCheck.ts` (not
  `ledgerParity.ts`, which is the separate bank-vs-books month check). With
  repair on, `ledgerCheck` hands every drift finding straight back to
  `postSource`, so a divergence between the two gates is a nightly churn loop
  plus an admin notification each run, not a report.
- `LedgerSourceError` carries `propertyId`, stored on
  `ledger_source_errors.property_id`
  (`20261103113000_ledger_source_error_names_the_property.sql`), and the drain's
  immediate retry asks about **that property**. Without it the company's date
  goes non-null as soon as any one property picks, and a source at a
  still-unanswered property would be retried on every single drain forever.
- **One opening posting per property, plus one for the company's own.**
  `source_id` is `landlordId|propertyId`, or the bare `landlordId` for the lines
  that name no property — which is where a bank balance lives. That split makes
  the "stale item" test come out right with **no special case**: a bank item
  belongs to the company's opening, whose day IS the company's earliest, which
  is exactly the day a bank balance has to be stated as of.
  - `projectOpening` parses the composite and **throws** on a malformed id. It
    used to `return []`, and an opening that returns no lines SUPERSEDES the one
    on the books — so a composite id would have quietly taken the balance sheet's
    opening away with nothing failing. This was the single most dangerous thing
    the verification found.
  - `listSources` returns one ref per property with a date plus the company's own.
  - `nettedBeforeStart` takes the slice being opened and filters per line.
  - `projectHomeSale` tests the **contract's property's** date, the exact
    complement of the opening's test, so a sale is never opened and posted both.
- **The drain fans a company-level opening mark out to its properties.** TEN
  trigger functions and a route queue an opening by the bare company id
  (`ledger_capture_books_opening_items_*`, `ledger_capture_home_sale_contracts_*`,
  `ledger_capture_home_sale_installments_*`, `ledger_capture_books_start`,
  `booksSettings` methodChosen). Teaching each of them which property to name
  would be ten places to get right now and one more for every projector that
  later feeds the opening — and getting it wrong is silent. Doing it once where
  the queue is read means every writer present and future is correct, and an
  unchanged opening posts nothing, so fanning out wider than needed costs a
  no-op key per property and can never be wrong.
  `20261103114500_opening_outbox_key_names_the_property.sql` adds the one
  trigger that still has to exist: a property's own date change queues the bare
  company key, because `ledger_capture_books_start` sits on `landlords` and fires
  only when the EARLIEST moves.
- `ledgerRebuild` and `ledgerPending` recognize an opening by the **owner half**
  of its id; the rebuild's ordering guard waits for EVERY opening of the company,
  not the first.
- `markOpening` carries composite keys and the outbox insert uses
  `split_part(x, '|', 1)::uuid` — the old `x::uuid` would throw on every
  per-property key.

### Tests
- 17 direct `UPDATE landlords SET books_start_date` writes across 10 test files
  moved onto `properties`.
- `bankReconciliation.test.ts` creates a landlord with a date and its property
  after; the date now has to be set after the property exists.
- `tenantOpening.test.ts` reads the opening through new fixtures
  `openingLines` / `openingPostingCount` / `markOpenings`, which span a
  company's openings — "what does the opening hold" is now a union.
- Four new engine tests: money at a started property posting while the same day
  at a later-starting one does not; the company's date following the earliest in
  both directions; a property with no date parking only its own money **and the
  error naming that property**; and a posting crossing a started and an
  unstarted property keeping the started side whole, clearing line included.

---

## What remains

### 1. Readers that must become per-property
Verified to carry a `property_id` at the point of use: `loansAssets.ts`,
`booksVendorsLoans.ts` (the depreciation due-list is the one with teeth),
`ledgerTenantChecks.ts`, `jobs/declaredDepositExpiry.ts` (left company-level, a
tenant at a late-starting property takes an undeserved strike), the three
`ledger_capture_books_fixed_assets_*` functions.

### 2. Readers that take `MIN()` and keep working
`bankFeed` sync cutoff (**keep the load-bearing `::text`** — without it
`'2026-07-31' < Date` is always false and the cutoff silently never applies),
`bankReconciliation`, `ledgerClose`, `ledgerParity` month selection,
`ledgerReports` ledger-live switch, `ledgerPending`, `ledgerRebuild`'s refusal
(which must name WHICH property lacks a date).

### 3. Opening-balance entry
`booksSettings.addOpeningItem` and `getOpeningBalances` each compute the stale
test separately and both read the company date; extract ONE helper so they
cannot drift. `kind='other'` has **no way to name a property** —
`openingItemSchema` has no `propertyId` field and the service leaves it null, so
this is a new wire field, not a swap, which the 11/2 plan listed as a clean one.
Not urgent: `books_opening_items` holds **zero rows**.

### 4. The `books_start` re-projection mark
Still company-level (`landlordId|earlier|later`). Moving one property's date
re-queues the company's sources in that window instead of that property's. Each
lands exactly where it would have anyway, so this costs drain work and **never
correctness** — which is why it was left. Narrow it when a company has enough
history for the extra work to matter.

### 5. UI — ships with the engine, never before
A date picker the engine ignores is a trap. `BooksSettingsPage.tsx` becomes a
per-property list; **`apps/landlord/.../BooksSettingsPage.tsx` and
`apps/books/.../BooksSettingsPage.tsx` are byte-identical and
`apps/api/src/bookkeeping-parity.test.ts` FAILS THE BUILD if they drift** —
edit both. Same for `OpeningBalancesPage`, `CloseMonthPage`, `LoansPage`,
`FixedAssetsPage`. `BankFeedPage` should become read-only there, showing the
derived earliest date. The agent action `set_books_start_date` must name the
property.

---

## Two things Nic must be told before they bite

1. **Adding a property bought EARLIER drags the company's bank cutoff
   backward**, and bank history deliberately hidden comes back into review —
   161 Wells Fargo rows for Mountain View (2026-03-09 → 2026-08-31), 98 PNC rows
   for Oak Park (2026-02-19 → 2026-07-30). Correct, but it will look like a
   flood. (Told 11/2.)

2. ~~**The month close is company-level**~~ — **ANSWERED AND BUILT, 11/3.**
   Nic was given the fork and picked **the close goes per-property** over the
   cheap option (refusing a new property's start inside a closed month). Do not
   re-raise the refusal option.

   `books_period_closes.property_id` is nullable, NULL meaning the company's own
   slice — the same split the opening uses, because a bank balance cannot be
   divided between properties. `ledger_closed_through` takes a third, defaulted
   property argument (the 2-argument signature had to be **dropped**, not
   replaced: adding a parameter creates an overload and
   `ledger_closed_through($1, NULL)` is then ambiguous). The per-line guard asks
   what the line's own property is closed through and names that property when
   it refuses.

   **The guard and the service had to ship together.** The guard reads the
   line's property; had it shipped while `closeMonth` still wrote one
   company-level row, every such row would carry `property_id IS NULL` and would
   therefore close only the property-less lines — closing November would have
   silently stopped protecting the rent, which is the only thing anyone closes a
   month for. So `closeMonth` and `reopenMonth` write one sibling row per
   property beside the primary one, and closing behaves exactly as it does today.

   Three readers mean "the primary row" and now say so (`property_id IS NULL`):
   the nightly check's latest-close read (without it, the balance snapshot hangs
   off the primary row while "the latest close" is a sibling, and every closed
   month reads as drift — three tests caught exactly that), the close-history
   list, and the `max(id)` change detector.

   **Still to do:** nothing for correctness. The close screen still closes the
   whole company in one press, which is today's behaviour and is right until
   somebody wants one property on its own — at which point it becomes a list,
   in BOTH `apps/landlord` and `apps/books` (byte-identical, enforced).
