# Session 211 — closed

## Theme

Landlord-side LeaseFormModal addendum-history parity. Mirrors S210's
tenant-side surface from the other side of the trust boundary. The
landlord who recorded the addendum can now see WHAT they recorded
after the fact — previously only available via the redacted /credit
event row.

## What S211 shipped

### Backend — GET /api/leases/:id/addendums

`apps/api/src/routes/leases.ts`:

- Landlord-scoped read of addendum events recorded against a specific
  lease. Auth gate via `canAccessLandlordResource(req.user,
  lease.landlord_id)` — owner / admin / PM-with-scope all admitted.
- SQL deduplicates the per-tenant emit (S202 fires one credit_event
  per active tenant per change set) by GROUP BY on
  `event_data->'changes'` + `date_trunc('minute', occurred_at)`. A
  2-tenant lease with one addendum renders as one row, with
  `tenant_ids` array carrying both subject refs for attribution.
- Returns `{ id, occurred_at, changes, tenant_ids, recorded_by_user_id }[]`
  ordered by occurred_at desc.
- Mounted at the natural per-lease path; mirrors the existing
  `GET /api/leases/:id` auth pattern.

### Frontend — AddendumHistorySection in LeaseFormModal

`apps/landlord/src/pages/LeaseFormModal.tsx`:

- New component rendered conditionally on `isEdit && leaseId`,
  inserted between the legal-disclaimer copy and submitError block
  in the modal body.
- Same field-label map and money-field formatting as the tenant
  surface (S210 parity), so the diff render reads identically on
  both sides.
- Each row shows date + time + tenant-count attribution
  ("· N tenants on record") — landlord-side specifically gets the
  tenant-count signal so they can cross-reference against
  multi-tenant leases.
- Renders nothing when no addendums exist (matches S210 behavior —
  empty card adds clutter for the common case).
- React-query key `['lease-addendums', leaseId]` is per-lease so
  invalidation is bounded if a future flow needs to refresh after
  recording a new addendum.

### Files touched (S211)

```
apps/api/src/routes/leases.ts                                   (+ /:id/addendums endpoint)
apps/landlord/src/pages/LeaseFormModal.tsx                      (+ AddendumHistorySection component + render hook)
```

### Verification

- `cd apps/api && npx tsc --noEmit` → clean
- `cd apps/landlord && npx tsc --noEmit` → clean
- SQL sanity: query against zero-row state returns empty result
  cleanly (verified via psql against dev DB)
- No new migrations.

## Decisions made (S211)

| Question | Decision |
|---|---|
| Per-lease endpoint or extend `/leases/:id` payload? | Per-lease endpoint. The lease record is already a fat payload; addendums are a lazily-loaded secondary surface (only viewed when editing). Separate endpoint keeps the main lease GET light + lets react-query cache the two independently. |
| Dedupe per-tenant events at SQL or frontend? | SQL. The per-tenant duplication is a backend implementation detail of the credit-ledger model (subject-keyed); the landlord surface is per-lease, so the dedup belongs server-side. Frontend gets a clean shape it can render directly. |
| Dedup key — minute-truncated timestamp or exact match? | Minute-truncated. The S202 emit loop fires per-tenant in sequence with `new Date()` per call, so timestamps differ by microseconds. Same-content addendums recorded in the same minute also merge — acceptable (same diff in same minute is effectively the same edit). |
| Surface inside LeaseFormModal or on LeasesPage row? | LeaseFormModal. Landlords already open the modal to edit; addendum history is most relevant when they're about to record another one. Adding it to LeasesPage rows would clutter the list view. |
| Show tenant_ids as names or IDs? | Count only ("N tenants on record"). Resolving to names needs an extra join (tenants → users → first_name/last_name) and could cross trust boundaries on multi-landlord historical leases. Count carries the multi-tenant signal without the resolution cost. |
| Show `recorded_by_user_id`? | Selected in the SQL but not rendered in v1. Would need user-name resolution + ambiguity decision (owner vs PM-acting-under-scope). Half-session scope mirrored S210; defer to a future polish pass if useful. |
| Show superseded addendums? | No. `ev.superseded_by IS NULL` filter mirrors S210. Corrected addendums (via /admin/disputes event-replacement) show only the corrected version. |
| What about addendums from prior tenants on the same lease (lease_id matches but the tenant has been removed)? | Included. The query joins by `event_data->>'lease_id'` regardless of current `lease_tenants.status`. Historic addendums are part of the lease's record. |

## Carry-forward — S212+

### Addendum thread polish

- Resolve `recorded_by_user_id` to a display name (landlord owner
  vs. PM acting under scope). Ambiguity decision needed: do we show
  "Recorded by Jane (PM)" with role attribution? Half-session.
- Render addendum history on the LANDLORD-side LeasePage / per-lease
  detail surface (currently no such page exists — LeaseFormModal is
  the only per-lease landlord view). If a per-lease detail page
  ships in the future, this section moves there.
- Tenant-name resolution for `tenant_ids` in the landlord view
  (matches the same naming question as recorded_by).

### B1+B2 thread — phase 2B (still deferred)

- **Auto-generate PDF addendum** on `confirm_addendum: true`.
  Uses the existing `addendum_terms` esign infrastructure
  (`POST /api/esign/documents/addendum-terms`). Needs a "blank
  addendum" template + programmatic field-binding so the change
  list renders into the PDF. Multi-session.

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
- Catalog small-pop states (~5% remaining US population)

---

End of S211 handoff.
