# Session 297 — closed

## Theme

Built the generic-upload claim-aggregation + promotion system —
the last piece of the morning's review-spec discussion. Generic
uploads now require landlords to type the platform name; matching
claims roll up by normalized name on the admin side; super admin
promotes a name when ≥ 5 distinct customers ask for it. Closes
out the S294→S295→S296→S297 arc into a complete review system.

## Items shipped

### Schema: `platform_claim_promotions`

Migration `20260516140000_platform_claim_promotions.sql` creates
a small dedup table:

- PK `normalized_name` (lowercased, alphanumerics-only form)
- `promoted_at`, `promoted_by` (FK users), `notes`
- `example_raw_name` — snapshot of the most-common raw spelling
  at promotion time, for the audit-log readback

Lazy-populated; missing row = not promoted. The candidates query
LEFT-JOINs and filters out promoted normalized names.

### Service: `normalizeClaimName` helper

`apps/api/src/services/csvImportAttempts.ts`:

```ts
export function normalizeClaimName(raw: string | null | undefined): string {
  if (!raw) return ''
  return raw.toLowerCase().replace(/[^a-z0-9]+/g, '')
}
```

"DoorLoop" / "doorloop" / "Door Loop" / "door-loop" / "DOORLOOP"
all normalize to "doorloop". Mirrored client-side in each of the
three onboarding pages for the soft-warning check.

### Handlers: 6 routes wired to read + persist claim

`apps/api/src/routes/landlords.ts`:

- All 3 validate handlers read `claimedPlatformName` from body
  when source='generic'; pass to `recordValidateAttempt` so the
  attempt row persists the claim alongside column shape.
