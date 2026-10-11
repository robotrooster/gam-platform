# Session 644–647 Handoff — 2026-09-16

Covers S644 through S647 (Sept 15–16). Everything listed as built is committed, deployed, and passing (last full suite: 7,390+ green). Nothing is uncommitted.

---

## 1. START HERE — Page 8 of the Mountain View RV lease, and move-in charges

### What already exists

- **Property-level move-in fees exist.** The table is `property_fee_schedules`, edited in the landlord portal (`PropertyFeeScheduleSection.tsx`). It holds fee type, amount, refundable, and due timing per property. **It has zero rows** — nothing is set for any property.
- **Some move-in boxes are wired to billing.** On page 8: Pet deposit (`pet_deposit`), Pet fee (`pet_fee`), and Rent pre-payment (`last_month_rent`). On page 2: Security deposit (`security_deposit`). When the landlord signs, each of these becomes a `lease_fees` row and bills on the move-in invoice.
- **The property schedule does NOT pre-fill the lease.** Its only job today is to flag a lease fee as an "override" when it differs from the property default. Setting a $350 pet deposit at the property level puts nothing on page 8.
- **Four page 8 boxes are tied to nothing:** First month's rent, Proration, Total due, and a second Security deposit box that duplicates page 2's. Billing never reads them.
  - This is how Martin Alvarado's lease (RV 34) said $589 on page 2 and $495 on page 8. Nic typed $495 in the two untagged page 8 boxes, and billing followed page 2.
- **There is no utility-deposit charge type.**

### What Nic said (directives from the end of this session)

- Page 8 is the **move-in invoice for new tenants**. For people being onboarded, whose fees were paid long ago, Nic types $0 in those boxes so nothing re-bills. Onboarded residents are exempt because any applicable fees were already paid at move-in.
- **Proration for a new tenant:** charge from the move-in date through the end of that month, then bill in full from the 1st.
- **Another prospective landlord doesn't prorate at all.** They bill each tenant on the day of the month the tenant moved in (anniversary billing). **GAM needs a billing-cycle engine that supports both**: calendar-month with proration, and anniversary date with no proration.

### Proposal awaiting Nic's decision (NOT built)

1. New move-ins: page 8 fee boxes pre-fill from the property fee schedule, and stay editable while signing.
2. Onboarding existing residents: fee boxes pre-fill $0. **Open question:** should the system zero them, or leave that to Nic?
3. First month's rent, Proration, and Total due fill themselves from the lease terms and can't be typed in. They show exactly what the move-in invoice will bill.
4. Page 8's Security deposit mirrors page 2's, so the two can never disagree.
5. Optional: add a utility deposit charge type, settable at the property level.
6. **New:** a per-property (or per-landlord) billing mode: calendar-month-with-proration vs anniversary-date-no-proration. Needs design: where it's set, how invoice generation, late fees, the platform fee, and work-trade settlement all key off it.

**Relevant code:** `moveInRentAmount()` and `existingTenancyCycle()` in `apps/api/src/jobs/moveInBundle.ts`; `FEE_ROW_SPECS` / `LEASE_COLUMN_CATEGORY` in `packages/shared/src/index.ts`; fee-row insert and schedule comparison in `executeOriginalLease` in `apps/api/src/routes/esign.ts` (around line 1110).

---

## 2. How Nic wants to be worked with (said forcefully this session)

- **Only act on a clear directive. When there's a design choice, ASK first.** Don't make decisions on his behalf.
- **Things that move money must be right.** Say what will be touched before touching it.
- **Don't mix up units.** When he's talking about RV 34, don't bring in RV 09. Always scope to the unit and property he named.
- **Describe the product as designed, not the old mechanics.** Earlier I told him tenants can sign from the emailed link before accepting; that isn't the flow he designed, and it confused him.
- **Say "test data" plainly.** A made-up date in a test fixture is not one of his leases.
- **Don't void or redraft a document he may have open.** I voided Clay's draft while Nic had it open, and his signature wouldn't finalize.

---

