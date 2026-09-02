# SESSION 634 HANDOFF — The account is not an entity (S633 delivered)

## THE ONE JOB, AND IT IS DONE

Nic (DIRECTIVE, verbatim):

> "Account ownership is no correlation to a specific entity. Entities own
> properties. The account owns the entities. When I'm logged into my account, I
> can invite any fucking person to any fucking property I own without switching a
> goddamn thing." And: "I don't want it to say fucking Oak Park ID when I sign
> into my login."

**A landlord session no longer names an entity.** `profileId` is `null` for
role=landlord, minted that way at login AND at registration. `landlordIds` — every
company the account owns, refreshed from the database on every request — is the
whole of a landlord's identity.

## THE TWO RULES THAT REPLACED IT

Every landlord call site is now one of these:

- **READS span every company the account owns** → `landlordScopeIds(user)` +
  `WHERE landlord_id = ANY($n::uuid[])`
- **WRITES take an explicit target, authorised** → `resolveLandlordTarget()`
  (names a company; silent when the account owns one, a 400 asking which when it
  owns several) or `landlordIdForProperty()` / `landlordIdForUnit()` (derives it
  from the property or unit the request already names — nothing for the caller to
  get wrong)

All three live in `apps/api/src/lib/landlordScope.ts` with the reasoning.

## WHY IT WAS DONE BY BREAKING THINGS ON PURPOSE

`AuthPayload.profileId` was retyped `string | null`. That is what made the
compiler name ~106 landlord-scoping sites instead of letting each one quietly
filter on `undefined` and return an empty list — the exact failure mode that made
the meters at Nic's own park come back with zero rows and no error.

The compiler could NOT see inside `any[]` query params, so those were swept by
hand and then by the test suite. **`resolveLandlordIdForUser` was deleted, not
made to return null**, so every caller had to be visited.

## WHAT THIS FIXED, CONCRETELY

- **The Mountain View invites.** `POST /landlords/me/onboard-tenant-pending` read
  the session's company and answered "unitId does not belong to this landlord"
  for a unit Nic owns. The company now comes from the UNIT. Pinned by
  `routes/accountEntitySeparation.test.ts`.
- **`GET /landlords/me`** returned one arbitrary company's details. Now takes
  `?landlordId=`, with a picker in Settings.
- **Portal theme moved off the company onto the ACCOUNT** (`users.theme_accent`
  / `font_style`). It is chrome for a person, not an asset of an LLC — and
  selling the company would have taken the theme with it.
- **`first_billing_cycle` moved from entity to PROPERTY** (finishing the
  half-applied S632 work). `PATCH /properties/:id/first-billing-cycle`. The old
  Settings card also read a field `/me/entities` never returned, so every row
  rendered blank no matter what was saved.
- **A tenant could resolve a landlord scope.** `landlordScopeIds` fell back to
  `profileId` for any unrecognised role — and a tenant's profileId is their
  `tenants.id`, which then read as "this account owns exactly one company".
  Caught by the terminal suite. Fixed with an explicit team-role list.
- **`maintenance_worker` is not a role** (it is `maintenance`). A test claiming to
  prove team-role authorization was using a role string the system does not have,
  and only passed because of that same fallback.

## MIGRATIONS APPLIED TO PRODUCTION

`gam` had FIVE pending migrations — three from earlier sessions that had never
been run. Backup taken first: `~/gam-backups/gam-pre-S633-20260901-135615.dump`.

- `20260831100000_admin_invitations.sql`
- `20260831110000_platform_owner_lock.sql` ← `isPlatformOwner()` was querying a
  table that did not exist and silently answering "not the owner"
- `20260901120000_propane_markup_and_true_cost.sql`
- `20260901140000_property_first_billing_cycle.sql`
- `20260901160000_account_level_portal_theme.sql` (new this session)

## TEST STATE

**Full API suite green: 384 files, 6,706 tests, 0 failures.**

`routes/accountEntitySeparation.test.ts` is new and pins all three halves at
once: the session carries no entity; one session reaches BOTH companies; a
stranger's property is still refused.

Also fixed **8 pre-existing red tests** that predate this session — stale
assertions left behind by HEAD's own directive commits:

- `MANUAL_PAYMENT_FEE = 0` ("cash is FREE", S630) — `bankDepositConfirm` still
  expected a $10 fee billed to the tenant
- "a subtype classifies a space, it never prices one" (S630) — 7 tests across
  `unitSubtypeLink`, `s414-hygiene`, `s537-late-fee-consistency` still expected a
  class to price a unit

## DEPLOYED — ALL SURFACES LIVE

`bash deploy.sh` — API restarted (launchd com.gam.api, answering 200 locally and
at api.goldassetmanagement.com), landlord portal live on `index-DbnJlV_1.js`,
marketing verified byte-identical, tenant/admin/pm-company already in sync.

