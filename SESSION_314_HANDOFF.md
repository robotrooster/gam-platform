# Session 314 — closed

## Theme

Shipped enrollment-acceptance audit capture for FlexPay and
FlexDeposit. S313 had teed up "FlexCharge signature capture"
(option B). Nic reframed early — FlexCharge isn't a launch
feature, and FlexPay/FlexDeposit don't need wet signatures.
Click-wrap acceptance + a persisted snapshot of the populated
terms is what's load-bearing for the SLA-not-loan / subscription
structural defense.

What landed: a new `flexsuite_enrollment_acceptances` audit table,
a server-side render-and-persist layer that snapshots the full
populated Subscription Terms / Service Agreement at acceptance,
a per-product preview endpoint for the "Read full terms" link in
the enrollment modal, and tenant-portal UX changes — explicit
acceptance gate on FlexPay (it had none), parallel UX on
FlexDeposit (it had a checkbox but the acknowledgment was fire-
and-forget — no row was written).

Recon contradicted the S313 framing: there was no FlexDeposit
SLA signing infra from S307 to reuse. S307 was a legal-doc
rewrite session only. This session built the first FlexSuite
acceptance subsystem from scratch.

## Items shipped

### Schema

**`apps/api/src/db/migrations/20260518140000_flexsuite_enrollment_acceptances.sql`**
— new table. Columns: `tenant_id`, `user_id`, `product_type`
('flexpay' | 'flexdeposit'), `template_version`,
`populated_content` jsonb, `rendered_text` (full populated terms
snapshot), `content_hash` (sha256 of rendered_text),
`accepted_at`, `accepted_ip`, `accepted_user_agent`. CHECK
constraint on product_type; index on
(tenant_id, product_type, accepted_at DESC). Applied;
schema.sql regenerated.

FlexCharge intentionally not in the product_type enum — drops
in via ALTER when FlexCharge launches.

### Service

**`apps/api/src/services/flexsuiteAcceptance.ts`** (new) —
- `FLEXPAY_TEMPLATE_VERSION` / `FLEXDEPOSIT_TEMPLATE_VERSION`
  constants pinned at `'1.0.0'`. Future template revisions ship
  new exported render fns + bump these strings; old acceptance
  rows stay reproducible because the full text is snapshot in
  `rendered_text`.
- `renderFlexPayAcceptanceText(ctx)` — loads
  `legal/FLEXPAY_SUBSCRIPTION_TERMS.md`, fetches tenant + bank
  context, substitutes the 11 placeholders, returns
  `{ renderedText, populatedContent }`.
- `renderFlexDepositAcceptanceText(ctx)` — same pattern against
  `legal/FLEXDEPOSIT_SLA_TEMPLATE.md`. Trims the static
  installment-table rows beyond the actual installmentCount
  before substitution so the rendered SLA only shows the real
  schedule. Substitutes 13 named placeholders +
  `Installment_N_Date` / `Installment_N_Amount` for N in 1..count.
- `recordAcceptance({ client, ... })` — takes a transaction
  client so the audit row inserts inside the existing enrollment
  tx. Computes sha256 hash of renderedText; inserts; returns id.

Path resolution uses `path.resolve(__dirname, '..', '..', '..',
'..', 'legal')` so it works from both `apps/api/src/services` and
the compiled `apps/api/dist/services`. Reads the .md file each
call (no caching — small files, low frequency).

### Backend wiring

**`apps/api/src/services/flexpay.ts`** —
- `enrollFlexPay` signature expanded:
  `{ tenantId, userId, pullDay, acceptedTerms, ip, userAgent }`
  returns `{ ok: true, fee, acceptanceId } | { ok: false, reason }`.
- Refuses when `acceptedTerms !== true`. Renders the populated
  Subscription Terms before opening the tx. Inside a new tx,
  records the acceptance row, then runs the existing tenants
  UPDATE, then commits.

**`apps/api/src/services/flexDeposit.ts`** —
- Extracted `computeFlexDepositSchedule()` pure helper that
  returns the canonical installment schedule shape used by both
  enrollment and the new preview endpoint.
- New `previewFlexDepositSchedule({ tenantId, installmentCount })`
  fetches the deposit row + computes the schedule without
  persisting anything. Powers `GET /flexdeposit/terms`.
- `enrollFlexDeposit` signature expanded:
  `{ tenantId, userId, installmentCount, acceptedTerms, ip,
  userAgent }`. Refactored to use the schedule helper. Records
  the acceptance row inside the existing transaction, after the
  installment rows and the `security_deposits` flip. If anything
  in the tx fails, the acceptance row rolls back too.

**`apps/api/src/routes/tenants.ts`** —
- `POST /flexpay/enroll` — accepts `{ pullDay, acceptedTerms }`,
  captures `req.ip` + `req.headers['user-agent']`, passes
  through.
- `GET /flexpay/terms?pullDay=N` — new endpoint. Renders the
  populated Subscription Terms text without persisting; returns
  `{ version, pullDay, fee, renderedText }`.
- `POST /flexdeposit/enroll` — accepts `acceptedTerms` (new
  canonical field); legacy `acknowledgedTos: true` accepted as a
  back-compat alias.
