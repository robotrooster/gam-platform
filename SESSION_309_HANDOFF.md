# Session 309 — closed

## Theme

Two-part session continuing the FlexCharge thread from S308:

**Part 1 — FlexCharge framing correction (legal layer).** The
template originally scoped at S307 was framed around "Landlord
extends credit." Nic corrected: FlexCharge is tied to account
owners who run POS, which can be a Landlord OR a standalone
POS operator. Widened the framing across the new template and
both ToS sections.

**Part 2 — Wired the per-Location enablement gate (code
layer).** The legal layer (Consumer ToS § 9.3, Business ToS
§ 11, FlexCharge Business Account Agreement § 3) all said
FlexCharge is enabled per Location at the Business Account
Owner's discretion. The code had no such gate — any property
under any landlord could be picked at account creation. S309
made the gate real: migration + service guard + property
settings toggle + landlord-portal create-flow filter.

## Items shipped

### S308 — FlexCharge framing correction + new template

- **`legal/FLEXCHARGE_BUSINESS_ACCOUNT_AGREEMENT.md`** (new,
  459 lines) — three-party template: Business Account Owner
  (creditor, may be Landlord or standalone POS operator) +
  Account Holder (Tenant or POS Customer) + GAM (software-only
  acknowledgment). Per-Location enablement is baked in (§ 3 +
  § 10). Includes optional ACH auto-pay (§ 6) with GAM-First
  Routing acknowledgment, default/collection carve-out (§ 7)
  confirming GAM Collections Partner doesn't engage on
  FlexCharge balances, and a TILA-style disclosure table (§ 5)
  for the Business Account Owner to fill in.
- **`legal/CONSUMER_TERMS_OF_SERVICE.md`** — § 9.3 rewritten
  around "Business Account Owner" with Tenant/POS Customer
  status framing + per-Location enablement disclosure; § 5.6
  Collections carve-out cross-referenced; § 9.5 cancellation
  pointer widened; preamble § 2 ref renamed to "FlexCharge
  Business Account Agreement."
- **`legal/BUSINESS_TERMS_OF_SERVICE.md`** — § 11 rewritten
  and retitled "Business-Account-Owner-Extended Credit
  (FlexCharge)"; per-Location enablement disclosed in section
  preamble; § 11.2 picks up state retail-installment law as a
  parallel framework to consumer-credit law for POS-Customer
  cases; § 11.3 codifies the Collections-Partner-not-engaged
  carve-out; § 22 survival list updated.
- **`legal/CONSUMER_PRIVACY_POLICY.md`** — FlexCharge data-
  categories bullet widened to "Business Account Owner."
- **`CLAUDE.md`** — FlexCharge product-line entry rewritten
  to reflect Business Account Owner framing, the per-Location
  enablement principle, the schema-already-supports-both-cases
  note, the still-aspirational standalone-POS-operator auth,
  and the new template path.
- **Memory:** `project_flexcharge_per_location.md` saved —
  captures the per-Location enablement rule, why it exists,
  and how to apply it across product/code/legal layers.

### S309 — FlexCharge per-Location gate wiring

- **`apps/api/src/db/migrations/20260518120000_properties_flexcharge_enabled.sql`**
  — adds `properties.flexcharge_enabled BOOLEAN NOT NULL
  DEFAULT FALSE` + comment. Backfill: `flexcharge_enabled =
  TRUE` for properties that already have at least one
  `flex_charge_accounts` row (dev seed has 0; production
  backfill on launch will pick up real accounts if any exist).
  Applied; `schema.sql` regenerated.
- **`apps/api/src/services/flexCharge.ts`**
  `createFlexChargeAccount` — fetch widened to include
  `flexcharge_enabled`; throws 403 with explanatory message
  after the landlord-ownership check. Existing accounts
  (read/write balance, statements, transactions) continue to
  function — the gate is on creation only.
- **`apps/api/src/routes/properties.ts`** PATCH — accepts
  `flexcharge_enabled` boolean via the existing COALESCE
  pattern next to `subleasing_allowed`.
