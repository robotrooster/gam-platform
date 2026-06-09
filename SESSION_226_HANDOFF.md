# Session 226 — closed

## Theme

Property + lease late-fee surface completion. The 5 unused
columns flagged in S223 + S224 carry-forward
(`late_fee_accrual_amount/type/period`,
`late_fee_cap_amount/type`) now have full UI on both surfaces,
backend route acceptance with cross-field validation, addendum-
diff support, and property-default seeding into create-mode
lease forms.

## Recon finding (correction to S225 carry-forward)

S225 handoff speculated that "a backend billing consumer that
actually applies accrual and respects cap when generating
late-fee invoices … is the one that may be missing entirely."
**That speculation was wrong.** `apps/api/src/jobs/lateFees.ts`
(S26b) already exists and:

- Reads `late_fee_accrual_*` and `late_fee_cap_*` directly from
  `leases`.
- Supports flat / percent_of_rent for both initial and accrual.
- Honors daily / weekly / monthly accrual periods.
- Implements cap-edge-partial logic (writes a partial row of
  exactly the remaining amount, then stops accruing — locked
  S26b decision).
- Idempotent via `ux_payments_late_fee_idempotent` partial unique
  index.
- Registered per-tz cron at midnight local (`0,10,20,30,40,50 0 * * *`).

The engine reads from leases only — never from properties. So
property-level columns are **defaults-for-new-leases only**,
exactly the same pattern as the four fields S223 + S224 covered.
Pure additive work.

## What S226 shipped

### Backend — `apps/api/src/routes/leases.ts` (PATCH `/:id`)

Zod schema extended with 5 new fields, all `nullable().optional()`:
- `lateFeeAccrualAmount`, `lateFeeAccrualType`, `lateFeeAccrualPeriod`
- `lateFeeCapAmount`, `lateFeeCapType`

Addendum-diff comparator gains 5 entries, all in the
**non-material** bucket (consistent with the rest of the late-fee
fields). Triggers the standard S201/S202 confirmation flow → PDF
generation → credit-ledger event emission.

SQL field map gains 5 new entries. Because the route uses a
dynamic field map (not COALESCE), `null` correctly clears the
columns and `undefined` (omitted key) preserves.

Cross-field validation added: post-patch final state of the
accrual triple must be all-set or all-null (same for cap pair).
A 400 fires if a half-configuration is attempted — guards against
silently-dead accrual config (the lateFees engine returns early
when any of the triple is null, so the invalid config would be
silently ignored otherwise).

### Backend — `apps/api/src/routes/properties.ts` (PATCH `/:id`)

5 new fields parsed off `req.body` (raw, not zod — matches the
existing route convention). Per-field type validation throws 400
on invalid input.

