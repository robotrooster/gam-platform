# Session 213 — closed

## Theme

B1+B2 phase 2B continuation — wire S212's `generateAddendumPdf` into
the leases PATCH `confirm_addendum: true` flow. Audit-only posture
per Nic's product call: addendums are one-way landlord notices, not
bilateral amendments. Closes the multi-session B1+B2 phase 2B item.

## What S213 shipped

### Product framing locked

Nic confirmed: **addendums = landlord one-way notices**. Tenant
countersignature is reserved for new leases or early termination.
Saved to memory at
`memory/project_addendums_one_way_notices.md` so future-Claude
won't re-litigate the question.

### Backend — PDF generation wired into PATCH

`apps/api/src/routes/leases.ts` PATCH `/:id`:

In the post-UPDATE block where S202's
`lease_addendum_recorded` events fire (when
`nonMaterialChangesApplied.length > 0`):

1. Generate the addendum PDF via `generateAddendumPdf` from
   S212's service. Best-effort: PDF generation failure logs
   `[ADDENDUM_PDF]` but doesn't roll back the lease update.
2. Pass `pdfFilename` into each tenant's
   `lease_addendum_recorded` event_data (and into
   `attestation_evidence` for the audit trail).

If PDF generation fails, `pdf_filename` is null in event_data —
the credit-ledger emit still succeeds and the diff is still
visible on S210/S211 surfaces, just without a downloadable PDF.

### Backend — PDF file-serving route

`apps/api/src/routes/leases.ts`:

New endpoint `GET /api/leases/:id/addendum-pdf/:filename`:

- Auth: landlord-side via `canAccessLandlordResource`, OR tenant
  who is/was on the lease (`lease_tenants` row regardless of
  status — historic tenants retain access to their record).
- Filename validated against
  `credit_events.event_data->>'pdf_filename'` for an event tied
  to THIS lease, so a leaked filename can't be used to fish other
  PDFs from the uploads directory.
- Path traversal blocked by `resolveUploadPath`.
- `res.sendFile()` against `process.cwd()/uploads/leases/`.

Did NOT extend the existing `/api/esign/files/:filename` endpoint
because it requires a `lease_documents` row association — addendum
PDFs are audit-only with no document row. Adding one would need a
new document_type enum + migration; cleaner to keep audit
artifacts at a separate route with their own auth model.

### Backend — PDF surface in addendums endpoints

Both addendums GET endpoints now return `pdf_filename`:

- `GET /api/tenants/lease/addendums` — selects
  `event_data->>'pdf_filename' AS pdf_filename`
- `GET /api/leases/:id/addendums` — selects
  `MIN(event_data->>'pdf_filename') AS pdf_filename` inside the
  GROUP BY (the dedup-by-changes-content collapses per-tenant
  events with the same pdf_filename, so MIN is identity here)

### Frontend — "View PDF" links on both surfaces

Both AddendumHistorySection components render a "View PDF" button
when `pdf_filename` is non-null. Click handler:

```ts
async function openAddendumPdf(leaseId, filename, token) {
  const res = await fetch(`/api/leases/${leaseId}/addendum-pdf/${filename}`,
                          { headers: { Authorization: 'Bearer ' + token } })
  const blob = await res.blob()
  window.open(URL.createObjectURL(blob), '_blank')
}
```

Direct `<a href download>` won't work because the browser doesn't
attach the Bearer token to a navigation request — same constraint
as the existing PdfViewer pattern in tenant LeasePage. The blob-
URL-in-new-tab approach satisfies both.

`leaseId` now passed to both AddendumHistorySection components.
Tenant side reads `gam_tenant_token` from localStorage; landlord
side reads `gam_token`.

### Files touched (S213)

```
apps/api/src/routes/leases.ts                                   (PDF gen wire-in + addendum-pdf serving route + pdf_filename in addendums GET)
apps/api/src/routes/tenants.ts                                  (pdf_filename in /tenants/lease/addendums response)
apps/tenant/src/pages/LeasePage.tsx                             (View PDF button + leaseId prop + openAddendumPdf helper)
apps/landlord/src/pages/LeaseFormModal.tsx                      (View PDF button + openLandlordAddendumPdf helper)
memory/project_addendums_one_way_notices.md                     (NEW — Nic-confirmed framing)
memory/MEMORY.md                                                 (+ pointer to new memory file)
```

### Verification

- `cd apps/api && npx tsc --noEmit` → clean
- `cd apps/tenant && npx tsc --noEmit` → clean
- `cd apps/landlord && npx tsc --noEmit` → clean
- No new migrations.

The full end-to-end flow (PATCH → PDF gen → event emit → read
endpoint → frontend "View PDF" click → file served) was not
runtime-smoke-tested — dev DB has no active-tenant leases for the
PATCH path to exercise. The PDF generator was smoke-tested
standalone in S212; the wire-in is mechanical.

## Decisions made (S213)

| Question | Decision |
|---|---|
| Audit-only PDF (option 1) vs countersignature (option 2)? | Option 1, per Nic. Addendums are one-way landlord notices; countersignature is for new leases / early termination. Saved as project memory. |
| Block credit-event emission if PDF gen fails? | No. Both are best-effort. PDF failure → null `pdf_filename`, event still emits, diff still visible on S210/S211 — landlord just can't download a PDF for that addendum. |
| Extend `/api/esign/files/:filename` or build a dedicated route? | Dedicated route. The esign file route requires lease_documents row association; addendum PDFs are audit-only with no document row. Adding a new document_type would need a migration + CHECK update for a single use case that doesn't really fit the e-sign domain. |
| Filename validation — match against credit_events or trust the URL? | Match against credit_events. Belt + suspenders alongside `resolveUploadPath` traversal block. A leaked filename can't be used to access PDFs from other leases. |
| Tenant access to PDFs after they're removed from the lease? | Allowed. `lease_tenants` query has no status filter — historic tenants retain access to their tenancy record, including PDFs from when they were on the lease. |
| Surface PDF link as `<a href download>` or click-to-fetch? | Click-to-fetch (blob URL). `<a>` can't carry Bearer tokens; matches the pattern the existing PdfViewer uses for the lease document. |
| Storage path — in/out of `uploads/leases/`? | In. Same directory as e-sign uploads. The auth gate is per-route, not per-directory; co-locating is fine and simplifies the file-serving code. |
| Should `pdf_filename` go in `event_data` or `attestation_evidence`? | Both. `event_data.pdf_filename` is what the read surfaces consume; `attestation_evidence.pdf_filename` makes the PDF formally part of the immutable attestation chain (a corrected event-replacement via dispute would need to attach its own PDF, properly). |

## Carry-forward — S214+

### Addendum thread — remaining polish

- **Resolve `recorded_by_user_id` to a display name** on both
  surfaces (with owner-vs-PM-acting-under-scope attribution).
  Half-session.
- **Resolve `tenant_ids` to names** on the landlord surface
  (currently shows count only). Half-session.
- **End-to-end smoke** of the full PATCH → PDF → event → frontend
  flow once dev DB has at least one lease with active tenants.
  Currently can't exercise without seed-data work.

### B1+B2 thread — closed

The B1+B2 phase 2B item is complete. PDF generated on every non-
material lease edit; viewable from both tenant and landlord
surfaces. Audit-only posture matches Nic's product framing.

### Already-known carry-forward (unchanged)

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

End of S213 handoff.
