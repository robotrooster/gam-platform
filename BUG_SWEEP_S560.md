# GAM Full-Platform Bug Sweep — S560 (post-S559)

Multi-agent sweep: 7 areas reviewed in parallel, each finding adversarially verified by an independent agent before surviving. 21 confirmed of 23 candidates. 31 agents, ~14 min.

## Claude's triage (overnight, unattended)
- **APPLIED tonight (11):** all obvious, single-correct-way fixes; each verified by typecheck + the relevant test suites (see "Verification" appended at the bottom).
- **MOVED to morning by Claude's judgment (1):** `payments.ts:454` — verifier tagged it obvious, but it's the core rent-money path with two valid fixes and zero live exposure today; not touching payment settlement unattended.
- **NEEDS DECISION — for Nic (6):** listed at the end of the report.

Nothing was committed. All changes are unstaged for review.

---

# GAM Full-Platform Bug Sweep — Synthesis Report

21 adversarially-verified findings across 7 areas. Severities reflect the verifier's final verdict (two originally-higher ratings were downgraded on verified live-exposure limits: `payments.ts:454` critical→high, one `utility.ts:720` report high→medium). Three separate reports land on the same `utility.ts:720` defect and are consolidated into one finding.

---

## Area: auth-security

### 1. `apps/api/src/middleware/auth.ts:48` — CRITICAL — **[OBVIOUS FIX]**
`requireAuth` never checks the JWT `purpose` claim, so the short-lived `totp_pending` token minted by `/login` is accepted as a full session everywhere, bypassing 2FA entirely.
- **Failure:** Attacker with an admin's email+password (no TOTP device) POSTs `/api/auth/login`; since `totp_enabled=true`, the response is `{requiresTotp:true, totpSession:<JWT>}`. That JWT carries the genuine admin role/permissions plus `purpose:'totp_pending'`. Sent as `Authorization: Bearer`, it passes `requireAuth`/`requireAdmin` (role-only checks) — full admin access, code never entered. `/api/auth/refresh` (also behind `requireAuth`) then re-signs the claims with a 7-day TTL, upgrading the 5-minute pending token into a full week-long session.
- **Fix:** In `requireAuth`, after `jwt.verify`, reject any token where `payload.purpose` is set (`if ((payload as any).purpose) return 401`). Keep the positive `purpose==='totp_pending'` check only in `/totp/verify`. Add a regression test that a pending token is rejected by a `requireAuth` route and by `/refresh`.

### 13. `apps/api/src/routes/auth.ts:335` — HIGH — **[NEEDS DECISION]**
For `MANDATORY_TOTP_ROLES` (admin/super_admin) not yet enrolled, `/login` issues a full 7-day session and relies solely on the client-side `mustEnrollTotp` flag — no server-side enforcement.
- **Failure:** An admin with `totp_enabled=false`; attacker with the password POSTs `/login`, the TOTP gate at line 319 is skipped, `signToken` mints a normal 7-day JWT with `mustEnrollTotp:true`. Only the React app honors that flag; a raw API caller ignores it and uses the token against every admin endpoint. Mandatory 2FA gives zero server-side protection for un-enrolled accounts.
- **Fix:** When `MANDATORY_TOTP_ROLES.has(role) && !totp_enabled`, mint a restricted enrollment-only token (distinct purpose) and enforce that only `/totp/enroll-*` endpoints accept it. Design choice among enrollment-scoped token vs. JWT claim + guard vs. `totp_enabled` re-fetch in `requireAdmin`.

### 19. `apps/api/src/routes/totp.ts:292` — MEDIUM — **[OBVIOUS FIX]**
The TOTP verify path drops the `businessId`/`staffRole` claims, so a `business_owner`/`business_staff` who enables TOTP loses business scope after login.
- **Failure:** Normal login injects `businessId` into the JWT; the TOTP path builds the session via `signTotpSessionToken` (no `businessId`/`staffRole` fields) and `/totp/verify` mints the full token copying only userId/role/email/profileId/landlordId/landlordIds/permissions. Result: `businessId=undefined`, `requireBooksRead/Write` return 403, and the owner is locked out of GAM Books for the full 7-day TTL (`/auth/me` returns businessId but does not re-issue the JWT). Triggered purely by turning on 2FA. (Business portal is outside the launch set.)
- **Fix:** Thread `businessId`/`staffRole` through `signTotpSessionToken`'s payload and the `signFullToken` call in `/totp/verify` (and the `/verify` response user object), matching the non-TOTP login shape.

