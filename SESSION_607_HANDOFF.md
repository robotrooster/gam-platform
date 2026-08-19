# SESSION 607 HANDOFF

Written at the end of S606. Everything below is **live and verified** unless
marked otherwise. (S606's own handoff — Connect KYC, portal lockout, deploy
automation — is `SESSION_606_HANDOFF.md` and is still accurate for that work.)

---

## 0. NIC'S IMMEDIATE PATH (nothing here is blocked)

1. **Meters + opening reads at Oak Park** — the only dated item. 19 electric
   submeters exist, **all with no opening read**. Without one a meter bills
   nothing on its first cycle, silently. Enter them before you bill August.
2. **Water** — no water meter exists yet. Create the **RUBS master**, assign
   **every unit that line feeds** (RV spots *and* any submetered mobile homes —
   submetered ones fall out of the split automatically), then submeters on the
   mobile homes.
3. **Mobile home units aren't entered.** All 19 units are `rv_spot`.
4. **Import the RV-spot lease template**, set it as that unit type's default.
5. **Invite households** → leases draft themselves into the signature queue.
   **Do one end-to-end first** before the other eighteen, in case the template's
   field mapping is off.

Order of 4 and 5 doesn't matter — drafting retries when a template lands (§5).

**Still waiting on:** the $0.01 microdeposit at WAFD for the tenant ACH test.
The six-digit code is in the deposit's *description*, not its amount.
`seti_1U5ohtDNEru9AEpKhmCBf4MT`.

---

## 1. STATE

- **Migrations:** 495 applied, checksum guard clean, `gam` and `gam_test` in sync
- **Deploys:** API + landlord + tenant + admin + pm-company all in sync
- **Git:** committed and pushed to `main` (`d67a96a`) — S601–S605 had never been
  committed
- **Oak Park:** 1 property, 19 units (RV 01–19), 0 leases, 0 tenants, Connect
  charges + payouts enabled, PNC linked (112 txns, 14 in review), books start
  2026-08-01, reconciliation window to 2026-09-04

---

## 2. BANK FEED — now two-sided

Money **out** → `landlord_expenses`. Money **in** that auto-matching did NOT tie
to a GAM disbursement → `landlord_other_income`.

The P&L previously counted every expense but only GAM-collected income, so it
understated profit for any landlord with outside revenue (laundry, vending,
insurance claims, cash rent deposited).

- **A `matched` inbound row can never be booked as income** — that money already
  reaches the P&L via `payments`. Guarded in `categorizeAsIncome`.
- The **sign of the amount** picks the side; the two category sets can't cross.
- **Balances** now shown. Stripe had already approved `balances` — no application
  change was needed, only re-consent on the link.
- **Duplicate-import guard**: re-linking the same bank (same landlord +
  institution + last4) treats same-day/amount/description rows as already
  imported. Without it Oak Park's 112 transactions would have doubled.
- **Books start date**: pre-cutoff rows still import but land `ignored`.

---

## 3. TENANT ACH — it had never worked

`verification_method: 'microdeposits'` is **incompatible with Stripe's
PaymentElement**. No tenant could ever add a bank account. Cards worked because
they take a different path entirely.

- ACH now collects routing/account on a **GAM-built form** and calls
  `confirmUsBankAccountSetup`. **Never** use PaymentElement for `us_bank_account`
  — see memory `gam-no-instant-bank-verification`. Instant verification (~$1.50)
  stays off the platform by directive.
- **Ownership check moved onto the SetupIntent.** It read `pm.customer`, which is
  null until microdeposits clear — so the first bank any tenant added always
  403'd with "payment method does not belong to this tenant".
- Routing-number **checksum**, **confirm-account** double entry (paste blocked),
  bank name echoed back, holder type person/business so a third party or agency
  can pay.
- **Microdeposit copy follows what Stripe actually sent** — `amounts` vs
  `descriptor_code` — via one helper, `microdepositInstruction`, used everywhere
  including the tenant agent. An unknown type shows BOTH inputs rather than
  guessing.

---

## 4. UNIT NUMBERING + UTILITIES

**Prefix is derived from unit type**, platform-wide: `RV MH APT CMP RM STG STALL
SLIP LOT SFH COM`. The number field is the **starting point**; padding is fixed
at two digits and can't be overridden by a client.

- A meter with **no readings** no longer freezes a unit's number during
  onboarding. A meter *with* a reading still locks it.
- Renumbering **rewrites generated meter labels** (`RV 03 electric` →
  `RV 14 electric`).
- Unit onboarding is **two toggles** (electric / water). Rates, RUBS membership
  and opening reads all live on the property's Utilities tab.

