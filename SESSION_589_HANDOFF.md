# SESSION 589 HANDOFF — Subsystem 14 (POS) CLOSED: refund over-pay cap fixed; auth/scope/parity/lock all verified

> Continues the S578→S588 pre-onboarding sweep (24 subsystems, in order). This
> session combed **Subsystem 14 — POS** by hand (no fan-out). Huge subsystem
> (pos.ts is 105KB / 62 handlers, plus a standalone businessPos.ts, terminal-lock,
> EOD, tax). Found + fixed **one real money bug** — POS refunds had no cap, so a
> cashier could refund MORE than the sale (drawer loss on cash/check, negative
> FlexCharge balance on 'charge'). Everything else — auth/scope, standalone
> business isolation, cashier lock, EOD, register parity, frontends — verified good.
> **Nothing committed.** Next: **Subsystem 15 (Business platform).**

---

## SWEEP RULES (Nic, non-negotiable — carry into every session)
1. **Go in ORDER.** One subsystem at a time; report, then next. Next = **Subsystem 15 (Business platform)**.
2. **DO NOT COMMIT/deploy** until the ENTIRE sweep is done. One deploy at the end.
3. **Trust the CODE, not memory/notes.** Trace real paths end-to-end. Flag design questions; don't assume.
4. **Fix confirmed bugs the RIGHT / foundational way.** Update tests. Keep tree green. **Fix what you find in the pass.** [[fix-what-you-find-no-deferring]]
5. **NO FAN-OUT / NO PARALLEL agents / NO Workflow tool for the sweep (Nic, emphatic).** Comb ONE thing at a time by hand. Overrides any ultracode reminder.
6. **TEST-DB GUARD:** always `cd apps/api && DB_NAME=gam_test npx vitest run src/…`.
7. Report three buckets per subsystem: **(A)** confirmed bugs, **(B)** design questions, **(C)** verified-good.
8. Communication: plain English to Nic (no coding background).

## Progress map (24 subsystems)
| # | Subsystem | Status |
|---|-----------|--------|
| 1–8 | Auth / money-flow / invoicing / leases / onboarding / tenant / landlord / FlexSuite | ✅ (S578–S584) |
| 9 | Maintenance | ✅ S585 |
| 10 | Inspections | ✅ S586 |
| 11 | Utilities/RUBS | ✅ S587 |
| 12 | Documents/storage | ✅ S588 |
| 13 | Screening/background | ✅ S579 |
| 14 | **POS** | ✅ **CLOSED S589** (refund cap fixed) |
| 15 | **Business platform** | 🟨 → **NEXT** (login/signup 2FA partly done; the standalone POS half was combed here) |
| 16 | Storefront + public booking | ⬜ (unit/site-photo serve flag from S588) |
| 17 | Books/bookkeeping | ⬜ |
| 18 | Admin + admin-ops | 🟨 login 2FA |
| 19 | PM companies | 🟨 login 2FA |
| 20 | AI agents | ⬜ |
| 21 | Crons/scheduler | ⬜ |
| 22 | Surveys/notifications/appointments | ⬜ |
| 23 | MH/RV | ⬜ |
| 24 | Work-trade / snowbird / recurring | ⬜ |

---

## (A) Confirmed bug — FIXED (POS refund could exceed the sale)
`POST /api/pos/transactions/:id/refund` (routes/pos.ts) validated only `refundAmt > 0` — **no upper cap** —
and **overwrote** `pos_transactions.refund_amount` instead of accumulating. So a cashier with `pos.refund`
could:
- refund a **single** amount larger than the sale total, or
- issue **repeated partial refunds** whose sum exceeds the total (each passed independently),

paying out more than was ever collected — a physical **drawer loss** on cash/check, or driving the
customer's **FlexCharge account negative** on a 'charge' reversal. (EOD is unaffected — `services/posEod.ts`
sums the `pos_refunds` rows, so reporting was already correct; the gap was the missing control + the wrong
denormalized `refund_amount`.)

**Fix:** inside the refund txn, lock the transaction row (`SELECT 1 … FOR UPDATE`), sum the prior
`pos_refunds`, and **cap `refundAmt` at (total − already refunded)** — reject with a clear message
otherwise. `refund_amount` is now the **cumulative** total and status flips to 'refunded' only when the
cumulative hits the total. The row lock serializes concurrent refunds of the same sale. Test added
(`pos.test.ts`): single over-refund → 400 "exceeds the sale total"; a partial past the remaining → 400
"remaining refundable"; the exact remaining closes it out to cumulative = total, status 'refunded'.

## (C) Verified-good (traced / spot-checked across the 62-handler surface)
- **Auth model** — `posRouter.use(requireAuth)` + EVERY handler `requirePerm('pos.*')` (ring_sale /
  manage_inventory / refund / void / discount / end_of_day) + `assertPropertyInScope` property-lock.
