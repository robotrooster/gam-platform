# SESSION 591 HANDOFF — POS re-combed (real cross-landlord PO bug fixed), Business verified, POS⊥Business isolation confirmed

> Continues the S578→S590 pre-onboarding sweep (24 subsystems, in order). This
> session **corrected a methodology miss** Nic flagged: S589/S590 had only
> PATTERN-checked the POS + Business CRUD routes while calling them "verified-good."
> On the line-by-line **re-comb** I found + fixed a real **cross-landlord
> purchase-order inventory-tampering bug** in POS, then verified the Business
> platform's equivalent write-paths are clean, and **verified the POS⊥Business
> isolation invariant** Nic asked to confirm. **Nothing committed.** Next:
> **Subsystem 16 (Storefront + public booking).**

---

## SWEEP RULES (Nic, non-negotiable — carry into every session)
1. **Go in ORDER.** One subsystem at a time; report, then next. Next = **Subsystem 16 (Storefront + public booking)**.
2. **DO NOT COMMIT/deploy** until the ENTIRE sweep is done. One deploy at the end.
3. **Trust the CODE, not memory/notes.** Trace real paths end-to-end. Flag design questions; don't assume.
4. **Fix confirmed bugs the RIGHT / foundational way.** Update tests. Keep tree green. **Fix what you find in the pass.** [[fix-what-you-find-no-deferring]]
5. **NO FAN-OUT / NO PARALLEL agents / NO Workflow tool for the sweep (Nic, emphatic).** Comb ONE thing at a time by hand. Overrides any ultracode reminder.
6. **TEST-DB GUARD:** always `cd apps/api && DB_NAME=gam_test npx vitest run src/…`.
7. Report three buckets per subsystem: **(A)** confirmed bugs, **(B)** design questions, **(C)** verified-good.
8. **COMB, don't pattern-check.** Read the write handlers, not just their auth line. If a subsystem is too big
   to fully read, state coverage NARROWLY — never round "spot-checked" up to "verified-good." [[gam-comb-thoroughly-no-overclaim]]
9. Communication: plain English to Nic (no coding background).

## Progress map (24 subsystems)
| # | Subsystem | Status |
|---|-----------|--------|
| 1–8 | Auth / money-flow / invoicing / leases / onboarding / tenant / landlord / FlexSuite | ✅ (S578–S584) |
| 9 | Maintenance | ✅ S585 |
| 10 | Inspections | ✅ S586 |
| 11 | Utilities/RUBS | ✅ S587 |
| 12 | Documents/storage | ✅ S588 |
| 13 | Screening/background | ✅ S579 |
| 14 | POS | ✅ S589 + **re-combed S591** (PO cross-landlord bug fixed) |
| 15 | Business platform | ✅ S590 + **write-paths re-combed S591** (clean) |
| 16 | **Storefront + public booking** | ⬜ **← NEXT** |
| 17 | Books/bookkeeping | ⬜ |
| 18 | Admin + admin-ops | 🟨 login 2FA |
| 19 | PM companies | 🟨 login 2FA |
| 20 | AI agents | ⬜ |
| 21 | Crons/scheduler | ⬜ |
| 22 | Surveys/notifications/appointments | ⬜ |
| 23 | MH/RV | ⬜ |
| 24 | Work-trade / snowbird / recurring | ⬜ |

---

## POS⊥BUSINESS ISOLATION — VERIFIED (Nic asked to confirm; locked in [[gam-pos-business-isolation]])
The landlord/POS world and the business-portal world are **completely isolated** — confirmed in code:
- `users.role` is a single-valued CHECK enum → one account is `landlord` OR `business_owner`, never both.
- NO FK links `landlords`↔`businesses`; NO cross-family FK (`business_pos_*` only references other `business_*`
  tables; nothing bridges `pos_*`↔`business_*`).
- `pos.ts` = 87 `pos_*` refs / 0 business refs; `businessPos.ts` = 23 `business_*` refs / 0 pos refs. Separate
  signup, separate Stripe Connect.
- **Multi-location:** landlord POS ALREADY supports it (`property_id` on pos_items/transactions/sessions —
  one POS per property). The business-owner side is single-business-per-owner today (requireBusinessAccess
  resolves the newest, LIMIT 1); a 2nd business/location for a business owner is a **deferred future workflow —
  don't build now.** **NEVER link the two worlds** (add a FK/JOIN/shared-id/route) — surface to Nic first.