**Rates are property-level policy** (`property_utility_rates`), overriding
per-meter values — anti-discrimination, mirroring the S535 late-fee rule. Issued
bills keep the rate they were charged at.

**A RUBS master ALWAYS bills.** An unread / flagged / negative submeter is
estimated from the lowest comparable (the S559 rule) and **reported in `reason`**
— it no longer aborts the whole property's water bill. Zero usage is legitimate,
not a failure.

---

## 5. LEASES — invite to signature, self-running

**Household invites**: multiple residents, one unit, one lease. First is primary,
the rest co-tenants, **everyone gets their own login** (joint-and-several).

**Auto-draft**: on invite the lease drafts from the **default template for that
unit's type**. **Landlord signs first** (order 1), residents 2..N — the
last-glance safety check.

**Retries** — order of operations doesn't matter:
- `pending_lease_drafts` records who was invited to which unit
- Setting a template as unit-type default drafts everything waiting on it
- **Hourly cron backstop** (`draftAllPendingLeases`) catches anything else
- Any lease created for a unit (drafted *or* hand-sent) closes its waiting rows

**Designated lease signer** (`properties.lease_signer_user_id`): one on-site
manager per property may sign instead of the owner. Entitlement is **re-checked
at signing time**, so a manager who is fired, unscoped, or loses `leases.sign`
falls back to the owner with nothing to clean up. API only, no UI.

**Carried balances**: `POST /leases/:id/carried-balance` — arrears from a prior
system, **late-fee exempt by default** (the nightly engine would otherwise
compound them from day one). Shows as `BALANCE` on the tenant's statement, not
`RENT`.

---

## 6. PROPERTY IA + SALE

Property-scoped screens are now **sub-tabs inside the property**:
**Overview · Utilities · Amenities · Equipment · Maintenance · Ownership**.
Left nav keeps portfolio-wide views — same page, two entrances, nothing moved or
deleted.

**Equipment** (`parts_inventory`) is property-scoped: tractors, tools, supplies
that live at a park. It is *not* POS stock (`business_inventory_items`) —
different table, different thing.

**Property sale** (Ownership tab):
- **Moves:** property, units, leases *unchanged*, deposit obligations, equipment,
  open maintenance
- **Stays:** payments, invoices, payouts, expenses, accruals — settled history
  records who was actually paid
- **No money moves.** Proration is the closing statement's job (credit at
  closing), not GAM's.
- **Unanimous consent**: every owner-member with a GAM account is emailed a
  six-digit code; the last approval executes it. Any single decline cancels it.
  Approver set frozen at request time. 7-day expiry. One live request per
  property.

**Co-owner invites** by link (`landlord_member_invitations`) — the invitee no
longer has to pre-register. Accepting adds membership **alongside** their own
entity, so portfolios never merge. It also clears the onboarding wizard for an
invitee who owns nothing.

**Dashboard now aggregates across every entity a landlord co-owns** — it was
single-entity while the properties list was not, so a co-owner saw a property on
one screen and none of its income on the other.

---

## 7. NEXT SESSION

1. **Buyer's equipment review prompt** (Nic, end of S605): after a transfer, show
   the new owner the inherited equipment list — "anything that didn't come with
   the sale, remove it." Small, not built.
2. **Property tabs for the rest**: Surveys and Work Trade already carry a
   property (mechanical). **Inspections and Documents** attach to a *unit* and
   need a join. **Screening** already carries `property_id` on
   `background_checks`; the applicant pool should be **filtered by proximity** to
   the entry property, not scoped — it's a shared conduit, not per-landlord.
3. **Lease signer UI** — API is live, no screen.
4. **`/esign/draft-household` has never run against a real template.** Watch the
   first one closely.
5. IL/NM `index_linked` deposit-interest values still 0.0000.
6. Marketing telemetry: zero `portal='marketing'` rows, ever.

---

## 8. TRAPS

- **NEVER run vitest without `DB_NAME=gam_test`** — it wipes the `gam` dev DB.
  Restore from `~/gam-backups`.
- A root `vitest.config.ts` now forces **serial** runs and excludes
  `.claude/worktrees/**`. Stale worktree copies of test files were running
  against the same database and producing fake failures — three times.
- **Don't edit an applied migration** — checksum mismatch blocks API startup.
  Fix forward. (Hit and recovered this session.)
- **Check the DATA MODEL, not the page**, before claiming something isn't built.
  Screening, inventory and the utilities property-picker were each called
  "missing" on the strength of a frontend grep; all three were wrong, and one of
  them (the picker) was hidden only because it renders when
  `properties.length > 1`.
