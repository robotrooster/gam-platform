# Session 312 — closed

## Theme

Landed the **(c1) structural fix** discussed at the start of the
session: a one-way snake_case → camelCase response transformer
applied via axios interceptor in every portal's API client, with
JSONB-passthrough rules protecting free-form / external-vendor
columns (audit_log snapshots, Checkr report payloads, notification
metadata, permissions records, etc.).

This ends the recurring camelCase-vs-snake_case drift that
surfaced repeatedly in S309 → S310 → S311. Going forward,
frontend code reads API responses as camelCase, the API returns
raw snake_case from Postgres, and the transformer bridges them
at the single axios boundary in each portal.

## Items shipped

### S312 — Shared transformer

**`packages/shared/src/camelize.ts`** (new) — exports:
- `snakeToCamel(s)` — string-level conversion helper.
- `camelizeKeys(obj)` — recursive key-transform on plain objects
  and arrays. Skips the value of any "passthrough" key (see
  list below). Other JS object types (Date, Map, etc.) pass
  through unchanged.
- `applyCamelizeInterceptor(api)` — axios response interceptor.
  Detects the standard GAM success wrapper (`{ success, data,
  message }`) and transforms only the inner `data` payload;
  endpoints that don't follow the wrapper get whole-body
  transform. Wrapper keys themselves (`success`, `data`,
  `message`) are single-word and unaffected.

Passthrough rules:
- Exact key set: `metadata`, `context`, `old_value`, `new_value`,
  `report_summary`, `risk_flags`, `risk_factors`,
  `income_document_urls`, `event_data`, `attestation_evidence`,
  `external_attestation`, `dimension_scores`, plus the six
  `credit_stats` JSONB columns, `definition` (credit_score_formulas),
  `column_headers`, `sample_rows`, `extraction_extras`,
  `import_extra_data`, `parser_flags`, `parser_output`,
  `evidence`, `signature_evidence`, `permissions`,
  `damage_lines`, `other_deductions`, `data`, `payload`,
  `scope_ref`, `scope_payload`, `items`, `due_dates`,
  `gam_supersedence_breakdown`.
- Suffix patterns: `_data`, `_metadata`, `_payload`, `_evidence`,
  `_attestation`, `_breakdown`, `_value`, `_stats`. Covers
  aliased columns like `disputed_event_data` (alias of
  `credit_events.event_data` in the admin dispute-detail route).

The KEY is always camelized (no-op for single-word passthroughs);
only the VALUE is kept verbatim for passthrough keys.

Re-exported via `packages/shared/src/index.ts`.

### S312 — Interceptor wiring (8 portals)

Each portal's API client picks up the transformer via
`applyCamelizeInterceptor(api)`:

- `apps/tenant/src/lib/api.ts` — main client
- `apps/tenant/src/main.tsx` — separate inline client used by
  the `get` / `post` helpers
- `apps/landlord/src/lib/api.ts`
- `apps/admin/src/main.tsx` (inline axios)
- `apps/admin-ops/src/main.tsx` (inline)
- `apps/property-intel/src/main.tsx` (inline; points at the
  separate `PROP_API` on 4001)
- `apps/books/src/main.tsx` (inline)
- `apps/pos/src/lib/api.ts`
- `apps/pm-company/src/lib/api.ts`
- `apps/listings/src/main.tsx` (bare `axios.get`/`axios.post`
  — interceptor registered on the global axios default
  instance)

### S312 — Codebase rewrites to match the new posture

**Reverts of S309–S311 snake_case workarounds** (those reads
were stopgaps for the broken pre-transformer state — the
transformer now provides the camelCase posture they were
designed against):

- `apps/landlord/src/pages/PropertiesPage.tsx`:
  property-read accesses returned to camelCase (`property?.allocationRule?.achFeePayer`,
  `property?.requiresBookingAcknowledgment`, `lateFee*`, etc.).
  Form-state KEYS remain snake_case because the PATCH body
  expects them that way. Updated comment to reflect the new
  posture.
- `apps/landlord/src/pages/FlexChargePage.tsx`: Property
  interface renamed `flexcharge_enabled: boolean` →
  `flexchargeEnabled: boolean`; filter call updated.
- `apps/landlord/src/pages/SchedulePage.tsx`: booking ack
  reads returned to camelCase + comment updated to note
  the still-latent backend gap (bookings GET doesn't JOIN
  properties).
- `apps/tenant/src/main.tsx`: HomePage + ServicesPage reads
  back to camelCase across all `me?.X` accesses.
- `apps/tenant/src/pages/ProfilePage.tsx`: form-init reads
  back to camelCase.
- `apps/tenant/src/pages/MaintenancePage.tsx`: `me.unitId`
  read restored.

**Bulk camelCase conversion** (script
`/tmp/camelize_reads.py`, kept ephemeral) across the
remaining portals — the script camelizes every `.snake_case`
property-read access where the parent isn't local form state:

- `apps/admin/src/main.tsx` — 172 reads
- `apps/admin-ops/src/main.tsx` — 73 reads
- `apps/property-intel/src/main.tsx` — 94 reads
- `apps/books/src/main.tsx` — 11 reads
- `apps/listings/src/main.tsx` — 21 reads
- `apps/tenant/src/main.tsx` — 74 (additional, outside the S311
  reverts already done by hand)