- All 3 commit handlers do the same, AND reject with 400 when
  source='generic' but no claim supplied. ("claimedPlatformName
  is required for generic uploads")
- The tenant per-group commit path (PunchList → UnitCard) gets
  source + claim plumbed through as props so punch-list resubmits
  pass the same claim as the parent fast-path commit.

### Frontend: claim input on 3 onboarding pages

`PaymentHistoryOnboardingPage`, `PropertyOnboardingPage`,
`TenantOnboardingPage`:

- New `claimedPlatformName` state.
- When `source === 'generic'`, shows a required text input:
  *"What platform is this CSV from?"* with placeholder
  *"e.g. Hemlane, SimplifyEm, Rentmoji..."* and explanatory
  copy under it.
- Validate (tenant page) + commit (all 3) reject locally when
  generic + empty claim — landlord sees inline error before any
  network call.
- Soft warning when the typed claim normalizes to an existing
  platform key/label:
  > "We have a dedicated **Buildium** importer — switch to
  > *Buildium* in the dropdown above for better column mapping."
  Doesn't block — landlord can proceed if they want.

### Admin API: 3 new endpoints

`apps/api/src/routes/admin.ts`:

- `GET /api/admin/platform-claims/candidates` (admin OK) —
  normalized-name groups with `distinct_landlords`,
  `total_mentions`, `most_recent_mention`, `raw_name_variants`
  array, `import_types` array. Already-promoted names filtered
  out.
- `GET /api/admin/platform-claims/promoted` (admin OK) —
  audit-trail view of previously-promoted claims.
- `POST /api/admin/platform-claims/:normalized/promote`
  (super_admin) — upserts the promotion row, picks the most-
  common raw spelling as `example_raw_name`, logs to
  `admin_action_log` with actionType `platform_claim.promote`.

### Admin UI: claim candidates section

`apps/admin/src/main.tsx` — new card on `/csv-imports`:

- Table of normalized claim names with: spellings seen (first 3
  + "+N more"), customer count, total mentions, import types
  touched, last-seen timestamp.
- Customers ≥ 5 highlighted gold (matches the verification
  first-5 model).
- Promote button per row, super_admin only. Confirm() prompt to
  avoid fat-fingers. Regular admin sees "super_admin only"
  placeholder where the button would be.
- Footnote: *"Customers ≥ 5 highlighted gold — meets the
  promotion threshold. Promoting just acknowledges the claim;
  the actual mapping work is a separate code change."*

### Tests

- 5 new normalizeClaimName cases in
  `apps/api/src/services/csvImportAttempts.test.ts`:
  lowercases, strips whitespace + punctuation, all variants
  collapse to one form, null/empty handling, alphanumeric
  preservation.
- 12 existing test commit calls updated to pass
  `claimedPlatformName: 'TestPlatform'` alongside
  `source: 'generic'` (commit handlers now require it).

## Files touched (S297)

```
apps/api/src/db/migrations/
  20260516140000_platform_claim_promotions.sql  (new)

apps/api/src/db/
  schema.sql                                    (regenerated)

apps/api/src/services/
  csvImportAttempts.ts                          (normalizeClaimName
                                                 added)
  csvImportAttempts.test.ts                     (+5 normalize tests)

apps/api/src/routes/
  landlords.ts                                  (3 validate + 3 commit
                                                 handlers read claim;
                                                 commit rejects on
                                                 generic + missing
                                                 claim)
  admin.ts                                      (~+105 lines — 3 new
                                                 claim endpoints)
  csvImportPaymentHistory.test.ts               (3 commit calls get
                                                 claim arg)
  csvImportProperty.test.ts                     (4 commit calls)
  csvImportTenantBalance.test.ts                (5 commit calls)

apps/landlord/src/pages/
  PaymentHistoryOnboardingPage.tsx              (claim state + UI +
                                                 commit guard + mut
                                                 body update)
  PropertyOnboardingPage.tsx                    (same)
  TenantOnboardingPage.tsx                      (same + props plumbed
                                                 through PunchList →
                                                 UnitCard)

apps/admin/src/main.tsx                         (~+60 lines — claim
                                                 candidates table +
                                                 promote mutation +
                                                 type def)

SESSION_297_HANDOFF.md                          (this file)
```

## Decisions made during build

| Question | Decision |
|---|---|
| Required on validate or commit only? | **Commit-required for property + payment** (validate stays preview-only). **Tenant page also gates validate** because tenant validate auto-runs fast-path commit on clean rows — landlord would hit an opaque backend error otherwise. |
| Normalization rules — strip punctuation + lowercase, or stricter? | **lower + strip non-alphanumeric.** "DoorLoop" / "doorloop" / "Door Loop" / "door-loop" all collapse. Numbers preserved ("Rentmoji 2.0" → "rentmoji20") in case a vendor name carries them. |
| Soft warning when claim matches existing platform — block or just suggest? | **Suggest only.** A blocker would prevent legitimate cases (someone might use "Buildium-style export" outside Buildium proper). The dropdown switch is one click; that's enough nudge. |
| Where to surface candidates — separate page or section on `/csv-imports`? | **Section on existing page.** Same conceptual surface (review queue + verification + claims all relate to "what platforms our customers are migrating from"). |
| Promotion threshold N = 5 — same as verification? | **Yes.** Matches Nic's original spec for both the verification and promotion gates. Gold-highlight on the candidates table flags rows that meet it; promotion isn't blocked below 5 (super admin can promote earlier if signal is strong). |
| Promotion is just bookkeeping, no mapping work — clear in UI? | **Yes — explicit confirm() prompt and footnote.** "Promoting just acknowledges the claim; the actual mapping work is a separate code change." Avoids confusion that clicking Promote magically adds the platform. |
| Tenant per-group commit path also requires the claim — plumb through or relax backend? | **Plumb through.** Backend stays strict; the per-group resubmit gets source + claim as props through `PunchList` → `UnitCard`. Slight prop-drilling but ~5 extra lines. Backend-relaxation would create a hole where some generic commits land without claims. |
| Show how many distinct landlords mentioned each claim, or just total mentions? | **Both, but distinct-landlord drives the threshold.** Total mentions is a noisier signal (one landlord could mention "Hemlane" 5 times during retries); distinct landlords is the truthful demand signal. |

## Verification

- `cd apps/api && npx tsc -b` → clean.
- `cd apps/landlord && npx tsc --noEmit` → clean.
- `cd apps/admin && npx tsc --noEmit` → clean.
- `cd apps/api && npm test` → **238 / 238 passing** (was 233 at
  S297 start; +5 new normalizeClaimName cases). Existing 51
  csv-import-* tests updated to pass claimedPlatformName on
  generic commits.
- Migration applied via `npm run db:migrate`; schema.sql regenerated.
- Hit `/api/admin/platform-claims/candidates` returns empty rows
  array (table empty pre-first-claim, as expected).

## Items deferred (S297-specific)

- **Promotion UI doesn't link to "next steps"** — once promoted,
  the actual mapping work (add platform to PLATFORMS / build
  alias arrays / add to dropdown) is a code-change session.
  The UI just says "the actual mapping work is a separate code
  change" but doesn't queue it anywhere. If we ever build a
  super_admin task tracker, promotions could feed into it.
- **No "unpromote" action** — once promoted, a name is dropped
  from candidates permanently. Reversing requires deleting from
  `platform_claim_promotions` manually. Could add a route if it
  ever becomes a real need.
- **Generic-claim-promoted view** — the `/platform-claims/
  promoted` endpoint exists but isn't surfaced in the admin UI.
  Add a section "previously promoted" below candidates when
  it's useful.

## Items deferred (cross-session docket, unchanged)

- **Campground Master import path** when Nic has the sample.
- **2FA fan-out** when admin walkthrough lands.
- **Yardi GL-export columns** (S293 carry-forward).
- **Rentec blank import template** (S293 carry-forward).
- **Lawyer review of ToS** (carry-forward).
- **PII redaction in admin list** (S295 carry-forward — list
  shows landlord email; sample-row PII stays super_admin-only
  via detail-modal gate).
- **Email notification to super_admin on new unverified upload**
  (S296 carry-forward — review queue is still pull-based).
- **Stats tile on admin Overview page** (S295/S296 carry-forward).
- **Most-recent-validate cross-link from commit detail rows**
  (S295 carry-forward).

## Nic-pending (unchanged)

- Stripe live keys.
- Resend domain verification.
- Plaid production keys.
- Stripe Terminal hardware.
- Checkr Partner credentials.

## What S298 should target

**Discretionary — the review-system arc (S294→S295→S296→S297) is
complete.** Natural next options:

1. **Campground Master import path** (the original S293 docket
   item) when the sample is handy. RV-niche product alignment.
2. **2FA fan-out** if the admin walkthrough has landed.
3. **Review-system polish bundle** — the S295/S296/S297
   carry-forwards (Overview stats tile, super_admin push
   notification, validate-attempt cross-link from commit rows,
   PII redaction tier on list view). Half-session of small wins.
4. **Wait for first real customer** to surface a need we haven't
   anticipated. The system is built; real signal makes the next
   priority obvious.

---

End of S297 handoff. Closed clean.
