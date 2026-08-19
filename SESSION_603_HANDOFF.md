# SESSION 603 HANDOFF — card repricing, Stripe audit, money-accuracy fix, reporting engine

> Started as the S602 agent sweep + Snowbird continuation. A question about the first live-fire
> charge redirected it into a **Stripe cost + settings audit** that found several real problems
> (including one that made ACH impossible in production), a **money-accuracy fix in the allocation
> engine**, and a **flexible reporting engine**.
>
> **Nic is onboarding Oak Park TODAY** and will run a live $1 ACH test himself. Everything he said
> had to be correct before that test is **done and deployed**.
>
> **3 migrations applied to `gam` (the LIVE db). API rebuilt + restarted 5×. KB re-ingested.
> Tenant + landlord frontends DEPLOYED to production. Marketing redeployed. No commits (107 files).**

---

## ✅ NOTHING IS BLOCKING.
**Next up (Nic, end of S603): finish the deposit-interest ACCRUAL structure — see §9 "STILL TO BUILD".** The schema half is done and deployed. After that: agent sweep cluster #6, then Snowbird 2b (see BUILD LIST).

---

## 1. Card repricing → 3.5% + $0.55 — DONE, LIVE

**Why:** the S600 live charge exposed that Stripe bills GAM on an **IC+ unbundled** contract —
`balance_transaction.fee` is ALWAYS 0 and costs post T+1 as separate debits with `source: null`
(daily aggregates, never per-charge). Real cost = interchange (`network_cost`) + 0.7% volume +
**$0.26 per AUTHORIZATION** + **$0.02 Radar per authorization**.

The old $0.26 flat recovered exactly ONE Stripe auth fee and nothing else; 3.25% left only 2.55% for
interchange after Stripe's 0.7%, so **every commercial card (~2.70–3.15%) lost money, and lost more
as rent rose.** Nic accepted a small commercial-card loss above ~$113 (−$0.28 on a $300 booking,
−$1.63 at $1,200) rather than pricing higher and reading worse to every ordinary tenant.

Landed: `PROCESSING_FEES` · migration `20260812150000` · 6 agent articles · both ToS docs · sales doc
· `stripeConnect.ts` header. **Verified live:** DB `card 3.5% + $0.55`, dist has `CARD_PCT: 0.035`.

> Cost side of `platform_processing_rates` deliberately left at 2.9% + $0.26 — conservative, so it
> UNDER-reports GAM revenue rather than over-reporting. Re-derive from real `network_cost` balance
> transactions once there is volume.

**$1.00 declined-card fee** (`DECLINEFEE`, migration `20260812160000`): Stripe bills per BANK ASK, so
every refused attempt costs $0.28 with no revenue. Fires on EVERY decline, card-only (ACH keeps its
$4 RETURNFEE), idempotent by PaymentIntent. Consumer ToS § 5.2 + tenant article. **It is a FLAT FEE,
not a pass-through — never describe it as "our cost."**

**Tenants cannot add a card unless a payment is due** — saving a card is its own $0.28 authorization.
ACH exempt (a bank mandate is not an authorization).

---

## 2. ⭐ Allocation-engine money accuracy — FIXED (this was the blocker; it is resolved)

Nic: *"We cannot have a discrepancy between landlord and the platform with how much was processed…
We have to be 100% accurate everywhere."*

Two pre-existing bugs, same root cause: allocation **recalculated** the fee from ONE row instead of
reading what actually happened.

**Bug A — flat fee booked once PER ROW.** `webhooks.ts` loops `settled.rows` calling
`executeRentAllocation` per row. **Under Nic's billing model this was the NORMAL case, not an edge
case:** rent, utilities, and late fees are separate LINE ITEMS on ONE invoice paid by ONE ACH charge
(deliberately, to avoid a second money-movement fee). So any tenant with a utility line double-booked
the flat $6 — $12 against $6 charged. With `ach_fee_payer='landlord'` that came **straight out of the
landlord's share.** (Late-fee rows were unaffected — allocation only runs for `rent`/`utility`.)

