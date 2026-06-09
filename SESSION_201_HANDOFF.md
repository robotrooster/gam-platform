# Session 201 — closed

## Theme

B1+B2 material-change workflow phase 1 — gate the lease PATCH on
two product rules per CLAUDE.md S177:

1. **Material changes** (rent, term/dates, lease_type, auto-renew)
   on an active/signed lease → reject with 409. Tells landlord
   to draft a new lease via Tenant Onboarding.
2. **Non-material changes** (late fee, notice days, security
   deposit) on an active/signed lease → reject with 409 unless
   `confirm_addendum: true` is sent. Frontend shows a confirmation
   modal listing the changes; user confirms → re-PATCH applies.

Pending-status leases bypass both gates — landlord is finishing
a draft, edits are free.

Phase 2 (later): generate a tenant-signed PDF addendum
automatically when non-material changes are confirmed (current
phase relies on the lease updated_at + the confirmation log
implicit in the request flow). Phase 3: lease history /
addendum-record surface visible to tenant.

## What S201 shipped

### Backend — `routes/leases.ts` PATCH gating

- Schema accepts new optional `confirm_addendum: boolean`.
- Pre-UPDATE classifier compares each changed field against the
  current lease row, splits into `materialChanges` and
  `nonMaterialChanges`.
- Material fields (any change → 409 with `error: 'material_change_requires_new_lease'`):
  - `rent_amount`, `start_date`, `end_date`, `lease_type`,
    `auto_renew`, `auto_renew_mode`
- Non-material fields (require `confirm_addendum` → 409 with
  `error: 'addendum_confirmation_required'`):
  - `late_fee_grace_days`, `late_fee_initial_amount`,
    `notice_days_required`, `expiration_notice_days`,
    `security_deposit` (compared against the live lease_fees row
    per S196)
- Workflow fields bypass the gate entirely:
  - `status`, `terminationReason`, `needsReview`
- Gate only applies when `lease.status` is `'active'` or
  `'pending_signature'`. Pending-not-yet-signed leases edit
  freely.

Both 409 responses include a `changes: [{ field, from, to }]`
array so the frontend can render the diff to the user.

### Frontend — `LeaseFormModal` confirmation overlay

- `updateMut` `onError` inspects the response: when status=409 +
  `error='material_change_requires_new_lease'` or
  `error='addendum_confirmation_required'`, it captures the
  change list and the original payload into a `pendingConfirm`
  state object. Other errors continue to populate `submitError`.
- New overlay renders on top of the existing modal when
  `pendingConfirm` is set:
  - **Material** variant: title "New lease required", message
    from server, change diff, single "Use Tenant Onboarding"
    button (disabled — informational; user closes and navigates
    elsewhere).
  - **Addendum** variant: title "Addendum confirmation",
    message, change diff, "Confirm — record addendum" button
    that retries `updateMut` with `{ ...originalPayload, confirm_addendum: true }`.
- Cancel button on both variants closes the overlay without
  applying.

### Files touched (S201)

```
apps/api/src/routes/leases.ts                                           (PATCH: + confirm_addendum schema field, change classifier, material-change 409, addendum-confirm 409)
apps/landlord/src/pages/LeaseFormModal.tsx                              (+ pendingConfirm state, onError dispatch, confirmation overlay with material/addendum variants)
```

### Verification

- `cd apps/api && npx tsc --noEmit` → 0
- `cd apps/landlord && npx tsc --noEmit` → 0
- No schema migrations
- No tenant changes (gate is landlord-side only)

## Decisions made (S201)

| Question | Decision |
|---|---|
| Block material changes outright vs let them through with a stronger confirmation? | Block. CLAUDE.md S177 is explicit: "material changes — rent, roommates, term — require new lease + new signatures." A confirm-and-apply path would silently bypass the new-signature requirement. The 409 with "use Tenant Onboarding" is the locked posture. |
| Pending-status free edits — is `'pending_signature'` the right umbrella? | Yes. The gate is "lease is signed and live." Per LEASE_STATUSES, signed-lease statuses are `active` (per CLAUDE.md S18) and arguably `pending_signature` is in-between. Conservative: gate both `active` and `pending_signature`. Not gated: `pending`, `expired`, `terminated`, `voided`. |
| Material gate covers `auto_renew` + `auto_renew_mode` — not in CLAUDE.md's list? | Yes, included. CLAUDE.md says "term" is material; auto-renew terms ARE part of the lease term (when does it end? does it extend?). Treating them as material errs on the side of "this is a real lease change." Conservative. |
| Roommate changes — gate them here? | Out of scope. Roommates are managed through `lease_tenants` / addendum_add / addendum_remove flows in `routes/esign.ts`, not via PATCH. Per CLAUDE.md they're material; the existing addendum_add / addendum_remove flow IS the new-lease equivalent (creates a signed addendum doc with full party signatures). Already in place. |
| Audit-trail emission — credit-ledger `lease_addendum_recorded` event? | Deferred to phase 2. Adding the event type is small but the scoring product call (does an addendum amend signal anything about the tenant?) is open. The lease updated_at + the request-log implicit in the workflow are enough audit for phase 1. |
| Auto-generate a PDF addendum doc on confirm? | Deferred. The existing `addendum_terms` esign flow exists but requires templateId + signers + field bindings. Auto-generation needs a "blank addendum" template + a programmatic field-binding system. Multi-session work. Phase 1 ships the gate; phase 2 wires the doc auto-generation. |
| Diff format — show old → new values? | Yes. The 409 response includes `changes: [{ field, from, to }]` so the user sees concretely what they're confirming. Field names use the snake_case backend keys (e.g. `late_fee_grace_days`); a future polish could humanize them ("Late fee grace days"). |

## Carry-forward

### B1+B2 thread — phase 2

- **Auto-generate PDF addendum** on `confirm_addendum: true`
  paths. Use the existing `addendum_terms` esign infrastructure
  (`esignRouter.post('/documents/addendum-terms')`). Requires a
  blank addendum template + programmatic field binding for "old
  value → new value" rendering. Multi-session.
- **`lease_addendum_recorded` credit-ledger event type** — adds
  audit trail to the tenant's credit subject. Half-session.
- **Tenant-side addendum visibility** — when an addendum is
  recorded, surface "Your lease was amended on YYYY-MM-DD"
  notification + a list view on the tenant LeasePage. Half-
  session, depends on the credit-ledger emission above.
- **Field-name humanization** in the confirmation diff —
  `late_fee_grace_days` → "Late fee grace days". Quarter-session.

### Already-known carry-forward (unchanged)

- C1 50-state property tax form catalog (multi-session)
- Sublease phase 3 (sub-tenant billing + invite-by-email)
- POS Terminal hardware + EOD
- A3 thread continuations (small, mostly diminishing returns)
- Primary manager urgency tier (S185 — needs Nic input)
- Owner-financial-escalation pattern (S186 — needs Nic input)
- Other POS tables for property scoping (S192 carry)
- B3 hard-gate check-in (product fork)
- D2 Flex tenant suite (launch-flag gated)
- CSV imports (vendor format specs)
- E2 npm upgrades (risky)
- F1 Marketing rebuild

---

End of S201 handoff.
