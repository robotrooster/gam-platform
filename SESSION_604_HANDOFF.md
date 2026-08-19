# SESSION 604 HANDOFF — deposit interest + custody, all 50 states; owner_use; custody enforcement

> Started as "continue the S603 build list unattended". The deposit-interest
> accrual work opened into a **full 50-state statutory read** (interest AND
> custody), which is now the largest thing in this session by far. Also shipped
> `owner_use` unit status, commission corrections, and deleted the orphaned
> withdrawals route.
>
> **Second half became a LIVE ONBOARDING session** — Nic signed up the real Oak
> Park account and walked the landlord flow, surfacing a blocker and ~25 UX/data
> findings. See §8 and **`ONBOARDING_PUNCHLIST.md`**.
>
> **21 migrations applied to `gam` (LIVE db). API rebuilt + restarted ~14×.
> Landlord portal DEPLOYED to production 7×. Nothing committed.**

---

## ✅ NOTHING BLOCKING. Oak Park onboarding is IN PROGRESS.
**Hard gate remaining: Connect KYC (§7 N4) — no rent can move without it.**
**Before sending the 19 leases: tick "Security deposit is already held" (§8).**

---

## 1. ⭐ CORE MODEL (Nic) — earn on everything, pay only what is required

> "We earn interest on every held deposit any way we can through T-bills or
> whatever means necessary. We only pay interest on units or states that require
> it and only the amount required. Anything above that amount for that unit is
> ours to keep."

Encoded in `services/depositInterest.ts`. Consequences that must hold:

- The accrual job writes a row for **every held deposit**, not only ones with a
  statutory rate. No statute → `owed = 0`, which is a REAL ROW, not a skip.
  Pre-S604 those produced no row at all, which made GAM's largest earning bucket
  (the no-obligation states) completely invisible.
- **Spread is signed.** A statute above market (AZ mobile home 5% vs ~3.5%
  market) reports NEGATIVE and GAM funds it. Never clamp at zero.
- **Terminology (Nic):** a state with "no obligation" is the BEST case. Say
  "no obligation — full spread to GAM", never "negative".

### Bugs fixed on the way in
- **The S603 unit-type catalog was never wired to the job.** `runMonthlyAccrual`
  resolved on state alone, so a unit-type rule could never match — an Arizona
  mobile home would have accrued **$0 forever**, which was the entire point of
  the S603 migration.
- **A second resolver in `routes/tenants.ts`** ran its own state-only `LIMIT 1`
  lookup, so an AZ APARTMENT tenant was shown "5.0000% — A.R.S. § 33-1431(B)",
  a mobile-home statute quoted at someone owed nothing, disagreeing with what
  the engine booked. Collapsed onto the one resolver.
- **Margin leak caught before shipping:** `getAccrualHistory` feeds the TENANT
  portal. earned/market_rate/spread are excluded there (same boundary S603 drew
  when `calcNetPerUnit` leaked to landlords). Admin uses
  `getPoolSpreadByMonth()`. There is a test asserting those keys never appear.

---

## 2. ⭐ ALL 50 STATES READ — interest and custody

Read **per (state, ACT)**, ~100 pairs. Arizona alone has four tenancy acts and
they disagree with each other. **Keyword triage was abandoned** after failing in
both directions on this very pass:
- called TN "clean" → § 66-28-301(a) requires a dedicated bank account
- called NM "clean" → § 47-8-18 owes passbook interest above one month's rent
- flagged OH from § 4781.25 (manufactured-housing **BROKER** trust accounts);
  Ohio's real rule § 5321.16 is a **5% obligation** the keyword pass never saw

**NEVER filter `state_law_section_texts` by a hand-picked act_key list.** 16
states file landlord-tenant law under `general_landlord_tenant`. That filter bug
is what produced the false "NJ and SC aren't in the corpus" claim — both were
there all along.