**Bug B — cost measured on the wrong base.** `gross = payment.amount` is the rent line, but Stripe
bills what it PROCESSED (rent + tenant-borne fee). Proven empirically on the S600 charge: $2.33
processed ($2.00 rent + $0.33 fee) was billed $0.02 volume fee — 0.7% × $2.33 = $0.0163 → 2¢, whereas
0.7% × $2.00 → 1¢.

**Fix** (`services/allocation.ts`): `resolveChargeContext()` gathers every settled row sharing the
PaymentIntent; the fee is computed ONCE against that whole charge (matching what `/pay-balance`
actually charged), the Stripe cost is computed against the **processed** amount (rent + fee when
tenant-paid), and both are **apportioned across the covered rent/utility rows by amount** — the last
row (deterministic id order) absorbs the rounding remainder so per-row pieces sum to the whole
exactly. A payment with no PaymentIntent (recorded cash/check) collapses to the old single-row path.

**Tests:** 2 new regression tests using the REAL production rate shape (flat $6 / 0.5% capped $3) on
a rent + utility charge — tenant-paid total spread **$3.00** (was $7.00), landlord-paid owner share
**$994.00** (was $988.00). Older tests that asserted `5.00` now assert `4.95` — they had been
asserting the bug ($1,000 rent + $10 fee = $1,010 processed → Stripe 0.5% = $5.05).

---

## 3. Stripe settings audit — 6 fixed, 1 open

- ✅ **Payout schedule was `daily`/2-day** — every dollar auto-swept to GAM's bank, so the Tuesday
  landlord batch would have run against an empty balance (and with `debit_negative_balances` on,
  Stripe would have pulled it back out of GAM's bank). **Now MANUAL.** Money stays on the Stripe
  balance. Payouts can be ANY amount up to the *available* balance — Nic's posture: leave the bulk on
  Stripe, move out only what's needed for bills.
- ✅ **`setup_intent.succeeded` was NOT subscribed on any live webhook** — the ONLY signal that a
  tenant finished microdeposit verification. **ACH could never complete for anyone in production.**
  Added to `we_1TvhBnDNEru9AEpKykhywHYW`; code-handled vs Stripe-sent now match exactly both ways.
  Never caught because the code was complete and correct — the gap was in Stripe's dashboard,
  invisible to the repo — and ACH was never live-fired.
- ✅ Statement descriptor `GDMGMT` → **`GOLD ASSET MANAGEMENT`** / shortened **`GOLD ASSET`**.
- ✅ Business URL → `goldassetmanagement.com` (was `golddoor.io`).
- ✅ Support email + support URL set and **verified receiving**.
- ✅ Payment methods trimmed. (Affirm/Klarna could not be disabled — Stripe's dynamic-management mode
  locks them. Harmless: GAM names `payment_method_types` explicitly on every charge, so nothing else
  can ever be presented. `us_bank_account_ach_payments` capability confirmed **active**.)
- ⬜ **BRANDING — the only open item.** No logo/icon/colors. Landlords see an unbranded Stripe Connect
  onboarding page. **Waiting on Nic's vector** (he is designing it; do NOT auto-trace it for him).
  Colors when ready: gold `#C9A227`, dark `#0D1014`.

**Per-charge statement descriptor suffixes were PROPOSED and DECLINED** (Nic: tenants pay one bundled
charge and know what it is). Do not re-propose except possibly for guest bookings.

---

## 4. Support email + marketing support page — LIVE

`support@goldassetmanagement.com` → Cloudflare Email Routing → `nic@golddoor.io`. Root domain now has
Cloudflare MX + `v=spf1 include:_spf.mx.cloudflare.net ~all`; Resend sending is unaffected (it runs
on the `send.` subdomain). **Verified working** (the long debugging detour was a typo in the test).

New **`/support`** page on the marketing site (`apps/marketing/server.js`), reusing the legal-page
chrome via a new `'general'` audience that suppresses the "(For Tenants)" label and version switcher.
It leads with the statement descriptor so a charge is recognisable, then says *email us before
contacting your bank*. **Deliberately NOT the Lucy sales chat** — someone querying a charge is not a
lead. This URL is published to Stripe and is submitted as dispute evidence.

**Reply-as is BLOCKED on a third party:** replies should go out as `support@…` via Gmail "Send mail
as" over Resend SMTP (`smtp.resend.com`:587, user `resend`, password = Resend API key; Resend has the
ROOT domain verified). Google refuses until Nic's partner enables **Admin console → Apps → Google
Workspace → Gmail → End User Access → "Allow per-user outbound gateways"** on golddoor.io.