- `GET /flexdeposit/terms?installmentCount=N` — new endpoint.
  Previews schedule + renders the populated SLA text without
  persisting; returns
  `{ version, installmentCount, installments, gamAdvanceAmount,
  renderedText }`.

### Frontend (tenant portal)

**`apps/tenant/src/main.tsx`** —
- New `TermsViewerModal` shared component — full-text viewer
  with monospaced pre-wrap rendering for the populated SLA /
  Subscription Terms. Used by both FlexPay and FlexDeposit
  modals.
- `FlexPayModal` — first-time gain of an acceptance gate.
  Subscription Terms summary block (3 clauses: subscription-
  not-loan / failed-pulls-retry-and-reprice / doesn't-change-
  lease) + "Read full FlexPay Subscription Terms →" link
  fetching from `/flexpay/terms` + checkbox. Enroll button gates
  on the checkbox. Body sends `acceptedTerms: true`.
- `FlexDepositModal` — kept S260's 3-clause summary, added a
  service-agreement-not-loan clause at top (no-debt-no-recourse
  + no CRA furnishing + no collections — the load-bearing
  recharacterization-defense language), added the "Read full
  FlexDeposit Service Agreement →" link, renamed the body field
  to `acceptedTerms` (matching new backend canonical name).

### Legal-doc consistency fixes

**`legal/FLEXDEPOSIT_SLA_TEMPLATE.md`** — three small content
fixes discovered while wiring the renderer (fix-it-right scope):
- § 4 table footer: `${{Total_Installments}}` →
  `${{Total_Installment_Amount}}` (the count placeholder was
  mis-used as the sum amount in the Total row).
- § 5 ACH-pull authorization: "all twelve scheduled
  Installments" → "all {{Total_Installments}} scheduled
  Installments" (hardcoded 12 → dynamic count).
- § 9 Term and Termination: same "twelve" → placeholder fix.

The template was originally drafted assuming 12 installments
max; actual product max is 4. The renderer also strips excess
installment-table rows beyond the actual count so the rendered
SLA matches the populated schedule exactly.

## Files touched (S314)

```
apps/api/src/
  db/migrations/20260518140000_flexsuite_enrollment_acceptances.sql  (NEW)
  db/schema.sql                                (auto-regenerated)
  services/flexsuiteAcceptance.ts              (NEW)
  services/flexpay.ts                          (enrollFlexPay refactor)
  services/flexDeposit.ts                      (enroll refactor + schedule helper + preview)
  routes/tenants.ts                            (enroll handlers + 2 new GET terms endpoints)

apps/tenant/src/
  main.tsx                                     (TermsViewerModal + both enroll modals)

legal/
  FLEXDEPOSIT_SLA_TEMPLATE.md                  (3 placeholder consistency fixes)

SESSION_314_HANDOFF.md                         (this file)
```

## Decisions made during build

| Question | Decision |
|---|---|
| FlexCharge signing in scope? | **Defer.** Nic confirmed FlexCharge isn't a launch feature. The S309 per-Location gate stays; signing is later work. |
| Wet/typed signature, or click-wrap acceptance? | **Click-wrap.** E-SIGN / UETA give it parity with a typed-name e-signature for consumer subscription / SLA agreements. Audit record (timestamp + IP + UA + snapshot) is the load-bearing artifact. |
| Snapshot full rendered text in audit row, or version-pointer + params? | **Snapshot.** Storage is trivial (~3-5 KB per row); defensibility is "here's exactly what they saw." Avoids the "is the rev'd template still pinned?" question. Hash-anchored for tamper evidence. |
| Inline full terms in modal, or summary + "Read full" link? | **Summary + link.** Standard click-wrap UX. The audit row stores the full text regardless of what they actually click-through to read. The summary itself contains the load-bearing terms (no-debt-no-recourse, separate parties, ACH priority, retry behavior) so notice is sufficient even if the link goes unclicked. |
| Per-product columns on tenants/security_deposits, or standalone table? | **Standalone table.** One row per enrollment event (vs. one column per product), keeps schema clean, reusable when FlexCharge ever launches. The portability columns on `security_deposits` are the precedent for inline per-row capture; FlexSuite enrollment audit is a higher-volume, multi-product use case that deserves its own table. |
| Schedule computation — duplicate across enroll + preview, or extract? | **Extract.** `computeFlexDepositSchedule` + `previewFlexDepositSchedule` are pure / re-fetching wrappers. `enrollFlexDeposit` uses them too. Single source of truth for the installment math. |
| Template versioning shape? | **String constants per product, exported.** Future template revisions ship a new render fn + bump the version string. Old acceptance rows stay reproducible because the rendered text is snapshot inline. |
| FlexPay terms checkbox copy? | "I have read and agree to the FlexPay Subscription Terms." Parallel to FlexDeposit's "I have read and agree to the FlexDeposit Service Agreement." Standardized phrasing. |
| Legacy `acknowledgedTos` flag — break the FlexDeposit contract, or accept both? | **Accept both.** Pre-launch dev only; nothing in production uses the old field, but back-compat alias costs one OR-expression and avoids surprise breakage if any client still sends the S260 name. |
| Legal-template "twelve" / `Total_Installments` mis-use — fix in this session? | **Yes (fix-it-right scope).** Three one-line edits to the SLA template. The template was drafted assuming 12 installments max; product max is 4. Fixed before rendering rather than memorializing the inconsistency in audit rows for every future tenant. |

