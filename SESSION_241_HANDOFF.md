# Session 241 — closed

## Theme

Big sweep through Nic's S240-prep decisions, then recon-found one
stale DEFERRED entry + shipped the Stripe Terminal reader-management
backend. Six items closed end-to-end (1, 2, 3, 4, 7, 12-partial);
three S240-prep tombstones cemented (5, 6, 13).

## Items shipped

### 1. AZ-specific marketing copy — stripped

CLAUDE.md "no AZ § citations anywhere in the product" applies to
marketing too. Nic decision: "drop state specific marketing."

`apps/marketing/src/index.html`:

| Surface | Replacement |
|---|---|
| Eviction protection card | "Per A.R.S. § 33-1371…" → "Accepting any rent can waive your eviction rights in many states. (Check your local laws.)" |
| Eviction Mode feature | "A.R.S. § 33-1371 protection" → "preserves right to evict where accepting rent would waive it" |
| Pricing line | "Eviction Mode — A.R.S. § 33-1371 protected" → "preserves eviction rights" |
| Compare table | "✓ A.R.S. § 33-1371" / "✓ AZ-compliant" → "✓" |
| Utility Billing card | "AZ-compliant calculations" → "itemized calculations" |
| Documents card | "AZ-compliant lease templates" → "Customizable lease templates" |
| 3 testimonials | "Phoenix/Tucson/Mesa, AZ" → unit-count only |
| Footer brand | "Built for Arizona landlords… Arizona · Est. 2026" → "Est. 2026" |
| Footer legal | "per A.R.S. § 33-1314" → "under applicable state law" |
| Footer copyright | "Arizona · All rights reserved" → "All rights reserved" |

Verified zero remaining hits via `grep -niE "Arizona|AZ\b|Phoenix|Tucson|Mesa|A\.R\.S\."`.

### 2. utility_bills payment integration — already shipped S178

Recon caught this as a stale DEFERRED entry. The exact "roll
unbilled utility_bills into the rent invoice as line items"
integration was shipped at S178 — `jobs/invoiceGeneration.ts:182-318`
pulls unbilled rows per cycle, writes `payments` rows with
`type='utility'` linked to the invoice, stamps
`utility_bills.payment_id` + flips status to 'billed'. The pre-S178
standalone `/api/utility/bills/:id/pay` path was retired in that
same session.

DEFERRED carried the entry forward unmarked; tombstoned this session
with a recon-finding note. Same stale-DEFERRED pattern as the S232
S113 audit + EOD-POS audit.

### 3. POS configurable tax tables → cart math

Nic decision: "have tax tables configurable so user can do what
they want."

**New service** `apps/api/src/services/posTax.ts:calculateCartTax`:
- Reads live `pos_tax_rates` per landlord
- Resolves each line item's property + category (via
  `pos_items.property_id` + `pos_categories.name`)
- Matches rates via `applies_to`:
  - `['all']` → every category
  - `['category_name', ...]` → case-insensitive category match
- **Stacks** multiple matching rates per line
- Property-bound rates win for items on that property; landlord-wide
  (NULL property_id) rates are the fallback when none configured

**Wired into** `POST /pos/transactions`: client-supplied `subtotal` /
`taxAmount` / `total` are now ignored — server-computed values from
`calculateCartTax` overwrite them. Walk-up items without a
`pos_items.id` still respect client `tax`/`tax_rate` (no DB source
of truth to override).

**Smoke**: 3 × $2.00 with 10% rate → subtotal $6.00, tax $0.60,
single applied rate. Verified end-to-end against a real
landlord/property/item/rate.

### 4. pos_items per-property migration

Nic decision: "pos is per property as likely a different LLC
operator."

Migration `20260510140000_pos_items_property_required.sql`:
- Pre-S241 `property_id` was S192-NULLABLE with "NULL = landlord-wide"
- Verified zero existing rows in pre-migration audit
- `ALTER TABLE pos_items ALTER COLUMN property_id SET NOT NULL`