## (A) Confirmed bug — FIXED (cross-landlord PO inventory tampering) — the re-comb catch
POS purchase-order line items took a body-supplied `itemId` **never validated to belong to the landlord**
(`POST /pos/purchase-orders` + `POST /pos/purchase-orders/:id/items`), and PO **receive** restocked via an
**unscoped** `pos_items WHERE id=$1`. So Landlord A could put Landlord B's item UUID on A's PO, mark it
received, and **inflate B's stock counts** (inventory-log even written under A referencing B's item). Same class
the S389/S390 fixes closed for items/variants/vendors/tax-rates/categories — the PO path was the one miss.
**Fix (`routes/pos.ts`):** validate `itemId` ownership up-front on both insert paths (reject before the PO is
created); scope the receive restock to `AND landlord_id = po.landlord_id` (defense in depth). Tests added
(`pos-inventory-vendors.test.ts`): create→400 (no PO), add-items→400, injected foreign line does NOT restock.
(This is [[gam-foreign-ref-write-scope]] — a recurring class to grep in every remaining subsystem.)

## (C) Verified-good on the re-comb
- **POS (full line-by-line):** items/settings/tax-categories/adjust-stock, vendors/POs (the bug)/low-stock/
  categories/variants(S390-scoped)/tax-rates/discounts, the whole **sessions** open-tab flow (open/get/patch/
  items/void/complete — all `WHERE id=$1 AND landlord_id=$2`, server-side totals, cashier property-lock;
  complete verifies the tx is the caller's), terminal readers + PIs (landlord's own Connect). All scoped/validated.
- **Business (foreign-ref write-paths):** quote + work-order + recurring-invoice create/convert handlers ALL
  validate every body ref (`customerId`/`vehicleId`/`appointmentId`) belongs to the business (`… WHERE id=$1 AND
  business_id=$2` → 404) AND vehicle-belongs-to-customer, before insert. No equivalent of the POS PO gap.

## FILES TOUCHED (S591)
- `apps/api/src/routes/pos.ts` — PO itemId ownership validated (both insert paths) + receive restock landlord-scoped.
- `apps/api/src/routes/pos-inventory-vendors.test.ts` — +2 cross-landlord PO tests.
- Handoffs `SESSION_589/590` coverage notes corrected. No schema, no migrations, no `@gam/shared`, no frontend.

## TREE STATE
- POS inventory/PO/tx suites **154/154 green** (incl. the 2 new PO tests); the earlier POS + Business suites
  still green. API tsc clean. Nothing committed (sweep rule 2).

## NEXT SESSION SHOULD TARGET
1. **Subsystem 16 — Storefront + public booking** (in order). Per-property public sites (`*.gam.biz`,
   [[gam-storefront]]) + public booking (`publicPropertyBooking.ts`, `propertyBookingAdmin.ts`). **Carry the
   S588 flag:** `properties.ts /unit-photo-files` + site-photo serves are broadly-served marketing images —
   decide the access policy (sign-in + approved-bg-check per [[gam-nothing-public-rule]] when listings launch,
   vs. landlord-scope now). Re-grep `res.sendFile` ([[gam-file-serve-perrow-auth]]) and check body-ref writes
   ([[gam-foreign-ref-write-scope]]). **COMB, don't pattern-check** ([[gam-comb-thoroughly-no-overclaim]]).
2. Carry the sweep rules (nothing committed; one deploy at the very END).

## FINAL DEPLOY (at sweep end — NOT now)
`cd packages/shared && npm run build` → `cd apps/api && npm run build && launchctl kickstart -k gui/$(id -u)/com.gam.api`; verify :4000 + a login; rebuild frontends; THEN commit. GOTCHA: orphan on :4000 → EADDRINUSE ([[gam-prod-api-restart]]).

## RELEVANT MEMORIES
[[gam-pos-business-isolation]] (NEW, Nic-locked), [[gam-comb-thoroughly-no-overclaim]] (NEW), [[gam-foreign-ref-write-scope]] (NEW),
[[gam-file-serve-perrow-auth]], [[gam-pos-is-standalone]], [[gam-pos-dual-mode-and-parity]], [[gam-business-monetization]],
[[gam-storefront]] + [[gam-nothing-public-rule]] (for S16), [[fix-what-you-find-no-deferring]], [[gam-test-db-guard]], [[gam-prod-api-restart]].