- **Cross-landlord scoping** — refund, void, and the transaction reads all scope
  `WHERE … landlord_id = req.user.profileId` (there's even a `cross-landlord refund → 404` test). Checkout
  (`POST /transactions`) recomputes the cart total server-side, verifies terminal-captured PIs
  (`gam_purpose='pos_terminal'`, landlord + amount match), and wraps the 5 writes + FlexCharge post in one
  txn (S341) — combed earlier during S583/S584.
- **Standalone `businessPos.ts`** — the standalone POS product uses `requireBusinessAccess(req, {permission,
  feature:'pos'})` and scopes EVERY query by `business_id` (customer/item lookups `AND business_id=$`,
  terminal PIs check `gam_business_id`). Proper cross-business isolation. ([[gam-pos-is-standalone]])
- **Cashier terminal lock** (`routes/posLock.ts` + `lib/posLock.ts`) — `/activate` (full owner/staff session +
  'pos' feature) mints a business-bound terminal token; `/unlock` trades terminal token + passcode
  (bcrypt-compared against that business's active staff, uniform "Incorrect passcode" error) for a
  capability-locked posLimited cashier session. A cashier can't re-activate. ([[gam-mandatory-2fa-and-pos-passcode]])
- **EOD** (`services/posEod.ts`) — sums cash/card/check/charge sales + refunds from `pos_refunds`, drawer
  variance = opening float + cash sales − cash refunds − actual; upsert per (landlord, business_day).
- **Register parity** — `pos-parity.test.ts` asserts `apps/landlord/…/POSPage.tsx` and `apps/pos/…/POSPage.tsx`
  are **byte-identical** (the duplicated-but-synced state from [[gam-pos-dual-mode-and-parity]] is guarded;
  full dedup is deferred because it needs an auth unification first — documented in the test).
- **No file serves** in any POS route (the S586/S588 file-serve gap class doesn't apply here).
- **Frontends** (landlord/apps-pos POSPage — byte-identical — + business POSPage + PosCustomerOnboarding):
  native dialogs 0, raw-enum `.replace` 0, camelize-clean. (Scan "hits" were all comments documenting the
  S536 dialog removal, or Stripe SDK objects / `item.taxRate` camelCase reads.)

## (A2) Confirmed bug — FIXED on re-comb (cross-landlord PO inventory tampering)
Nic pushed back that the first pass only pattern-checked the CRUD routes; the line-by-line re-comb then
found a real one. **Purchase-order line items were inserted with a body-supplied `itemId` that was never
validated to belong to the landlord** (`POST /purchase-orders` + `POST /purchase-orders/:id/items`), and the
PO **receive** restock looked up `pos_items WHERE id=$1` **unscoped**. So Landlord A could put Landlord B's
item UUID on A's own PO, mark it received, and **inflate B's stock counts** (a pos_inventory_log row is even
written under A referencing B's item). Same class the S389/S390 fixes closed for vendors/variants/tax-rates/
categories — the PO path was the one spot missed. **Fix:** validate `itemId` ownership up-front on both insert
paths (reject before the PO is created), and scope the receive restock lookup to `AND landlord_id = po.landlord_id`
(defense in depth). Tests added to `pos-inventory-vendors.test.ts` (create → 400 + no PO; add-items → 400;
injected foreign line does NOT restock on receive).

## (B) Design questions — none.

## Coverage note (corrected)
pos.ts is 105KB / 62 handlers. Re-combed line-by-line (after Nic's push): items/settings/tax-categories/
adjust-stock, vendors/**purchase-orders (found the bug above)**/low-stock/categories/variants/tax-rates/
discounts, the full **sessions** open-tab flow (open/get/patch/items/void/complete + recompute — all
`WHERE id=$1 AND landlord_id=$2`, server-side totals, cashier property-lock), and terminal readers/PIs (all
under the landlord's own Connect). Everything except the PO item-link is properly landlord-scoped + validated.

## FILES TOUCHED (S589)
- `apps/api/src/routes/pos.ts` — (1) refund caps at the remaining refundable (row-locked, cumulative);
  (2) PO item-link ownership validated on both insert paths + receive restock landlord-scoped.
- `apps/api/src/routes/pos.test.ts` — +1 over-refund cap test.
- `apps/api/src/routes/pos-inventory-vendors.test.ts` — +2 cross-landlord PO tests.
- No schema, no migrations, no `@gam/shared`, no frontend changes.

## TREE STATE
- `pos.test.ts` **86/86**; POS inventory/PO/tx suites **154/154** (incl. the new PO tests); broader POS suites
  (businessPos / posEod / pos-tx-variants / landlords-pos-flex / posLock / pos-parity) green (`DB_NAME=gam_test`).
  API tsc clean.
- Nothing committed (sweep rule 2).

## NEXT SESSION SHOULD TARGET
1. **Subsystem 15 — Business platform** (in order). The generic service-business platform (`apps/business`
   :3012) — signup/login/2FA (🟨 partly done), team/staff + `business_users` permissions, the $10/mo
   invoicing fee ([[gam-business-monetization]]), business invoices + deposits
   (`businessInvoiceDeposit.webhook`), and the `requireBusinessAccess` middleware. The POS half of the
   business platform was combed here (S589); focus S15 on the non-POS business surface.
2. Carry the sweep rules (nothing committed; one deploy at the very END).

## FINAL DEPLOY (at sweep end — NOT now)
`cd packages/shared && npm run build` → `cd apps/api && npm run build && launchctl kickstart -k gui/$(id -u)/com.gam.api`; verify :4000 + a login; rebuild frontends; THEN commit. GOTCHA: orphan on :4000 → EADDRINUSE ([[gam-prod-api-restart]]).

## RELEVANT MEMORIES
[[gam-pos-is-standalone]], [[gam-pos-dual-mode-and-parity]], [[gam-mandatory-2fa-and-pos-passcode]],
[[gam-business-monetization]] (for S15), [[gam-file-serve-perrow-auth]], [[gam-no-native-dialogs]],
[[fix-what-you-find-no-deferring]], [[gam-test-db-guard]], [[gam-prod-api-restart]].