Routes updated:
- `POST /pos/items` requires `propertyId` (400 if missing); validates
  ownership.
- `GET /pos/items?propertyId=...` filters strictly by `property_id`
  (pre-S241 was `property_id = $2 OR property_id IS NULL` to surface
  landlord-wide rows).
- Default-items seeding requires explicit `propertyId` query param.
  Pre-S241 seeded landlord-wide rows; that's no longer valid.

### 7. Deposit-interest model under destination charges

Nic decision: "interest on deposits goes to gam if gam holds it
unless state requires it to go to tenant."

**Recon finding**: existing code already implements this. The
`depositInterest.ts` cron only accrues for states listed in
`state_deposit_interest_rates`; unlisted states leave
`interest_accrued = 0`, and the yield GAM earns on the held
principal is implicit GAM revenue (bank/platform-balance income).
`depositReturn.calculateDepositReturn` correctly adds
`interest_accrued` to the tenant pool only when non-zero.

**No code changes** — model was already right; the framing was
the gap. Updated header comments in `depositInterest.ts` and
`depositReturn.ts` to lock the S241 policy explicitly.

### 11. F1 Marketing rebuild — "summary of the launch product"

Nic direction: "marketing rebuild should be a summary of the launch
product." Single-session full rewrite of
`apps/marketing/src/index.html`:

**Hero stats fixed**: $15/unit (stale) → $2/unit (current). Hero
subtitle adds the GTM angle: "purpose-built for RV parks, extended-
stay properties, and small-to-mid landlords nationwide" per CLAUDE.md.

**Features grid rebuilt** (5 of 9 cards rewritten):
- ✅ Kept: On-Time Pay Guarantee, Eviction Mode, Utility Billing,
  Maintenance, E-sign + Documents
- 🆕 Multi-portal Platform (landlord/tenant/on-site mgr/PM company/
  POS/books/listings)
- 🆕 Stripe Connect Rail (destination charges, 1-2 day settlement)
- 🆕 Per-state Compliance (38-state deposit interest + tax-form
  deadlines + annual refresh)
- 🆕 Point-of-Sale (RV park camp stores + per-property inventory
  + Stripe Terminal hardware-agnostic)
- 🆕 Tenant Screening (Checkr-backed + GAM applicant pool + FCRA
  adverse action notices)
- ❌ Dropped: FlexDeposit (pre-launch, behind flag)
- ❌ Dropped: Tenant Credit Reporting to 3 bureaus (we don't bureau-
  report; we have an internal Credit Ledger gated to lending services)
- ❌ Dropped: "AZROC-licensed contractors" → "licensed contractors"
  (state-specific)

**Pricing section rebuilt** (3 cards):
- Platform Fee: $2/occupied unit + $10/property minimum + $0 vacant
- Payment Processing: 1.0% ACH cap $6 / 3.25% card flat / +1.5%
  Canadian USD surcharge / no separate Connect account fee
- Volume / Partner: custom, superadmin-set per-landlord rate cuts +
  CSV migration from 8 platforms + PM company third-party fee splits
  + direct API access

Footer pricing claim + CTA section updated to match.

**Comparison table updated**:
- Dropped: FlexDeposit installments, 3-bureau credit reporting
- Added: Built-in POS, Per-state deposit-interest compliance, PM
  company third-party fee splits, CSV migration from 8 platforms
- Fixed: pricing row ($15 → $2/unit + $10/property), reserve-fund
  backing language

Verified: zero remaining hits for `\$15` / AZROC / FlexDeposit /
"3 bureaus". Tag-balance check clean (6/6 sections, 185/185 divs).

Future enhancements (portal previews, dedicated audience pages,
lead-capture flow) are separate scope.

### 12 (partial). Stripe Terminal reader-management backend

Nic decision: "if we are using stripe api any stripe hardware
should work."

**Schema** `20260510150000_pos_terminal_readers.sql`:
- New table `pos_terminal_readers` with `id`, `landlord_id`,
  `property_id`, `stripe_reader_id`, `nickname`, `status`
  (active/archived), timestamps
