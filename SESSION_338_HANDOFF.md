# Session 338 — closed

## Theme

S337 closed the e-sign domain. S338 opens the POS thread with the
densest single endpoint: `POST /api/pos/transactions` (the money
path, ~200 lines covering cash / card / terminal-PI / FlexCharge,
server-side tax, stock decrement, auto-PO, S70 cross-landlord
guard, S242 PI validation, S254 FlexCharge gate).

New test file `apps/api/src/routes/pos.test.ts` — 21 cases across
three describe blocks. Includes the S70 cross-landlord stock-guard
test (verifies the route accepts the transaction but does NOT
touch the victim landlord's stock), and the full S242 PI metadata
validation matrix (status / amount / purpose / landlord-id).

Two POS infra changes: 7 cleanup additions to `dbHelpers.ts`
(POS tables FK to landlords with RESTRICT, so they must be
cleared before the landlord wipe), and the test-file pattern
established for future POS slices.

Suite at S337 close: **658 / 32 files**.
Suite at S338 close: **679 / 33 files**.

Zero production regressions; zero source-code changes (this is a
test-only session). tsc + suite clean across all 10 portals.

## Items shipped

### POS transactions test coverage (21 new cases)

**Block 1 — happy paths (6 cases)**

- Cash sale: subtotal/tax/total computed by mocked
  `calculateCartTax`, line item written to `pos_transaction_items`,
  stock decremented (50 → 48), inventory log row with
  change_qty=-2, reason='sale', reference_id=transaction.id.
- Card sale with terminal `stripePaymentIntentId`: PI retrieved
  via mocked `retrieveTerminalPaymentIntent`, validation passes
  (status='succeeded', amount matches total*100, metadata correct),
  PI id stamped on `pos_transactions.stripe_payment_intent_id`,
  `retrieveTerminalPaymentIntent` called with the landlord's
  Connect account id from the users table.
- Walk-up item (no catalog id): client-supplied price + tax_rate
  pass through, no inventory log, walk-up subtotal added to
  catalog subtotal correctly.
- Mixed cart (catalog + walk-up): server tax applied to catalog
  line, client tax to walk-up line, both summed correctly.
- Auto-draft PO: stock decrement that lands at/below `stock_min`
  with a `vendor_id` set fires `autoDraftPO` → new
  `pos_purchase_orders` row in 'draft' status with correct
  vendor + subtotal (reorder_qty * cost_price using the
  PRE-decrement stock value at pos.ts:495), and a
  `pos_purchase_order_items` row with qty_ordered = stock_max -
  stock_qty.
- Untracked stock (stock_qty=999): stock not decremented, no
  inventory log written (the `if (dbItem.stock_qty < 999)` gate
  at pos.ts:454).

**Block 2 — FlexCharge gate (S254) (8 cases)**

- Happy path: `getAccountForCharge` returns active account, route
  inserts pos_transactions with `platform_fee = subtotal * 0.01`,
  then calls `postFlexChargeTransaction` with the new
  transaction id + amount.
- propertyId required → 400 (pos.ts:313).
- XOR violation (both tenantId + posCustomerId set) → 400 (pos.ts:314).
- Walk-up item (no catalog id) on FlexCharge → 400 (pos.ts:322).
- Cart contains a non-charge-eligible item → 400 (pos.ts:332).
- No FlexCharge account at (customer, property) → 404 (pos.ts:346).
- FlexCharge account status != 'active' → 409 (pos.ts:349).
- FlexCharge account belongs to a different landlord → 403
  (pos.ts:351).

**Block 3 — guards + idempotency (7 cases)**

- Empty items array → 400 (pos.ts:303).
- S70 cross-landlord guard: attacker landlord submits a
  transaction referencing a victim landlord's pos_item.id →
  transaction row IS inserted (the route doesn't reject the
  cart up front), but the victim's `pos_items.stock_qty` is NOT
  decremented and no `pos_inventory_log` row is written for it
  (the `WHERE id=$1 AND landlord_id=$2` scope at pos.ts:443
  returns null → `dbItem` is null → stock-decrement branch
  short-circuits).
- Duplicate `stripePaymentIntentId`: first POST returns 201, second
  returns 200 with the existing row (caught by the
  `pos_transactions_stripe_pi_uniq` UNIQUE index → 23505 →
  pos.ts:426 retry-safe branch). Only one pos_transactions row
  exists on the landlord after both calls.
- Terminal PI status != 'succeeded' → 400 (pos.ts:406).
- Terminal PI amount mismatch → 400 (pos.ts:410).
- Terminal PI metadata.gam_purpose != 'pos_terminal' → 400 (pos.ts:400).
- Terminal PI metadata.gam_landlord_id mismatch → 403 (pos.ts:403).

### Test infra additions

**`apps/api/src/test/dbHelpers.ts` — POS table cleanup (+7 lines)**

POS tables all FK to landlords with ON DELETE RESTRICT; they
must be cleared before the existing landlords wipe at line ~96.
Added in dependency order (children cascade where possible):
```
DELETE FROM pos_transactions      (cascades pos_transaction_items + pos_refunds)
DELETE FROM pos_purchase_orders   (cascades pos_purchase_order_items)
DELETE FROM pos_items             (cascades pos_inventory_log, pos_item_variants, pos_price_history)
DELETE FROM pos_categories
DELETE FROM pos_vendors
DELETE FROM pos_tax_rates
```

Scoped to tables this session's tests actually seed; future POS
slices may need additional entries (`pos_sessions`, `pos_session_items`,
`flex_charge_*`, `pos_eod_settlements`, `pos_terminal_readers`,
`pos_customers`, `pos_discounts`, `pos_item_variants`, `pos_refunds`).

**`apps/api/src/routes/pos.test.ts` (new, 580 lines)**

- Three vi.mock blocks: `posTax` (calculateCartTax), `posTerminal`
  (retrieveTerminalPaymentIntent + 8 stub exports — the entire
  module has to be replaced since pos.ts top-level imports them
  all from one statement), `flexCharge` (getAccountForCharge +
  postFlexChargeTransaction, partial mock via importOriginal).
- `seedPosFixture({ withConnectAccount? })` — landlord + property
  + category + JWT, optional `stripe_connect_account_id` stamp
  on the user (for card-PI tests that go through
  `getLandlordConnectId`).
- `seedPosItem(f, opts)` — pos_items insert with optional override
  knobs (sellPrice, costPrice, taxRate, stockQty, stockMin,
  stockMax, chargeEligible, vendorId, landlordId for the
  cross-landlord guard test).
- `seedVendor(f)` — pos_vendors insert for auto-PO tests.
- `seedRealTenant()` — wraps the existing `seedTenant` helper
  for the FlexCharge happy-path test (pos_transactions.tenant_id
  FK to tenants).

## Files touched

```
apps/api/src/routes/
  pos.test.ts            (NEW — 580 lines, 21 cases, 3 describe blocks)

apps/api/src/test/
  dbHelpers.ts           (+7 lines: POS cleanup additions)
```

No source-code changes. No migrations. No schema changes.

## Decisions made during build

| Question | Decision |
|---|---|
| New test file or append to a peer file? | **New file (`pos.test.ts`).** POS surface is large (~50 endpoints, 1726 lines); a single file per endpoint group keeps scopes coherent. Future POS slices (sessions, EOD, terminal) will likely get their own files or describe blocks here. |
| Mock `calculateCartTax` or run the real implementation? | **Mock.** Real implementation does heavy DB work (per-item rate lookup + applies_to category matching). Mocking the result keeps each test's tax math intent explicit and lets us pin exact subtotal/tax/total values. Real `calculateCartTax` has its own test file potential as a follow-up. |
| Mock the full `posTerminal` module or only `retrieveTerminalPaymentIntent`? | **Full module.** pos.ts imports 8 exports from posTerminal in one statement at the top; partial mocks via `importOriginal` would still call into the real Stripe SDK for the other 7 stubs. Replacing the whole export surface with `vi.fn()` stubs is cleaner. |
| Mock or seed the FlexCharge account? | **Mock `getAccountForCharge`.** Real `flex_charge_accounts` seeding would require seeding tenant + property + the account row, plus exercising the XOR query inside the service. Mocking returns a `FlexChargeAccountRow`-shaped object lets us pin the three fields the route actually reads (`id`, `status`, `landlord_id`). |
| Pass `tenantId: randomUUID()` or seed real tenants for FlexCharge? | **Mostly randomUUID; real tenant only on the happy path.** Most FlexCharge tests fail in validation gates BEFORE the pos_transactions INSERT (which has the tenant_id FK). Only the happy path reaches the INSERT — that test gets a real seeded tenant. Tracking which tests need which is documented inline. |
| Numeric-as-string assertions? | **Cast with Number().** Postgres `numeric(10,3)` and `numeric(10,2)` columns come back as JS strings from the pg driver. Lines like `expect(Number(lines.rows[0].qty)).toBe(2)` are the standard pattern across the existing test suite (S333 leases.test.ts uses the same posture). |
| S70 cross-landlord guard test — assert error or assert silent-no-decrement? | **Silent-no-decrement.** The route accepts the cart (no validation gate up front), inserts the pos_transactions row, but `dbItem` resolves to null when the item belongs to another landlord (the `WHERE id=$1 AND landlord_id=$2` scope at pos.ts:443). The stock-decrement and inventory-log branches both short-circuit on `dbItem` being null. Test pins both: transaction inserts (201), victim's stock unchanged, no log row. |
| Add atomicity test for transaction body? | **Skip.** The route is not wrapped in BEGIN/COMMIT — each statement (transaction INSERT, line item INSERT, stock UPDATE, inventory_log INSERT) runs independently. Cleaning up partial state on failure is a separate refactor (NOT in S338 scope). Flagging here for awareness; future session if Nic wants atomicity for POS sales. |

## Verification

- `npx tsc --noEmit` clean on apps/api AND every frontend portal:
  landlord, tenant, pm-company, admin, admin-ops, books, listings,
  pos, property-intel. Every count is 0.
- `npm test` in apps/api: **679 tests across 33 files, 0 failures**,
  ~292s.
- 0 production-source changes.
- 0 production regressions.

## Items deferred — what S339 could target

### POS thread continuation

The S338 slice covered only `POST /transactions`. Remaining POS
endpoints (~49 more) split into logical slices:

- **Sessions slice** (`/sessions` GET/POST/PATCH, `/sessions/:id`
  GET/PATCH, `/sessions/:id/items` POST/PATCH/DELETE,
  `/sessions/:id/void`, `/sessions/:id/complete`) — the cart-
  builder state machine that feeds /transactions. ~10-12 tests.
- **EOD close slice** (`/eod` GET, `/eod/:date` GET, `/eod/close`
  POST, `/eod/regenerate` POST) — settlement path; reads
  pos_transactions + writes pos_eod_settlements. ~6-8 tests.
  Needs the auto-Friday cron job context.
- **Refund / void slice** (`/transactions/:id/refund` POST,
  `/transactions/:id/void` POST) — reverses sales,
  re-increments stock, writes pos_refunds. ~4-5 tests.
- **Inventory CRUD slice** (`/items`, `/categories`, `/vendors`,
  `/tax-rates`, `/discounts`, `/purchase-orders`,
  `/inventory-log`) — boilerplate-y CRUD endpoints, lower risk.
  ~15-20 tests if comprehensive, ~6-8 if scoped to the gates.
- **Terminal slice** (`/terminal/connection-token`,
  `/terminal/readers`, `/terminal/payment-intents`) — Stripe-
  mocked ceremony. ~8-10 tests.

### Architectural / non-test

- **Unicode-capable font in flexsuitePdf** — deletes the 14
  sanitizer tests for a cleaner renderer. ~300KB bundle add.
  (Open architectural pick since S333.)
- **responsibleParty source-comment drift fix** — one-line
  comment correction (deferred since S333).
- **POS transactions atomicity** — wrap the INSERT chain
  (pos_transactions + pos_transaction_items + pos_items UPDATE +
  pos_inventory_log) in BEGIN/COMMIT so partial failures roll
  back cleanly. Currently each statement is independent.
  Flagged in S338 but not in scope.

### Vendor-blocked (no progress possible)

- Stripe live keys, Resend domain auth, Plaid production keys,
  Stripe Terminal hardware, Checkr Partner credentials.

### Walkthrough-blocked (per Nic direction)

- 2FA fan-out (admin-ops / landlord / pm-company / tenant)
- Visual review of reconstructed PmInvitationsPage
- SchedulePage booking-vs-lease shape audit

### Dev-team scope

- Deploy host pick + Dockerfile / render.yaml
- Production cron runner
- DB backups + PITR

## Items deferred (cross-session docket, post-S338)

- Consumer-side retention framing decision (S300) — Nic-pending
- Campground Master import path — Nic-blocked on sample
- 2FA fan-out — walkthrough-blocked
- Yardi GL-export columns, Rentec template (S293) — vendor-blocked on real exports
- FlexCharge Business Account Agreement signature capture (S309 option B) — not a launch feature
- FlexDeposit eligibility-check workflow (S309 option C)
- Standalone POS-operator auth (S309 option D)
- Deposit-return ↔ unpaid-installment offset architecture call — Nic-pending
- SchedulePage booking-vs-lease shape audit — walkthrough-blocked
- Embed Unicode-capable font in flexsuitePdf — open architectural pick
- Credit-score formula + recompute test coverage — locked v1.0.0; defensive only
- Visual review of reconstructed PmInvitationsPage — walkthrough-blocked
- POS sessions / EOD / refund-void / inventory CRUD / terminal test slices
- POS transactions atomicity refactor (S338 flagged)

## Nic-pending (unchanged)

- Stripe live keys + production webhook URL registered
- Resend domain verification
- Plaid production keys
- Stripe Terminal hardware
- Checkr Partner credentials
- Consumer-side retention framing decision (S300)
- FlexCredit Lender partner selection
- SLA § 9.1.4(iii) deposit-return offset framing call

## What S339 should target

S338 closed only the densest slice of POS. The remaining slices
are smaller and well-bounded.

If S339 continues POS coverage, **refund/void** is the next
load-bearing slice — it touches money + stock reversal + the same
S70-style guards. ~4-5 tests, single session. After that,
**sessions** is the cart-builder state machine (~10-12 tests).

If S339 picks up the atomicity refactor, the transactions chain
should be wrapped in BEGIN/COMMIT so partial failures roll back
cleanly. Bounded change in pos.ts; existing tests stay green.

If S339 steps off tests, **Unicode font in flexsuitePdf** remains
the bounded architectural pick.

Otherwise: waiting for vendor unblock / walkthrough is a
reasonable posture. The launch-critical money path has coverage
now.

---

End of S338 handoff. Closed clean. 679 tests / 33 files / 0 failures.
POS transactions endpoint covered.