Ran with `--skip-tests` because the full suite had just been run green in the
same session (384 files / 6,706 tests / 0 failures) — the banner the script
prints in that mode is not accurate here.

## THE AGENTS MATCH THE SCOPE TOO (done)

All 43 landlord-audience tools now read `actorLandlordIds(actor)` with
`landlord_id = ANY($n::uuid[])`. **`AgentActor.profileId` is EMPTY for a
landlord** — the compatibility shim is gone, so a tool that still reached for it
scopes to nothing and is visible rather than quietly answering for one company.

Nic caught the other half of it: *"If the tenant scope had a role that showed
that they owned exactly one company, the agent is gonna reference that somewhere
in the back end too."* It did, in four places outside the tools:

- **`logInteraction.ts`** stamped `actor.profileId` as the interaction's
  `landlord_id`, so every landlord conversation was filed under one company. Now
  attributed only when the account owns exactly one, null otherwise — the same
  shape the tenant branch already used.
- **`portalDispatch.ts`** resolved a spoken "spot 7" against one company, so a
  landlord naming a unit at their other park got "I could not confirm which one
  that is."
- **`turnBudget.ts`** sized the per-unit turn allowance from one company's
  occupied units — half the allowance for an account that owns two.
- **`marketRent.ts`** excluded one company from the market comparison, so an
  account that owns two parks was compared against half of itself.