- **`apps/landlord/src/pages/PropertiesPage.tsx`** — toggle
  card with creditor-responsibility copy (TILA/ECOA/FCRA/state
  lending-law reminder, pointer to FlexCharge Business Account
  Agreement). Styled parallel to the subleasing toggle.
- **`apps/landlord/src/pages/FlexChargePage.tsx`** —
  `enabledProperties = properties.filter(p =>
  p.flexcharge_enabled)`; "New Account" button disabled with
  tooltip + page-level banner when zero properties enabled;
  CreateAccountModal receives `enabledProperties` instead of
  the full set. Filter chips and existing-account table
  retain the full property list so accounts on now-disabled
  properties remain visible/manageable.

## Files touched (S309)

```
legal/                                         (S308 — framing pass)
  FLEXCHARGE_BUSINESS_ACCOUNT_AGREEMENT.md     (NEW; 459 lines)
  CONSUMER_TERMS_OF_SERVICE.md                 (§ 2, § 9.3, § 9.5)
  BUSINESS_TERMS_OF_SERVICE.md                 (§ 11, § 22 survival)
  CONSUMER_PRIVACY_POLICY.md                   (FlexCharge data bullet)

apps/api/src/                                  (S309 — gate wiring)
  db/migrations/20260518120000_properties_flexcharge_enabled.sql  (NEW)
  db/schema.sql                                (auto-regenerated)
  services/flexCharge.ts                       (createFlexChargeAccount guard)
  routes/properties.ts                         (PATCH accepts flag)

apps/landlord/src/                             (S309 — UI)
  pages/PropertiesPage.tsx                     (form state + toggle card)
  pages/FlexChargePage.tsx                     (Property iface, filter, button gate)

CLAUDE.md                                      (FlexCharge entry rewrite)

~/.claude/projects/.../memory/
  project_flexcharge_per_location.md           (NEW)
  MEMORY.md                                    (index entry added)

SESSION_309_HANDOFF.md                         (this file)
```

No items deleted from `DEFERRED.md`. The FlexCharge
Business Account Agreement template was S307-deferred — not
on DEFERRED.md's tracked list.

## Decisions made during build

| Question | Decision |
|---|---|
| Who is the creditor on FlexCharge? | **Business Account Owner**, not Landlord-specifically. Could be a Landlord OR a standalone POS operator. Nic correction at the start of S308. |
| One unified template or two (landlord-flavored + POS-flavored)? | **One template.** The legal mechanics are identical; placeholder for Account Holder Status (Tenant vs. POS Customer) handles the variance. |
| Rewrite both ToS sections in the same session as the template? | **Yes.** The "Landlord is the creditor" framing in ToS would have created CLAUDE.md drift against the wider template. |
| Standalone POS-operator account — concrete today or aspirational? | **Aspirational.** Schema for `flex_charge_accounts` already supports `tenant_id XOR pos_customer_id` (so the customer side is built); POS portal auth still piggybacks on landlord users (operator side is not). The legal layer is forward-compatible; auth widening is a separate session. |
| Per-Location gate default — opt-in (FALSE) or opt-out (TRUE)? | **FALSE / opt-in.** Mirrors the FlexSuite portal-separation principle: landlords who don't offer FlexCharge at a property should not have its surfaces exposed by default. Also the safer pre-launch posture. |
| Backfill existing properties to TRUE? | **Only those with existing `flex_charge_accounts` rows.** Properties without prior FlexCharge use stay at FALSE. Dev seed has zero matching properties (expected). |
| Gate creation only, or gate viewing/management too? | **Creation only.** Existing accounts continue to function in full — read balance, post charges, accept payments, generate statements. The gate is at `createFlexChargeAccount`. |
| Filter property dropdown vs label-disabled-but-show? | **Filter.** Properties without enablement get hidden from CreateAccountModal entirely. When zero are enabled, the New Account button disables with a banner pointing to property settings. |

## Verification

- `psql gam` confirms `properties.flexcharge_enabled BOOLEAN
  NOT NULL DEFAULT FALSE` landed; backfill produced 0 enabled
  (dev seed has no existing FlexCharge accounts — expected).
- `npx tsc --noEmit` clean on `apps/api` and `apps/landlord`
  (both 0 errors).
