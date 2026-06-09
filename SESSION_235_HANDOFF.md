# Session 235 — closed

## Theme

Bench session — the last 2 e-sign UI items shipped, closing out the
6-item bundle. **Witness-in-send-modal** added a witness signer flow
(new provisioning endpoint + send-modal UI), and **view-only re-open**
relaxed the GET /sign/:documentId endpoint to serve terminal-state
docs as read-only payloads with both portal pages rendering a
PDF-iframe + status banner instead of throwing.

## Items shipped

### 1. Witness-in-send-modal

**Backend `apps/api/src/routes/esign.ts`:**
- New `POST /api/esign/witnesses/provision` endpoint. Witnesses are
  external parties (property staff, notaries, neighbors) who attest
  to a signing without being tenants, landlords, or platform staff.
  Pre-S235 the only user-provisioning path was `/tenants/invite`,
  which required `unitId` and inserted a `tenants` row — wrong fit.
- The new endpoint creates a minimal `users` row with role='tenant'
  (the generic CHECK-allowed role) and NO tenants record. Idempotent
  on email — returns existing user id when the email is already in
  the table. The signing role on `lease_document_signers.role='witness'`
  is what drives field assignments; `users.role` is irrelevant for
  the signing flow.
- The /esign/documents validation already accepts `role: 'witness'`
  signers (existing `s.role === 'witness'` branch in the validator
  + the `if (!isTenantRole(s.role)) continue` skip on tenant-profile
  resolution); zero changes there.

**Frontend `apps/landlord/src/pages/ESignPage.tsx`:**
- Tracks `templateNeedsWitness` from the picked template's fields.
  Only surfaces the witness UI when at least one field is assigned
  to `signerRole='witness'` — common no-witness leases stay one-click.
- New witness section in `SendDocumentModal` (amber-bordered card):
  first name + last name (optional) + email. Validated pre-send
  (email required, valid format, first name required).
- `handleSend` provisions the witness via the new endpoint after
  tenant signers are added, then appends the witness signer with
  `role: 'witness'` and orderIndex = lastTenant + 1.
- Signing-order summary line includes "Witness" when applicable.

### 2. View-only re-open of executed / in-flight docs

**Backend `apps/api/src/routes/esign.ts`:**
- `GET /api/esign/sign/:documentId` previously threw 400 on terminal
  doc states (completed / voided / execution_failed) and on the
  signed-already signer state. Both signers and landlords could not
  re-open executed leases to view what they'd agreed to.
