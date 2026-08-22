# SESSION 617 HANDOFF

End of S616. **Everything below is LIVE and deployed** unless marked otherwise.
Full suite green at close: **5,073 tests, 304 files, zero failures.**
22 commits, 42 migrations. Supersedes SESSION_616_HANDOFF.md.

---

## 0. NIC'S IMMEDIATE PATH — OAK PARK

Nothing at Oak Park has started. Exact state at close:

| | |
|---|---|
| Units | **30, ALL `vacant`** — owner-occupied ones still not marked |
| Leases / tenants | **none** |
| Neighbour service points | **none created** |
| Meters | 30 · 50 readings recorded |
| Utility bills / invoices generated | **zero** |
| Unit types | 21 rv_spot (short-stay), 8 mobile_home, 1 apartment (both long-term only — corrected this session) |

In order:

1. **Add the neighbour service points.** Utilities → *Neighbor utilities* → Add
   a space. Tick **"they've already agreed to pay for this"** or nothing bills —
   see §3. Then attach them to the trash/electric meters like any other space.
2. **Import lease templates**, then invite tenants. Templates first: one pass
   instead of two.
3. **Mark the owner-occupied units** and set household sizes. This one has a
   live cost — while they sit `vacant` they take NO share of a RUBS split, so
   Nic's own usage lands on the paying tenants.
4. **Utility responsibilities into the templates.** Free in the template, an
   addendum per tenant afterwards.

---

## 1. THE BIG BUILD — NEIGHBOUR UTILITIES, END TO END

S614 could attribute a bill to a lease-less space and had nowhere to put it.
That is now complete: **a neighbour can be set up, log in, and pay.**

**The invoice.** An invoice belongs to EITHER a lease or a service agreement.
`jobs/serviceAgreementInvoices.ts` cuts the lease-less ones on the same 7am-local
schedule as rent. Kept as its own loop — no rent, fees, proration, move-in
bundle, sublease, booking schedule or work trade applies. Nothing is billed when
nothing is owed: a $0 invoice would burn the cycle's idempotency key.

**One invoice per agreement, however many utilities.** Trash + electric is ONE
bill and ONE charge — the portal used to render a Pay button per row, which was
two Stripe charges and two processing fees for one month at one address.

