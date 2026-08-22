# SESSION 616 HANDOFF

End of S615. **Everything below is LIVE and deployed** unless marked otherwise.
Full suite green at close: **4,937 tests, 293 files, zero failures.**

Supersedes SESSION_614_HANDOFF.md.

---

## 0. NIC'S IMMEDIATE PATH

**Billing next door is DONE end to end and you can use it today.** Everything
else on the S614 list is unchanged and still waiting.

1. **Set up the spaces next door.** Utilities page → *Next door* → **Add a
   space**. One form: what you call it, the service address, who pays (name,
   email, phone), the due day. That creates the space, emails the payer a link
   to set a password, and starts the billing.
2. **Put the meters on them** in Meter Setup exactly like any other space — the
   trash can count (3 next door), and the 5-digit electric submeter.
3. **Then the original list:** import lease templates → invite tenants → mark
   the owner-occupied units and set household sizes → get utility
   responsibilities into the templates. See §1 of SESSION_614_HANDOFF.md; none
   of it changed.

---

## 1. WHAT SHIPPED — BILLING THE SPACES NEXT DOOR

S614 built the attribution and stopped at the money. A bill for a lease-less
space was written to `utility_bills` and could never reach a document or a
payment, because `invoiceGeneration` iterates ACTIVE LEASES and
`invoices.lease_id` was NOT NULL. Nic was still collecting that $75 in cash.
All five missing pieces are now built.

### The invoice

An invoice belongs to EITHER a lease or a service agreement — exactly one, by
CHECK. A separate driver (`jobs/serviceAgreementInvoices.ts`) cuts the
lease-less ones on the SAME 7am-local schedule as rent, so the neighbour's bill
goes out the morning the tenants' invoices do.

Kept as its own loop rather than a branch inside `invoiceGeneration`: no rent,
no monthly fees, no proration, no move-in bundle, no sublease, no booking
schedule, no work trade and no prepaid rent apply here. Threading "lease might
be null" through 900 lines of rent logic to reach the ~80 that matter would put
every paying tenant one null-check away from a bad bill. It deliberately SHARES
`dueDatesInRange`, `ensureBillsForUnit` and `allocateInvoiceNumber`, because
those must not drift.

**Nothing is billed when nothing is owed.** A $0 invoice for an unread meter
says nothing to the payer AND would burn that cycle's idempotency key, so the
real charge could never land on it once the read arrives. It rides the next
cycle like any other straggler.

**No read-hold, on purpose.** A leased unit holds its WHOLE invoice when a
tenant-responsible meter is unread, because sending rent without the utilities
means two documents. Here the utilities ARE the invoice.

### Late fees — same as rent (Nic, asked directly)

Two things stood in the way and both are fixed:

- The late-fee engine INNER JOINed leases, so it never saw these invoices at all.
- `percent_of_rent` would have based every fee on a rent that structurally
  cannot exist — computing $0 while looking configured, and a percent CAP would
  have returned 0 remaining, which blocks even a FLAT fee. A service invoice
  bases the percentage on its own utilities instead.

Terms are **stamped on the agreement at creation** from property policy, the
same way S558 stamps them on a lease. The instrument is the charge; a policy
change in March must not silently reprice a bill someone already agreed to.

### Setting one up

**Utilities page → "Next door" → Add a space.** One call mints the space, the
payer's portal account and the agreement. The card is ALWAYS visible, empty or
not — hiding it until one exists would put the only door behind the thing it
opens (the S613 propane-card trap).

An existing account is REUSED, never collided with: S614 is explicit that when
the space is later onboarded it must be the same person, same login.

### The payer's portal

With no lease, `unitId` is null and `bgApproved` is false — so `showFullNav` was
false and the only thing they could reach after logging in was an **Application
tab: a background check they have no reason to take, for a tenancy that does not
exist.** They now get Home, Billing and Profile only, and a home page showing
what is true of them rather than "undefined · Unit undefined" over a rent card.

