# Session 225 — closed

## Theme

Close out S224's "Add Lease button is dead — POST /api/leases
doesn't exist" carry-forward. The cleanest fix was to remove the
broken entry point and route landlords to the working
`/tenant-onboarding` flow (e-sign, the actual canonical lease-
creation path).

## What S225 shipped

### Frontend — `apps/landlord/src/pages/LeasesPage.tsx`

- Replaced the `<button onClick={openCreate}>Add Lease</button>`
  with a `<Link to="/tenant-onboarding">Start Tenant Onboarding</Link>`
  styled as a `btn btn-primary`.
- Icon swapped from `Plus` to `UserPlus` (the action shifted
  from "add row" to "start a person flow").
- Removed the now-unused `openCreate` handler.
- `Link` added to the `react-router-dom` import.
- The edit flow (row-click + `?open=<leaseId>` deep link) is
  unchanged — still opens `LeaseFormModal` in edit mode.

### Frontend — `apps/landlord/src/pages/LeaseFormModal.tsx`

Added a top-level comment explaining that the modal is now
edit-only because the create entry point was removed in S225,
and pointing to the dormant create-mode branches that survive
in case a future session wires up `POST /api/leases`. No code
deleted — the dormant branches (`createMut`, `!isEdit` submit
path, `availableUnits` filter, `preselected*` props,
`seededForPropertyRef` create-mode seed effect) are kept.

### Files touched (S225)

```
apps/landlord/src/pages/LeasesPage.tsx       (entry-point swap, removed openCreate, icon + Link import)
apps/landlord/src/pages/LeaseFormModal.tsx   (header comment only — dormant create-mode branches kept)
DEFERRED.md                                  (tombstoned the property late-fee modal item + the Add Lease item)
```

### Verification

- `cd apps/landlord && npx tsc --noEmit` → clean
- No backend changes
- No new migrations

## Decisions made (S225)

| Question | Decision |
|---|---|
| Replace the broken button or build POST /api/leases? | Replace. The product currently has no scenario where direct-create-without-onboarding is needed (CSV import covers bulk migration; e-sign covers new tenants; lease parser covers paste-text). Adding a backend POST + new transactional INSERTs into 3+ tables for a hypothetical future use case is over-engineering. |
| Delete the dormant create-mode code in LeaseFormModal, or keep with a comment? | Keep. Total surface area to delete is large (props, conditional branches, validation paths, a dedicated mutation). Cost of dormancy is zero. Documented at the top of the file so future-Claude knows why the branches exist. |
| Use `<Link to=...>` or `useNavigate` programmatic navigation? | Link. It's a simple page navigation with no preflight (no permission checks, no state to capture). `<Link>` plays better with browser middle-click / cmd-click open-in-new-tab. |
| Update the DEFERRED.md "Property late-fee edit confirmation modal" entry as well? | Yes. S223 + S224 effectively closed it (Option B locked, edit surface + lease default-pull both shipped). Keeping the stale entry would re-surface as confusion. Tombstoned with one-line summary of the resolution. |

## Carry-forward — S226+

### Property accrual + cap fields (still open)

S223 + S224 deferred the 5 unused property late-fee columns
(`late_fee_accrual_amount/type/period`, `late_fee_cap_amount/type`).
LeaseFormModal doesn't expose these either, so per S223's logic,
both surfaces should be wired in the same session — adding only
the property side would create config that the lease form can't
consume. Estimated: full session.

Order:
1. Extend LeaseFormModal with the 5 inputs (and matching
   `lease_fees`-style accrual/cap UI logic — accrual is
   "X per period until cap reached", which is a 3-input combo).
2. Extend the lease PATCH route zod schema + addendum diff +
   SQL field map (same pattern as S224 added enabled + type).
3. Extend `ADDENDUM_DIFF_FIELD_LABEL` + `formatAddendumDiffValue`
   in shared.
4. Extend PropertiesPage edit form with the 5 inputs (mirror
   S223 pattern).
5. Wire a backend billing consumer that actually applies accrual
   and respects cap when generating late-fee invoices. **This is
   the one that may be missing entirely** — recon needed.

### POS thread polish (still open)

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

End of S225 handoff.