**`golddoor.io` is owned by Nic's PARTNER** — Nic has the inbox, not the domain/DNS. He is keeping
both domains deliberately; **do not argue for consolidating.** Still pointing at golddoor.io: the
DMARC `rua=` on goldassetmanagement.com (also still `p=none` while gam.biz is `p=reject`).

---

## 5. In-house microdeposit verification — BUILT + DEPLOYED

Tenants previously LEFT GAM: Stripe emailed them a link and they confirmed on a Stripe-hosted page.
- `GET /api/stripe/tenant/microdeposits` — is one pending + which KIND
- `POST /api/stripe/tenant/microdeposits/verify` — `{amounts:[c,c]}` or `{descriptorCode}`
- Supports BOTH Stripe styles (two sub-$1 deposits, or one 1¢ deposit whose statement descriptor
  carries a 6-digit code); the GET tells the UI which to ask for
- Ownership: the pending SetupIntent is resolved from the tenant's OWN customer, never trusted from
  the request body; Stripe's own error wording passes through (it distinguishes "wrong, try again"
  from "locked, start over")
- Does NOT flip `ach_verified` — `setup_intent.succeeded` stays the single place that happens
- `VerifyMicrodepositsCard` at the top of the tenant Payments page; old "check the email from Stripe"
  copy replaced

---

## 6. Reporting engine + T-12 — BUILT + DEPLOYED

Nic: *"we should be able to generate reports for any combination of events and timelines and tables."*

`services/reportEngine.ts` — one engine, three knobs: **any date range × portfolio|property|unit ×
total|monthly|daily**. Deliberately NOT a free-form query builder (DoS + cross-tenant reach).
`GET /reports/query`, `GET /reports/t12`. Frontend **Custom & T-12** tab (`reports.tab.custom`) with a
builder, a **Cost per unit** preset, CSV export, and a print-ready **T-12 statement** (line items
down, months across) with a GAM letterhead + diagonal watermark and a stated basis-of-preparation.
Drop `apps/landlord/public/brand/logo.png` and it appears automatically (README in that folder).

Baked in + tested: deposits are NEVER income · T-12 excludes the current partial month · only actual
repair costs, never estimates · platform fee from the real accrual and OMITTED (and stated) on daily
buckets · property scope enforced server-side · daily capped at 400 days.

**Per-unit allocation changed (Nic):** any expense not tied to a unit is now **always** split across
ALL units on the property (including vacant — they carry insurance, and dividing by occupied would
spike costs as occupancy falls). Unified in `reportEngine.ts` AND
`landlordExpenses.unitAllocatedExpenses`. The decorative `allocate_per_unit` checkbox is REMOVED from
the expense form and the bank-feed scope picker de-duplicated. **`MERCHANT_RULE_SCOPES` still carries
`property_common` + `property_allocate`, which now behave identically — retiring the duplicate needs
its own migration + backfill.**

---

## 7. Security / accuracy fixes (all tested)

- **`maintenance.ts` property-scope leak** — list, detail, and stats filtered team roles by
  `landlord_id` ALONE. A worker assigned to one property could list the ENTIRE portfolio (tenant names
  included) and read any request by id. Now uses `getScopedPropertyIds`. 3 tests.
- **Tenants were sent landlord-internal fields** — `SELECT mr.*` shipped `estimated_cost`,
  `actual_cost`, `landlord_notes`, `platform_fee`. Stripped at the RESPONSE boundary (not per-role
  SELECT lists) so a future column can't leak through the wildcard. 3 tests.
- **GAM's own margin leaked to landlords** — `/units/:id/economics` spread `calcNetPerUnit`
  (gross/cost/reserve/net-kept) into a landlord-readable payload. Admin-only now.
- **Phantom maintenance fee REMOVED** — every completed repair stamped 5% of `actual_cost`.
  **GAM charges NOTHING for maintenance** (Nic); the 5% belongs to the DEFERRED contractor-bid
  marketplace (brokering an OUTSIDE contractor), never in-house work. 0 existing rows carried it.