**Late fees** ride the property's policy, STAMPED on the agreement at creation
(S558's rule: the instrument is the charge). `percent_of_rent` on an agreement
with no rent bases on the utilities instead, or every such fee computes as $0
while looking configured.

**Nobody is invoiced without agreeing.** Either the payer accepts their invite,
or the landlord attests they agreed off-platform (Nic's own case — cash for
years). Until then charges ACCRUE but are not issued.

**Move-out notice.** The utility-only portal has an "I'm moving out" button that
records a NOTICE and tells the landlord to take a closing read. Never a
termination — that would let someone walk away from a balance.

---

## 2. CONVERGENCE — THE TWO LANDLORD PIECES

When the neighbour's own landlord onboards, GAM merges the billing.

**GAM links it automatically. Nobody approves it, and the other landlord is
never told.** Nic reversed an earlier three-consent design: *"you can't have
landlord B refusing permission to have landlord A's utilities ride on the same
payment rail... we are matching it up on the back end without anybody knowing."*
Daily sweep, `services/crossPropertyAutoLink.ts`.

**The match is THE PERSON and THE TOWN.** Not the street, not parcel data, not
coordinates. Nic: *"whatever I'm gonna name my next door neighbor's thing as
should be irrelevant... a landlord may not want to put that in, or put it
incorrectly... it could be a corner lot facing on the other street."* A typed
address only enriches the recorded evidence; it can no longer refuse anything.

Requires BOTH: same tenant id AND same town. The roommate case (utilities in one
name, lease in another) correctly does not link.

**Ambiguity stops and flags admin.** Two units both matching = GAM cannot tell,
and linking the wrong one bills a stranger's electricity to somebody's invoice.

**One invoice, money splits.** Rent and the neighbour's utilities on one
document. Each utility row is stamped with the SERVICE landlord's id — the
payout sweep scopes by `payments.landlord_id`, not by invoice, so the money
reaches the landlord whose meter turned with no new payout code.

**Late fees follow the lease** once converged. No split, no ratio — Nic: *"I
don't wanna deal with any of that."*

**The utility row carries NO lease_id.** It is not part of that lease. The
balance is scoped by INVOICE instead, which is what makes the whole document
payable at once without pretending the charge belongs to a lease it does not.

---

## 3. A SERVICE POINT IS NOT A UNIT

Nic's framing: *"a way for a landlord to add units that don't count as units...
the unit we create is to place the utility bills in under somebody's name.
That's how they get access to the tenant portal. Not rentable. Not bookable.
Doesn't show as vacant or owner occupied."*

`units.status = 'utility_service'`. Excluded from: `v_unit_occupancy` (the
structural fix — most of the platform asks that view about occupancy), occupancy
counts, portfolio totals, the rent roll's expected rent, and inventory counts.

**Its utility income DOES reach the books** — that money is real and the $2 is
charged on it. It is income, never rent, occupancy, or inventory.

**Do NOT gate the $2 on a meter assignment.** Tried; Nic rejected it: *"trash is
a flat rate, water is a RUBS system, there is not always going to be a meter."*
The agreement existing IS the statement that the space is on a utility charge. A
test pins the no-meter case at $2.

---

## 4. THE $2, AND HOW IT MOVES

- **Per SPACE, never per utility.** Trash + electric on one neighbour is $2.
- **Charged to the utility landlord** while he is the only one serving it.
- **Swaps to the new landlord** when the real unit is onboarded and a lease
  supersedes the agreement. It moves; it never evaporates. Tested end to end.
- **Short-stay nights: `CEIL(nights / 30)` × $2.** Nic: *"the first thirty is two
  dollars, the next thirty or portion thereof is another two dollars."* 1–30 =
  $2, 31–60 = $4, 61–90 = $6. No proration either direction.
- **Leases: flat $2/occupied unit/month**, counting either way.
- A 30+ night stay is NOT a booking — `computeStayPrice` tiers it `monthly`,
  stored as `month_to_month`, so it becomes a lease and leaves the nights pool.

---

## 5. PRICING CHANGES THIS SESSION

- **STR revenue fee 5% → 3%** (furnished short stays only; RV/campsite/boat slip
  still bill nights). Changed in FOUR places that must move together: the live
  config row, the code fallbacks, the column DEFAULT, and
  **legal/BUSINESS_TERMS_OF_SERVICE.md §6.2** — the document a landlord agrees
  to. Live at goldassetmanagement.com/business/terms.
- **`CONNECT_ACCT_MO` $2 → $1**, per the Stripe contract. Admin-side only
  (`calcNetPerUnit`, gated to admin in `units.ts /:id/economics`). The terms
  already said $1; the code was the outlier.
  **The Connect account fee is HIDDEN from landlords and part of the
  subscription cost — that is what the $10/property minimum covers. Do not
  change it.**

---

## 6. PAYOUT CADENCE — REPLACED THE WEEKLY BATCH

Nic: *"that's a lot of margin we're giving up on an extra twenty five cent
initiation... we're processing sixty million a month and spending ten thousand
on extra processing charges."*

**Leases follow a three-batch plan** driven by the rent roll:
1. 50% of occupied units paid → fires 4 days out
2. 90% paid → fires 4 days out
3. a guaranteed late-month sweep (also covers a month where neither trips)

**Short-term stays keep the weekly Tuesday** — nightly bookings have no
denominator to take a percentage of. A landlord can be both; the two coalesce on
the shared balance. A landlord with NO rent roll stays weekly.

**Three per Connect account per cycle, capped by a UNIQUE INDEX**, not by the
code that reads it. $0.75/month against a $10 floor — known in advance.

Trigger on PAID, not settled: Stripe holds an ACH ~4 business days, so
scheduling ahead front-runs the wait. The engine now measures every landlord
EVERY weekday (`0 9 * * 1-5`, Phoenix); it used to self-gate to Tuesday.

**Why day-3 payouts are impossible:** a payout draws only from Stripe's
`available` balance. ACH money sits in `pending` until `available_on`. Verified
live: $7.96 pending, −$0.04 available. Only Instant Payouts (~1%) can beat it.

---

## 7. OTHER THINGS SHIPPED

- **One-off charges** (violation, damage, replacement key). No door existed —
  every payments row came from a system flow and every lease_fee from the lease
  document. Own table, NOT lease_fees: a lease fee is a term of the lease, this
  is a thing that happened on a Tuesday. Reason required, prints on the invoice
  with the date. NOT work-trade creditable.
- **Autopay grace.** The card told a Social Security payer choosing the 3rd that
  late fees would apply when the lease allowed 5 days. Math moved to
  `@gam/shared` so the screen and the runner cannot disagree.
- **Grace period parsing.** Now finds the word "grace" in any phrasing, and
  ignores it when it is a tenant's NAME ("Grace Whitfield"). Previously matched
  exactly one phrasing and silently defaulted to 5.
- **Invite interception.** Both onboarding routes mailed "activate your account
  and set a password" to people who already had one — following it would
  overwrite their working password. Now drafts the lease and notifies instead.
- **Partial payments** are gone as a concept: `accept_partial_payments` dropped.
  Enforcement was always unconditional; the column was a settable lie.
- **Lease types by unit type.** Create and edit had two different rules; all 8
  Oak Park mobile homes were bookable nightly. One shared source of truth. Homes
  are long-term until an operator opts in (`is_bookable` IS the toggle).
- **Occupancy counts short stays.** A full RV park read as empty — Sunset Palms
  July was 8%, now 17%.
- **Admin chart**: counts money the tenant has SENT (ACH sits in `processing`
  for days after the bank is debited), shows gross / obligations / fees / in
  flight, and `tenant_remittances` now stores `gross_amount` and
  `processing_fee_amount` so GAM can tie out to Stripe.

---

## 8. STILL OPEN

- **`tenant_credits` is lease-keyed** — no way to forgive part of a neighbour's
  utility bill. Nic: *"that's fine. The utilities are the utilities."*
- **A pure service payer cannot autopay** (also lease-keyed). They pay each
  invoice by hand.
- **Turnover on a linked unit.** When the neighbour's payer moves out and
  someone new moves in, the agreement's `tenant_id` goes stale. The right person
  is charged (the invoice uses the lease's tenant), but if the link ever broke,
  the old payer would be billed for the new one's usage. The move-out button is
  the workaround; the agreement's payer following the unit is not built.
- **Payouts fire on a fixed +4 days**, not Stripe's actual `available_on` from
  the balance transaction. Reading the real date would fire the day the money
  lands rather than on an estimate. Offered three times, never built.
- **Onboarding questionnaire** for unusual utility arrangements — Nic's idea for
  catching cross-property setups at onboarding rather than detecting them after.

---

## 9. HOW TO WORK WITH NIC — WHAT S616 TAUGHT

Everything from S614 §11 still holds. What this session added, all of it earned:

- **SEARCH THE CODE BEFORE ASSERTING ANYTHING.** Nic, twice: *"you keep
  screwing up stuff... search the code before you just pull some bullshit out of
  your ass."* I stated the $10/property minimum did not exist after having
  written a test asserting it earlier the same session; I called an endpoint
  landlord-facing by reading a HISTORICAL comment describing a bug that was
  already fixed. Both were one query away.
- **Do not over-engineer, and do not build gates he did not ask for.** The meter
  requirement on the $2, the two-row versioning of a pricing change with zero
  history, a long analysis of a 31-night booking that the system cannot create.
  Nic: *"you keep overcomplicating things and ignoring the facts."*
- **He reverses himself, and the latest instruction governs.** Three consents →
  no consents. Ask once, then build what he last said.
- **When he says something contradicts what is built, check the code first.**
  He was right about the mobile homes, the occupancy gap, the meter, the invite,
  and the Connect fee. Every single time.
- **He does not read code.** Describe what a PERSON experiences and what it costs.

---

## 10. FILES / OPS

**Migrations:** 42 applied this session (all `2026082*`). The notable ones:
`invoice_without_a_lease`, `restore_lease_due_date_index` (see below),
`cross_property_service_links`, `link_matches_on_the_back_end`,
`match_on_person_and_town`, `one_off_charges`, `payout_triggers`,
`service_points_are_not_units`, `no_partial_payments_ever`,
`str_fee_single_row`.

**A near-miss worth keeping.** A migration rewrote `ux_invoices_lease_due_date`
as a PARTIAL index. Postgres cannot infer a partial index for a plain
`ON CONFLICT (lease_id, due_date)` — four live statements say exactly that, so
**every rent invoice for every tenant would have failed with 42P10.** Caught in
dev; reverted byte-for-byte. NULLs are already distinct in a unique index.
**Grep for the arbiter before touching an index an ON CONFLICT depends on.**

**New:** `services/crossPropertyAutoLink.ts`, `services/addressAdjacency.ts`,
`services/payoutTriggers.ts`, `routes/oneOffCharges.ts`,
`jobs/serviceAgreementInvoices.ts`, `packages/shared/src/autopaySchedule.ts`.

**`packages/shared` tests now run.** They never did — there is no test script in
that package and the API's vitest only included its own `src`, so
`paymentAllocation.test.ts` (the FIFO math every rent payment goes through) had
never been executed. Included now.

**Tests:** `cd apps/api && DB_NAME=gam_test npx vitest run` — **never without
DB_NAME, it wipes the dev database.** ~7 min.
**Lint:** `npm run lint:hooks` from repo root before any frontend deploy.
**Deploy:** `bash ~/gam/deploy.sh`.
**Backup before the S615 migrations:**
`~/gam-backups/gam-pre-s615-invoice-20260821-175823.dump`.
