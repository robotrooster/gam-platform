# SESSION 568 HANDOFF

**Theme:** Data-retention audit + a large MH/RV product build. Confirmed history
is permanent (retention audit + fixes), then built five interlocking
features Nic asked for: onboarding reconciliation, rent line-item split, financed
home sales, full generic e-sign (with a contact/customer pool), home-ownership
tracking, and the investor-as-independent-operator model (homes-only parks + lot
rent + investor net). **Everything deployed to prod as we went** (self-hosted
`gam` DB + launchd API rebuilt/restarted after each change). **All UNCOMMITTED —
Nic pushes at the end.** 20 migrations applied to the prod DB this session.

Read alongside `SESSION_567_HANDOFF.md`. Memory: **[[gam-data-retention-keep-everything]]**,
**[[gam-mh-rv-sales-and-reconciliation]]**.

---

## 1. Data-retention audit + fixes (Nic's opening ask)
Standing rule confirmed: **GAM never erases; a user "delete" only hides from
their profile, never leaves our server.** Full delete-sweep of both portals:
- **Structurally permanent:** no route deletes properties/units/leases/historied
  tenants; the FK graph blocks cascade destruction; move-outs are status changes.
- **Fixed:** pending-invite cancel was the one hard-erase (tenant+user+PDF) →
  now a **soft-hide** (`pending_tenant_intents.cancelled_at`); utility-meter
  delete was cascading away reading history → now guarded (retire via
  `out_of_service`).
- **Bonus launch-critical fix:** invoice-generation cron was crashing on one bad
  (demo) lease and aborting the whole run → now isolates per-lease (log-and-skip).

## 2. Onboarding reconciliation ("already paid off-platform")
First rent invoice can be marked paid off-platform (old-system autopay overlap)
so tenants aren't double-charged during a landlord's migration. **Gated on the
LANDLORD's reconciliation window** (`landlords.reconciliation_until`, auto now+21d
at creation) — NOT lease source (Nic's correction: new-vs-imported is irrelevant).
First rent only, fee-free. `POST /payments/:id/record-prior-arrangement`;
`prior_arrangement_eligible` on `GET /payments`; PaymentsPage button.

## 3. Rent line-item split (space + trailer rent)
`lease_rent_components` (kind space/trailer/other, sums to `leases.rent_amount`,
billing stays one rent payment). `PUT /leases/:id/rent-components`; inline editor
in LeaseOverviewModal.

## 4. Financed home sale
`home_sale_contracts` + `home_sale_installments` (shared `computeAmortization`),
new `type='home_payment'` (routes to landlord/seller via platform-holds, NOT
`rent`), daily billing cron auto-stops at term, flips unit to tenant-owned on
payoff (+ records buyer as home owner). FinancedSaleSection on UnitDetailPage.

## 5. Generic e-sign (full — any parties)
Standalone (non-lease) documents on the SAME engine, built ADDITIVELY (lease
signing untouched — verified). `STANDALONE_DOCUMENT_TYPES` + arbitrary signer
roles (`isValidSignerRole`) + `POST /esign/standalone-documents`. **Account-gate
+ customer/contact pool:** every signer resolves to a GAM account; new emails mint
a free `contact` account (customer pool, no landlord/tenant profile) + invite —
no raw-email delivery (anti-spam/consent). **Contact signing works end-to-end**
via the existing send→/accept-invite→/sign flow (send landlord-first check gated
to leases; `accept-invite` made role-aware; tenant app is token-gated not
role-gated). **Landlord "New Contract" UI** in ESignPage (verified rendering).

## 6. Home-ownership tracking
`home_ownerships` (owner = economic sublessor; owner = ANY user; one active per
unit; history retained; `assignHomeOwnerByContact` mints a contact for EXTERNAL
investors). `/api/home-ownerships` (unit owner+history, assign/transfer,
portfolio). Financed-sale payoff records the buyer. HomeOwnerSection on
UnitDetailPage.

## 7. Investor-as-independent-operator (landlord-optional) — Nic strategic
An investor who owns homes across many parks operates on GAM **without any park
owner on the platform** (adoption not gated on a landlord). They're just an
operator (reuse the landlord portal).
- `properties.operator_owns_land` (FALSE = homes-only external park; toggle in
  PropertiesPage), `units.lot_rent_amount` (AddUnitModal field + live net).
- **Lot-rent economics (finished this session):** `lot_rent_charges` obligation
  ledger + monthly accrual cron (`services/lotRent.ts`) + `record-paid` (operator
  pays the park OFF-platform, GAM moves no money) + `getInvestorPortfolio` (net =
  tenant rent − lot rent). `/api/lot-rent/*`. **LotRentPage** ("Lot Rent & Net"
  nav) — verified rendering.
- Lot rent is its OWN ledger, NOT a `payments` row (that rail is tenant money
  through GAM; lot rent is the operator's off-platform expense).

---

## State
- **331 tests green** across the 10 touched suites; per-suite green throughout.
- Migrations `20260730120000` … `20260730230000` (12 this session's MH/RV block)
  + the retention ones, all on the prod `gam` DB. `psql gam -c "SELECT filename
  FROM schema_migrations ORDER BY filename DESC LIMIT 14;"` to confirm.
- API rebuilt + `launchctl kickstart -k gui/$(id -u)/com.gam.api` after each
  change; frontends Vite-live.
- **Nothing committed.**

## Open / deferred (all logged in [[gam-mh-rv-sales-and-reconciliation]])
- Tenant-to-tenant home-ownership: the CONTRACT is already facilitatable (New
  Contract); the DATA layer now exists (home_ownerships). Fine.
- Investor model follow-ons (NOT launch-blocking): GAM Books integration of the
  lot-rent expense; park-owner upsell/viral loop.
- Convenience: one-click "Generate purchase agreement" from a financed sale.
- Demo landlord james@demo.dev reconciliation window is CLOSED (created 7/11) —
  extend `landlords.reconciliation_until` to demo feature #2 on demo data.

## Next
- Nic will **walk the landlord + tenant portals** (drives; fix UI live).
- Standing launch blockers unchanged: live Stripe cutover (C4/C5) + Oak Park data
  entry (N2/N3/N4).