### 16 obligations, 7 statutory bases
`fixed` (AZ mobile home 5%, RI mobile home 3%, **OH 5%**, MD 1.5%, MN 1%) ·
`lesser_of_actual` (MA) · `share_of_actual` (FL 75%) · `actual_earned` (ND, NH,
IA, NJ) · `actual_minus_admin` (NY 1%, PA 1%) · `index_linked` (CT, IL, NM) ·
`none` (verified negatives, recorded as rows so nobody re-researches them).

**Only `fixed` can run negative — AZ mobile home, RI mobile home, OH.**

MA was originally seeded as flat 5%; the statute is *"five per cent per year OR
OTHER SUCH LESSER AMOUNT as has been received from the bank"*. That
mis-encoding would have cost more than the harshest statute in the catalog,
since MA is a big high-deposit apartment market.

### Five gate dimensions the catalog now models
tenure (IA 60mo, PA 24, NH 12, OH 6) · property size (IL 25+ spaces, NY 6+
family) · deposit size, two flavours — **`excess_only`** (OH: 5% on the excess
over the greater of $50 or one month's rent) vs **`trigger`** (NM: above one
month's rent the WHOLE deposit earns). Collapsing those two to one flat rate
would overpay Ohio ~5x and underpay New Mexico.

---

## 3. Custody — where the money may physically sit

`state_deposit_custody_rules`, **FAIL-CLOSED** (absent state → `needs_research`,
never "go ahead"). Full detail + the Jiko question list in
**`DEPOSIT_CUSTODY_PLAYBOOK.md`** (repo root) — read that first, not this.

| | Count | States |
|---|---|---|
| supported (T-bills lawful) | 26 | AL AR **AZ** CA HI IN LA MD MN MS MT NE NM NV OH OR RI SC SD **TX** UT VA VT WI WV WY |
| blocked | 21 | AK CO CT DE FL GA ID IL KY MA ME MI MO NC ND NH NY OK PA TN WA |
| read, unresolved | 3 | IA KS NJ |

- **AZ is supported** — no account requirement in §§ 33-1321/1431/2121. Oak Park
  can hold Treasuries. **TX is fully open** and is the largest rental market.
- **Why T-bills fail in 21 states:** they require an insured *institution* AND a
  deposit/escrow/trust *account* there. A T-bill is a security, not a deposit;
  a broker-dealer is not an insured depository. Treasuries are stronger credit
  than FDIC insurance — they are not FDIC insurance, and the statutes test the
  latter.
- **`geography_test`** distinguishes what "financial institution" means per
  state: `none` (13 — any federally regulated institution; GA/TN/KY say
  "or any agency of the United States government") · `doing_business` (NC) ·
  `physical_office` (7: CT DE FL MA NY OK WA) · `state_chartered` (2: NH NJ —
  the structural wall; a national charter fails).
- **Pocket accounts (per-tenant, KYC'd, GAM-controlled) would take 26 → 41**,
  and would also solve CO, whose bar is the opposite of pooling (it REQUIRES
  separation). The 6 physical-office states flip too **if Jiko has in-state
  presence** → ceiling 47.
- **Bond alternatives exist in only 4 states: MI GA FL NC.** MI is strongest —
  post a bond and the landlord "may use the moneys so deposited for any purposes
  he desires". **Bonds name THE LANDLORD as principal, not GAM**, and FL/GA
  require filing per county, capped at deposits or $50,000 whichever is less.
- **MA/NH/NJ are permanent skips for custody** — they owe actual-earned or
  lesser-of, so GAM earns exactly $0 there as a custodian. **They flip under a
  bank charter** (Nic): those statutes peg the tenant to what the institution
  PAYS, not what it earns, so the NIM would be GAM's.

---

## 4. Custody ENFORCEMENT — new this session

`services/leaseFeesSync.ts` resolved `held_by` purely from lease source, so GAM
would have taken custody in Washington or Oklahoma. It now joins
`state_deposit_custody_rules` and forces `held_by='landlord'` wherever the state
is not `supported`, fail-closed. Flipping a state to supported later lets new
deposits flow to GAM **with no code change**. 2 tests.

Onboarding flags (both fire on property create, post-commit, non-throwing so a
custody gap can NEVER block a signup):
- `flagUnsupportedCustodyState` — critical alert naming the state, blocker,
  statute, and the interim action (`held_by='landlord'`)
- `flagDepositInterestObligation` — any state owing interest in any form, with
  each obligation's unit types and gates. Warns in BOTH directions: under-paying
  is penalised (AZ § 33-1431(D) = twice the amount withheld), over-paying is a
  silent permanent margin leak.

---

## 5. Also shipped

- **`owner_use` unit status** (Nic) — no lease, no rent, not bookable, counts as
  occupied. The $2 fee waiver needed NO code: billing counts units with an
  ACTIVE LEASE, so it is structural. Both directions enforced — can't flip a
  leased unit to owner_use, and a **DB trigger** blocks creating a lease on one
  (leases are created from 5 different paths). Landlord UI deployed.
- **Commission fix** — `commissionAccrual` counted `status <> 'vacant'`, which
  included `available` (vacant-but-listed). Reps earned MORE as occupancy got
  worse. Now excludes `available` + `owner_use`.
- **`withdrawals.ts` DELETED** (Nic) — orphaned manual-payout route with no UI
  since S574 that let a landlord pull their Connect balance outside the Tuesday
  batch. Route + 2 test files removed; `instantFeeBreakdown` had no other
  consumer; admin revenue surface reads historical ledger rows, unaffected.
- **Stale tests fixed** — `stripeConnect.test.ts` still asserted card 3.25% +
  $0.26 (S603 repriced to 3.5% + $0.55); `s537-payment-fifo` asserted a 1% ACH
  fee (S600 made it flat $6). A red suite hides real regressions.
- **`dump-schema.sh` header** now states that `test/globalSetup.ts` rebuilds
  `gam_test` from schema.sql — it previously read as inert.

---

## 6. Test + deploy state

- **Full suite: 4498 passing / 271 files.** Remaining failures are pre-existing
  and NOT from this session: `admin-arc-closer` (3), `stripeConnectCharges` (5),
  `propertyBookingAdmin` (1), `s409-hygiene` (1), `turnBudget` (1).
- Deposit suites: 53 engine + 13 custody + 13 sync, all green.
- **API: rebuilt + `launchctl kickstart -k gui/$(id -u)/com.gam.api`, /health 200.**
- **LANDLORD PORTAL: DEPLOYED to production** — verified, `landlord.goldassetmanagement.com`
  serves the same asset hash as the local build (`index-tOsXCqCq.js`).
- Tenant/admin/marketing NOT redeployed (no changes needed).
- **Nothing committed.** 148 files in the working tree.

---

## 7. ▶ OAK PARK ONBOARDING — the only hard gates are Nic's

Checked against the LIVE db, not the doc:

- **N2 — the real Oak Park landlord account does not exist.** Only
  `james@demo.dev`, `maria@demo.dev`, an internal pool-intake account, and
  `realestaterhoades@gmail.com`. Nic must register under the real business email
  and say which one, so QA never touches demo data.
- **N4 — Connect KYC is not done on ANY account** (`stripe_connect_account_id`
  null across the board). This is the hard gate: no Connect account = no rent
  moves. ~10 min with EIN + bank.
- N3 data entry, N5 Vercel Pro — Nic's pace.
- Then C4 live-fire money test, C5 invite→login→pay walkthrough on prod,
  C6 billing dry-check (**the doc says "Aug 1"; the live cycle is now SEPT 1**),
  C7 rolling QA behind his data entry.

**Waiting on third parties (unchanged):** Stripe branding (Nic's vector),
`support@` reply-as (partner's Workspace setting), deposit-trust go-live (FBO
account). None of these block Oak Park onboarding — AZ is custody-supported and
deposits can sit with the landlord meanwhile.

---

## 8. ⭐ OAK PARK ONBOARDING — LIVE, and what was fixed mid-flight

Nic signed up `oakparkaz@gmail.com` and began real onboarding during this
session. Everything below was found BY DOING IT, and is captured in
**`ONBOARDING_PUNCHLIST.md`** (repo root) — read that alongside this file.

**Blocker fixed:** the Properties page showed "Add your first property" after
signup had created one. The property, token claims and API were all correct end
to end; the onboarding wizard never invalidated the react-query `properties`
cache. **Lesson: data present in the DB but a page says "none yet" → suspect the
query cache, not the API.**

**The expensive one:** e-signing new leases for EXISTING tenants would have
billed 19 tenants $350 each for deposits the landlord already holds (~$6,650).
Fixed with `lease_documents.deposit_already_held` — the lease still STATES the
deposit (signed doc + move-out sweep stay correct), but the custody row is
pre-marked `carried_forward`, which trips the EXISTING S516 double-charge guard.
Reused that guard deliberately so one code path owns "never bill a deposit
twice". **Nic must check the box when sending those 19 leases.**

**Also shipped this batch:** bulk numbering `startAt`/`padWidth` (a park's real
signage — Oak Park runs RV 1-3, apts 4-5, motel 6-12, apts 13-19, RV 20-36, MH
1-8 — could not be expressed before); same-utility double-billing guard (a unit
could be attached to two water masters and be charged twice, silently); and the
whole batch-1 UI list (late-fee preview table + edit, subtype prefill incl.
rates, card-fee copy derived from the constant, password confirm, EIN/phone
formatting, vacant-status colour, agent permissions off the property page).

**Late batch — unit lifecycle (Nic's decision, DECIDED):**
- **Rename + delete added** — neither existed. A unit's number was permanent from
  creation and a unit created by mistake could never be removed.
- **Then Nic locked rename:** *"I wouldn't allow a rename of a unit after data is
  on something."* The deciding fact: **nothing snapshots `unit_number`** — every
  invoice and payment joins by `unit_id` and renders the CURRENT value, so a
  rename retroactively rewrites how years of records display while executed
  lease PDFs keep the original and disagree. Rename now 409s once the unit has a
  lease (ANY status incl. ended), payment, booking, deposit, meter link or
  maintenance request. Fresh units still rename freely, so onboarding stays
  forgiving. Delete uses the SAME `unitHistoryBlocker` probe so the two cannot
  drift on what counts as history.
- **His design for the real fix — RETIRE & REPLACE** (specced, NOT built; see
  `ONBOARDING_PUNCHLIST.md` § "NEXT BUILD"): one physical unit becomes two
  database records — retire the old, create the replacement under the new
  number, link them both ways. *"If data ever needs to be pulled you don't have
  to pinpoint when it changed and what to look for before that."* Needs
  `retired_at` + `superseded_by_unit_id`, a transactional retire endpoint, and
  **an audit of every list query for `retired_at IS NULL`** — a missed filter is
  how a retired unit silently keeps getting billed or booked. Deliberately not
  built at 22:30 on a full context.

### Oak Park state as of end of session
- Property `Oak Park Motel and RV`, Yarnell AZ, landlord `8d59242e…`
- **19 RV spots** created (`RV 01`–`RV 19`), rent $440, nightly $40, weekly $200,
  30-amp back-in, tenant-owned. All `security_deposit = 0.00` (field is on step
  2 of Add Unit, easily scrolled past) — real deposit is **$350**, taken from the
  LEASE, so this is cosmetic but pre-fills wrong.
- Connect KYC **not done** — still the hard gate on money.
- No tenants/leases yet.

### The September plan (agreed)
1. Create electric submeters per spot + **a backdated BASELINE read** from the
   old system. **Without a baseline the first cycle bills NOTHING and says
   nothing** — the engine returns "no prior reading — first cycle baseline" and
   stays silent.
2. Last business day of August: enter the Aug 31 reads.
3. Water is **RUBS**, not metered — configure on the utilities page. Oak Park's
   shape (master serving both submetered mobile homes and RUBS-only RV spots) is
   ALREADY handled by S558: submetered usage is subtracted from the master pool
   before the split, derived from shared unit membership with no manual linking.
   It fails safe — the pool won't bill until every linked submeter is read.
4. **Lease start dates = Sept 1** (not the tenant's original move-in), so the
   move-in invoice bills a clean full September. The regular cron deliberately
   skips the start month, so there is no double bill.
5. Anyone who already paid September rent off-platform → `reconciliation_until`
   (expires **2026-09-04**).

## 9. ▶ NEXT

**Oak Park onboarding comes first — it is live and Nic is mid-flow:**
0a. **Connect KYC** (Nic, ~10 min, EIN + bank) — still the only hard gate on money.
0b. **RETIRE & REPLACE** for units — decided, specced, not built. See
    `ONBOARDING_PUNCHLIST.md` § "NEXT BUILD". The `retired_at IS NULL` audit
    across every list query is the risky part, not the endpoint.
0c. The rest of `ONBOARDING_PUNCHLIST.md` (~13 open): multi-LLC signup, bank step
    after units, RUBS at onboarding, opening-read prompt, carried tenant balance,
    physical/mailing address, property-type multi-select, land-on-add-unit.

**Then the deposit/platform work:**
1. **Maturity-bucket fields** — the last piece of the original S604 build, and
   the only one NOT done. **BLOCKED ON A QUESTION TO JIKO:** does GAM choose
   maturities, or does Jiko's sweep? If Jiko controls it, laddering is their
   engine and these fields are wasted work. Nic is asking.
2. **Admin surface for the deposit catalog** — `getPoolSpreadByMonth()` exists
   with no route or UI, and the state catalog is only visible in psql.
3. **CT / IL / NM index values** — all three are `index_linked` and need the real
   published index before those states are live. Annual-refresh cadence.
4. Agent sweep cluster #6 (27 articles, BY HAND, no fan-out) — untouched.
5. Snowbird Phase 2b, add-and-pay frontend, seasonal pricing — untouched from
   the S603 list.

## MIGRATIONS APPLIED (to `gam`, the LIVE db) — 21, all dated 20260814
`100000` accrual unit-type provenance · `110000` unit_status **owner_use** ·
`120000` deposit pool yield earned-vs-owed · `130000` yield placeholder 3.5% ·
`140000` state custody rules · `150000` rate_basis · `160000` accrual basis stamp ·
`170000` full 50-state read · `180000` basis widen (fix-forward) · `190000` NJ/SC ·
`200000` sweep corrections · `210000` custody re-read · `220000` all-fifty ·
`230000` final three · `240000` CT/IL custody · `250000` institution + geography
tests · `260000` pocket accounts + bonds · `270000` bonds corrected ·
`280000` NY small-building carve · `290000` bank-charter NIM note ·
`300000` **lease_doc deposit_already_held**

## QUICK-REF
- Restart API: `cd apps/api && npm run build && launchctl kickstart -k gui/$(id -u)/com.gam.api`
- Tests: `cd apps/api && DB_NAME=gam_test npx vitest run <file>` (NEVER without `DB_NAME=gam_test`)
- Read a statute: `psql gam -t -A -c "SELECT regexp_replace(full_text,'[[:space:]]+',' ','g') FROM state_law_section_texts WHERE state_code='XX' AND section_number='YY';"`
- Models: `scripts/analysis/deposit_ladder_model.py`, `deposit_mix_model.py`,
  `deposit_law_extract.py` (per-state reading aid)