- UNIQUE(`landlord_id`, `stripe_reader_id`) — prevents double-
  registration of the same physical reader
- Partial index on `(property_id) WHERE status='active'` for fast
  "live readers at this property" lookups

**Service** `apps/api/src/services/posTerminal.ts`:
- `createConnectionToken(landlordConnectAccountId)` — issues short-
  lived Connection Token for the Stripe Terminal SDK
- `registerReader({...})` — exchanges a `registrationCode` shown on
  the reader screen for a Stripe `terminal.readers.create` then
  persists locally
- `listReaders(landlordId, propertyId?)` — active readers, scoped
- `archiveReader(landlordId, readerId)` — soft-archive

All Stripe Terminal API calls fire under the LANDLORD's Connect
account (`{ stripeAccount: landlordConnectAccountId }`) — readers
belong to the landlord's Stripe account, not GAM's platform. Matches
the rest of the POS revenue model.

**4 new routes** in `pos.ts`:
- `POST /api/pos/terminal/connection-token`
- `POST /api/pos/terminal/readers` (register)
- `GET /api/pos/terminal/readers?propertyId=...`
- `DELETE /api/pos/terminal/readers/:id` (soft-archive)

All routes pull the landlord's Connect account id via
`getLandlordConnectId(profileId)` helper; throws 409 if the
landlord hasn't completed Connect onboarding yet.

**Out of scope**: payment-processing flow (create card-present PI,
process on reader, capture, webhook reconciliation). That's the
S242 follow-up.

## Items already closed in S240-prep (tombstone-only this session)

- **5. Primary manager urgency tier (S185)** — leave alone.
- **6. Owner-financial-escalation pattern (S186)** — PMs own
  notifying LL; no platform-level escalation.
- **13. POS receipt printing** — no paper receipts ever.

## Files touched (S241)

```
apps/marketing/src/index.html                  (AZ copy stripped,
                                                state-neutral replacements
                                                across 12 surfaces;
                                                full rewrite to match
                                                launch product:
                                                hero stats, features grid,
                                                pricing, comparison
                                                table)

apps/api/src/services/posTax.ts                (NEW — tax calculator,
                                                ~190 lines)
apps/api/src/services/posTerminal.ts           (NEW — reader management,
                                                ~140 lines)
apps/api/src/routes/pos.ts                     (+ tax calculator wired
                                                  into POST /transactions,
                                                + 4 terminal routes,
                                                + getLandlordConnectId
                                                  helper,
                                                ~ POST /items: propertyId
                                                  required,
                                                ~ GET /items: strict
                                                  property_id filter)
apps/api/src/db/migrations/
  20260510140000_pos_items_property_required.sql (NEW)
  20260510150000_pos_terminal_readers.sql         (NEW)
apps/api/src/db/schema.sql                       (auto-regen)

apps/api/src/services/depositInterest.ts        (~ header comment:
                                                  S241 policy lock)
apps/api/src/services/depositReturn.ts          (~ inline comment:
                                                  S241 policy lock)

DEFERRED.md                                     (6 items closed +
                                                 tombstones; queue
                                                 dramatically tightened)
SESSION_241_HANDOFF.md                          (this file)
```

## Verification

- `cd apps/api && npx tsc --noEmit` → clean
- `cd apps/api && npm run schema:diff` → unchanged (only pre-launch
  Flex Suite phantoms remain)
- `cd apps/api && npm run migrate` → 2 migrations applied cleanly
- AZ-copy grep across `apps/marketing/src/index.html` → zero hits
- posTax smoke verified: $6.00 subtotal + $0.60 tax single rate stack
- All new posTerminal routes typecheck + DB schema available

## Decisions made (S241)

