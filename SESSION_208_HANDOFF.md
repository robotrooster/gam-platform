# Session 208 — closed

## Theme

C1 phase 6 — `state_tax_forms` form-code-ambiguity verification
round: OH, PA, VA, MA, MI W/H. Resolves the pile flagged in S205
phase 3 carry-forward; benefits from the `filing_method` column
S207 added (MA UI collapses cleanly into online_portal).

## What S208 shipped

### Catalog expansion — 10 forms across 5 states

Migration `20260509145228_state_tax_forms_phase6.sql`:

| State | form_code | category | freq | filing_method |
|---|---|---|---|---|
| OH | IT-941 | reconciliation | annual | paper_form |
| OH | JFS 20127 | unemployment | quarterly | paper_form |
| PA | PA W-3 | withholding | quarterly | paper_form |
| PA | UC-2 | unemployment | quarterly | paper_form |
| VA | VA-6 | reconciliation | annual | paper_form |
| VA | FC-20 | unemployment | quarterly | paper_form |
| MA | M-941 | withholding | quarterly | paper_form |
| MA | MA UI Quarterly | unemployment | quarterly | online_portal |
| MI | Form 5081 | reconciliation | annual | paper_form |
| MI | Form 5080 | withholding | quarterly | paper_form |

PA W-3 disambiguation: PA's W-3 is QUARTERLY despite the federal
W-3 being annual. Verified and noted in the row.

Cadence-variable forms got the NC-5 treatment (encode quarterly
variant + notes pointing to other-cadence form codes):
- MA M-941 — quarterly variant; M-941M monthly, M-941W weekly
  noted
- MI 5080 — quarterly variant; same form on monthly cadence noted

MA's UI quarterly is online-only via UI Online portal (no current
paper form code) — encoded as online_portal with descriptive
form_code "MA UI Quarterly", same pattern as MN/SD/WY/AK in S207.

MI 5080/5081 use 20th-of-month due dates (not 30/31st most other
states use) — same posture as MI UIA 1028's 25th-of-month notes
from S205. Captured in the row notes.

Catalog total post-S208: **40 forms across US + 22 states**
(AK, AZ, CA, CO, FL, GA, IL, MA, MI, MN, NC, NJ, NV, NY, OH, PA,
SD, TN, TX, VA, WA, WY).

### Skipped this round (and why)

| Form | Reason |
|---|---|
| OH IT-501 | Cadence-variable W/H payment voucher; IT-941 annual recon already captures the full-year picture for the catalog. Adding cadence-variable payment vouchers across all states would explode the row count without adding deadline visibility. |
| PA REV-1667 | Annual W-2 transmittal; current form-code stability uncertain in Pennsylvania's recent online-filing migration. Defer to verification round. |
| PA UC-2A, VA FC-21 | Wage-detail counterparts always filed alongside UC-2 / FC-20 (never independently). Merged into the parent rows via notes rather than splitting into two rows. |
| MI 5099 | Amended quarterly return (corrections only). Not a routine filing — emerges only when an error needs fixing. Out of scope for the deadline catalog. |

### Files touched (S208)

```
apps/api/src/db/migrations/20260509145228_state_tax_forms_phase6.sql  (NEW — 10 form rows)
apps/api/src/db/schema.sql                                            (regenerated)
```

### Verification

- `npm run db:migrate` → applied; schema.sql regenerated
- `psql gam -c "SELECT COUNT(*) FROM state_tax_forms"` → 40 rows
- `psql gam -c "SELECT COUNT(DISTINCT state_code) FROM state_tax_forms"` → 23 jurisdictions (US + 22 states)
- `psql gam -c "...WHERE state_code IN ('OH','PA','VA','MA','MI')"` → 11 rows (10 new + MI UIA 1028 from S205 phase 3)
- Migration only — no code or doc changes

## Decisions made (S208)

| Question | Decision |
|---|---|
| Encode OH IT-501 alongside IT-941? | No. IT-501 is a cadence-variable payment voucher, not a deadline-bearing return. The catalog's job is deadlines for filings; payment vouchers blur the surface. IT-941 annual recon captures what landlords need to see. |
| Merge PA UC-2A / VA FC-21 into parent rows or give them their own rows? | Merge via notes. They're never filed independently of the parent. Splitting would create false visual signal that the landlord has two distinct deadlines instead of one composite filing. |
| MA UI as paper_form or online_portal? | online_portal. UI Online is the only filing path; no active paper form code. Pattern matches MN/SD/WY/AK from S207. |
| Same treatment for OH JFS 20127 / PA UC-2 / VA FC-20 (also primarily online filing)? | No — paper_form. Those states have stable form codes still in active use even though filing happens via state portals. The form code is what landlords look up; the portal is just the delivery method. Same as NJ-927, AZ UC-018, FL RT-6. |
| Encode the cadence-variable forms (M-941, MI 5080) at all? | Yes, with NC-5-style notes. The quarterly variant is what most small landlords hit; refusing to encode penalizes the common case. Notes spell out higher-volume cadence options. |
| Refactor cadence-variable encoding into a structured field (e.g. `cadence_variants` jsonb)? | Out of scope. Three rows (NC-5, M-941, MI 5080) fit the notes pattern fine. Reconsider if catalog hits 5+ cadence-variable forms. |

## Carry-forward — phase 7+

### State catalog — remaining gaps

**Verified but deferred:**
- OH IT-501 (cadence-variable payment voucher — would need cadence_variants structure)
- PA REV-1667 (annual W-2 transmittal — form-code stability uncertain)
- MI 5099 (amended return — not a routine deadline)

**Second-pass candidates:**
- MN annual W/H reconciliation (online_portal — cadence threshold rules)
- CO DR 1094 (cadence-variable W/H payment voucher)
- MA M-3 (annual W/H reconciliation)
- VA VA-5 (monthly W/H deposit voucher; cadence-variable)

**Threshold-gated:**
- NV MBT — TXR-020.05 above $50k/quarter wages

**Unverified states (no research yet):**
- IN, MO, MD, WI, OR, UT, KY, OK, AR, IA, KS, MS, NM, ID, NH, NE, ND, ME, RI, MT, DE, HI, WV, VT, CT, LA, SC, DC

A reasonable next-state batch: IN, MO, MD, WI, OR (top-population
remaining states; covers another ~15% of US population).

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

End of S208 handoff.