- **`STRIPE_CONFIG` ACH cost 0.8%/$5.00 → 0.5%/$3.00** — that was Stripe's PUBLIC list price, never
  GAM's negotiated rate.
- **Schema-generator duplication** — TWO different `dump-schema.sh` scripts produced `schema.sql`
  (one with `--no-comments`), churning ~1000 lines. Root one deleted; `npm run schema:dump` now points
  at the canonical `apps/api/scripts/dump-schema.sh`. **That script's header wrongly claims the file
  "is not executed by any tool" — `test/globalSetup.ts` rebuilds `gam_test` from it.**
- **3 test files RED since S602** — `booking_deposit_pct_steps` locked deposits to 5/10/15/20 but
  fixtures still seeded 25.

---

## 8. Agent sweep — cluster #6: 11 of 38 combed

Combed BY HAND against real code (per `gam-sweep-byhand-no-fanout`). Corrections:
- **maintenance job categories** — article named 5, code has 12 (+ empty = all)
- **"tenants never see this internal step"** — FALSE. `MaintenancePage.tsx` labels
  `awaiting_approval` as "Pending Approval" to tenants; only the NOTIFICATION is suppressed
- **eviction mode "blocks all tenant ACH payments"** — it blocks EVERY landlord-bound payment, card
  included. As written an agent would have told a landlord an evicting tenant could still pay by card
- **screening docs "locked to you and the applicant"** — permitted TEAM MEMBERS can open them too

Verified-correct, no change: fee constants · batch unit create · 24h team-invite TTL · 7-day tenant
invite · disposable-email block · on-site-manager permanence · card-fee lock · maintenance priority
sort · `> threshold` with $500 default · ID-file per-row auth · rent-roll occupied definition.

**Closed an S602 open item:** screening timers CODE-VERIFIED — decisions gated to
`['complete','submitted','processing']`, approval sets `expires_at = NOW() + INTERVAL '6 months'`.

**A suspected bug that was NOT one:** background routes scope on `req.user.profileId`, which looked
like it excluded team members. It does not — `profile_id` is a query alias
(`COALESCE(l.id, t.id, b.id)`) falling through to `scope.landlordId` for worker roles. Don't "fix"
it; that would widen access to FCRA-adjacent data.

---

## 9. ⭐ DEPOSIT INTEREST IS UNIT-TYPE SPECIFIC — the 50-state corpus DOES exist

**The 50-state landlord-tenant import is real. It is in `state_law_section_texts`** — **49,161
sections, all 50 states**, full-text indexed (`search_tsv` GIN), split by **`act_key`**. Do NOT
conclude it is missing from `state_law_provisions` (3 rows, one literally "test") or
`state_landlord_tenant_acts` (1 row) — those are scaffolding; the corpus is the section-text table.

Act keys carry the UNIT-TYPE split: `residential` (48 states), `mobile_home_park` (15),
`manufactured_home_park` (15), `rv_long_term`, `condo_coop`, `self_storage`, `eviction`, etc.

**Arizona proves deposit interest varies BY UNIT TYPE within one state:**
- `mobile_home_park` **§ 33-1431(B)** — *"The landlord shall pay **not less than five per cent annual
  interest** on any damage, security, cleaning or landscaping deposit… either pay the interest
  annually or compound the interest annually."*
- `residential` **§ 33-1321** — deposits/refunds, **no interest requirement**
- `rv_long_term` **§ 33-2121** — deposits, 14-day return, **no interest requirement**

**Oak Park is a mobile-home/RV property — this is the 5% obligation, and it compounds.**

### The gap
`state_deposit_interest_rates` is keyed **`(state_code, effective_year)`** with ONE `annual_rate_pct`.
It **cannot express** "AZ mobile home 5%, AZ apartment 0%". It also holds only **3 states and NO
Arizona row**, so today Oak Park's mobile-home deposits accrue **nothing**.
`state_landlord_tenant_acts.unit_types[]` shows the intended shape (act → unit types → rule); it was
never wired to the interest catalog. `services/depositInterest.ts:resolveRateForLandlord()` does the
state-only lookup (statutory row, then `landlord_deposit_interest_rate_overrides`).