They pay each bill on its own through the existing per-charge route, which is
already lease-independent (its only lease branch is gated on `type='rent'`).

### Supersedence

`superseded_by_lease_id` is now SET by a **trigger on leases**, not at call
sites. There are many doors that create or activate a lease — onboarding, invite
accept, CSV import, booking draft, the lifecycle job — and a rule about what is
true of a UNIT should not depend on which one it came through. Any door added
later inherits it.

The agreement stays ACTIVE and keeps billing — Oak Park is still supplying that
power. Only the $2 follows the lease. Ending the service is the landlord's
decision to make out loud.

---

## 2. THREE DEFECTS FOUND BY READING THE S614 FOUNDATION

The S614 handoff asserted all three of these worked.

**The $2 was shown but never charged.** S614 taught the live ESTIMATE to count
a serviced space and not the ACCRUAL JOB, which is the thing that bills. GAM
quoted the landlord one number and invoiced a lower one, every month, and
under-collected its own revenue. Counted separately from `long_term_unit_count`
so the fee line can say what it is made of.

**A serviced space took no share of a RUBS pool.** The handoff says it carries
"a share of a RUBS pool like any other". `rented_spaces` measures occupancy by
asking for a LEASE, which such a space cannot have, so it scored zero and its
consumption was divided among the PAYING TENANTS — who would have quietly
covered the neighbour's water. Same for `occupant_count`. This is the S609
owner-occupied bug in a new costume, with one difference: this space has a
payer, so its share is BILLED, not absorbed.

`unit_type_weight` had the same hole for BOTH lease-less statuses — S609 fixed
`rented_spaces` and `occupant_count` for owner-occupied units and left that
branch alone, so an owner-occupied unit under a weighted split still pushed its
draw onto the tenants. Fixed too.

**A flaky test S614 moved rather than fixed.** Making `seedUnit` canonicalise
turns an all-digit hex suffix into `U 123456` (hyphen → space), so every
remaining `toMatch(/^U-/)` fails ~6% of runs. It surfaced in
`properties-gap-close` on the full-suite run; the same latent assertion was in
`subleaseInvitations` (×2) and `tenants-lease`, with one already patched ad hoc
in `tenants-misc` — which is how the pattern survived. All now assert the seeded
unit's ACTUAL number: exact, format-proof, and the stronger check anyway.

---

## 3. A NEAR-MISS WORTH KEEPING

The first S615 migration rewrote `ux_invoices_lease_due_date` as a PARTIAL index
(`WHERE lease_id IS NOT NULL`), reasoning that a nullable column needs its
uniqueness restated per payer source.

**Postgres can only infer a partial index for ON CONFLICT when the statement
repeats the predicate.** Four live statements say plain
`ON CONFLICT (lease_id, due_date) DO NOTHING` — `invoiceGeneration` (×2),
`moveInBundle`, and the landlord backfill route. Against a partial index every
one raises 42P10. That is not a degraded edge case: it is **every rent invoice
for every tenant on the platform failing to generate**, to fix a bill for three
trash cans.

Caught in dev by a test, reverted byte-for-byte in
`20260821230000_restore_lease_due_date_index.sql`. A unique index already treats
NULLs as DISTINCT, so the full index was correct all along.

**The lesson, alongside S614's "never retype a CHECK from memory": changing an
index that an ON CONFLICT depends on changes that statement, silently, at
runtime.** Grep for the arbiter before touching one.

---

## 4. WHAT IS STILL LEASE-KEYED, AND DELIBERATELY UNTOUCHED

Named plainly so nobody assumes otherwise:

- **`/pay-balance` and autopay.** Lease-keyed end to end — FIFO scope,
  pay-in-full guard, eviction hold, sublease markup. A service payer pays each
  bill on its own rather than one lump, and cannot autopay. Widening the engine
  that moves every tenant's rent is its own pass with its own test run.
