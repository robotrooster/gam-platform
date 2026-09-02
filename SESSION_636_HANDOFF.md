# Session 636 handoff — Mountain View onboarding, work-trade coverage, lease identity fields

## Theme
Mountain View RV Ranch going live: 46 invites out, work-trade arrangements
recorded, and the lease-template defects that surfaced the moment real tenants
started accepting.

## Shipped

**RUBS rebuilt (carried from S635's start).** The pool is the WHOLE master bill
divided by occupancy; submeters bill gallons on top. `rubs_exclusion_mode` is
dead config. One meter per unit per utility, enforced by DB trigger. Oak Park's
August water re-cut from $0.00-to-everyone to $94.01 recovered exactly.
See `gam-rubs-eats-the-full-bill` in memory.

**Work-trade coverage now rides from the INVITE.**
`pending_tenant_intents.work_trade_covered_charges` (migration
`20260901230000`), carried into `work_trade_agreements` at signing
(`routes/esign.ts`). Before this the agreement was created with the column
default — rent, fees and every utility — so an arrangement covering only electric
and propane would have suspended the tenant's RENT on their first invoice.
`WORK_TRADE_COVERABLE` moved to `@gam/shared`; the landlord picker, the API and
both CHECKs now read one vocabulary.

**Lease identity fields are nobody's to fill.** `isAutoFilledLeaseColumn()` in
shared. Fixed at the CLASSIFIER (`services/autoFieldPlacement.ts`), not just the
editor — see the near-miss below. New `occupant_names` column (migration
`20260901234500`): the whole household on one line, in invite order.

**Raw enums no longer reach a signed document.** `leaseColumnDisplayValue()` maps
`lease_type`, `auto_renew_mode` and the `utility_*_responsibility` columns on
their way onto the page.

## The near-miss worth remembering
I fixed the template editor + the one template's rows and reported the identity
problem solved. Nic: "That's not gonna happen every time a new landlord opens a
lease and tries to set that. The auto place boxes will actually do what you
changed." He was right — auto-placement still stamped `signer_role='landlord'`.
TWO paths classify a blank (heuristic and model), so the rule is now applied once
at the END of `autoPlaceFields` over every field. Guard:
`services/autoFieldRoleScope.test.ts`.

## Reverted the same session
`property_utility_rates.unit_type` (migration `20260902003000`, reverted by
`20260902010000`). I heard "$2.25 for mobile homes, $3.30 for RVs" as one utility
with two prices. Nic: delivered to the unit = utility (one price per property);
sold at the front counter = POS item. Dropped rather than left unused, for the
reason he gave on `users.active_landlord_id`. Mountain View propane is back to a
single $2.25 utility rate.

## Mountain View state

- **46 invites out** — RV batch 18:15–18:43, MH batch 18:50–19:10. Two accepted
  (Renee Allen RV 24, Calvin Curtis RV 40), both parked on the missing template.
- **Templates:** `Mountain View Mobile Home` uploaded and repaired (tenant names
  2/3/4 mapped, occupants bound, identity fields freed). **The rv_spot template
  is still missing** — 25 invites and both acceptances are waiting on it. It
  drafts everything parked the moment it is uploaded and set as default.
- **Utilities:** electric submeters on all 53 RV spots @ $0.21; propane $2.25/gal
  (tank, no meter); water/sewer/trash included in rent, no meters, never billed.
- **Work trade, 9 units → 8** (MH 10 removed, below). All at the property default
  of 80 hrs/mo:

| Unit | Household | Covers |
|---|---|---|
| MH 01 | Scheeler | electric, propane |
| MH 02 | Rhoades | electric, propane |
| MH 05 | Negrete + Hendrickson | rent |
| MH 20 | Robinson | electric, propane |
| RV 08 | Gutierrez | everything |
| RV 45 | Conklin | rent, electric, propane |
| RV 50 | Johnson | rent, electric, propane |
| RV 51 | Kvasnicka | rent, electric, propane |

## Corrections made to invites
- Seven invites moved MH n → RV n (Ast 07, Gutierrez 08, Cunningham 16,
  Shultz 17, Lane 18, Schroeder 20, Coyle 23).
- Melendez + Reyes moved MH 20 → MH 23 (the Robinsons had landed on MH 20).
- None had accepted. **The invite EMAIL names the space**, so those nine hold an
  email with the old number; the link resolves correctly. Re-send is Nic's call.

## NEEDS NIC
1. **Mountain View rv_spot lease template** — the one thing blocking two
   residents who have already accepted.
2. **MH electric.** Billed directly to the utility in the park's name, no
   submeters on the mobile homes. Nic wants to enter the bill when it arrives and
   have it show the true value of the work trade. A `bill_amount` RUBS master over
   the mobile homes does that but splits by OCCUPANCY, not usage. If the utility
   itemizes each mobile home separately that is a different shape. **Not built —
   waiting on which.**
3. **MH 10 credit.** Valdez/Sanchez hold a purchase credit for free space rent to
   a date in their contract; they are NOT work trade. Space rent $460/mo. Nic is
   checking the end date. Mechanism already exists and needs no new code:
   `tenant_credits` (rent × months, category 'other'), applied automatically at
   invoice generation by `services/creditApplication.ts`.
4. **Propane at the pump, $3.30/gal** — belongs as a POS Fuel item. Mountain View
   has no POS categories yet; Oak Park does. One row when he wants it.
5. **RV 02 / RV 03 signed leases** print `month_to_month` raw. Not altered —
   changing an executed document's content is not ours to do. Re-issue is his call.
6. **`oakparkaz@gmail.com` locked out** (locked_until 2099), not deleted — it
   holds 27 meter readings, a signed lease document, and is the account that made
   `realestaterhoades` owner of Mountain View. Reversible.

## Not touched
`nicholasfausett12@gmail.com` — super_admin, unverified, created 2026-09-01. Nic
confirmed it is a partner admin who may not have accepted the invite yet.
