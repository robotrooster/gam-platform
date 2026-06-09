# Session 210 — closed

## Theme

S202 carry — tenant-side LeasePage addendum-history section.
Pivots off the catalog work (S205–S209). Bounded frontend addition
that surfaces lease amendments directly on the tenant's lease view.

## What S210 shipped

### Backend — GET /api/tenants/lease/addendums

`apps/api/src/routes/tenants.ts`:

- New endpoint, requireAuth gated like the other tenant endpoints.
- Resolves the requesting tenant + their active/pending lease, then
  queries `credit_events` joined to `credit_subjects` for events of
  type `lease_addendum_recorded` scoped to (tenant_id, lease_id).
- Returns `{ id, occurred_at, changes }[]` ordered by occurred_at
  desc. `changes` is the diff payload from S202's emit
  (`event_data->'changes'`), shape `{ field, from, to }[]`.
- Empty result (no tenant, no active lease, or no addendums) returns
  `success: true, data: []` — the frontend renders nothing.

The /credit page already shows lease_addendum_recorded events but
runs them through `redactEvent()` which strips event_data. This
endpoint is the surface where the tenant sees WHAT actually changed
in each addendum, scoped to their current lease.

### Frontend — AddendumHistorySection in LeasePage

`apps/tenant/src/pages/LeasePage.tsx`:

- New component `AddendumHistorySection` rendered conditionally on
  `fullyExecuted && lease.id`, between the signature audit trail
  and the SubleaseSection.
- Uses react-query (`tenant-lease-addendums` key) to fetch the
  endpoint.
- Renders nothing while loading or when the array is empty (no
  empty state — addendums are rare, the section shouldn't add
  visual clutter when there's nothing to show).
- Each addendum row: date + time, then a grid of changes. Each
  change shows humanized field label + monospace from-value →
  gold to-value.
- Field-label map covers the five non-material fields the leases
  PATCH endpoint can change: late_fee_grace_days,
  late_fee_initial_amount, notice_days_required,
  expiration_notice_days, security_deposit. Unknown field names
  fall back to the raw snake_case for forward-compat as the diff
  set grows.
- Money fields (late_fee_initial_amount, security_deposit) format
  as `$X,XXX.XX`; day fields render as raw numbers (label suffix
  carries the unit).

### Files touched (S210)

```
apps/api/src/routes/tenants.ts                                 (+ /lease/addendums endpoint)
apps/tenant/src/pages/LeasePage.tsx                            (+ AddendumHistorySection component + render hook)
```

### Verification

- `cd apps/api && npx tsc --noEmit` → clean
- `cd apps/tenant && npx tsc --noEmit` → clean
- `psql gam -c "SELECT COUNT(*) FROM credit_events WHERE event_type='lease_addendum_recorded'"` → 0
  (pre-launch — no activity. Endpoint returns empty array, section
  renders nothing as designed.)
- No new migrations.

## Decisions made (S210)

| Question | Decision |
|---|---|
| New endpoint or extend `/credit/subject/own`? | New endpoint. `/credit/subject/own` redacts `event_data` for visibility/dispute reasons; un-redacting it generally would leak event payloads across event types. Scoping a tenant-lease-specific endpoint to the requesting tenant + their current lease is tighter and doesn't touch the credit-ledger redaction posture. |
| Filter by lease_id at SQL or fetch all and filter client? | SQL. `event_data->>'lease_id' = $2` keeps the response scoped to the tenant's current lease. Cleaner network payload + leaves room for the tenant to have prior-lease addendum events that don't need to render here. |
| Show empty state ("No amendments on file")? | No. Most tenants will never have an addendum; an empty card adds clutter. Section renders nothing when empty. Matches how SubleaseSection behaves for tenants without subleases. |
| Resolve `recorded_by_user_id` to a name? | Not in v1. The S202 emit captures the field for audit but resolving to a user name needs an extra join + decision about which name (landlord owner vs. PM acting under scope). The half-session scope keeps the diff visible without that. |
| Show superseded addendums? | No. `superseded_by IS NULL` filter at the SQL level. If an addendum is superseded (corrected via /admin/disputes event-replacement), the corrected version is what the tenant should see. |
| Order ascending or descending by date? | Descending. Most-recent first matches the rest of the lease page's reverse-chronological surfaces (renewal banner, etc.). |
| Render currency formatting in the diff? | Yes for security_deposit and late_fee_initial_amount. Snake-case money rendered as raw integers ("500" → "500") looked wrong next to the gold-emphasis "to" value. `$500.00` reads as money. |
| Include the addendum-history surface for non-active leases (pending, expired)? | Active + pending only (matches /lease endpoint filter). Expired leases drop off the LeasePage entirely; addendum history for those would belong on a future tenancy-history surface. |

## Carry-forward — S211+

### B1+B2 thread — phase 2B (still deferred)

- **Auto-generate PDF addendum** on `confirm_addendum: true`.
  Uses the existing `addendum_terms` esign infrastructure
  (`POST /api/esign/documents/addendum-terms`). Needs a "blank
  addendum" template + programmatic field-binding so the change
  list renders into the PDF. Multi-session.

### Catalog — lower priority remaining work

- Smaller-population unverified states (~5% remaining US pop):
  OK, AR, IA, KS, MS, NM, ID, NH, NE, ND, ME, RI, MT, DE, HI,
  WV, VT, CT, LA, SC, DC, KY, UT.
- Cadence-variable forms (would need a `cadence_variants`
  jsonb structure): OH IT-501, MD MW506, IN WH-1, WI WT-6, CO
  DR 1094.
- NV MBT — needs threshold-gating product surface.
- Second-pass: MN annual W/H recon, MA M-3, VA VA-5, PA REV-1667.

### Already-known carry-forward (unchanged)

- B1+B2 phase 2B (PDF addendum auto-generation, multi-session)
- Sublease phase 3 (sub-tenant billing + invite-by-email)
- POS Terminal hardware
- A3 polish (mostly diminishing returns)
- Primary manager urgency tier (S185 — needs Nic input)
- Owner-financial-escalation pattern (S186 — needs Nic input)
- Other POS tables for property scoping (S192 carry)
- B3 hard-gate check-in (product fork)
- D2 Flex tenant suite (launch-flag gated)
- CSV imports (vendor format specs)
- E2 npm upgrades (risky)
- F1 Marketing rebuild

---

End of S210 handoff.
