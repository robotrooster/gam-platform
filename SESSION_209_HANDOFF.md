# Session 209 — closed

## Theme

C1 phase 7 — `state_tax_forms` catalog: IN, MO, MD, WI, OR. Top-5
by population from the unverified pile. Brings catalog past ~95%
US population coverage by landlord-state.

## What S209 shipped

### Catalog expansion — 10 forms across 5 states

Migration `20260509145847_state_tax_forms_phase7.sql`:

| State | form_code | category | freq | filing_method |
|---|---|---|---|---|
| IN | WH-3 | reconciliation | annual | paper_form |
| IN | IN UI Quarterly | unemployment | quarterly | online_portal |
| MO | MO-941 | withholding | quarterly | paper_form |
| MO | MO UI Quarterly | unemployment | quarterly | online_portal |
| MD | MW508 | reconciliation | annual | paper_form |
| MD | MD UI Quarterly | unemployment | quarterly | online_portal |
| WI | WT-7 | reconciliation | annual | paper_form |
| WI | UCT-101 | unemployment | quarterly | paper_form |
| OR | Form OQ | unemployment | quarterly | paper_form |
| OR | OR-WR | reconciliation | annual | paper_form |

**Special case — OR Form OQ:** Oregon uses a single combined
quarterly filing covering W/H + UI + Workers' Benefit Fund +
statewide transit tax. Encoded as 'unemployment' category (UI is
the most common quarterly-deadline driver) with notes spelling out
the combined nature. Single row instead of artificially splitting.

**Cadence-variable:** MO-941 got the now-standard NC-5 treatment
(quarterly variant + notes about monthly cadence for higher-volume
filers).

**Online-portal pattern:** IN, MO, MD UI all migrated to portal-only
filing with paper form codes retired. Encoded as online_portal
following S207's MN/SD/WY/AK and S208's MA UI pattern. WI UCT-101
kept as paper_form — UCT-101 is still the active form code in DWD
documentation, just filed via uctax.wisconsin.gov portal.

Catalog total post-S209: **50 forms across US + 27 states**
(AK, AZ, CA, CO, FL, GA, IL, IN, MA, MD, MI, MN, MO, NC, NJ, NV,
NY, OH, OR, PA, SD, TN, TX, VA, WA, WI, WY).

Approximate US population coverage by landlord-state: **~95%**.

### Skipped this round (and why)

| Form | Reason |
|---|---|
| IN WH-1 | Cadence-variable W/H deposit voucher (monthly/quarterly). WH-3 annual recon already captures landlord-visible deadline. Same posture as OH IT-501 / CO DR 1094. |
| MD MW506 | Cadence-variable W/H return. MW508 annual recon covers it. |
| WI WT-6 | Cadence-variable W/H deposit voucher. WT-7 annual recon covers it. |

### Files touched (S209)

```
apps/api/src/db/migrations/20260509145847_state_tax_forms_phase7.sql  (NEW — 10 form rows)
apps/api/src/db/schema.sql                                            (regenerated)
```

### Verification

- `npm run db:migrate` → applied; schema.sql regenerated
- `psql gam -c "SELECT COUNT(*) FROM state_tax_forms"` → 50 rows
- `psql gam -c "SELECT COUNT(DISTINCT state_code) FROM state_tax_forms"` → 28 jurisdictions (US + 27 states)
- `psql gam -c "...WHERE state_code IN ('IN','MO','MD','WI','OR')"` → 10 new rows present
- Migration only — no code or doc changes

## Decisions made (S209)

| Question | Decision |
|---|---|
| OR Form OQ — split into separate W/H and UI rows? | No. It IS one combined filing with one deadline; splitting would create false visual signal of two distinct obligations. Single row, category='unemployment' (the primary cadence driver), notes spell out W/H + WBF + transit tax inclusion. |
| OR Form OQ category — 'withholding' or 'unemployment'? | 'unemployment'. UI is what most often drives the quarterly cadence; W/H component is settled here as a side effect. Annual W/H reconciliation lives in OR-WR. |
| WI UCT-101 — paper_form or online_portal? | paper_form. UCT-101 is still the active form code in DWD agency documentation; uctax.wisconsin.gov is the delivery channel, not a replacement form. Same posture as NJ-927, OH JFS 20127, PA UC-2. |
| IN/MO/MD UI as online_portal? | Yes. Paper codes for those three (UC-1/UC-5A in IN, MO-DES wage report, DLLR/DUI 15/16 in MD) are retired in current agency documentation; filing is portal-only with descriptive labels. |
| Add cadence-variable W/H deposit vouchers? | No. Continuing the pattern from S208: vouchers don't add deadline visibility a landlord acts on. The annual recon row gives them the relevant deadline. |
| Stop the catalog buildout after this session? | Yes — at 27 states / ~95% population coverage, marginal-population return per session drops sharply. Smaller-population states (DE, RI, MT, etc.) deserve to be done eventually but should not crowd out other carry-forward items. Pivot recommended for S210. |

## Carry-forward — S210+

### State catalog — remaining work (lower priority)

**Smaller-population unverified states:** OK, AR, IA, KS, MS, NM,
ID, NH, NE, ND, ME, RI, MT, DE, HI, WV, VT, CT, LA, SC, DC, KY,
UT. Combined ~5% remaining US population. Worth eventually for
catalog completeness; defer until other carry-forward items
clear.

**Verified but deferred (cadence-variable / threshold-gated):**
- OH IT-501, MD MW506, IN WH-1, WI WT-6, CO DR 1094 — would need
  a cadence_variants jsonb structure. Reconsider at 8+ such forms.
- NV MBT (TXR-020.05) — needs threshold-gating product surface.

**Second-pass possibilities:**
- MN annual W/H recon (cadence threshold rules)
- MA M-3 (annual W/H recon)
- VA VA-5 (monthly W/H deposit voucher)
- PA REV-1667 (annual W-2 transmittal — form-code stability check)

### Recommended pivot for S210

After 5 catalog sessions in a row, the marginal value drops.
Options:
- **Tenant-side LeasePage addendum-history section** (S202 carry) —
  bounded frontend addition, ships a tenant-visible feature.
- **B1+B2 phase 2B PDF addendum auto-generation** — multi-session;
  bigger commitment but moves a major deferred line.
- **A3 polish** — diminishing returns.

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

End of S209 handoff.
