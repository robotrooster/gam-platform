# Session 206 — closed

## Theme

C1 phase 4 — state_tax_forms catalog expansion: CO, TN, NV.
Conservative posture continued from S205.

## What S206 shipped

### Catalog expansion — 4 forms across 3 states

Migration `20260508210000_state_tax_forms_phase4.sql`:

- **CO** — DR 1093 (Annual Transmittal of State W-2s — W/H
  reconciliation) + UITR-1 (Quarterly UI Tax Report)
- **TN** — LB-0456 (Quarterly Premium and Wage Report; no state
  income tax → UI only)
- **NV** — NUCS-4072 (Quarterly UI Contribution and Wage Report;
  no state income tax → UI only). Note in row flags Modified
  Business Tax (TXR-020.05) for >$50k/quarter wages but doesn't
  encode it — most GAM landlords sit below threshold.

Catalog total post-S206: **26 forms across US + 14 states**
(AZ, CA, CO, FL, GA, IL, MI, NC, NJ, NV, NY, TN, TX, WA).

Same conservative bar as S205: only forms with clear statutory
basis, agency name, and quarterly cadence. Tax-form data carries
real consequence; each row is staked on rather than guessed at.

### Skipped this round (and why)

| State | Reason |
|---|---|
| MN, SD, WY, AK | UI quarterly filings are online-portal-only without a stable paper form code. Encoding a fabricated code would mislead. Need a "filed online via <portal>" first-class shape in the catalog data model first. |
| NV MBT (TXR-020.05) | Most landlords sit below $50k/quarter wage threshold; encoding without threshold-gating creates false-positive deadlines. Add when product surfaces threshold logic. |
| OH, PA, VA, MA, MI W/H | Form-code or cadence ambiguity already flagged in S205 phase 3 carry-forward. Still deferred. |

### Files touched (S206)

```
apps/api/src/db/migrations/20260508210000_state_tax_forms_phase4.sql  (NEW — 4 form rows)
apps/api/src/db/schema.sql                                            (regenerated)
```

### Verification

- `npm run db:migrate` → applied; schema.sql regenerated (10292 lines)
- `psql gam -c "SELECT state_code, COUNT(*) FROM state_tax_forms GROUP BY state_code"` → 15 jurisdictions confirmed (US federal + 14 states)
- `psql gam -c "SELECT state_code, form_code, frequency FROM state_tax_forms WHERE state_code IN ('CO','TN','NV')"` → 4 new rows present
- Migration only — no code or doc changes

## Decisions made (S206)

| Question | Decision |
|---|---|
| Add MN, SD, WY, AK in this session? | Deferred. UI filings in those four are online-portal-only; the schema requires a `form_code` and fabricating one would mislead landlords. Better fix is to add an "online-portal" shape to the data model first, then re-attempt. |
| Add NV Modified Business Tax (TXR-020.05)? | Deferred. MBT only applies above $50k/quarter taxable wages; encoding it as a flat row would generate false-positive deadlines for the majority of small landlords. Wait until threshold-gating exists in the surface. |
| Add CO DR 1094 (W/H payment voucher) alongside DR 1093? | Deferred. DR 1094's cadence depends on filer designation (weekly/monthly/quarterly) — same cadence-ambiguity pattern that held back PA W-3, MI 5080 chain, etc. |
| Bundle phase 4 + phase 5 into one larger session? | No. S205's "ship 4-6 states per session" cadence is the right pace given the per-state research cost. |

## Carry-forward — phase 5+

### State catalog further expansion

**Form-code-ambiguity pile (all flagged S205):**
- **OH** — IT-941 (annual W/H recon) + JFS 20127 (quarterly UI)
- **PA** — UC-2 (quarterly UI). PA W-3 cadence needs verification.
- **VA** — FC-20 / FC-21 (quarterly UI Tax + Wage). VA-6 (annual W/H recon) needs verification.
- **MA** — M-941 (quarterly W/H). 0500 UI form code needs verification.
- **MI** — withholding forms (5080 / 5081 / 5099) verification round.

**CO additions to revisit:**
- DR 1094 (W/H payment voucher) — once cadence-variable forms have a clean encoding pattern.

**Online-portal pile (need data-model addition first):**
- **MN** — Form 9 (quarterly UI), W-3 reconciliation
- **SD** — quarterly UI (SUITS portal)
- **WY** — quarterly UI (WYUI portal)
- **AK** — quarterly UI Contribution Report (TQ01-era code unverified)

**Threshold-gated pile (need product surface first):**
- **NV MBT** — TXR-020.05 above $50k/quarter wages

### Already-known carry-forward (unchanged from S205)

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

End of S206 handoff.