- 13 landlord page files — ~245 reads combined
- **Total: 653 property-read conversions across 18 files.**

**Bulk interface/type-key conversion** (script
`/tmp/camelize_interfaces.py`, kept ephemeral) across the
same files — converts snake_case keys inside `interface X { }`
and `type X = { ... }` bodies to camelCase, tracking brace
depth to avoid touching object literals elsewhere. Handles
both line-separated style (`first_name: string\n`) and
semicolon-packed style (`first_name:string;last_name:string`).

- **170 interface key conversions across 12 files.**

**Manual fix-ups for inline types** that aren't `interface X`
or `type X` declarations (e.g., `useQuery<{ ... }>` parameters):

- `apps/landlord/src/pages/DepositReturnPage.tsx` — object-
  literal keys constructing `DepositReturnState` flipped from
  snake_case to camelCase.
- `apps/landlord/src/pages/DisbursementsPage.tsx` — inline
  `useQuery<{...}>` type with `property_id` / `pm_company_*`
  fields.
- `apps/landlord/src/pages/NewInspectionPage.tsx` — `Unit` /
  `Lease` type aliases.
- `apps/landlord/src/pages/PropertyDetailPage.tsx` — inline
  fee-plan type.
- `apps/landlord/src/pages/TeamPage.tsx` — inline Stripe
  Connect status type.
- `apps/landlord/src/pages/TenantScreeningPage.tsx` — inline
  Map value type.
- `apps/landlord/src/pages/BankingPage.tsx` — inline Stripe
  Connect status type, plus three `statusQ.data?.X` reads.
  (BankingPage was skipped by the bulk pass because it has
  form-state `form.snake_case` accesses that should NOT be
  converted.)

## Files touched

```
packages/shared/src/
  camelize.ts                                  (NEW)
  index.ts                                     (re-export)

apps/tenant/src/
  lib/api.ts                                   (interceptor)
  main.tsx                                     (interceptor + reverts + bulk)
  pages/ProfilePage.tsx                        (reverts)
  pages/MaintenancePage.tsx                    (revert)

apps/landlord/src/
  lib/api.ts                                   (interceptor)
  pages/PropertiesPage.tsx                     (reverts; bulk-skipped due to form-state)
  pages/FlexChargePage.tsx                     (revert)
  pages/SchedulePage.tsx                       (revert)
  pages/BankingPage.tsx                        (manual; bulk-skipped)
  pages/BookingsPage.tsx                       (bulk + interface)
  pages/DepositReturnPage.tsx                  (bulk + interface + object-literal)
  pages/DisbursementsPage.tsx                  (bulk + inline-type)
  pages/LeaseTerminationPage.tsx               (bulk + interface)
  pages/NewInspectionPage.tsx                  (bulk + type aliases)
  pages/PropertyDetailPage.tsx                 (bulk + interface + inline-type)
  pages/PropertyFeeScheduleSection.tsx         (bulk + interface)
  pages/SettingsPage.tsx                       (bulk + interface)
  pages/SubleasesPage.tsx                      (bulk + interface)
  pages/TeamPage.tsx                           (bulk + interface + inline-type)
  pages/TenantOnboardingPage.tsx               (bulk)
  pages/TenantScreeningPage.tsx                (bulk + interface + inline-type)

apps/admin/src/main.tsx                        (interceptor + bulk + interfaces)
apps/admin-ops/src/main.tsx                    (interceptor + bulk + interfaces)
apps/property-intel/src/main.tsx               (interceptor + bulk + interfaces)
apps/books/src/main.tsx                        (interceptor + bulk)
apps/listings/src/main.tsx                     (interceptor + bulk)
apps/pos/src/lib/api.ts                        (interceptor only)
apps/pm-company/src/lib/api.ts                 (interceptor only)

SESSION_312_HANDOFF.md                         (this file)
```

No backend changes, no migrations, no schema work.

## Decisions made during build

| Question | Decision |
|---|---|
| Where does the transformer live? | **`packages/shared`.** Tenant + admin + books + listings already import from `@gam/shared`. Adding the helper there means each portal gets the same JSONB passthrough rules; future maintenance is one-place. Used a structural `any` parameter type for the api argument to avoid taking a hard dependency on the axios types in shared. |
| Wrapper detection — by `data` key or `success` key? | **`success` key.** Some endpoints legitimately return objects with a `data` field meaning something else (e.g., a wrapped response inside a wrapped response, or an entity with a JSONB `data` column at top level). Detecting by `success` is unambiguous. |
| JSONB passthrough — explicit list, suffix patterns, or both? | **Both.** Explicit list covers the named JSONB columns I enumerated from the schema. Suffix patterns (`_data`, `_metadata`, `_payload`, `_evidence`, `_attestation`, `_breakdown`, `_value`, `_stats`) catch aliased columns like `disputed_event_data` and any future JSONB additions that follow the naming convention. |
| Bulk conversion via script — safe for files with form state? | **No — skipped for PropertiesPage and BankingPage.** Both files have `form.snake_case` accesses where the form-state keys intentionally match the PATCH body shape. The `.snake_case` regex can't distinguish API-response reads from local-state reads, so those two files were handled manually for the API-read portions; form-state keys were left intact. |
| Convert interface/type keys in addition to property reads? | **Yes.** After the property-read bulk, every interface declaring response shape with snake_case keys produced "Property 'X' does not exist" errors. Second-pass script converts keys inside `interface X { }` and `type X = { }` blocks via brace-depth tracking. Inline `useQuery<{ ... }>` types not caught by the script were fixed manually. |
| Listings — `axios` direct calls or migrate to an `api` instance? | **Register on global `axios` default.** Listings only has two bare `axios.get`/`axios.post` calls. Wrapping them or creating a new api instance was more code than just registering on the default axios global. Single-line change. |