## 3. Onboarding / signing flow (the Build Plan artifact) — built this session

Build plan: https://claude.ai/artifact/L2EBfs1X3YZifaknyEnNCc

**The flow as Nic designed it:**
Landlord onboards names → **no tenant email** → leases draft into the landlord's "Waiting on you to sign" list → **landlord signs** → the lease and its first invoice are created (billing starts) → the tenant gets **one** email → accept, password, code, and signature are one continuous flow.

### Built and live

| Piece | What it does |
|---|---|
| **Issuance on landlord signature** | The landlord's signature builds the lease and move-in invoice. There is still one billing path (`buildLeaseFromDocument` → `generateMoveInInvoice`); only *when* it runs changed. The lease records `signed_by_tenant = FALSE` until the tenant signs. `lease_documents.issued_at` stamps issuance. |
| **Completion guard** | A compare-and-swap on the `completed` transition replaced the old "already built?" check, which would have skipped the PDF stamp and emails on every lease. |
| **Overlap check** | The sign route's overlap pre-check now excludes the document's own lease. Without that, tenants were refused their own signature. |
| **Schedulers** | Future-dated lease activation and the renewal handoff now key off the landlord's signature only. |
| **Invite-time drafting** | `autoDraftLeasesForUnit` no longer waits for acceptance; the invite route drafts immediately and sends to the landlord first, with no email. Accepting later is a no-op for drafting. |
| **One tenant email** | `services/tenantLeaseLink.ts`: a tenant with no account gets the setup link with `next=/sign/<doc>`, reusing any old token with a refreshed 7-day expiry. A tenant with an account gets the normal signing link. Used by the post-signature relay, daily reminders, the 48-hour resend, renewal reminders, and the manual Remind button. Email copy says "Set Up Account & Sign Lease." |
| **No tenant email at onboarding** | Unless drafting failed (e.g. missing template); then the old portal invite still goes out so nobody is stranded. |
| **48-hour void (Window A)** | Only voids a landlord-pending draft when a tenant has actually accepted, measured from acceptance. Drafts in the landlord's own queue are never auto-voided. Window B (tenant has 48h after the landlord signs; resend, never void) is unchanged. |
| **Void cleanup** | `lib/unwindIssuedLease.ts`, called from the Void button, the 48-hour pass, and the renewal-deadline pass. Voiding a signed lease: the lease is terminated, invoices marked void, pending charges removed, utility put back on hold (so re-signing re-bills it once), the work-trade agreement ended, and the invite reopened (no auto-redraft). **Refuses if any money was paid** — supersede instead. |
| **Co-tenant add** | Refused once the landlord has signed ("add them by addendum"). |
| **Front desk** | Being named on a draft no longer counts as "accepted." A closed invite stays listed while its lease is unsigned. Two false script lines fixed. |
| **US-format date bug** | The move-in invoice now uses the lease's stored date. Date helpers reject non-ISO input. (This billed RV 09 September for an October tenancy; fixed.) |
| **Late-fee stamp on move-in invoice** | Also exempts an existing tenancy's first invoice. **Nic pointed out this was already enforced (S640, at the late-fee job itself).** It's redundant; offer to revert. |

### Recon findings (still true)

- `pending_tenant_intents` **is** the onboarding pipeline. Don't create a second "not real yet" state.
- **SMS does not exist at all.** No Twilio, no dependency. `lease_document_signers.phone` is never written (0 of 122 rows). About half of users have a phone number on file. The plan calls SMS the primary channel for this population.
- The trigger `intent_default_existing_tenancy`: any invite within a landlord's first 28 days is an existing tenancy by default.

### Not built yet (from the plan)