| Question | Decision |
|---|---|
| utility_bills "where applicable" gate — what defines it? | Recon answered: the `utility_bills` row's existence IS the gate. Upstream `lease_utility_responsibilities` controls whether bills GET GENERATED at all; by the time a row exists, it's applicable. S178 implementation matches. No code work needed — entry was stale in DEFERRED. |
| POS tax: trust client, or server-compute? | Server-compute, ignore client. Money math is authoritative server-side. Walk-up items keep client tax (no DB row to override against). |
| Stripe Terminal Connect account — landlord's or GAM's? | Landlord's. POS sales are landlord revenue; the reader, the PI, and the funds all live in the landlord's Connect account. GAM doesn't intermediate POS revenue. |
| Payment-processing flow in same session as reader management? | No. Reader management is the pairing infrastructure; payment processing needs create-PI + processPaymentIntent + capture + webhook handling — substantively different work. Splitting keeps each session bounded. |
| Stripe-side reader delete on archive, or soft-archive only? | Soft-archive only. Landlord can delete via Stripe dashboard if desired; our archival hides from POS UI without losing historical references. Stripe-side delete is destructive + irreversible. |
| Deposit-interest yield to GAM — track in a ledger? | Not yet. Yield is implicit in bank/platform balance income; no GAM-side accounting layer needed unless we want explicit revenue attribution. Future-future concern. |
| AZ A.R.S. citations in marketing — replace with generic legal language or strip entirely? | Replace with generic. The Eviction Mode + Utility Billing + Collection Agent features are real; underlying legal concepts apply broadly. "Check your local laws" disclaimer per CLAUDE.md state-neutral framing. |

## Carry-forward — S242+

### Still need from Nic (asked, no answer yet)

- **A. Flexion 8 spec** — **partial answer**: Nic confirmed it's
  landlord-facing while the other Flex products are tenant-facing,
  and **not needed now**. Flex Suite epic is unblocked to start
  without Flexion 8. Flexion 8 stays in DEFERRED for future spec.
- **B. Marketing rebuild positioning** — **partial answer**: Nic
  said "summary of the launch product." Scope can be derived from
  CLAUDE.md + product state (current portals, Stripe Connect rail,
  credit ledger, RV/extended-stay focus, multi-portal architecture).
- **C. utility_bills "where applicable" gate** — **resolved by
  recon**: already shipped S178, no further input needed.

### Open queue post-S241

**Pickable (no input needed):**
- Stripe Terminal payment-processing flow (S241 follow-up — readers
  registered; now wire card-present PIs through them)
- /resolve smoke (testing — Nic-runs)
- POS end-to-end smoke (testing — Nic-runs)
- POS multi-terminal session sync (likely premature)

**Monday-trigger:**
- Checkr Partner post-approval items.

**Multi-session epics — all greenlit per S240-prep, all pickable now:**
- **Flex Suite** (FlexPay / FlexCharge / FlexDeposit / FlexCredit,
  tenant-side, hidden behind launch flag). Flexion 8 deferred.
- **OTP full build** (landlord/tenant UI surface + advance-from-
  reserve disbursement + qualification gate confirmation, hidden
  behind same launch flag).
- **Sublease subsystem** (greenfield, full scope pre-launch).
- **F1 Marketing rebuild** (summary of launch product, scope from
  CLAUDE.md + current product state).

## Revised count

S241 closed 7 line items + cemented 3 prior-session tombstones +
unblocked the Flex epic (Flexion 8 deferred separately) + the
Marketing rebuild epic landed in-session.

| Bucket | Pre-S241 | Post-S241 |
|---|---|---|
| Pickable now | ~4 | ~3 (testing + multi-terminal + Terminal follow-up) |
| Nic-blocked | 5 | 0 (all answered or deferred) |
| External-vendor-blocked | 1 | 1 (Checkr Mon-trigger) |
| Multi-session epics | 3 | 3 (Flex / OTP / Sublease — Marketing closed) |
| npm audit | 1 | 0 |
| Pre-launch flag-gated | 2 | 2 (now actionable) |

**Until v1 launch-ready:** ~7 sessions → ~4–5 (with Flex / OTP /
Sublease as the remaining multi-session epics; Open queue mostly
tombstoned; Checkr Mon-trigger ready).

---

End of S241 handoff.