- Now: backend computes `readOnly = (doc terminal) OR (signer in
  signed/declined)` and serves the same response shape with that
  flag. The fields query switches to all-roles when readOnly (so the
  full executed state is visible, not just the caller's slot). The
  `signer.viewed_at` update is suppressed for read-only fetches.
- No throws on terminal states anymore — the only remaining 4xx is
  the 403 for "you are not a signer on this document" (sets the
  authorization boundary).

**Frontend (both portals — apps/tenant/src/pages/SignPage.tsx and
apps/landlord/src/pages/SignPage.tsx):**
- New `ReadOnlyView` component, rendered when `data.readOnly === true`.
- Status banner: green for completed / signed, red for voided /
  execution_failed / declined, with status-specific subcopy
  (void_reason for voided docs, decline_reason for the declined-by-me
  case, etc.).
- PDF iframe (executed_pdf_url falls back to base_pdf_url).
- "Field values" section listing all populated fields with values
  (signature/initials slots show "(signed)" instead of dumping a
  data-URL into the DOM).
- Back-to-portal button.
- Bypasses ALL the regular sign flow: no draft persistence, no
  decline button, no submit, no fields-overlay.

### Files touched (S235)

```
apps/api/src/routes/esign.ts                     (+ /witnesses/provision endpoint, ~30L
                                                  ~ /sign/:documentId GET — readOnly path,
                                                    all-roles fields, no viewed_at update)
apps/landlord/src/pages/ESignPage.tsx            (+ templateNeedsWitness flag,
                                                  + witness UI block in SendDocumentModal,
                                                  ~ handleSend builds witness signer,
                                                  ~ signing-order summary)
apps/landlord/src/pages/SignPage.tsx             (+ readOnly destructure,
                                                  + early-return ReadOnlyView,
                                                  + ReadOnlyView component, ~85L)
apps/tenant/src/pages/SignPage.tsx               (+ readOnly destructure,
                                                  + early-return ReadOnlyView,
                                                  + ReadOnlyView component, ~85L)

DEFERRED.md                                       (- last 2 e-sign items,
                                                   - whole "E-sign small items" section,
                                                   + bundle tombstone in Closed section)
SESSION_235_HANDOFF.md                            (new)
```

No migrations.

## Verification

- `cd apps/api && npx tsc --noEmit` → clean
- `cd apps/landlord && npx tsc --noEmit` → clean
- `cd apps/tenant && npx tsc --noEmit` → clean
- `cd apps/api && npm run schema:diff` → unchanged (only the
  pre-launch Flex Suite phantoms remain on write side, 0 read-side
  drift)

## Decisions made (S235)

| Question | Decision |
|---|---|
| Witness user provisioning: extend `/tenants/invite` or new endpoint? | New endpoint. The tenant-invite path requires unitId + creates a `tenants` row + sets up a tenant invite token; none of that fits a witness. A dedicated `/esign/witnesses/provision` is 30 lines, idempotent on email, and keeps the data model clean. |
| Witness's `users.role` field — extend the CHECK to add 'witness', or use 'tenant'? | 'tenant'. Extending the user role enum is invasive (touches auth middleware + permission gating + every role-conditional render across portals); the document-side `lease_document_signers.role='witness'` is the actual source of truth for how the user signs. The user-table role just needs to be a valid CHECK value. |
| Surface the witness UI always, or only when the picked template needs one? | Only when needed. Most lease templates have no witness fields; showing an always-visible witness section adds friction to the common case. The conditional check is one `.some()` over the template's fields. |
| Read-only re-open: pre-existing 400 errors → silent allow, or explicit `readOnly` flag in payload? | Explicit flag. Silent allow would let callers with stale assumptions miss the state change. Adding a `readOnly: true` field in the payload makes the contract clear, and the frontend branch is unambiguous. |
| Read-only fields query: same role-scoped query, or all-roles? | All-roles when read-only. The signer who's viewing post-execution wants to see the FULL executed state, not just their own role's filled fields. Live-signing path stays role-scoped (no leakage of in-progress fields from other signers during the sign window). |
| Suppress `signer.viewed_at` update on read-only fetches? | Yes. `viewed_at` is a "first-time-they-saw-it" audit signal; a re-open by a tenant who already signed shouldn't overwrite that timestamp or the data point loses meaning. |
| Render the executed PDF inline or download-only? | Inline iframe. The whole point of "view-only re-open" is being able to see what was signed without having to download a file. iframe gives the user the standard browser PDF viewer with no extra dependencies. |
| Show the "(signed)" placeholder for signature/initials fields in the value list? | Yes. Dumping a base64 data-URL into the value list would be ugly + meaningless. The PDF iframe shows the signature visually; the value list is for plain text values (rent amount, dates, names) that need explicit context. |

## Carry-forward — S236+

DEFERRED post-S235 — the e-sign UI bundle is fully closed. Remaining
open items:

**Open — pickable now:**
- Owner-vs-manager re-audit of permissions (open-ended audit)
- POS receipt printing (hardware adapter)
- POS multi-terminal session sync (probably premature)
- /resolve smoke (testing)
- POS end-to-end smoke (testing)

**Nic-blocked / external / multi-session / npm audit / pre-launch
flag-gated:** unchanged from S234.

## Revised count

S235 closed 2 sub-items, completing the e-sign bundle.

| Bucket | Pre-S235 | Post-S235 |
|---|---|---|
| Pickable now | ~5 | ~5 |
| (e-sign sub-items) | 2 | 0 — bundle closed |
| Nic-blocked | 5 | 5 |
| External-vendor-blocked | 1 | 1 |
| Multi-session epics | 3 | 3 |
| npm audit | 4 | 4 |
| Pre-launch flag-gated | 2 | 2 |

**Until v1 launch-ready:** ~12 sessions → ~11.
**Until 100% feature-complete:** ~21 sessions → ~20.

---

End of S235 handoff.
