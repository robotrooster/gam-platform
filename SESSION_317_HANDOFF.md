# Session 317 — closed

## Theme

Started the S312 option C work — closing the snake_case vs.
camelCase request-body drift that's been creating bugs since
S309/S310/S311. Recon turned up bigger scope than the S312
handoff suggested: ~134 backend zod schema fields are split
roughly 2:1 snake_case to camelCase, plus ~10 destructure-style
routes still on snake_case. A full mass-rename is 2–3 sessions;
S317 scoped to the 5 highest-confidence, isolated frontend ↔
backend pairs and documented the going-forward convention.

## Items shipped

### 5 frontend↔backend pairs aligned on camelCase

For each pair, both the backend zod schema (or destructure) and
the frontend mutation body were renamed in lockstep. Wire is
camelCase; DB column names stay snake_case.

| Endpoint | Renamed key(s) |
|---|---|
| POST /bulletin/:id/vote | `vote_type` → `voteType` |
| PATCH /properties/:id/manager | `user_id` → `userId` |
| PATCH /landlords/me/default-pm-company | `pm_company_id` → `pmCompanyId` |
| PATCH /inspections/:id | `scheduled_for` → `scheduledFor` |
| PATCH /leases/:id/deposit-return | `damage_lines`, `other_deductions` → `damageLines`, `otherDeductions` |

### Wire-format convention documented

**`packages/shared/src/camelize.ts`** — rewrote the
one-way-transform comment to state the going-forward convention:
request bodies use camelCase keys; backend zod schemas +
req.body destructures should accept camelCase; new routes
always, existing routes migrate fix-it-right when touched. The
S317 5 pairs listed in the comment as the migration's anchor
set.

## Files touched (S317)

```
apps/api/src/
  routes/bulletin.ts                       (vote_type → voteType)
  routes/properties.ts                     (manager user_id → userId)
  routes/landlords.ts                      (pm_company_id → pmCompanyId)
  routes/inspections.ts                    (scheduled_for → scheduledFor)
  routes/leases.ts                         (damage_lines / other_deductions
                                            → damageLines / otherDeductions)

apps/landlord/src/pages/
  PropertyDetailPage.tsx                   ({ userId })
  SettingsPage.tsx                         ({ pmCompanyId })
  InspectionDetailPage.tsx                 ({ scheduledFor })
  DepositReturnPage.tsx                    (patchMut signature +
                                            both mutate sites)

apps/tenant/src/
  main.tsx                                 (bulletin vote
                                            voteType:'up' / :'flag')

packages/shared/src/
  camelize.ts                              (convention doc)

SESSION_317_HANDOFF.md                     (this file)
```

No migrations. No schema changes. No service-layer rewrites.

## Decisions made during build

| Question | Decision |
|---|---|
| Pick wire format: snake_case or camelCase? | **camelCase.** Aligns with JSON industry standard, matches the response side (S312 already camelizes responses for the frontend), and is what the majority of newer routes already use. The legacy snake_case zod fields migrate fix-it-right as their surrounding code is touched. |
| Runtime transformer (axios request interceptor) or rename pass? | **Rename pass.** A transformer would silently break the ~43 backend zod schemas that already expect camelCase keys, while a rename pass is explicit and reviewable. A transformer also makes the convention invisible to anyone reading the code — the rename pass leaves the convention legible. |
| Scope — all 134 zod fields or a curated subset? | **Curated subset.** The recon showed a full pass would be 2–3 sessions. Picked the 5 high-confidence pairs where the frontend↔backend mapping is 1:1 and isolated (no fan-out callers). |
| POS routes — include or defer? | **Defer.** POS has an offline sync queue (`apps/pos/src/lib/syncQueue.ts`) with persisted payloads. Renaming wire keys could conflict with in-flight queued operations on real terminals. A dedicated POS-aware session handles this. |
| Inspections create/items schemas — include or defer? | **Defer.** Those schemas have 7+ snake_case fields each, tied to form-field naming in NewInspectionPage / inspection item-add. Bigger-than-one-pair scope. Migrates in a future session. |
| Fitness routes — include? | **Skip permanently.** Not GAM critical-path; appears to be a personal/experimental side module. |
| Inspections photo upload `req.body.item_id` — include? | **Defer.** Multipart upload path (different from the JSON paths). Touching it requires also updating the multer-handling form code; out of scope. |
| Document the convention where? | **In `packages/shared/src/camelize.ts`.** That's where future devs will land when they ask "how does case work between frontend and backend?" — the transformer module is the canonical answer. |

