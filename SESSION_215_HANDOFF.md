# Session 215 — closed

## Theme

C1 phase 8 — `state_tax_forms` catalog: AR, KS, MS, NH, MT.
Mid-population states. Brings catalog past ~98% US population
coverage. Pivot off the addendum thread (closed S210–S214) to a
clean low-risk session.

## What S215 shipped

### Catalog expansion — 9 forms across 5 states

Migration `20260509154940_state_tax_forms_phase8.sql`:

| State | form_code | category | freq | filing_method |
|---|---|---|---|---|
| AR | AR3MAR | reconciliation | annual | paper_form |
| AR | DWS-ARK-209B | unemployment | quarterly | paper_form |
| KS | KW-3 | reconciliation | annual | paper_form |
| KS | K-CNS 100 | unemployment | quarterly | paper_form |
| MS | 89-140 | reconciliation | annual | paper_form |
| MS | UI-2/UI-3 | unemployment | quarterly | paper_form |
| NH | NH UI Quarterly | unemployment | quarterly | online_portal |
| MT | MW-3 | reconciliation | annual | paper_form |
| MT | UI-5 | unemployment | quarterly | paper_form |

**NH special case:** state has no broad income tax (interest/
dividends only, being phased out), so no W/H quarterly form. UI
filed online via NHES WebTax with no current paper code; encoded
as online_portal following S207's MN/SD/WY/AK pattern + S208's
MA UI pattern.

**MS special case:** UI-2 (wage report) + UI-3 (tax return) are a
paired filing always submitted together. Encoded as a single row
with composite form_code "UI-2/UI-3", same shape used for TX
"C-3/C-4" in phase 1.

Catalog total post-S215: **59 forms across US + 32 states**
(AK, AR, AZ, CA, CO, FL, GA, IL, IN, KS, MA, MD, MI, MN, MO, MS,
MT, NC, NH, NJ, NM— wait, NM not in this batch. Let me re-list:
AK, AR, AZ, CA, CO, FL, GA, IL, IN, KS, MA, MD, MI, MN, MO, MS,
MT, NC, NH, NJ, NV, NY, OH, OR, PA, SD, TN, TX, VA, WA, WI, WY).

Approximate US population coverage by landlord-state: **~98%**.

### Skipped this round (and why)

| Form / State | Reason |
|---|---|
| AR AR-941, KS KW-5, MS 89-105, MT MW-1 | Cadence-variable W/H deposit vouchers. Annual recon (AR3MAR / KW-3 / 89-140 / MW-3) covers landlord-visible deadline. Pattern continues from earlier phases. |
| OK, IA, ID, NM, WV | Form-code stability uncertain; defer to phase 9 verification round. |

### Files touched (S215)

```
apps/api/src/db/migrations/20260509154940_state_tax_forms_phase8.sql  (NEW — 9 form rows)
apps/api/src/db/schema.sql                                            (regenerated)
```

### Verification

- `npm run db:migrate` → applied; schema.sql regenerated
- `psql gam -c "SELECT COUNT(*) FROM state_tax_forms"` → 59 rows
- `psql gam -c "SELECT COUNT(DISTINCT state_code) FROM state_tax_forms"` → 33 jurisdictions (US + 32 states)
- `psql gam -c "...WHERE state_code IN ('AR','KS','MS','NH','MT')"` → 9 new rows present
- Migration only — no code or doc changes

## Decisions made (S215)

| Question | Decision |
|---|---|
| Encode AR-941 alongside AR3MAR? | Skip. AR-941 cadence-variable. Same posture as M-941 / MI 5080 — would need cadence_variants structure to encode cleanly. AR3MAR annual recon is the landlord-visible deadline. |
| MS UI-2 + UI-3 — combine or split? | Combine. Always filed together; splitting creates false visual signal of two distinct deadlines. Same shape as TX C-3/C-4. |
| NH withholding form? | None to encode. NH has no broad state income tax; interest/dividends-only tax doesn't generate a withholding deadline for landlord employees. |
| NH UI as paper_form or online_portal? | online_portal. NHES WebTax has no stable paper form code; same posture as MN/SD/WY/AK/MA. |
| Continue catalog past phase 8? | Yes, but each subsequent phase has diminishing population return. Phase 9 should focus on the form-code-uncertain pile (OK, IA, ID, NM, WV) — research-heavier per state but resolves long-standing carry-forward items. |

## Carry-forward — phase 9+

### State catalog — remaining

**Form-code-uncertain pile (next verification round):**
- **OK** — WTH-10001 / WTH-10004 (cadence-variable mix), OES-3 (UI)
- **IA** — 44-007 retired? Move to GovConnectIowa portal posture, 65-5300 (UI)
- **ID** — Form 967 (annual W/H), TAX020 (UI)
- **NM** — TRD-41409 (annual W/H), ES-903A (UI)
- **WV** — IT-103 (annual W/H), Form WVUC-A-154 (UI) — verify

**Smaller-population states (lower priority):**
- DE, RI, ME, ND, NE, VT, CT, LA, SC, DC, KY, UT
- Combined ~3% remaining US population.

**Cadence-variable pile (need cadence_variants structure):**
- OH IT-501, MD MW506, IN WH-1, WI WT-6, CO DR 1094, AR AR-941,
  KS KW-5, MS 89-105, MT MW-1.

**Threshold-gated:**
- NV MBT — needs threshold-gating product surface.

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

---

End of S215 handoff.
