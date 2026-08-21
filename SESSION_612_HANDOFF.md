# SESSION 612 HANDOFF

End of S609–S611. **Everything below is LIVE and deployed** unless marked
otherwise. Full suite green at close: **4,846 tests, 289 files, zero failures.**

Supersedes SESSION_611_HANDOFF.md, which covers the same work — read this one.

---

## 0. NIC'S IMMEDIATE PATH — FINISHING OAK PARK

1. **Two changes on Master 22658:** priced-from → *the utility bill*; take-
   submeters-out-by → *their invoiced dollars*. Split method (occupancy) and
   submeter rate (published penny/gallon) are already right.
2. **Assign its units** — it has **zero**, so it bills nothing. All 19 RV spots
   and the 8 mobile homes; submetered ones fall out of the split automatically.
3. **Trash:** just set the price in **Rates** ($25, already set) — that creates
   what billing needs on its own. Then switch it ON per unit under *Flat charges*
   on each unit page. Self-haulers stay off. **Also mark trash tenant-responsible
   on each lease** or nothing bills and nothing complains (see §1a).
4. **Mark the owner-occupied units** (currently marked *vacant* — see §2) and set
   each household size.
5. **Propane rate** — set a per-gallon price on the property Rates panel so
   recording gallons is enough to bill correctly.
6. **Opening reads** — all 28 meters still have zero. **Nic has a question about
   the two he entered — pick this up FIRST next session.**

---

## 1a. TRASH — AND THE GATE THAT SILENTLY STOPS ANY UTILITY BILLING

**Trash is not a meter and the landlord never creates one.** Setting the price in
Rates creates the underlying row silently. Nic: *"It's not a master meter. It's a
toggle on or off for people that have it or don't. It's a flat rate."* Asking him
to "add a meter" was implementation leaking into his workflow.

On the unit page, **Flat charges** and **Shared meters** are separate sections —
listing trash beside a water master made it read as equipment.

**Trash can ALSO be billed by RUBS** (Nic, and verified end-to-end by test): a
RUBS trash master on the *utility bill* basis takes the hauler's bill total each
cycle and splits it by occupancy or any other basis. $180 across two
single-occupant units → $90 each. Nothing about trash forces a flat price.

Setting a trash price only auto-creates the flat-rate row **when no trash setup
exists at all** — it must never override a landlord who chose RUBS, or they get
two trash meters and the double-billing guard blocks their units.

### THE GATE — worth knowing before debugging any "why is nothing billing"

A unit bills for a utility ONLY where its LEASE has
`lease_utility_responsibilities.tenant_responsible = TRUE` for that utility type.
The meter, the assignment and the rate are all irrelevant without it. It fails
SILENTLY — bills simply aren't created and the run reports `unitsSkipped`.

This is the first thing to check when a correctly-configured meter produces
nothing. It is also a real Oak Park step: water is marked, **trash is not**.

---

## 1. PROPANE — REBUILT THIS SESSION, READ BEFORE TOUCHING

Final model, all live:

- **Nothing charges when a fill is recorded.** The whole schedule is written up
  front; the first installment rides the NEXT monthly invoice. *"All decided
  before any money moves."*
- **The split is in GALLONS**, not dollars. 190 gal over 4 → 48, 48, 48, 46; the
  last carries the remainder so gallons reconcile to the fill exactly. A tenant
  can check gallons against their tank; they cannot check a quarter of a dollar.
- **Future installments are FUTURE CHARGES** — not payable rows until their month
  arrives, the same mechanism that stops all future rent being due at once.
- **Fills QUEUE BEHIND each other.** A refill starts after the last scheduled
  installment, never alongside it. *"It shouldn't overlap on the December
  invoice. That's not really a thing."* One propane line per invoice, always.
- **No acceleration on a new fill.** A refill just adds more future installments;
  they stack and level out as fills get smaller.
- **EXCEPT at move-out**, where every remaining installment comes due on the
  final bill. That was a real gap: the final bill sweeps existing charges only,
  so a tenant could move out owing three scheduled installments and nothing would
  bill. Propane already delivered and burned, no future invoice left.
- **Delivery entry:** one master bill, price once, gallons per tank, blanks
  skipped. All-or-nothing so a bad line never leaves six tanks in and two out.
  Warns when a tenant still owes on an earlier fill.
- **Property-level price per gallon** — a **Propane** row in the Rates panel
  (added there this session; the API accepted it before the UI offered it).
  Prefills the delivery form; still editable, because the truck's price moves.
- **Work trade covers propane** (Nic) — taken LAST, so a partial month covers
  living costs before a one-off fill.

**NOT built:** the running-ledger box on the tenant's invoice showing their
remaining propane balance and what's scheduled. Nic described wanting this; it is
the main outstanding propane item.

**Dead code pending deliberate removal:** `services/propaneRedistribution.ts`
applied rent money to accelerated propane FIRST — the rent-supersession Nic ruled
out. Nothing sets `accelerated` any more so it is unreachable. Delete the
service, its call in `routes/webhooks`, and the `accelerated` column together.

**Correction worth carrying:** propane-last ordering in the ledger allocator was
added to stop propane absorbing money ahead of rent. Nic pointed out that on the
normal portal path this is moot — an invoice is payable in full, so nothing is
paid "before" anything. It still guards the non-all-or-nothing paths (credits,
work trade, a recorded cash payment against one row). Real, but not central.

---

## 2. OWNER-OCCUPIED UNITS — READ BEFORE MARKING ANY

An owner-occupied unit has no lease, so it scored **zero** in a RUBS split and
contributed nothing to the divisor — meaning the remaining TENANTS' shares summed
to the whole bill. **The owner's own water was being paid for by the tenants**,
invisibly.

