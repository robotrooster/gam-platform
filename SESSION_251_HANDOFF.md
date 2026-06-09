# Session 251 — closed

## Theme

Sublease e-sign integration — final follow-up that closes the sublease
subsystem entirely. Landlord approve no longer flips straight to
'active'; instead the sublease enters `awaiting_signatures`, a
sublease agreement document is generated (GAM-default PDF or
landlord-uploaded template per-property), both parties sign via the
existing e-sign infrastructure, and completion dispatch flips the
sublease to 'active'.

## Items shipped

### Schema migration — `20260511140000_sublease_esign.sql`

- `subleases.status` CHECK extended: adds `'awaiting_signatures'`
  between `'pending'` and `'active'`
- `properties.sublease_agreement_template_url` (nullable text) —
  optional landlord-uploaded template URL that overrides the GAM
  default at document generation
- `lease_documents.document_type` CHECK extended: adds
  `'sublease_agreement'`
- `lease_documents.addendum_fields_check` updated so
  `'sublease_agreement'` follows the same `target_lease_tenant_id`/
  `promote_lease_tenant_id` NULL contract as `'original_lease'`
- `subleases.sublease_document_id` FK to `lease_documents(id)` —
  link from sublease row to its agreement document

### Shared exports — `packages/shared/src/index.ts`

- `LEASE_DOCUMENT_TYPES` const adds `'sublease_agreement'`
- `LEASE_DOCUMENT_TYPE_LABEL` adds the matching `'Sublease Agreement'`
  display label

### Document generator — `apps/api/src/services/subleaseDocuments.ts` (new, ~340 lines)

- `generateSubleaseDocument({ subleaseId })`:
  - Resolves template source: `properties.sublease_agreement_template_url`
    when set; else generates a PDF programmatically with pdf-lib
  - Default PDF includes: header, property/unit/dates/amount info
    block, parties block (sublessor + sublessee + landlord),
    boilerplate terms (master-lease responsibility, joint+several
    liability, sublessee subject to master rules, generic
    "check local law" framing per CLAUDE.md no-state-legal rule),
    signature blocks
  - Creates `lease_documents` row with `document_type='sublease_agreement'`,
    `template_id=NULL`, signers for sublessor (order 1) + sublessee
    (order 2), each with token
  - Stamps `subleases.sublease_document_id` on the source sublease
  - Fires first signing email via existing `emailSigningRequest`
  - Flips document status to `'sent'` + first-signer status to
    `'sent'` matching the existing e-sign send path
- `executeSubleaseAgreementCompletion({ documentId })`:
  - Called from e-sign dispatch when both signers complete
  - Flips `subleases.status='active'`, stamps
    `sublease_document_url`, sets `landlord_consent_date` if not
    already set
  - Returns lease-shaped result so the dispatcher's `{ leaseId,
    status, primaryTenantId }` signature stays unchanged (leaseId
    = subleaseId, primaryTenantId = sublessor_tenant_id)

### Routes — `apps/api/src/routes/subleases.ts`

**`PATCH /api/subleases/:id/decision` approve path:**
- Status flip changed from `'active'` → `'awaiting_signatures'`
- Post-update, `generateSubleaseDocument({ subleaseId })` fires
- On generator error: admin notification (`sublease_doc_generation_failed`
  category) + sublease left in `awaiting_signatures` for manual recovery
- Deny path unchanged (still flips to `'terminated'`)

### Routes — `apps/api/src/routes/esign.ts`

**`buildLeaseFromDocument` dispatcher:**
- New `'sublease_agreement'` case calls
  `executeSubleaseAgreementCompletion` and returns a lease-shaped
  result for compat with the function signature
- All other lease document types unchanged

### Tenant UI — `apps/tenant/src/pages/LeasePage.tsx`

- `TenantSublease` type: status includes `'awaiting_signatures'`;
  added `sublease_document_id?: string | null`
- Sublease row when status='awaiting_signatures': gold "Sign sublease
  agreement →" button linking to existing `/sign/{documentId}` page
- Status badge: gold variant + "sign required" label for
  `'awaiting_signatures'`
- Terminate button hidden for `'awaiting_signatures'` rows (sublease
  isn't legally binding until both parties sign; terminate is for
  active subleases)

### Landlord UI — `apps/landlord/src/pages/PropertiesPage.tsx`

- New `sublease_agreement_template_url` field in property form
- Renders only when `subleasing_allowed=true` (no point exposing the
  template URL when the toggle is off)
- Pasted-URL input, not file upload — landlord points GAM at a
  hosted PDF (e.g., S3 / Dropbox). File-upload UX is a separate
  feature when landlords need it
- Copy explains: blank = GAM default; URL = landlord override

### Landlord UI — `apps/landlord/src/pages/SubleasesPage.tsx`

- Sublease type status enum updated to include `'awaiting_signatures'`
- `STATUS_BADGE` map: gold badge for `'awaiting_signatures'`

## Decisions made during build

| Question | Decision |
|---|---|
| Reuse `lease_documents` table or new `sublease_documents`? | Reuse. Extending the existing CHECK + dispatcher branch is cleaner than parallel-plumbing signer flow, fields, voiding, audit, file storage. The dispatcher's lease-shaped return signature gets a sublease-id-as-leaseId cast in the new case. |
| Template = file upload or URL? | URL string in property settings. File upload requires upload-handling UI + storage routing for the landlord side, separate scope. Pasted URL works for landlords with existing PDF hosting. |
| Signer order? | Sublessor first (order 1), sublessee second (order 2). Sublessor initiated; their commitment confirms the deal as proposed before the sublessee gets prompted to sign. |
| GAM default template — merge fields or programmatic PDF? | Programmatic via pdf-lib (matches addendumPdf.ts pattern). Merge-field rendering would require `lease_template_fields` rows + a separate template asset; programmatic generation gives the same output with no asset-storage concern. |
| What about the landlord as a signer? | Not for v1. Landlord already approved via the decision route; signing is between sublessor + sublessee per the existing S199 product model. Landlord can be added as a third signer later if a use case emerges. |
| Generator failure handling? | Sublease stays in `awaiting_signatures` (the status was flipped before generation); admin notification fires; manual recovery path. Could be reattempted via a "regenerate document" admin route — deferred. |

## Files touched (S251)

```
apps/api/src/db/migrations/
  20260511140000_sublease_esign.sql                (new — 60 lines)