- Bulk entry grid → one-at-a-time signing queue (sign / skip / fix, resumable)
- Pipeline board (Draft / Sent / Undelivered / Flagged / Executed)
- "Something's wrong" correction button for tenants
- Tenant never reaching a dashboard with an unsigned lease (the accept page already honors `next=`, but dashboard gating isn't done)
- Undelivered-email state and resend
- SMS

### Known issue to raise with Nic

`PATCH /me/pending-intents/:id/contact` (the contact edit Nic used for Clay):
- saves whatever name is on the form, which reverted Clay to "Simpsosn"
- does not update names on an unsigned draft
- defaults to **resending the old portal invite**, which conflicts with the new one-email flow

---

## 4. Data fixes done this session

- **Six leases the landlord had already signed were issued** (backfill): Mountain View MH 18 $460, MH 19 $589, RV 08 $0 (Ignacio, work trade), RV 09 $495.42 (moved to Oct 1), Oak Park MH 08 $440, RV 31 $470.22 (includes $30.22 of released utility). All are existing tenancies with full-month billing.
- **Fourteen households still waiting on old-flow invites** were drafted into Nic's queue by the background sweep: MV MH 05, MH 08 (Todd Niemeier), RV 25, RV 27, RV 50; OP MH 02, MH 03 & RV 27 (Josh Roby), MH 09, RV 20, RV 23, RV 25, RV 34 & RV 35 (Billy Jose Miranda).
- **Martin Alvarado, MV RV 34:**
  - The rent box on his signed lease was changed from $589 to $495, carried through to the lease, the invoice, and the unit.
  - His meter read 61808 on both Aug 1 and Sept 2, so August electric was billed at an estimated 387 kWh = **$81.27** (method `comparable_low`).
  - His invoice INV-2026-00038 = **$576.27**.
  - Co-tenants Lily and Luis are still pending signature.
- **Clay Simpson, MV RV 25:**
  - Account corrected to Simpson; email `clay_simpson@hotmail.com` is correct (Nic changed it on purpose).
  - His draft was redrafted and now reads Clay Simpson (document `50985638…`). Two earlier drafts are voided.
- **Harold Cunningham** was MV RV 16. Invited Sept 1, never accepted, cancelled Sept 11. **916 kWh** Aug 1 → Sept 2 ($192.36); Nic is billing it off-platform.
- **Gerald Logue**, MV RV 48: $495 rent, no electric (camper in storage). Correct as-is.

---

## 5. Stuck meters (fixed this session)

- **Root cause of the repeated misses:** there were two roads to a first utility bill. The monthly run (`generateBillsForMeter`) handled stuck meters. The lease-signing road (`releaseSuspendedChargesForLease`) required the meter to have moved, so every onboarding lease with a stuck meter billed $0. That's why it kept recurring: Chris Ast RV 07, Jared Coil RV 23, Calvin Curtis RV 40, MH 04, RV 41, Martin RV 34.
- **Fix:** the signing road now estimates stuck meters for **existing tenancies only**. It runs inside a savepoint so it can never abort a signature.
- **New estimate rule (Nic):** "low end of the cluster." The 25th percentile (nearest-rank) of credible occupied usage (`clusterLow()` in `utilityBilling.ts`). On August at Mountain View that's **387**. Randall Cox (120) and David Shultz (197) stay in the pool but no longer set the price alone.
- **Meters to check physically:** RV 34 (the Sept 2 reading equals Aug 1) and RV 19 (identical reads twice).
- **Still deferred:** detecting a meter that died mid-month (needs history per space).

---

## 6. Property-manager layer (S644–S646) — the 11,000-unit PM prospect

Priority one is getting this PM onboarded. They're in TX/OK/GA, mostly mobile homes. Nic wants to learn their pain points on a first call before setting a rate or confirming owner and state counts.

### Built and live

- `pm_owner_relationships`: one row per (manager, owner). A trigger creates it when a property joins a manager. Holds portal access (none / active / closed). **There is no deny state; a manager can't deny or revoke owner access, only the owner can close it.**
- **Owner statement** (`services/ownerStatement.ts`):
  - built from money that actually moved; settled money only in gross
  - management fee sums both the percent-of-rent cut and the flat/per-unit monthly accruals
  - GAM's contract with the manager never appears on it
- **Owner portfolio + manager scorecard** (`services/ownerPortfolio.ts`, landlord portal → **My Managers**):
  - one login shows the whole book across managers, with self-managed first
  - shows occupancy, on-time collection, days late, and days to fill
  - a manager with no rent roll yet shows blank, not 0%; averages are count-weighted
- **PM portal → Owners page:** owner list, Give access (no Deny), and the statement view.
- **GAM bills the manager, one bill,** at the manager's negotiated rate (`pm_company_platform_fee_overrides`, `platform_fee_accruals.billed_pm_company_id`). The $10-per-Connect-account floor biting often is fine with Nic.

### Decided and removed

- **Platform-fee pass-through was removed.** A manager recovers software cost through their own fee plan (`pm_fee_plans`: percent / flat / per-unit). Pass-through is only for self-managed landlords → tenants.
- **Payout mode and a manager-chosen payday were removed.** GAM's books hold every landlord's money until GAM's own payout run, net of the manager's fee.
- **Evictions are not measured**, on purpose. The court process is external.

### Future

- Turn time measured against scope of repairs (e.g. a $500 repair taking two months is a failing manager).
- Showing the owner what's actually been paid out vs. still on GAM's books (needs to read payout records).
- Platform fee may be eliminated eventually once tenant products carry the revenue.

### Not built, needed for the deal

- **Bulk import** (11,000 units won't go through a form).
- **Scale check** on invoice generation (production is 120 units).
- **Native apps** (see §8).

---

## 7. Point of sale / in-person cards

- **Stripe Terminal is already built:** server-driven and JS paths, full lifecycle under the landlord's Connect account (`apps/landlord/src/lib/terminal.ts`; backend `/pos/terminal/*`).
- **Hardware:**
  - Order the **BBPOS WisePOS E ($249)**: Wi-Fi, tap/chip/swipe, works from any browser at the counter.
  - Wire it **server-driven**, so the iPad and the front-counter PC can both use the same reader.
  - The $59 M2 is Bluetooth to a native app only; it doesn't work from a browser.
  - Square hardware can never work with Stripe.
  - Order at https://dashboard.stripe.com/terminal/shop and assign the reader to the right connected account.
- **Record Payment modal:** the layout is fixed (2×2 grid, equal buttons) and "Check" lost its "(incl. cashier's or certified)" suffix.
  - **A "Card" option is still needed**, so residents can pay rent by card at the counter. It should run through the Terminal flow.
  - Nobody has asked about in-person card pricing yet. GAM is on interchange-plus, and card-present interchange is lower.
- First test Nic wants: a propane sale.

---

## 8. Native apps (directive)

Landlord and tenant native apps are needed **before making solid contact with the PM**.

**Open fork, Nic's call:**
- **Capacitor wrapper** of the existing portals: weeks. My recommendation.
- **React Native rewrite:** months, and it forks the UI.

Native apps would also unlock Tap to Pay on iPhone and the M2 reader.

---

## 9. Dates to watch

- **October 1:**
  - first-ever run of the work-trade settlement on real money
  - the untracked-trade credit fix (MH 02, MH 10) gets its first real exercise
  - RV 09's first invoice
  - the monthly run reaches back two months, so August utilities still bill for the leases that just issued
- **Ben:** moving the API/payments off the Mac (Google Cloud); agents stay on the Mac.

---

## 10. Standing constraints (unchanged)

- `DB_NAME=gam_test` is mandatory for vitest. `gam` **is** production. Never run two vitest processes at once.
- Run one deploy at a time (`bash ~/gam/deploy.sh`). Don't edit the tree during its test gate.
- Migrations: `npm run migrate` in `apps/api` applies them to `gam` and regenerates `schema.sql` (tests rebuild `gam_test` from it).
- Never enter bank or credential details; never sign or accept terms on anyone's behalf.
- Every unit action is scoped to its property; unit numbers repeat across parks.
- Rent is pay-in-full platform-wide.
- A person with two roles gets two real email addresses.
- **Handoff routine (Nic, S647):** write the handoff → commit → `git push origin main` → confirm nothing is left unpushed → only then clear context.