Writes take the company from the ROW they concern (the request's, the unit's,
the lease's, the check's, the property's) — never from session state. Three
things genuinely need ONE company and now ask for it by name: **profit-and-loss,
bank reconciliation, and a portfolio-level expense** (separate books, separate
bank, separate return). See `tools/companyScope.ts`.

Agent suites: 61 files / 1,446 tests green.

## ALSO SHIPPED THIS SESSION (unrelated hotfix, LIVE)

**Typed birthday field on the lease-signing modal.** An applicant on Chrome for
Android could not reach his birth year — `<input type="date">` opens the Material
calendar, which starts at today and pages by MONTH. Every GAM lease template
carries `Birthdate 1..4` as a date field. Replaced with three numeric boxes
(`components/TypedDateInput.tsx`). Live at `tenant.goldassetmanagement.com`,
bundle `index-BZUDZoYD.js`, verified on the served file.

**Deploy trap worth knowing:** `npm run build` writes `dist/`, but
`vercel deploy --prebuilt` uploads `.vercel/output/`. Skipping `vercel build --prod`
between them ships the PREVIOUS bundle and reports success. Saved to memory.

## WHAT THE NEXT SESSION SHOULD TARGET

1. **POS multi-company UI.** `posLandlordId()` asks which register when an account
   owns several; the POS UI has no picker yet, so such an account gets a clear
   400 rather than a mis-filed sale. Single-company merchants are unaffected.
4. Nic still owes a decision on whether `users.active_landlord_id` should be
   dropped outright — nothing reads it as identity any more.

## DO NOT

- Do not reintroduce a "current entity" anywhere. There is no active company.
- Do not bring back `resolveLandlordIdForUser`. `lib/scope.ts` says why.
- Do not let `profileId` mean a company for a landlord again.

## S634 LATE ADDITIONS (both shipped)

### The utility warning that cried wolf

Nic, the day RV 02 and RV 03's leases were signed: *"the system is detecting that
leases are not billed back for utilities... I clicked to bill back anyway, and it
said it wasn't gonna start until the next bill."*

**Both units were billing correctly.** Two pieces of code read the same fact
opposite ways:

- the billing engine (`tenantOwesUtility`) follows the standing directive — an
  absent lease clause is SILENCE, and the meter/unit setup decides who pays
- the meter list (`units_not_billing`) treated an absent clause as "bills
  nothing"

RV 02 had no utility rows on its lease at all; RV 03 none for trash. Both were
billing fine off submeter/RUBS/flat-rate meters. Checked against production: with
the corrected rule, **not one unit on the platform is actually blocked** — the
warning was false everywhere it appeared.

A unit now warns only when the lease EXPLICITLY says the tenant is not
responsible, or the meter is `master_bill_to_landlord`. Three tests pin it.

### Bill-back releases held charges immediately

`POST /utility/meters/:id/bill-back` used to affect only the next cycle, which
silently wrote off usage already metered and parked in
`suspended_utility_charges`. It now releases those onto the lease at once, dated
to the cycle the usage happened in, and the UI reports the amount instead of
saying "starts on the next invoice".

RV 02 and RV 03's August charges were already released on signature and sit as
`unbilled` utility_bills ($176.40 + $217.35 electric, $25 trash each). The
invoice sweep takes prior-cycle stragglers, so they land on the next invoice.

### users.active_landlord_id is DROPPED

Nic: *"Remove the landlord ID column so it doesn't creep its way back in
accidentally."* Migration `20260901180000_drop_active_landlord_id.sql`. Backup at
`~/gam-backups/gam-pre-drop-activelandlord-20260901-161038.dump`.

Removed first: the login query no longer joins `landlords` at all, `/auth/me`
resolves the account's companies through `landlord_members` UNION founding
ownership, and both remaining writes (create-entity, accept-co-owner-invite) are
gone — each only ever set which entity to sit on.

**A bug this surfaced:** the first `/auth/me` rewrite joined `landlord_members`
alone. One production account owns a company with no membership row (it predates
that table) and would have been handed `business_name` NULL and
`onboarding_complete` FALSE — i.e. an established landlord sent back to the
signup wizard. The UNION is why that does not happen.

Final: **384 files / 6,710 tests green**, all surfaces deployed, prod API 200.

## S634 — UTILITIES, WORK TRADE, AND THE EXPLAINABLE BALANCE (all shipped)

### The transaction-visibility bug behind BOTH of Nic's symptoms

`generateMoveInInvoice` read the lease and the work-trade agreement with
`queryOne` — a SEPARATE pool connection — while `routes/esign.ts` held an open
transaction. At READ COMMITTED it could not see the caller's uncommitted rows, so
it decided the invoice from a stale picture. The file already documented this
exact hazard for `lease_fees`; the fix had never reached these two reads.

On RV 03 it did two things at once:
- missed `is_existing_tenancy = TRUE`, so a tenancy papered 31 August was treated
  as a new move-in and billed ONE DAY of proration — the $14.19 Nic asked about
- missed the work-trade agreement created moments earlier in the same
  transaction (S631 put it there *deliberately* so the first invoice would be
  exempt), so the invoice was never stamped and never `late_fee_exempt`

Both reads now use the caller's connection.

### A work-trade month is suspended, not owed

Nic (DIRECTIVE): *"Nobody is gonna pay rent that month and then work hours for the
following month. There's no arrears arrangement here."* And: *"Have the work trade
exist, but be suspended... and it creates only at the month close."*

The month-close arithmetic already matched him (`services/workTradeSettlement.ts`,
built on his worked examples). What did not was the month IN PROGRESS: the rent
line was written `pending` on day one and counted as outstanding while the tenant
worked it off.

`payments.work_trade_suspended_at` (migration `20260901190000`) marks a line that
exists but is not owed — excluded from `invoices.total_amount` and therefore from
every balance surface. Month close clears it, leaving 0 (hours met) or the lapse.

**Also fixed:** only the monthly run ever opened a `work_trade_settlements`
period, so a work-trade tenancy that began with a signed lease had nothing for
month close to settle — the hours were logged and never reconciled. The move-in
path opens it now.

### Utilities ride the first invoice

The move-in invoice never swept `utility_bills`, and the monthly run deliberately
skips a lease's whole START MONTH. A lease starting 1 September had its August
utilities appear no earlier than October — released, correct in every table, and
absent from the only document the tenant is asked to pay.

### Outstanding balances are clickable

`GET /api/balances/:tenantId/invoices` returns every open invoice with its lines
AND each line's note — the meter reads, the cycle a late utility belongs to. That
note is the sentence a landlord repeats to a resident at the counter. Rows on the
Balances page expand to show it.

### Suspension follows `covered_charges`, per agreement

Nic: *"work trade should be including the utilities, or at least have utilities
be toggleable in the work trade... Landlords are gonna want that per agreement
with specific people. My agreement with RV 03 is that it's including utilities
too."*

Which charges a trade covers was ALREADY a per-agreement choice
(`work_trade_agreements.covered_charges`, with a Covers control already on the
Work Trade page). What the suspension did not do was read it — only rent was
suspended, so a tenant whose trade covers electricity still had the electricity
sitting as money owed while they worked it off.

Now every line the agreement covers is suspended; an uncovered one is ordinary
money due. `subtotal_*` still records what the month was WORTH; `total_amount` is
what is OWED. The settlement basis is everything covered, not rent alone — the
period open moved to AFTER the utility sweep so the utilities' value is known
when the hours are priced.

### Backfilled, because the code only fixes NEW invoices

- **RV 02** — $641.40 owed: rent $440 + Electric $176.40 + Trash $25.00, itemised.
- **RV 03** — **$0.00 owed.** Rent corrected to the full cycle $440, invoice moved
  to the 2026-09-01 cycle, stamped with the agreement and `late_fee_exempt`; rent,
  Electric $217.35 and Trash $25.00 all suspended per its `covered_charges`.
  Settlement period open: 40 hours against a $682.35 basis — $17.06 an hour.

### One pre-existing bug found on the way

`services/moveOutInspections.ts` compared a UTC "today" against a Postgres
`CURRENT_DATE` window. In Phoenix those disagree from 5pm, so for seven hours
every evening it scheduled move-out inspections a day early. It showed up as a
suite that passed in the afternoon and failed after 17:00. Both halves now read
the same clock.

**Final: 385 files / 6,720 tests green, all surfaces deployed, prod API 200.**