`security_deposit_interest_accruals` ALREADY EXISTS and is well shaped — per deposit, per month,
recording state_code / rate / principal / days_held / days_in_month / interest_amount, unique on
`(security_deposit_id, accrual_month)` so accrual is idempotent. **0 rows — never run.** What it
lacks: a unit-type/act dimension, and any record of what GAM actually EARNED versus what is OWED.

### Nic's requirements for the build (S603)
- Track **per-tenant accrual regardless of account structure** — needed for a pooled FBO anyway, and
  it keeps GAM able to switch to sub-accounts later without re-deriving history.
- Track **owed vs earned separately**, so GAM can see the spread it keeps (yield above the statutory
  requirement) rather than inferring it.
- **Why Jiko's tenant-named sub-account product is dangerous** (Nic): the accounts carry an AUM fee
  split with GAM, but if the TENANT can withdraw directly, the landlord cannot claim against the
  deposit for damages — *"you're chasing down a tenant for money they're never gonna give back."*
  Any sub-account structure MUST be custodial/restricted with GAM controlling disbursement.
- **1099-INT:** if interest is earned in GAM's account and paid out unreported, it reads as GAM
  income and GAM pays tax on it. Issuing 1099-INTs moves it to the tenant. GAM Books already
  generates 1099s, so the machinery exists.

### ✅ BUILT + DEPLOYED THIS SESSION (the schema half)

Migration **`20260813120000_deposit_interest_by_unit_type.sql`**:
- `state_deposit_interest_rates` gains **`unit_types text[]`** + **`act_key`**; PK widened to
  `(state_code, effective_year, unit_types)` so a state can carry MORE THAN ONE rule.
- `unit_types = '{}'` means a BLANKET state rule. Existing MA/MD/MN rows migrated to blanket —
  behaviour identical to before.
- **AZ mobile_home @ 5.0000% seeded from the corpus** (`A.R.S. § 33-1431(B)`, act_key
  `mobile_home_park`). `rv_spot` deliberately EXCLUDED — AZ RV spaces fall under § 33-2121, which
  owes nothing.
- `act_key` ties each rate to the corpus section it was read from, so the annual refresh can
  re-read the statute instead of trusting a copied number.

`services/depositInterest.ts:resolveRateForLandlord()` now takes an **optional `unitType`** and
resolves most-specific-first: unit-type row → state blanket row → landlord override → null. Optional
so existing callers are unchanged (without it only a blanket row can match = pre-S603 behaviour).
`ResolvedRate` now carries `unit_types` + `act_key`.

**3 tests** in `s440Triplet.test.ts`, including the real Arizona shape: mobile_home → 5%, apartment →
**null**, rv_spot → **null**. That null case is the one that would have silently paid interest to
every non-mobile-home tenant in the state. 79 tests green; API rebuilt + restarted, `/health` 200.

### ⬜ STILL TO BUILD on the accrual structure (start here)
1. **Stamp the unit type / act_key on each accrual row** so a row records WHY it accrued, not just
   how much. `security_deposit_interest_accruals` already stores state_code + rate + principal +
   days_held; it has no unit-type dimension. (Table is well shaped and idempotent on
   `(security_deposit_id, accrual_month)`, but has **0 rows — the job has never run.**)
2. **Track EARNED vs OWED separately** (Nic): the table records only what is owed to the tenant.
   GAM needs actual pooled yield alongside it to see the spread it keeps — and it is the same data
   required if Jiko sub-accounts ever return.
3. **Per-unit-type research for the other 47 states** — the corpus supports it
   (`mobile_home_park` 15 states, `manufactured_home_park` 15, `rv_long_term`, `condo_coop`,
   `self_storage`). Only AZ has been read so far. Query pattern:
   `SELECT ... FROM state_law_section_texts WHERE state_code=$1 AND act_key=$2 AND search_tsv @@
   plainto_tsquery('english','deposit interest')`.

---

# ⏸ WAITING ON SOMEONE ELSE — not actionable by us, do NOT drop

These are DONE on our side and blocked on a third party. Re-check each session; the moment the
blocker clears, the remaining work is small.