apps/api/src/db/schema.sql                         (regenerated)
packages/shared/src/index.ts                       (~ LEASE_DOCUMENT_TYPES
                                                    + LABEL; +2 lines)
apps/api/src/services/subleaseDocuments.ts         (new — ~340 lines)
apps/api/src/routes/subleases.ts                   (~ approve path —
                                                    status flip change +
                                                    generator call +
                                                    admin alert on
                                                    failure; ~+25)
apps/api/src/routes/esign.ts                       (~ dispatcher case
                                                    for sublease_agreement;
                                                    ~+20)
apps/tenant/src/pages/LeasePage.tsx                (~ status type +
                                                    awaiting_signatures
                                                    CTA + badge variant;
                                                    ~+25 / -3)
apps/landlord/src/pages/PropertiesPage.tsx         (~ template URL form
                                                    field + UI block;
                                                    ~+30)
apps/landlord/src/pages/SubleasesPage.tsx          (~ status type +
                                                    STATUS_BADGE entry)
DEFERRED.md                                        (~ sublease entry —
                                                    e-sign shipped;
                                                    subsystem fully
                                                    closed)
SESSION_251_HANDOFF.md                             (this file)
```

## Verification

- `cd apps/api && npx tsc --noEmit` → clean
- `cd apps/landlord && npx tsc --noEmit` → clean
- `cd apps/tenant && npx tsc --noEmit` → clean
- `cd apps/admin && npx tsc --noEmit` → clean
- `packages/shared` rebuilt
- Migration applied: `\d subleases` confirms status CHECK includes
  `awaiting_signatures`; `\d lease_documents` confirms document_type
  CHECK includes `sublease_agreement`; `\d properties` confirms
  `sublease_agreement_template_url` text column

## End-to-end sublease flow (now fully shipped)

1. Landlord toggles `properties.subleasing_allowed=true`
2. Tenant requests sublease → status `pending_invite` or `pending`
3. (Invite-flow only) Sublessee signs up via accept link → status
   flips to `pending`
4. Landlord approves → status flips to `awaiting_signatures`,
   sublease agreement PDF generated, first signing email fires
5. Sublessor signs → second signing email fires to sublessee
6. Sublessee signs → e-sign dispatch flips sublease to `active` +
   stamps `sublease_document_url`
7. Allocation engine routes master_share to landlord on each
   sublessee rent payment; markup credits to sublessor balance
8. Sublessor withdraws to bank via Stripe Connect (S248)

## Carry-forward — S252+

Sublease subsystem fully closed. Remaining build queue:

### Flex Suite remaining

- **FlexCredit** — vendor-pending (CredHub callback + Esusu email
  responses outstanding)
- **FlexCharge** — total rebuild (multi-session). Phantom tables
  (`flex_charge_accounts`, `flex_charge_transactions`); routes target
  nonexistent tables. RV/extended-stay credit-account with POS
  integration. Biggest remaining single-product scope.

### FlexDeposit follow-up

- **Deposit portability** across leases on GAM platform — when
  tenant moves between landlords, deposit re-points to new unit;
  custody fee continues uninterrupted. Touches lease-end + deposit-
  return engine.
- **Missed-installment legal remedy** — Nic pending spec.

### Smaller items

- POS multi-terminal sync (still likely premature)
- POS end-to-end smoke (Nic-runs)
- /resolve smoke (Nic-runs)
- OTP cron-timing rework (flagged S244, non-blocking)

### External-vendor-blocked

- **Checkr Partner** — credentials still pending

## Revised count

| Bucket | Pre-S251 | Post-S251 |
|---|---|---|
| Sublease | 1 follow-up (e-sign) | 0 — subsystem closed |
| Multi-session epics | 1 (FlexCharge) | 1 (FlexCharge) |
| Vendor-blocked | 2 (FlexCredit + Checkr) | 2 |

**Until v1 launch-ready:** ~3 sessions: FlexCharge (multi-session
on its own), FlexDeposit portability, then any of the smoke walks /
Checkr post-trigger when partner credentials land.

---

End of S251 handoff.