- `grep "flexcharge_enabled" apps/` — wired in 6 source
  locations + migration + schema.sql comment + memory file.
  No orphaned references.
- `grep "Landlord is the creditor"` across legal + CLAUDE.md
  — 0 hits. Old framing fully replaced.

## Items deferred — what S310 could target

Five candidate angles, plus one adjacent quality fix that
could ride along with any of them.

### A. OTP exclusion enforcement (RECOMMENDED — symmetry to S309)

**Why this is the strongest pick:** S309 just closed the
parallel "legal says X, code doesn't enforce X" gap on the
FlexCharge side. The same gap exists on the FlexDeposit /
OTP side and has been carrying since S304. Consumer ToS
§ 9.1.4(i) and FlexDeposit SLA § 7 promise service-tier
exclusion (OTP gate, restricted FlexSuite enrollment,
deposit-refund offset) when an Account Holder's installment
schedule goes delinquent — but no code enforces it today.

**Scope (estimated one focused session):**
- Schema: `tenants.flex_deposit_service_tier` or equivalent
  status column. Inspect existing `flex_charge_disqualified_*`
  columns (S309 recon found these on tenants) and decide
  whether to mirror that pattern or generalize to a single
  service-tier enum.
- Backend: nightly job (or trigger off the FlexDeposit
  installment-pull cron) that flips the status when an
  installment fails past N retries / pull date. Middleware
  or route guard on OTP-enrollment endpoint that rejects
  when service-tier is restricted.
- Tenant portal UI: lockout copy on the OTP page when blocked,
  with clear "bring FlexDeposit current to restore OTP" CTA.
- Verify the deposit-refund-offset path picks up the
  service-tier signal at lease end (this may already exist
  in `services/depositReturn.ts` from S180 — recon needed).

**Recon needed first:** trace where OTP enrollment lives in
the tenant portal + API. Find any existing service-tier or
disqualification columns on `tenants`. Identify the
FlexDeposit installment-failure detection path.

### B. FlexCharge enrollment signature capture

**Why:** S308 shipped the template. There's no route or UI
yet to present the populated agreement to the Account Holder
and Business Account Owner and capture both e-signatures at
account creation. Today `createFlexChargeAccount` skips
straight to writing the row. The legal layer is in place
but the audit-trail evidence isn't being captured.

**Scope (estimated one focused session):**
- New e-sign flow modeled on FlexDeposit SLA signing (S307
  shipped that pattern). Recon `services/esign.ts` (or
  wherever the FlexDeposit signature capture lives) for the
  reusable bits.
- Variable-substitution layer: the template has 25+
  `{{Placeholder}}` slots — they need to be populated from
  the FlexCharge account row + Business Account Owner config
  + Account Holder profile.
- New route: `POST /api/landlords/flex-charge/accounts`
  (currently service-level only) wraps the
  signature-capture flow before calling
  `createFlexChargeAccount`.
- Audit table for FlexCharge signature events (or extend
  the existing e-sign audit table if one exists — recon).