**1. `support@` reply-as — blocked on Nic's developer partner.** Everything else is finished and
verified: the address receives, the route is active, Resend has the root domain verified, and the
SMTP settings are known. Google refuses the send-as until the partner enables **Admin console → Apps
→ Google Workspace → Gmail → End User Access → "Allow per-user outbound gateways"** on **golddoor.io**
(Nic has the inbox there, NOT the domain — see §4). Nic has asked him; as of end of S603 it is not
done. Until then, replies go out from Nic's personal address rather than support@.
→ When it clears: Gmail → Settings → Accounts and Import → Send mail as →
`support@goldassetmanagement.com`, "Treat as an alias" CHECKED, `smtp.resend.com`:587,
user `resend`, password = Resend API key. Gmail's confirmation code forwards to Nic already.

**2. Stripe branding — blocked on Nic's artwork.** He is designing/vectorising the logo himself.
**Do NOT auto-trace or generate a logo for him.** When it lands: Stripe Settings → Branding (icon,
logo, gold `#C9A227`, dark `#0D1014`) AND drop the same file at
`apps/landlord/public/brand/logo.png` for the T-12 letterhead — one file covers both surfaces.

**3. Deposit-trust go-live — blocked on the FBO/custodial trust account.** Code was finished in S602.
Do not take real deposits until the account exists.

---

# ▶ BUILD LIST — everything still outstanding

**1. Agent sweep cluster #6 — 27 articles left** (21 landlord, 3 sales, 6 shared). BY HAND, in order,
no fan-out. Highest value for Oak Park: real tenants + landlords will talk to these agents, and
accuracy is the standing rule. *Suggested next.*

**2. Snowbird Phase 2b — the yearly generation job.** The original S602 ask, still untouched.
`seasonal_tenancies` table + `PUT/GET/DELETE /leases/:id/seasonal` exist; the job that materializes
the spot-locked recurring reservation (resolving the cross-year window, coupling to hibernate/resume)
does NOT. Then Phase 3 (wire `is_priority` to `relocateBlockingBookings` + relocation audit log),
Phase 4 (guest-friction downgrade/auto-upgrade engine), Phase 5 payment split, Phase 6 tenant
self-service. Full per-phase status in `SNOWBIRD_SEASONAL_SPEC.md`. **Oak Park is an RV park — this
is the feature its snowbirds need.**

**3. Add-and-pay frontend — the $0.28.** Backend is DONE (`createRentPlatformCharge` sets
`setup_future_usage` on card charges). **Saves nothing until the frontend changes**: the tenant portal
still adds cards via a separate SetupIntent. Key fact — **creating a payment method is FREE**
(tokenization); only AUTHORIZATIONS cost $0.26. So collect the card inside the pay modal
(`stripe.createPaymentMethod`) and let the payment authorization save it. Do NOT do the client-secret
redesign — it opens an abandonment window after invoice rows are already split. Touches the rent
payment screen; verify in a browser.

**4. POS ↔ business customer merge (Nic wants this).** `pos_customers.landlord_id` vs
`business_customers.business_id` are DIFFERENT owner entities, so this is an ownership-model change,
not a table merge. It also reverses the standing `gam-pos-business-isolation` directive — Nic has
since said businesses using POS should share one customer base. Needs its own design pass.

**5. Seasonal & weekend PRICING** (`SEASONAL_PRICING_SPEC.md`) — per subtype, ≤2 season windows,
Fri–Sun weekend rate, precedence season > weekend > base. Design locked S602, nothing built.

**6. Owner-occupied units** (`gam-owner-occupied-units`) — add `owner_use` status: no lease, no rent,
$2 fee waived, occupied but not bookable. Not built.

**7. FlexDeposit launch scope** (`FLEXDEPOSIT_LAUNCH_SCOPE.md`) — open decisions B/C/D
(tenure/on-time gates? flat-2 vs risk-tier? gap funding source?).

**8. Deposit-trust go-live** — code DONE (S602), GATED on Nic standing up the FBO/custodial trust
account. Do not take real deposits until it exists.

**9. Smaller items:**
- Stripe **branding** once Nic's vector lands (also drop it at `apps/landlord/public/brand/logo.png`
  for the T-12 letterhead — one file covers both)