The properties PATCH route uses COALESCE everywhere, which can't
distinguish "preserve" from "clear" for nullable columns. I added
a **separate dynamic UPDATE** that runs after the existing one,
covering only the 5 new fields. Same all-or-nothing post-state
validation as leases. This avoids touching the COALESCE behavior
of the existing route — the 4 fields S223 added still preserve
on null (because they're NOT NULL DEFAULT, so the "clear"
semantic doesn't apply to them anyway).

### Shared — `packages/shared/src/index.ts`

`ADDENDUM_DIFF_FIELD_LABEL` extended with 5 new entries.

`ADDENDUM_DIFF_MONEY_FIELDS` extended with `late_fee_accrual_amount`
and `late_fee_cap_amount` so the diff overlay + addendum PDF
format them as money.

`formatAddendumDiffValue` extended:
- Refactored the existing `late_fee_initial_type` branch into a
  `LATE_FEE_TYPE_FIELDS` set covering all three flat/percent
  fields (initial, accrual, cap).
- Added a branch for `late_fee_accrual_period` →
  Daily / Weekly / Monthly humanization.

### Frontend — `apps/landlord/src/pages/PropertiesPage.tsx`

7 new form-state keys (5 columns + 2 UI-only `_enabled` toggles).
Hydrated from property; toggles reflect "all required columns
non-null."

Two new sections inside the existing Late-fee policy block:
- **Recurring accrual** — toggle + 3-input grid (amount / type /
  period). Disabled when parent `late_fee_enabled` is off
  (accrual without a parent fee makes no sense).
- **Maximum cap** — toggle + 2-input grid (amount / type).
  Independent of accrual.

Submit handler: when toggle is on, sends the parsed group; when
off, sends `null` for every column in the group.

### Frontend — `apps/landlord/src/pages/LeaseFormModal.tsx`

Same 7-key state extension. Hydration from `existingLease` in
edit mode. **Property-default seeding extended** to also seed
accrual + cap when the property has them set (Q2 = (a) per S226
scope).

`matchesPropertyAccrual` and `matchesPropertyCap` derived hint
helpers compute group-level `(from property)` indicators —
shown next to the toggle when the toggle state AND every
sub-field matches the property; vanishes the moment any one is
overridden (consistent with S224's per-field hint logic).

Same UI layout as PropertiesPage (toggle + conditional grid).
Wired into the PATCH payload — accrual/cap columns get nulled
when toggle is off.

`FIELD_LABEL` map (used by the in-modal addendum confirmation
overlay) extended with 5 new entries.

### Files touched (S226)

```
apps/api/src/routes/leases.ts                        (+ 5 zod fields, + 5 diff comparators, + 5 SQL field-map entries, + cross-field validation)
apps/api/src/routes/properties.ts                    (+ 5 raw body parses, + per-field validation, + separate dynamic UPDATE for accrual/cap with all-or-nothing post-state check)
packages/shared/src/index.ts                         (+ 5 label entries, + 2 money-field entries, + LATE_FEE_TYPE_FIELDS set refactor, + accrual_period humanization)
apps/landlord/src/pages/PropertiesPage.tsx           (+ 7 form-state keys, + accrual UI block, + cap UI block, + submit-handler null-on-off, + hydration)
apps/landlord/src/pages/LeaseFormModal.tsx           (+ 7 form-state keys, + property-default seeding extension, + 2 group-level hint helpers, + accrual UI block, + cap UI block, + FIELD_LABEL entries, + PATCH payload wiring, + edit-mode hydration)
```

### Verification

- `cd packages/shared && npm run build` → clean
- `cd apps/api && npx tsc --noEmit` → clean
- `cd apps/landlord && npx tsc --noEmit` → clean
- No new migrations
- Backend already consumes the columns (lateFees.ts), so end-to-end
  flow works first time: landlord enables accrual on the property
  → seeds into a new lease → late-fee cron picks it up → child
  rows generated honoring accrual + cap.

## Decisions made (S226)

| Question | Decision |
|---|---|
| Accrual + cap optionality UX: explicit toggles or empty-input-means-off? | **Explicit toggles** (Q1=(a)). A landlord who clears the accrual amount during an edit shouldn't accidentally disable the whole accrual rule. The toggle makes the on/off intent explicit. |
| Property defaults seed accrual + cap into create-mode lease too? | **Yes** (Q2=(a)). Full parity with the 4 initial fields S224 wired. The "(from property)" group-level hint shows the landlord exactly what's seeded; they can override. |
| Materiality of the 5 new fields in the S201 addendum gate? | **Non-material**, consistent with the rest of the late-fee surface. Triggers addendum confirmation + PDF + credit event, doesn't block as material. |
| Back-end cross-field validation: all-or-nothing for the accrual triple + cap pair? | **Yes, enforced at the route boundary on both leases and properties.** A half-configured accrual rule (e.g., amount set but type null) would otherwise be silently ignored by the lateFees engine — exactly the silent-misconfig bug worth blocking at write time. The error is a 400 with a human message. |
| Properties PATCH refactor (move all fields to dynamic, drop COALESCE)? | **No.** The new 5 fields needed null-as-clear semantics, the existing 4 (NOT NULL DEFAULT) didn't. A targeted second UPDATE for accrual/cap was less invasive than rewriting the whole route. |
| Disable accrual + cap toggles when parent `late_fee_enabled` is off? | **Yes, both UIs.** Visual: opacity 0.4. Functional: `disabled` on the input. Toggling the parent off doesn't blow away the values (they sit dormant); flipping it back on restores the previous accrual/cap state. |
| UI grouping: nested under the parent late-fee block, or top-level Late Fees section? | **Nested.** Both surfaces already had a "Late Fees" section header; accrual + cap are sub-policies within the same domain. Keeps the form scannable and the disabled-when-parent-off relationship visually obvious. |

## Carry-forward — S227+

### POS thread polish (carries forward)

`pos_items.category` should become `pos_categories.id` FK with
`(landlord_id, name)` UNIQUE on `pos_categories`. Schema migration
+ POS routes update + admin UI. Independent of all lease work.

### Already-known carry-forward (unchanged)

- Wire `pos_tax_rates` → cart math (S217 carry — needs
  product call on stacking + override semantics)
- Sublease phase 3 (multi-session greenfield)
- Stripe Connect S113 rebuild (multi-session)
- DEFERRED.md "Build sessions" tombstone trim (mechanical
  hygiene, full session)
- 4 npm audit vulns (deferred to dedicated upgrade sessions)
- Platform-specific CSV import mappings
- Tenant-pool picker + unit picker with consent rule
- End-to-end /resolve smoke
- Landlord disbursement engine that nets tenant-owed deposit
  interest from monthly payouts (separate from the lease-end
  netting which IS wired)
- Primary manager urgency tier (S185 — needs Nic input)
- Owner-financial-escalation pattern (S186 — needs Nic input)
- D2 Flex tenant suite (launch-flag gated)
- F1 Marketing rebuild
- POS Terminal hardware

---

End of S226 handoff.