Now the unit takes a real share (household size, default 1) and that share is
**withheld — billed to nobody** and recorded in its own ledger, so "billed out +
kept back = the pool" reconciles exactly. That is the audit answer.

**Oak Park's owner-occupied units are still marked VACANT** because there was no
way to mark them otherwise. Now settable at unit creation and on the unit page.
Until marked, their usage still lands on the tenants.

A VACANT unit taking no share stays correct — it draws nothing.

---

## 3. OTHER MONEY WORK SHIPPED

- **Tenant autopay** — due date or a day 1–28, same code as the Pay button,
  charges the live balance, cannot charge twice. Stays on after a failure, tells
  both sides, disarms after two. Landlord sees THAT it is scheduled and can never
  change the day.
- **Pay ahead, no cap.** GAM holds it, releases each month as the invoice comes
  due.
- **Prepaid money now reaches the landlord.** It never did — bills were marked
  paid and nothing told the payout side anything was earned.
- **Late fees and landlord-billed fees go to the landlord.** Only rent and
  utilities were ever split out. Every charge now records whose money it is at
  creation. GAM keeps only: ACH return/retry, card decline, manual-payment fee,
  opt-in products.
- **Flat-rate charges set at the PROPERTY** (anti-discrimination) — an editable-
  per-meter amount is a way to bill two identical units differently for the same
  service.
- **Meters editable, locked by USE not existence.**
- **Unit pickers show only selectable units** — taken ones are gone, not greyed.
- **Photo minimums by unit type** — 1 for bare sites, 5 for interiors.
- **Admin rent volume** is a real heartbeat off settled money (was a hardcoded
  fake trend line), 6m/1y/2y/3y windows.
- **Intermittent white screen fixed** (React #310: a hook below an early return).
  Guarded by **`npm run lint:hooks`** across twelve front-ends — **run it before
  deploying a frontend.** It is invisible to typechecking and to every test.

---

## 4. STILL TO DO

1. **Opening reads question** — Nic entered two at Oak Park and wants to discuss
   something about them. **Start here.**
2. **Tenant-facing running propane ledger** on the invoice.
3. **Delete propaneRedistribution** (see §1).
4. **Propane model flexibility (Nic, not built — the same box as trash was):** *"Propane should be set up to
   set the option at the property level... if it's just a one off charge or
   whatever or a submetered thing, we need to have all that flexibility."* Today
   there is one model: per-unit tank fills. A **one-off charge** and **submetered
   propane** (central tank, per-home meters) are not covered. The submetered case
   almost works as a `gas` meter billed per gallon, but the invoice hardcodes
   **"therms"** for gas — wrong unit on a billable document.
5. **Onboarding revamp (Nic will design).** Three symptoms found, all the same
   shape — *one decision, two places, or a setting wired to nothing*: sub-meters
   creatable from two screens; the property trash rate read by nothing; sub-meters
   present but below the listing block so "can't find it" looked like "doesn't
   exist".
6. **Financed sales scope** — code offers it on RV spots; Nic said mobile-home
   only. NOT changed; he said it mid-explanation, so it needs confirming.

---

## 4a. THE PATTERN NIC CALLED OUT — READ THIS

> "You keep writing inside the lines to deal with a specific type of property
>  instead of making it work for how each landlord might operate in a different
>  capacity. We don't wanna draw ourselves inside of a box or back into a corner."

He is right and it happened repeatedly across this session: trash built as
flat-rate only, propane as fills only, a lease-term cap on paying ahead, greyed
rows that work at three units and fail at twenty-seven. Each time his answer was
treated as THE answer rather than one setting among several.

**Before building a rule, ask whether it is a rule or a landlord's choice.** GAM
is national; Oak Park is one shape. The standing exceptions are the deliberate
platform rules — pay-in-full, no per-unit flat-rate amounts (discrimination),
GAM never absorbing fees — and those are narrow and already written down.

---

## 5. HOW TO WORK WITH NIC

- **He does not read code.** Describe what a PERSON experiences and what it costs.
- **Don't ask what he has already answered.** He described the propane delivery
  flow in full and was then offered three versions of it: *"I already said the
  flow that I want, so I don't know why you were asking questions."*
- **When he pushes back, check whether the disagreement is about behaviour or
  about the sentence.** Several times the code was right and the wording muddled.
- **He is right about scale.** Greyed-out rows were defended as clearer than a
  missing row — true at three units, useless at twenty-seven.
- **Verify before claiming something is missing.** The sub-meter editor existed;
  it was unfindable. Check the DATA MODEL, not two likely files.
- **He catches deletions.** He asked directly whether options had been removed to
  suit his property — and one thing had been lost (a prior-balance warning). Say
  what changed.

---

## 6. FILES / OPS

**New:** `services/rentCharge.ts`, `services/prepaidRelease.ts`,
`services/propaneFill.ts`, `jobs/autopayRunner.ts`, `routes/tenantAutopay.ts`,
`apps/tenant/src/pages/AutopayCard.tsx`,
`apps/admin/src/components/RentVolumeMonitor.tsx`, `.hooks-eslint.json`.

**Migrations applied** (dev `gam`, schema.sql regenerated):
`20260819210000_autopay_failure_tracking`, `20260819220000_payment_revenue_owner`,
`20260819230000_carried_balance_one_per_lease`,
`20260820100000_owner_use_household_size`, `20260820110000_owner_use_absorptions`,
`20260820120000_propane_installment_gallons`.

**Tests:** `cd apps/api && DB_NAME=gam_test npx vitest run` — **never without
DB_NAME, it wipes the dev database.** ~6.5 min.

**Lint:** `npm run lint:hooks` from repo root, before any frontend deploy.

**Deploy:** `bash ~/gam/deploy.sh`.