## Verification

- `psql gam -c "\\d flexsuite_enrollment_acceptances"` — table
  landed with CHECK on product_type, FK to tenants + users, index
  on (tenant_id, product_type, accepted_at DESC).
- Hand-tested INSERT with a real tenant_id / user_id: succeeded.
- Hand-tested INSERT with `product_type='flexcharge'`: rejected
  by CHECK constraint with the expected error.
- `npx tsc --noEmit` on `apps/api`: clean (0 errors).
- `npx tsc --noEmit` on `apps/tenant`: clean (0 errors).
- All three legal-template edits applied verbatim; grep on
  "all twelve scheduled" → 0 hits remaining.

Not browser-walked. The product Q on rendering fidelity (does
the populated SLA read correctly for a tenant with dev seed
data — null bank_last4 / null landlord_name / etc.) is part
of the next walkthrough batch.

## Items deferred — what S315 could target

### A. Walkthrough (Nic-driven, recommended once batch is ready)

Per S311/S312/S313, the walkthrough is queued and the right
next move is *whenever Nic wants to run it*. The S314 surfaces
to verify in browser:
- FlexPay enrollment modal — summary block renders, full-terms
  link populates with the right pullDay/fee, checkbox gates
  Enroll button, body posts `acceptedTerms: true`, audit row
  lands.
- FlexDeposit enrollment modal — summary block (with new
  service-agreement-not-loan clause) renders, full-agreement
  link populates with the right schedule, audit row lands.
- TermsViewerModal — populated terms readable, scrollable,
  closes cleanly.

### B. Landlord/admin viewer for acceptance records

`flexsuite_enrollment_acceptances` is write-only today. A
future session could add a tenant-detail tab in the admin
portal (and possibly the landlord portal) showing the history
of acceptances + the snapshot text for forensic review.
Bounded scope; single page.

### C. FlexCharge signature capture (when FlexCharge ships)

When FlexCharge becomes a launch feature, this subsystem
extends naturally:
- Add `'flexcharge'` to the product_type CHECK constraint.
- Add `renderFlexChargeAcceptanceText()` to
  `services/flexsuiteAcceptance.ts`.
- Two-party flow: Business Account Owner pre-signs the
  configured template per Location; Account Holder counter-
  signs at account creation. Two rows per enrollment.

### D. Email confirmation with attached terms PDF

The audit row stores `rendered_text` (markdown). A nice
follow-up: render to PDF via the existing `pdfStamp` service
and attach to a confirmation email to the tenant. Provides a
durable copy in their inbox. Out of scope this session.

### E. Re-acceptance prompt on template version change

If FLEXPAY_TEMPLATE_VERSION bumps from '1.0.0' to '1.1.0', any
currently-enrolled tenant whose latest acceptance is on '1.0.0'
should be prompted to re-accept at next login. Not blocking
launch; nice-to-have for the v1.x evolution.

## Items deferred (cross-session docket)

- Consumer-side retention framing decision (S300).
- Campground Master import path (Nic-blocked on sample).
- 2FA fan-out (walkthrough-blocked).
- Yardi GL-export columns, Rentec template (S293).
- Stats tile on admin Overview (S295/S296).
- PII redaction in admin list (S295).
- Per-platform notes / review history display (S296).
- Email notification deep links (S298).
- FlexCharge Business Account Agreement signature capture
  (S309 option B — explicitly deferred; not a launch feature).
- FlexDeposit eligibility-check workflow (S309 option C).
- Standalone POS-operator auth (S309 option D).
- Deposit-return ↔ unpaid-installment offset architecture
  call (S310 carryover).
- SchedulePage booking-vs-lease shape audit
  (`booking.startDate` / `booking.checkIn` rendering logic).
- Standardize request-body shape on camelCase (S312 option C).

## Nic-pending (unchanged)

- Stripe live keys.
- Resend domain verification.
- Plaid production keys.
- Stripe Terminal hardware.
- Checkr Partner credentials.
- Consumer-side retention framing decision (S300).
- FlexCredit Lender partner selection.
- SLA § 9.1.4(iii) deposit-return offset framing call.

## What S315 should target

**Recommended:** browser walk of the S312/S313/S314 surfaces
when Nic is ready. Specifically the FlexPay + FlexDeposit
enrollment flows now that acceptance capture is wired. A real
ACH-verified dev tenant going through enroll → seeing the
populated SLA → clicking Accept → confirming an audit row
lands is the only honest validation that the v1 acceptance
pattern works end-to-end.

**If a code session before walkthrough:** option B (admin/
landlord viewer for acceptance records) is the bounded next
step. Useful for QA-ing the audit-row content during the
walkthrough.

---

End of S314 handoff. Closed clean. Acceptance subsystem in
place for FlexPay + FlexDeposit; FlexCharge slot reserved for
when it ships.