- Reply-as `support@` once the partner enables the Workspace outbound-gateway setting
- DMARC `rua=` off golddoor.io; consider `p=none` → stricter on goldassetmanagement.com
- Retire the duplicate `property_allocate` merchant-rule scope (migration + backfill)
- Fix the false header in `apps/api/scripts/dump-schema.sh` ("not executed by any tool" — gam_test is
  built from its output)
- Sale-grade T-12 export beyond CSV/print, if a formatted document is wanted
- **Orphaned manual-withdrawal endpoint**: `withdrawals.ts` is still mounted at `/api/users` with NO
  UI (Nic retired the UI in S574). A landlord who knows the address can still pull their Connect
  balance outside the weekly batch. Delete the route, or restore the button — but not the current
  in-between.

---

## MIGRATIONS APPLIED (to `gam` — the LIVE db)
- `20260812150000_card_fee_35_pct_55_flat.sql`
- `20260812160000_decline_fee_entry_description.sql`
- `20260813120000_deposit_interest_by_unit_type.sql`
- (`20260812170000_guest_payment_profiles.sql` was applied then FULLY removed — file, table, and
  `schema_migrations` row. Do not look for it. See §Guest card-on-file below.)

## GUEST CARD-ON-FILE — BUILT THEN REVERTED (do not rebuild)
Storage half was built (`guest_payment_profiles` + `setup_future_usage` on the deposit charge) then
fully reverted at Nic's direction: *"I wanna design it right, and I don't wanna do this fix just to do
something else later."* The blocker is identity — `publicPropertyBookingRouter` is fully
UNAUTHENTICATED, so a stored card can never be offered back on an email match. Guests re-type their
card every booking; that is the accepted behavior. See `gam-guest-identity-verification`, which also
records the **Sign in with Apple scope: YES for bookings/POS/business customers, NEVER for tenants.**

## DEPLOY STATE
- **API: DEPLOYED** — rebuilt + `launchctl kickstart -k gui/$(id -u)/com.gam.api`, `/health` 200.
- **KB: RE-INGESTED** — 190 chunks / 64 articles; agents quote 3.5% + $0.55.
- **TENANT + LANDLORD: DEPLOYED to production** via prebuilt upload; live on
  `tenant.goldassetmanagement.com` / `landlord.goldassetmanagement.com`.
- **MARKETING: redeployed** (launchd `com.gam.marketing`) — `/support` live.
- **Nothing committed.** 107 files in the working tree.
- ⚠️ **UI NOT VISUALLY VERIFIED** — the microdeposit card, the Custom & T-12 tab, and the T-12 print
  layout compile and build but have never been seen rendered (portals need a login). Nic tests.

## THE $1 ACH TEST (Nic runs it; nothing blocks it)
Add bank → two deposits land in 1–3 business days → confirm amounts **inside GAM** → pay.
**$1.00 rent + $6.00 flat ACH fee = $7.00 charged. Stripe takes $0.035 (0.5% of the $7.00 processed,
cap $3 not reached). GAM nets $5.965. Landlord gets $1.00.** The books will now record exactly that.

## QUICK-REF
- Restart API: `cd apps/api && npm run build && launchctl kickstart -k gui/$(id -u)/com.gam.api`
- Re-ingest KB: `cd apps/api && node -r ts-node/register src/services/agents/ingestKnowledge.ts`
- Tests: `cd apps/api && DB_NAME=gam_test npx vitest run <file>` (NEVER without `DB_NAME=gam_test`)
- Frontend deploy: `cd apps/<app> && npm run build && rm -rf .vercel/output && mkdir -p
  .vercel/output/static && cp -R dist/. .vercel/output/static/ && printf '%s'
  '{"version":3,"routes":[{"handle":"filesystem"},{"src":"/.*","dest":"/index.html"}]}' >
  .vercel/output/config.json && vercel deploy --prebuilt --prod --yes`
- Stripe audit pattern: read the key from `apps/api/.env`, `curl -u "$SK:"` — costs live on
  `/v1/balance_transactions`, NOT on `balance_transaction.fee` (always 0 on IC+).