- Both-party signature UX: typically the Business Account
  Owner pre-signs the configured template (a "template
  signature") and the Account Holder counter-signs at
  enrollment. Confirm with Nic.

### C. FlexDeposit eligibility-check workflow

**Why:** Carryover from S304/S307. Larger product surface
area than A or B. Consumer Privacy Policy § 2.1 already
says "FlexDeposit eligibility is determined from your
existing Platform account data (e.g., your tenancy record,
payment history on the Platform, and active-lease status)"
— but no actual eligibility check runs. Today FlexDeposit
just lets anyone with an active lease enroll.

**Scope (estimated two focused sessions; spans product +
code):**
- Product decision: what signals qualify? Tenancy length,
  Platform payment history (count of on-time vs. late),
  active-lease status, screening outcome, prior FlexDeposit
  defaults across landlords. Ask Nic to rank.
- Algorithm: scoring or rule-based? Probably rule-based to
  keep it explainable (the SLA-not-loan framing requires
  this is NOT a credit decision; rule-based is easier to
  defend as a service-tier qualification rather than
  underwriting).
- Backend: new service `services/flexDepositEligibility.ts`
  that takes a tenant + lease and returns
  `{ eligible: bool, reasons: string[], computed_at: Date }`.
- Tenant portal UI: "Check FlexDeposit eligibility" page;
  surfaces the reasons-array when ineligible without
  exposing the algorithm internals.
- Audit: persist each eligibility check for the
  recharacterization-defense paper trail.

### D. Standalone POS-operator auth

**Why:** The legal layer (S308) is forward-compatible with
standalone POS operators. The auth side is still
landlord-only — POS portal uses `req.user!.profileId` as
the landlord_id. Until this lands, the Business Account
Owner is always-a-Landlord in practice; the legal
flexibility doesn't translate to a real product surface.

**Scope (estimated three focused sessions; biggest of the
five):**
- Schema decision: new `pos_operators` entity, or extend
  `users` with a `pos_operator` role and a parallel
  ownership chain to `pos_items` / `pos_categories`?
- Onboarding flow: POS portal signup that doesn't require
  property ownership. Stripe Connect account for the
  operator (separate from landlord Connect rail).
- POS-side surfaces: items / categories / customers / sales
  / settlements need an alternative ownership FK that
  doesn't go through `landlord_id`.
- FlexCharge wiring: `flex_charge_accounts.landlord_id`
  becomes a misnomer; either rename to `business_owner_id`
  (big migration) or add a parallel `pos_operator_id` (XOR
  with landlord_id, same pattern as customer_xor on the
  same table).

### E. Smoke walk the FlexCharge gate

Not proposed per CLAUDE.md. If Nic wants visual validation
of the S309 wiring, he'll initiate.

### Adjacent quality fix (could prefix any session)

**PropertiesPage broken `requiresBookingAcknowledgment` /
`subleasingAllowed` reads.** Discovered during S309 recon:
the property edit form reads
`property?.requiresBookingAcknowledgment ?? false` and
`property?.subleasingAllowed ?? false` (camelCase), but
the `GET /properties` response returns raw `p.*` with
snake_case columns. Result: the form always shows OFF
regardless of the DB value, and re-saving the property
silently overrides whatever was previously TRUE because
the spread sends `subleasing_allowed: false` back to the
PATCH. Two-line fix per field (`p?.subleasing_allowed
?? false`). Probably more such patterns hiding in the
file. Could be a 15-min warmup at the start of any larger
session, or its own micro-session.

## Items deferred (cross-session docket, unchanged)

- Consumer-side retention framing decision (S300).
- Campground Master import path (Nic-blocked on sample).
- 2FA fan-out (walkthrough-blocked).
- Yardi GL-export columns, Rentec template (S293).
- Stats tile on admin Overview (S295/S296).
- PII redaction in admin list (S295).
- Per-platform notes / review history display (S296).
- Email notification deep links (S298).

## Nic-pending (unchanged)

- Stripe live keys.
- Resend domain verification.
- Plaid production keys.
- Stripe Terminal hardware.
- Checkr Partner credentials.
- Consumer-side retention framing decision (S300).
- FlexCredit Lender partner selection (blocks the FlexCredit
  third-party referral disclosure).
- Confirm "Business Account Owner pre-signs template, Account
  Holder counter-signs" model for option B if pursued.

## What S310 should target

**Recommended primary:** Option A (OTP exclusion
enforcement). Strongest reasons:
1. Closes the symmetric "legal says X, code doesn't enforce
   X" gap on FlexDeposit — exact same pattern S309 just
   closed for FlexCharge.
2. Two-session carryover (S304 → S307 → S309) means it's
   the longest-standing underwired item.
3. Bounded scope (one focused session).
4. Unblocks the broader FlexDeposit launch posture: the
   SLA-not-loan structural defense relies on the
   service-tier consequences being real, not aspirational.

**Recommended secondary if A feels too code-heavy:** Option
B (FlexCharge signature capture) — direct continuation of
the S308/S309 legal-then-code thread.

**Defer:** Options C, D as larger/needs-more-product-input.

---

End of S309 handoff. Closed clean. Context at handoff point
per CLAUDE.md guidance — start S310 fresh.
