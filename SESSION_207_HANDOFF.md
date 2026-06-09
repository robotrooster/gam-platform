# Session 207 — closed

## Theme

C1 phase 5 — `state_tax_forms.filing_method` column + online-portal
seed for MN, SD, WY, AK. Resolves the structural gap that blocked
those four states in S206.

## What S207 shipped

### Schema extension — filing_method column

Migration `20260509010438_state_tax_forms_filing_method.sql`:

- `state_tax_forms.filing_method` text NOT NULL DEFAULT 'paper_form'
- CHECK against `('paper_form', 'online_portal')`
- COMMENT pointing to `packages/shared/src/index.ts FILING_METHOD_VALUES`
- All 26 existing rows defaulted to `'paper_form'` — no backfill writes
  needed (every existing catalog form IS a paper-form-with-optional-
  e-file, not portal-only)

### Shared single source of truth

`packages/shared/src/index.ts`:

```ts
export const FILING_METHOD_VALUES = ['paper_form', 'online_portal'] as const
export type FilingMethod = typeof FILING_METHOD_VALUES[number]
```

Pattern matches the rest of the file (readonly array + derived type).
The migration's CHECK list and the shared array are the two places
this enum lives, by design (CLAUDE.md "Single source of truth for
enums and CHECK constraints").

### Catalog expansion — 4 new online-portal rows

| State | form_code label | Agency | Statute |
|---|---|---|---|
| MN | MN UI Wage Detail | MN DEED | Minn. Stat. § 268.044 |
| SD | SD UI Quarterly | SD DLR Reemployment Assistance | SDCL § 61-5-24 |
| WY | WY UI Quarterly | WY DWS Unemployment Tax Division | Wyo. Stat. § 27-3-504 |
| AK | AK Quarterly Contribution | AK DOL&WD Employment Security | AS § 23.20.165 |

All quarterly UI, all `filing_method='online_portal'`, agency_url
points to the actual employer portal. Notes spell out "Filed online
via <portal> — no paper form" so a landlord doesn't go searching for
a code that doesn't exist. AK row also notes the Alaska-unique
employee-side UI contribution.

Catalog total post-S207: **30 forms across US + 18 states**
(AK, AZ, CA, CO, FL, GA, IL, MI, MN, NC, NJ, NV, NY, SD, TN, TX, WA, WY).

### Service + frontend wiring

**`apps/api/src/services/taxForms.ts`** — added `filing_method` to:
- `TaxFormDeadline` interface
- the SELECT column list
- the row mapper

**`apps/books/src/main.tsx`** Tax Center filing-deadlines render:
- "Online portal" badge (amber, `.ba` class) appended to the badge row
  when `filing_method === 'online_portal'`
- Link text switches: paper-form rows still say "File online ↗"
  (e-file is optional); online-portal rows say "Open portal ↗"
  (filing IS the portal)
- `form_code` rendering unchanged — descriptive labels like
  "MN UI Wage Detail" sit naturally in the gold-mono spot where
  paper codes like "DR 1093" went

### Files touched (S207)

```
packages/shared/src/index.ts                                                  (FILING_METHOD_VALUES + FilingMethod export)
apps/api/src/db/migrations/20260509010438_state_tax_forms_filing_method.sql  (NEW — column add + CHECK + 4 portal rows)
apps/api/src/db/schema.sql                                                    (regenerated — 10301 lines)
apps/api/src/services/taxForms.ts                                             (interface + SELECT + mapper)
apps/books/src/main.tsx                                                       (Tax Center render: portal badge + link wording)
```

### Verification

- `npm run db:migrate` → applied; schema.sql regenerated
- `psql gam -c "SELECT filing_method, COUNT(*) FROM state_tax_forms GROUP BY filing_method"` → 4 online_portal / 26 paper_form
- `psql gam -c "SELECT state_code, form_code, filing_method FROM state_tax_forms WHERE state_code IN ('MN','SD','WY','AK')"` → 4 rows present, all online_portal
- `cd packages/shared && npm run build` → clean
- `cd apps/api && npx tsc --noEmit` → clean
- `cd apps/books && npx tsc --noEmit` → clean

## Decisions made (S207)

| Question | Decision |
|---|---|
| Add `filing_method` as a column or normalize portal info into a separate table? | Column. Most rows are paper_form; a separate `online_filing_portals` table would force a join + nullable agency_url merge logic to render. Single column with descriptive form_code keeps the surface trivial. |
| What goes in `form_code` for portal rows? | A stable per-state descriptive label ("MN UI Wage Detail", "SD UI Quarterly"). Not a fabricated paper code. Display position is unchanged so the existing render slot just works; the "Online portal" badge differentiates visually. |
| Default for the new column? | `'paper_form'`. All 26 existing rows ARE paper forms. Default + insert-only seeds means zero backfill churn. |
| Add MN annual W/H reconciliation alongside the quarterly UI row? | Deferred. MN's W-2/1099 reconciliation is also online-only but the cadence/threshold rules are more nuanced. One row per state per session keeps the conservative posture. |
| Update DEFERRED.md? | Not yet — DEFERRED.md is for major shipped items. Phase 5 is part of an in-flight catalog buildout. Will tombstone the catalog block when it hits its conservative ceiling. |
| Add a catalog API route (e.g. `GET /api/admin/tax-forms/catalog`) for admin visibility? | Out of scope. The current consumer (books Tax Center) is the only surface. Admin visibility would only matter if we shipped a tax-form admin tool, which we haven't. |

## Carry-forward — phase 6+

### State catalog further expansion

**Form-code-ambiguity pile (still flagged):**
- **OH** — IT-941 (annual W/H recon) + JFS 20127 (quarterly UI)
- **PA** — UC-2 (quarterly UI). PA W-3 cadence needs verification.
- **VA** — FC-20 / FC-21 (quarterly UI Tax + Wage). VA-6 (annual W/H recon) needs verification.
- **MA** — M-941 (quarterly W/H). 0500 UI form code needs verification.
- **MI** — withholding forms (5080 / 5081 / 5099) verification round.

**MN second-pass:**
- Annual W/H reconciliation (online_portal, online via e-Services) — once cadence threshold rules are clarified.

**CO second-pass:**
- DR 1094 (W/H payment voucher) — cadence-variable. Wait for a clean
  encoding pattern (or split into per-cadence rows).

**Threshold-gated pile (need product surface first):**
- **NV MBT** — TXR-020.05 above $50k/quarter wages.

### Already-known carry-forward (unchanged)

- B1+B2 phase 2B (PDF addendum auto-generation, multi-session)
- Sublease phase 3 (sub-tenant billing + invite-by-email)
- POS Terminal hardware
- Tenant-side LeasePage addendum-history section (S202 carry)
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

End of S207 handoff.
