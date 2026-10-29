# A resident takes over a spot and the home on it

**Authorized 10/23 (Nic): "build it all."** Live case: Country Acres MH 28,
Susie McCoy out, the Bowmans' daughter in, taking over BOTH the lot and the
$24,000 home-installment sale ($200/mo, 38 of 120 paid, 82 left).

## The rule this follows

**"It's what you want the end result to be determines which path you need to
take to get there."** The co-tenant path gets the new person liable BEFORE the
old one is released — and the price is that nothing financial may change: same
rent, same sale price, same payments. A new price means the other path (move
out, renegotiate, re-sell). See memory `gam-the-path-determines-the-outcome`.

Her $739.60 stays under her name, flagged left-owing. Her $7,600 of equity goes
nowhere — "mobile homes are the thing people walk away from."

## What already exists (recon 10/23, file:line)

**The add/remove engine is complete and has NEVER run in production** (0
addendum_add documents; all 109 lease_tenants rows are `added_reason='original'`).

- `POST /api/esign/documents/addendum-add` — `routes/esign.ts:4900`, perm
  `leases.create`. Refuses unless the lease is **active** (4906-4916), requires
  every current active resident as a signer (4957-4962), exactly one new tenant
  (4964-4972). Writes `lease_tenants` role `co_tenant`, status `pending_add`,
  `financial_responsibility 'joint_several'` at **5028**.
- `executeAddendumAdd` — `esign.ts:2358-2435`: flips `pending_add` → `active`.
- Fires from `buildLeaseFromDocument` at **esign.ts:7394-7396**, and
  `landlordSignsFirst()` returns true for addendum_add (**esign.ts:122-124**) —
  so today the LANDLORD'S signature activates her. **This is gap 4.**
- `POST /api/esign/documents/addendum-remove` — `esign.ts:5041`, takes
  **`promoteLeaseTenantId`** (5091) and refuses while fewer than 2 residents are
  active (5073) → the order is forced: add first, then remove.
- `executeAddendumRemove` — `esign.ts:2512-2519`; the only `UPDATE lease_tenants
  SET role` in the repo (2518). Sets status but **never demotes the outgoing
  row's role** → two `role='primary'` rows, ~20 status-blind readers.
- `assertResidentsBelong` — `esign.ts:261-287` via `residentsTiedHere:244-259`:
  the new person must already hold a lease, a live `pending_tenant_intents`, or
  a `pending_lease_draft` with this company. **No "join an existing lease"
  purpose exists** → gap 2.
- Screening gate is scoped to `document_type === 'original_lease' &&
  !renews_lease_id` — **esign.ts:5964** → an addendum never checks → gap 3.
- Seat builder to reuse: `services/signerSeats.ts:78` `householdSignerRows`.
- Primary lives only in `lease_tenants.role`; `leases` has NO tenant_id column.
  Unique active primary: `schema.sql:32406`. Views `v_lease_active_tenants`,
  `v_unit_occupancy.primary_tenant_id` (`schema.sql:22669`).
- Landlord UI today: `apps/landlord/src/pages/LeasesPage.tsx:1502` "Send an
  addendum" → `SendAddendumModal` (1535-1565) → **addendum-terms only**.

## The home sale

- `home_sale_contracts.lease_id` is already nullable and **8 of 9 live contracts
  have it NULL** — the sale already sits outside the lease.
- `tenant_id` is NOT NULL, written once (`services/homeSale.ts:88-92`), and
  **never updated anywhere**. It is a **watched ledger column**
  (`packages/shared/src/booksLedger.ts:847-852`, trigger
  `schema.sql:4478-4489`) — mutating it rewrites the sale's history. DO NOT.
- Billing: `jobs/invoiceGeneration.ts:838` (gate), **851-852** matches
  `c.unit_id = $1 AND c.tenant_id = $2` where $2 is the lease's PRIMARY
  (resolved 169-170). Swap the primary and the installment leaves the rent bill.
- Then `services/homeSale.ts:853-857` — the standalone fallback bills only when
  no active lease has the buyer as primary — flips TRUE and starts billing
  **the departed buyer directly**. This is the sharp edge: do the swap before
  the handover exists and Susie is billed forever.
- Catch-up attach is buyer-locked: `homeSale.ts:689-696`, insert uses
  `c.tenant_id` at 703-708; household lock at 633.
- Sale cannot start unless the unit is landlord-owned: `homeSale.ts:970`.

## The lien bug (Nic's correction, confirmed)