## Verification

- `npx tsc --noEmit` on `apps/api`: clean.
- `npx tsc --noEmit` on `apps/landlord`: clean.
- `npx tsc --noEmit` on `apps/tenant`: clean.
- `npx tsc --noEmit` on `apps/admin`: clean.
- `npx tsc --noEmit` on `packages/shared`: clean.

Not browser-walked. The 5 pairs are localized enough that the
type-check + careful 1:1 alignment is high-confidence; a real
test of each surface is part of the queued walkthrough.

## Items deferred — what S318 could target

### A. Walkthrough (Nic-driven)

Same queue as the S314–S316 surfaces. S317's renamed paths
(bulletin vote, manager assignment, default PM company,
inspection reschedule, deposit-return draft) each get a quick
sanity check during the walkthrough.

### B. Continue the camelCase migration

Most natural next-code session. The remaining ~80+ snake_case
zod fields are in:
- inspections create/items schemas
- Various POST/PATCH bodies in leases, payments, utility,
  workTrade, etc.
- The 3 POS routes (skip — offline-sync session needed)
- bulletin post-create + other tenant bulletin actions

Pick a vertical (e.g., "all inspections snake_case → camelCase")
or knock out 5 more isolated pairs per session.

### C. Re-acceptance prompt on template version change (S314 E)

Small standalone session. When FlexPay /
FlexDeposit template versions bump, prompt currently-enrolled
tenants to re-accept at next login.

### D. Email confirmation with attached terms PDF (S314 D)

Render acceptance snapshot to PDF via `pdfStamp`, attach to a
tenant enrollment-confirmation email.

### E. FlexDeposit eligibility-check workflow (S309 option C)

Bigger; needs Nic input on which signals qualify before code
lands.

## Items deferred (cross-session docket)

- Consumer-side retention framing decision (S300).
- Campground Master import path (Nic-blocked on sample).
- 2FA fan-out (walkthrough-blocked).
- Yardi GL-export columns, Rentec template (S293).
- FlexCharge Business Account Agreement signature capture
  (S309 option B — explicitly deferred; not a launch feature).
- FlexDeposit eligibility-check workflow (S309 option C).
- Standalone POS-operator auth (S309 option D).
- Deposit-return ↔ unpaid-installment offset architecture
  call (S310 carryover).
- SchedulePage booking-vs-lease shape audit
  (`booking.startDate` / `booking.checkIn` rendering logic).
- Remaining ~80+ snake_case → camelCase migration (S312 C
  continued — S317 closed the first 5 pairs).
- POS request-body migration (offline-sync subsystem).
- Inspections create/items schemas migration.

## Nic-pending (unchanged)

- Stripe live keys.
- Resend domain verification.
- Plaid production keys.
- Stripe Terminal hardware.
- Checkr Partner credentials.
- Consumer-side retention framing decision (S300).
- FlexCredit Lender partner selection.
- SLA § 9.1.4(iii) deposit-return offset framing call.

## What S318 should target

**Recommended:** walkthrough when ready. The S314–S317
surfaces stack into a coherent admin-side launch path that
needs a visual sanity check before more code piles on top.

**If code session before walkthrough:** **B** (continue
camelCase migration on a chosen vertical — e.g., all inspections
schemas) is the cleanest continuation. **C** (re-acceptance
prompt) is the smallest standalone option if you want to close
S314's loose end.

---

End of S317 handoff. Closed clean. First 5 pairs of the
camelCase migration done; convention documented.