## Verification

- `npx tsc --noEmit` clean on all 10 surfaces:
  `admin / admin-ops / tenant / landlord / books / property-intel / listings / pm-company / pos / api` — every count is 0.
- The transformer logic is contained to a single helper file
  in shared. No backend changes; API response shape on the
  wire is unchanged.
- Scripts (`/tmp/camelize_reads.py`, `/tmp/camelize_interfaces.py`)
  printed match counts in preflight before applying.

## Carryover bugs surfaced during recon (not in scope)

1. **Bookings GET doesn't join properties.** Same finding as
   S311. The SchedulePage ack badge still won't render until
   `apps/api/src/routes/units.ts:286` is widened to JOIN
   properties and surface `requires_booking_acknowledgment`
   on each booking row.

2. **Form-state shape vs PATCH body shape inconsistency.** The
   landlord PropertiesPage form intentionally uses snake_case
   keys to match the PATCH body the backend accepts. The body
   itself could be camelCase if the backend accepted both
   shapes — which it generally does (the tenants/profile route
   accepts `themeAccent` camelCase, for example). Standardizing
   request body posture on camelCase would let the form state
   match the response state, eliminating one more axis of
   case-related drift. Not in scope for S312; flag for future.

3. **JSONB-passthrough coverage might miss columns.** The
   explicit list was derived from the current schema, plus
   suffix patterns for aliased forms. New JSONB columns added
   in the future need to be either auto-caught by an existing
   suffix or explicitly added to the set. The suffix patterns
   are deliberately broad (`_data`, `_metadata`, etc.) to
   reduce maintenance burden, but a new column with a
   non-conventional name would slip through.

## Items deferred (cross-session docket, unchanged)

- Consumer-side retention framing decision (S300).
- Campground Master import path (Nic-blocked on sample).
- 2FA fan-out (walkthrough-blocked).
- Yardi GL-export columns, Rentec template (S293).
- Stats tile on admin Overview (S295/S296).
- PII redaction in admin list (S295).
- Per-platform notes / review history display (S296).
- Email notification deep links (S298).
- FlexCharge Business Account Agreement signature capture
  (S309 option B).
- FlexDeposit eligibility-check workflow (S309 option C).
- Standalone POS-operator auth (S309 option D).
- Deposit-return ↔ unpaid-installment offset architecture
  call (S310 carryover).
- Bookings GET → properties JOIN for ack badge.
- SchedulePage booking-vs-lease shape audit (mostly closed
  by S312's bulk pass, but `booking.startDate` /
  `booking.checkIn` rendering logic still needs a walk-through
  to confirm the calendar correctly distinguishes leases from
  bookings).

## Nic-pending (unchanged)

- Stripe live keys.
- Resend domain verification.
- Plaid production keys.
- Stripe Terminal hardware.
- Checkr Partner credentials.
- Consumer-side retention framing decision (S300).
- FlexCredit Lender partner selection.
- SLA § 9.1.4(iii) deposit-return offset framing call.

## What S313 should target

Three viable directions:

**A. Browser walk through the camelize-affected surfaces** —
*recommended primary.* Type-clean ≠ behavior-clean. Worth a
walk through the highest-value pages (PropertiesPage edit,
DepositReturnPage finalize, admin csv-import detail, tenant
ServicesPage / dashboard, landlord BankingPage Stripe Connect
status, FlexChargePage create-account flow) to confirm the
transformer didn't surface any regression. Browser-side, not
type-side. Nic-driven.

**B. Bookings GET → properties JOIN for ack badge** —
bounded backend fix. Half-session. Activates the
SchedulePage ack badge that's been latent since S200.

**C. Standardize request-body shape on camelCase** — extend
the API layer to accept camelCase request bodies universally,
then convert frontend form state from snake_case to camelCase
to match. Removes one more axis of case-related drift across
the codebase. Estimated 1-2 sessions.

**D. FlexCharge Business Account Agreement signature capture**
— direct continuation of S308 thread, deferred since S309.

Recommend **A** — the (c1) work landed substantial mechanical
change and the only honest validation is to see the affected
pages render correctly with real data.

---

End of S312 handoff. Closed clean. Context at handoff point
per CLAUDE.md guidance — start S313 fresh.