`services/spaceRentCarryforward.ts:268` — `else if (lease.dwelling_ownership
!== 'tenant')` → ineligible, *"The park owns the home on this space."*
`units.dwelling_ownership` stays `'landlord'` for the whole life of a sale, and
`units_dwelling_ownership_check` allows only `'landlord'|'tenant'` — mid-purchase
is not representable. `closeOutWithCarryforward` (361-362) throws 409 on
ineligible, so this is the only door.

**All 9 active contracts at Mattoon are in this state, including MH 22 at 79%
paid off.** Nic: a home mid-purchase belongs to the tenant in every way that
matters; the landlord only holds title.

**The fix is already written twice in this codebase** —
`services/signingPackages.ts:101-106`: *"A sale in flight beats everything: the
home is still the park's on paper (ownership flips at payoff), but a sale is
what is being papered today."* Carry-forward is the outlier.

## Build order

1. **The sale handover.** New `home_sale_assumptions (contract_id,
   from_tenant_id, to_tenant_id, effective_month, document_id)` + a resolver
   "who is the buyer in month M" (latest assumption ≤ M, else
   `contracts.tenant_id`). Point `invoiceGeneration.ts:852`, the standalone
   fallback and the catch-up attach at the resolver. `tenant_id` untouched.
2. **"Join an existing lease"** as an invite purpose, so a brand-new person can
   be screened and then added. Screening required before the addendum.
3. **Landlord UI** for add and remove, and the handoff asks the lien question
   with the figure on screen (stays with the leaver / attaches to the space) —
   a per-situation landlord decision, never a setting.
4. **The lien reaches a sale in flight**, and the outgoing primary is demoted so
   only one `role='primary'` row can exist.

Plus gap 4: **the add activates on the NEW PERSON's signature**, not the
landlord's, because being liable before the other is released is the entire
point of this path.

---

# 10/24 — the counter must settle without a judgment call

Nic: *"going forward, is it where the front desk person has to decide on if we
bill somebody back the electric or if it washes out? Or is that chosen
systematically from our list of criteria? I don't really want the front desk
making judgment calls. I want the computer to do it for them."*

**THE WASH IS SYSTEMATIC. THE REFUND IS THE LANDLORD'S. NEITHER IS THE DESK'S.**

Every input the wash needs is already data:
- did money arrive for that period (rent rows / the stay's `total_amount`)
- nights used against half the paid period
- `early_departure_refunds` / `prorates_mid_month_rent` on the property
- RV month-to-month vs fixed term vs another unit type
- work trade (absorbed, below)

So the read settles the moment it is taken. What CANNOT be systematic is whether
money goes back — Nic, 10/22: *"it's situational where we may refund somebody or
we may not."* But that question never has to block the counter, because the
unwind already exists: a refund issued later takes the wash back off the book and
bills the stub (`unwindWash`, reason `refund_issued`). Settle now, unwind if the
owner refunds. Nobody waits.

## The bug that stopped Lisa (Patrick Neuman, RV 06)

`washVerdict`'s no-answer branch asks "has the money answer come in?" BEFORE
"was there any money at all". On a property that gives money back it returns
`undecided` → `settleFinalStubForDeparture` parks the stub → the counter is told
to wait for a landlord. Patrick's stay is **$0.00** (work camper), so the money
question can never be answered and that read parks FOREVER.

The "nothing was paid, so there is nothing to wash → bill" answer exists only on
the no-refunds path. It has to come first, for both.

## Work trade at the counter — DECIDED 10/24

Nic: *"count their final electric as absorbed. And reported."*

A work camper's final read settles as **absorbed** (`utility_absorbed_charges`),
reported in the recovery figures as power the park ate — never billed, never
washed (nothing was kept), never held. Work trade is hours, not wages, so the
power is not priced into the hours.

## Three money items waiting on the check tender

The migration is in (`20261024030000`); the ROUTE and BUTTON are not. These are
NOT to be hand-written in SQL — that skips inventory, the EOD settlement and the
ledger projection.

1. **Donald Hemp** (spelling to confirm — Nic said Hemp, then Hamp) — propane
   $49.25, transaction `200c4976-f76c-479a-b985-c3b244d516ad`, recorded 10/23
   2:56pm Phoenix as **cash with no customer attached**. Must become a **check,
   number 167**, with Hemp attached. He is not in `pos_customers` yet.
   Correcting it moves $49.25 out of that day's cash total — the EOD figure for
   10/23 changes.
2. **Mike Prevenis** — propane $23.92 at current prices, **check 1006**. Not yet
   recorded at all.
3. The per-property `accepts_checks` switch needs its settings control.