---

## Area: payments-stripe

### 10. `apps/api/src/routes/payments.ts:454` — HIGH *(reported critical; downgraded on live-exposure limits)* — **[OBVIOUS FIX]**
Card payments via `/:id/pay` are stamped `status='settled'` at charge time, but the webhook's settle+allocate path is gated on `status != 'settled'`, so allocation, credit-ledger, supersedence, propane, and PM/manager transfers never run for card.
- **Failure:** Tenant pays rent by card through `POST /api/payments/:id/pay`; the route folds `gam_supersedence_amount` into `application_fee_amount` (money moves to GAM's platform balance) and sets `status='settled'`. Stripe's `payment_intent.succeeded` then runs `UPDATE ... WHERE ... status != 'settled'` → 0 rows → `executeRentAllocation`, `emitPaymentSettledEvent`, `applyTenantSupersedence`, `applyAcceleratedPropane`, `firePmTransfersForReference`, `fireManagerTransfersForReference` all skipped. Concrete wrong outputs: (a) FlexDeposit/FlexCharge/FlexPay balances never credited though GAM took the boost → tenant double-charged; (b) PM/manager cuts never Transfer out of the landlord's Connect balance (stranded funds); (c) no owner ledger audit row; (d) a 3DS card is marked settled before the intent succeeds. *Limited today: no current frontend routes card through `/:id/pay` (UI uses `/pay-balance`), but it is a mounted, tenant-authenticated endpoint reproducible by direct call.*
- **Fix:** Set `status='processing'` for card (as ACH and the FIFO `/pay-balance` route do) and let the webhook settle+allocate; or, if instant card settlement is wanted, run allocation+supersedence+transfers inline in the route. Do not leave allocation gated behind a status the route pre-sets.

### 11. `apps/api/src/routes/webhooks.ts:1041` — HIGH — **[NEEDS DECISION]**
`extractPaymentMethod` and `stripeChargeId` read `(pi as any).charges.data[0]`, removed from `PaymentIntent` since API version 2022-11-15 (replaced by `latest_charge`); on a modern payload, ACH allocation throws and the webhook retries forever.
- **Failure:** On `payment_intent.succeeded`, a payload rendered at >= 2022-11-15 carries `latest_charge` (a string) and no `charges.data[]`. `extractPaymentMethod` returns null → the handler throws "payment_method could not be determined" → ROLLBACK + 500 → Stripe retries indefinitely; the payment stays `processing` and never allocates. Separately `stripeChargeId` is null, so PM/manager transfers lose `source_transaction`. Affects card the same as ACH. Tests pass only because they hand-construct the legacy `charges.data` shape.
- **Fix:** Read `pi.latest_charge` (expand or `stripe.charges.retrieve`) for both the payment-method type and charge id; handle both shapes defensively. Decision needed: async retrieve vs. `payment_method_types` vs. expand, and where the extra call sits relative to the DB transaction.

### 12. `apps/api/src/services/stripeConnect.ts:689` — HIGH — **[NEEDS DECISION]**
Dispute handling only records the dispute; with Connect accounts created as `losses.payments='application'`, every disputed destination charge is borne by GAM's platform balance with no recovery from the landlord — violating S512 "GAM bears no charge burden."
- **Failure:** Tenant pays rent by card (gross to landlord's Connect, GAM keeps only the app fee); tenant later files a chargeback. Stripe debits the full disputed amount + fee from GAM's platform balance. `recordDisputeEvent` writes a `connect_disputes` row but never reverses the transfer or debits the landlord's Connect account, so GAM eats the loss; on high-dispute landlords the platform balance goes negative. Same gap for late ACH returns. (Pre-existing S117-era gap, not an S559 regression.)
- **Fix:** Either set `losses.payments='stripe'` at account creation, or on `charge.dispute.created` reverse the destination transfer / debit the recipient Connect balance to recover amount + fee. Multiple valid designs (reverse at `created` vs. only on lost `closed`; multi-destination PM/manager handling; win/re-transfer timing).

---

## Area: metering-billing-core

### 2. `apps/api/src/services/utilityReadingRuns.ts:366` — HIGH — **[OBVIOUS FIX]**
`enterDoubleCheck`'s UPDATE targets every row sharing `(meter_id, billing_cycle_month)` with no reason filter, so a re-read overwrites same-month reference reads too.
- **Failure:** A submeter has a Jan-15 `stay_turnover` read (5000) and a Jan-31 flagged `monthly_cycle` read (5200), both with `billing_cycle_month=2026-01-01`. Reader re-enters ~5200; the UPDATE sets `reading_value=5200` on BOTH rows. The Jan-15 turnover baseline is destroyed, so the next occupant's usage and the departed guest's bill compute off a wrong baseline — the exact leakage point-in-time reads were built to prevent. The clean-pad seeding means any meter with a same-month turnover read can hit this.
- **Fix:** Add `AND reason = 'monthly_cycle'` to the WHERE clause (and match the specific reading id where possible) so only the cycle read is mutated.

### 3 & 7. `apps/api/src/services/utilityReadingRuns.ts:219` — HIGH — **[OBVIOUS FIX]**
*(Reported twice — metering-billing-core and check-in-bookings — same defect.)* `getRunMeters` computes `is_read` from any reading in the cycle month, so a mid-month `stay_turnover`/reference read makes the walk show a meter as already read.
- **Failure:** A submeter gets a Jan-10 `stay_turnover` read (`billing_cycle_month=2026-01-01`). The end-of-month run's LEFT JOIN on `cur.billing_cycle_month = r.billing_cycle_month` (no reason filter) matches it → `is_read=true`. Reader skips the meter, no `monthly_cycle` read is entered, and `tryInsertBill` (which requires `reason='monthly_cycle'`) finds none → "no reading recorded for this cycle" → the unit silently under-bills. S559 regression: the reason split was applied to sibling queries but missed the run-progress joins.
- **Fix:** Add `AND cur.reason = 'monthly_cycle'` to the LEFT JOIN (and the `meters_read` count query at `routes/utility.ts:430`).

### 4. `apps/api/src/services/utilityReadingRuns.ts:453` — HIGH — **[OBVIOUS FIX]**
`isRunFullyRead` counts any reading in the cycle month as a read, so a reference read lets a run auto-advance/complete without its `monthly_cycle` read.
- **Failure:** A meter with only a Jan-10 `stay_turnover` read: once the other meters are read, `isRunFullyRead`'s billing_cycle_month-only LEFT JOIN never sees `rd.id IS NULL` for it, returns true, and the run completes. `generateBillsForMeter` then finds no `monthly_cycle` read → the tenant's January utility silently never bills.
- **Fix:** Add `AND rd.reason = 'monthly_cycle'` to the LEFT JOIN condition.

### 14. `apps/api/src/services/utilityReadingRuns.ts:263` — MEDIUM — **[OBVIOUS FIX]**
`startDoubleCheckPhase`'s pad-selection query has no reason filter, so a same-month reference read can become a double-check's `first_value` instead of the cycle read.
- **Failure:** A clean submeter has a `stay_turnover` read (5000) and its `monthly_cycle` read (5200), both unflagged. The pads query returns both; `ON CONFLICT(run_id,meter_id) DO NOTHING` under `ORDER BY random()` may keep `first_value=5000`. The verifier re-reads ~5200; `|5200-5000|=200 > tolerance(2)` → spurious "replaced" outcome, an unnecessary bill delete+regen, and (compounded by finding #2) corruption of the turnover baseline. `MIN=6` pads means the path is routinely hit.
- **Fix:** Filter the suspects/pads queries with `AND rd.reason = 'monthly_cycle'`.

### 15, 18 & 20. `apps/api/src/routes/utility.ts:720` — MEDIUM — **[OBVIOUS FIX]**
*(Consolidated — reported three times under metering-billing-core, permissions-scope, and frontend-metering-ui; one defect.)* The `/readings/flagged` prior-reading LATERAL still picks the prior by `billing_cycle_month <` ordering instead of the S559 point-in-time `(reading_date, created_at)` tuple, so a same-month turnover/replacement read is skipped and the landlord's rollover-vs-swap decision is shown the wrong baseline.
- **Failure:** A submeter has a mid-month `meter_replaced`/`stay_turnover` read (same `billing_cycle_month` as the monthly run). The flag is raised against the point-in-time prior (the same-month reset read), but the flagged-queue LATERAL filters `p.billing_cycle_month < r.billing_cycle_month`, excludes the same-month read, and displays the *prior cycle's* value. `ReviewReadingModal` then shows a `Previous/Entered` pair inconsistent with both the flag basis and the actual re-bill math (which uses the point-in-time prior), so the landlord may hide the rollover/swap radios and confirm against the wrong prior. *Note: the verifier found the money outcome is largely self-correcting because `generateBillsForMeter` recomputes from its own point-in-time prior; the confirmed harm is a display/decision-integrity inconsistency on the one surface built to show accurate prior/entered side-by-side.*
- **Fix:** Replace the LATERAL with the point-in-time selection used at flag time and in billing: `WHERE (p.reading_date, p.created_at) < (r.reading_date, r.created_at) ORDER BY p.reading_date DESC, p.created_at DESC LIMIT 1`.

### 16. `apps/api/src/services/utilityBilling.ts:478` — MEDIUM — **[NEEDS DECISION]**
`billMoveOutRead` computes raw current-minus-prior with no odometer-rollover handling, so a move-out read whose meter wrapped bills nothing.
- **Failure:** A departing tenant on a 6-digit submeter at 999500 wraps to 000300 (true usage 800). `move_out_final` special read of 300 → `300-999500 = -999200 < 0` → `{billed:false, reason:'negative usage'}`; the 800 units are never billed. Unlike `generateBillsForMeter` there is no `is_rollover` path, and special reads never enter a double-check that could confirm the wrap, and are not flagged (so they never surface in the flagged queue).
- **Fix:** Reuse `cycleUsageFromReadings` with the meter's digit count and a rollover determination (treat a plausible wrap as rollover, or flag for review) instead of a bare subtraction. Design decision needed because special reads have no double-check queue.

---

## Area: invoice-deposit-blast

### 5. `apps/api/src/jobs/invoiceGeneration.ts:336` — HIGH — **[OBVIOUS FIX]**
The S534/S558 invoice read-hold counts ANY reading for the cycle month instead of only `reason='monthly_cycle'`, so a point-in-time special read masks a missing cycle read and lets the invoice ship without the utility charge.
- **Failure:** A tenant-responsible submeter with an open monthly run; on Aug 10 the front desk enters a `stay_turnover` special read (`billing_cycle_month=2026-08-01`), but no `monthly_cycle` read yet. The invoice cron fires: the `NOT EXISTS` hold finds the turnover row → false → hold does not fire; `flagHold` also skips (special reads aren't flagged). `ensureBillsForUnit` bills only `monthly_cycle` reads → no `utility_bill` → invoice ships rent-only, submeter usage silently omitted.
- **Fix:** Add `AND rd.reason = 'monthly_cycle'` to the `NOT EXISTS` subquery so the hold clears only when the actual cycle read has landed.

### 6. `apps/api/src/jobs/invoiceGeneration.ts:350` — HIGH — **[OBVIOUS FIX]**
The RUBS-master hold's submeter-unread check (lines 347-350) also omits `reason='monthly_cycle'`, so a turnover read on a feeder submeter falsely satisfies "submeter read" and releases the RUBS hold with an incomplete pool.
- **Failure:** A RUBS master needs all submeters read before the pool computes. A guest turns over on one submetered spot mid-cycle → `stay_turnover` special read; that submeter's `monthly_cycle` read is still missing. The RUBS `NOT EXISTS` finds the turnover row → the hold no longer reports it unread; with the master read, the whole hold clears. `generateBillsForMeter` then blocks on the missing cycle read → 0 RUBS bills → the tenant's invoice ships without the RUBS charge.
- **Fix:** Add `AND rd2.reason = 'monthly_cycle'` to the submeter `NOT EXISTS` (and mirror on the master self-read `NOT EXISTS` at 333-336, i.e. finding #5).

---

## Area: permissions-scope

### 9. `apps/api/src/routes/utility.ts:496` — HIGH — **[OBVIOUS FIX]**
S559 gave the property-locked `onsite_manager` write access to utility endpoints via `utility.read_meters`, but those endpoints check only landlord-level access (`canAccessLandlordResource`) and never property scope (`assertPropertyInScope`), so a clerk locked to one property can act on meters at every other property under the same landlord.
- **Failure:** An `onsite_manager` with `property_ids=[A]`, `all_properties=false`, `utility.read_meters=true` POSTs `/utility/meters/<meterAtPropertyB>/reads {reason:'move_out_final'}`. `canAccessLandlordResource` only checks `landlordId` match → passes → `billMoveOutRead` bills a tenant at property B outside the clerk's lock. Same gap on monthly readings (487), opening runs (449), and double-checks (603). The hard property-lock enforced on schedule/reservations/inspections is absent from every utility route. `units.ts` correctly uses `assertPropertyInScope` on the parallel path, confirming the deviation.
- **Fix:** Call `assertPropertyInScope(req.user, property.property_id)` after the landlord check on the utility write endpoints, and scope `GET /meters` via `getScopedPropertyIds`.

### 8. `apps/api/src/routes/utility.ts:316` — HIGH — **[NEEDS DECISION]**
`GET /meters/:id/readings` is gated to the blind front-desk perms (`utility.read_meters`/`units.view_status`) but returns `SELECT *` — every historical `reading_value`, `needs_review`, `review_note`, `is_rollover` — exposing the exact prior/entered values the S559 design keeps hidden from readers.
- **Failure:** An `onsite_manager` whose only utility grant is `utility.read_meters=true` calls the endpoint; `requirePerm` is OR-semantics so it passes, and the handler returns the full readings array including every cycle's `reading_value`. The reader now knows last and current entered values, defeating the blind double-check bias-prevention that the sibling `/readings/flagged` was deliberately locked to `properties.edit`. `git` history shows the reader key was added to this value-returning endpoint in the same S559 changeset that locked the sibling.
- **Fix:** Two defensible remedies — gate to `properties.edit` only (mirror `/readings/flagged`), or return a value-stripped projection so a pure reader still sees dates/reason but not values. Product call on what a reader UI should show.

---

## Area: check-in-bookings

### 17. `apps/api/src/services/utilityReadingRuns.ts:603` — MEDIUM — **[OBVIOUS FIX]**
`getReadsDue` does not exclude `out_of_service` meters, unlike `unitPendingReads`, so a broken submeter after a departure is perpetually listed as a read that is due but is never taken (it bills from comparables) and can never clear.
- **Failure:** Submeter M on unit U has `out_of_service=true` (bills `comparable_low`, never reread). A lease on U ends July 1. `GET /utility/reads-due` joins `utility_meters` filtering only `billing_method='submeter'` (no `out_of_service` filter), so M shows as a `move_out_final`/`stay_turnover` due read. No one reads a broken meter → `NOT EXISTS` stays true → M shows in the to-do list for the full 60-day window, confusing front desk. `unitPendingReads` (line 639) correctly excludes it, so the two surfaces disagree. Not a money bug.
- **Fix:** Add `AND m.out_of_service = false` to the `utility_meters` join in `getReadsDue`.

---

## Area: frontend-metering-ui

### 21. `apps/landlord/src/pages/UtilityMetersPage.tsx:242` — LOW — **[NEEDS DECISION]**
The Utility Bills table's Reads column (`readingStart → readingEnd`) is rendered with no `canReview` gate, exposing prior/entered submeter readings to non-landlord staff — contradicting the S559 rule that only `properties.edit` holders see prior/entered values.
- **Failure:** A staff user without `properties.edit` reaching `/utilities` (via `utility.read_meters` + `units.view_status` nav, or direct URL) sees every completed submeter bill's start/end odometer reads; `GET /utility/bills` returns them for onsite_manager/property_manager roles. The latest bill's `readingEnd` is exactly the prior read for that spot's next blind cycle, defeating the blind-entry standard. Low severity: completed-bill history, requires correlation, values already billed.
- **Fix:** Gate the Reads column (or whole bills table) behind `canReview`, mirroring the flagged-readings card and `MeterConfigSection`. Decision on whether canRead staff should still see status/usage but not raw reads.

---

## Apply tonight (obvious)

1. `auth.ts:48` — **CRITICAL** — reject `purpose`-bearing tokens in `requireAuth` (kills the 2FA bypass; also covers `/refresh`).
2. `payments.ts:454` — set card `status='processing'` and let the webhook allocate.
3. `utilityReadingRuns.ts:366` — add `reason='monthly_cycle'` to the double-check UPDATE.
4. `utilityReadingRuns.ts:219` / `routes/utility.ts:430` — add `cur.reason='monthly_cycle'` to `getRunMeters` `is_read` join and meters-read count.
5. `utilityReadingRuns.ts:453` — add `rd.reason='monthly_cycle'` to `isRunFullyRead`.
6. `invoiceGeneration.ts:336` — add `rd.reason='monthly_cycle'` to the read-hold `NOT EXISTS`.
7. `invoiceGeneration.ts:350` — add `rd2.reason='monthly_cycle'` to the RUBS submeter `NOT EXISTS`.
8. `routes/utility.ts:496` — add `assertPropertyInScope` to utility write endpoints (reads/reading/double-checks/open-run) + scope `GET /meters`.
9. `utilityReadingRuns.ts:263` — add `reason='monthly_cycle'` to suspects/pads selection.
10. `routes/utility.ts:720` — switch flagged-readings prior LATERAL to the point-in-time `(reading_date, created_at)` tuple (fixes all three reports of this defect).
11. `utilityReadingRuns.ts:603` — add `m.out_of_service=false` to `getReadsDue`.
12. `routes/totp.ts:292` — thread `businessId`/`staffRole` through `signTotpSessionToken` and `/totp/verify`.

## Morning decisions (ambiguous)

1. `routes/utility.ts:316` — reader-perm data exposure: lock to `properties.edit` vs. value-stripped projection (what a reader UI should show).
2. `webhooks.ts:1041` — `charges.data[0]` vs. modern `latest_charge`: retrieve/expand/`payment_method_types`, and where the async call sits relative to the DB transaction.
3. `stripeConnect.ts:689` — dispute loss recovery: `losses.payments='stripe'` vs. transfer reversal at `created` vs. on lost `closed`; multi-destination PM/manager and win/re-transfer timing.
4. `auth.ts:335` — server-side mandatory-TOTP enforcement for un-enrolled admins: enrollment-scoped token vs. JWT claim + guard vs. `totp_enabled` re-fetch.
5. `utilityBilling.ts:478` — move-out odometer rollover handling: special reads have no double-check queue, so wrap confirmation needs a design call.
6. `UtilityMetersPage.tsx:242` — gating the bills Reads column: hide reads while still showing status/usage to canRead staff.
---

## Verification (Claude, overnight)

**11 obvious fixes applied + verified.** Clean `tsc --noEmit` (api); **232 tests pass** across every affected suite (utilityBilling, utility, utilityReadingRuns, units, totp, auth, authBusiness, leaseLifecycle, loginLockout, passwordReset, emailVerification), including **2 new regression tests**:
- `totp.test.ts` — a `totp_pending` token is rejected by a `requireAuth` route and by `/refresh` (guards the CRITICAL 2FA bypass).
- `utilityReadingRuns.test.ts` — a mid-month `stay_turnover` read does not mark the meter read or auto-complete the monthly run (guards the silent under-billing regression).

Applied:
1. `middleware/auth.ts` — `requireAuth` rejects any `purpose`-bearing token (kills the 2FA bypass + `/refresh` upgrade). **[CRITICAL]**
2. `utilityReadingRuns.ts` — `reason='monthly_cycle'` on: `getRunMeters` is_read join, `isRunFullyRead` join, `enterDoubleCheck` UPDATE, double-check suspects+pads; `out_of_service=false` on `getReadsDue`.
3. `routes/utility.ts` — `reason='monthly_cycle'` on meters-read count; flagged-readings prior LATERAL switched to point-in-time `(reading_date, created_at)`; `getScopedPropertyIds` on `GET /meters`; `assertPropertyInScope` on open-run / reading / double-check / special-read / reads-due (property-lock).
4. `jobs/invoiceGeneration.ts` — `reason='monthly_cycle'` on both read-hold `NOT EXISTS` (meter + RUBS submeter).
5. `routes/totp.ts` + `auth.ts` — thread `businessId`/`staffRole` through the TOTP session so 2FA doesn't strip GAM Books access.

Nothing committed — all unstaged for review.