- **`tenant_credits`.** Keyed to `lease_id`, so a service payer cannot hold a
  credit. The invoice driver does NOT call `applyCreditsToOpenCharges` — a call
  that finds nothing by construction reads like "credits are handled" while
  handling nothing. If Nic needs to forgive part of a neighbour's bill, that
  wants the same nullable-lease treatment invoices just got.
- **Cross-landlord routing (S614 Scenario A).** Not started. A meter serving a
  unit at ANOTHER landlord's property, with consent. Every charge row already
  carries its own `landlord_id`, so it is an unlock rather than a rewrite.

---

## 5. OAK PARK — EXACT STATE AT CLOSE

Unchanged from S614 except that the next-door billing now exists to be used.

| | |
|---|---|
| Units | 30, **all `vacant`** — owner-occupied ones not yet marked |
| Next-door spaces | **none created yet** — §0 step 1 |
| Leases / tenants | **none** |
| Electric | 20 submeters, all assigned, **all 20 read** |
| Electric widths | **4-digit:** RV 01, 26, 27, 31–37 · **5-digit:** RV 02, 03, 20, 22–25, 28–30 |
| Water | 7 submeters, **all read** · 2 RUBS masters on `bill_amount` — no opening read needed |
| Trash | flat $25/mo, **1 unit assigned** — still worth checking |
| Propane | no rate, no tanks marked |
| Bills generated | **zero** |

The unit next door the §1 build is for is a **5-digit** electric meter.

---

## 6. HOW TO WORK WITH NIC

Carried forward from S614, all still true. What this session reinforced:

- **Verify before claiming — including claims in the last handoff.** Three
  things S614 stated as working did not. Reading the code found all three in
  under an hour; none would have been found by trusting the document.
- **He corrects the premise, not just the answer.** Asked whether a serviced
  space could be shut off for non-payment, he answered that you can never shut
  off utilities on a tenant without being a utility company. The question came
  from misreading a filename — `serviceInterruptions` is an OUTAGE NOTICE
  ("water's off Tuesday for a repair"), never a collections lever, and the
  codebase already agreed with him. Check what a name actually does first.
- **He does not read code.** Describe what a PERSON experiences and what it costs.
- **Ask whether it is a rule or a landlord's choice** before building a rule.

---

## 7. FILES / OPS

**Migrations applied** (dev `gam` = the live DB; schema.sql regenerated):
`20260821210000_invoice_without_a_lease`,
`..220000_service_agreement_billing_terms`,
`..230000_restore_lease_due_date_index` (the §3 correction),
`..240000_accrue_serviced_spaces`,
`..250000_supersede_service_agreement`.

**New:** `jobs/serviceAgreementInvoices.ts`,
`routes/utilityServiceAgreements.ts` (mounted BEFORE `utilityRouter` so
`/service-agreements` is matched there), `emailUtilityServiceInvite` in
`services/email.ts`, `ServicedSpacesCard` + `AddServicedSpaceModal` on the
landlord Utilities page, `UtilityServiceHome` in the tenant portal.

**Changed:** `jobs/lateFees.ts` (LEFT JOIN lease + agreement, service basis),
`jobs/platformFeeAccrual.ts`, `services/utilityBilling.ts` (RUBS basis),
`routes/payments.ts` (`serviceCharges` in balance-context),
`routes/tenants.ts` (`/me` exposes the agreement), `jobs/scheduler.ts`.

**Backup before the migrations:**
`~/gam-backups/gam-pre-s615-invoice-20260821-175823.dump`.

**Tests:** `cd apps/api && DB_NAME=gam_test npx vitest run` — **never without
DB_NAME, it wipes the dev database.** ~7 min.

**Lint:** `npm run lint:hooks` from repo root, before any frontend deploy.

**Deploy:** `bash ~/gam/deploy.sh`.

**A note on route tests:** the real app camelizes every response on the way out
(`index.ts`). A test app mounted without that middleware asserts a contract
production does not serve — snake_case keys the frontend reads as `undefined`.
`utilityServiceAgreements.test.ts` mounts the camelizer for exactly this reason.
