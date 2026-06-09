# Session 205 — closed

## Theme

C1 phase 3 — state_tax_forms catalog expansion: NJ, NC, GA, MI.
Plus annual-refresh discipline documentation in CLAUDE.md.

## What S205 shipped

### Catalog expansion — 7 forms across 4 states

Migration `20260508200000_state_tax_forms_phase3.sql`:

- **NJ** — NJ-927 (Quarterly Combined Withholding + UI + SDI) +
  WR-30 (Quarterly Wage Report)
- **NC** — NC-5 (Quarterly Withholding) + NCUI-101 (Quarterly UI)
- **GA** — G-7Q (Quarterly Withholding for quarterly filers) +
  DOL-4 (Quarterly UI)
- **MI** — UIA 1028 (Quarterly UI; W/H deferred for
  verification — MI's withholding form codes have ambiguity I
  want a second look at)

Catalog total post-S205: **22 forms across US + 11 states**
(AZ, CA, FL, GA, IL, MI, NC, NJ, NY, TX, WA).

Conservative posture: only forms with clear statutory basis,
agency name, and quarterly cadence. Tax-form data carries real
consequence (landlord misses a filing because we labeled it
wrong → penalty); each row needs to be staked on rather than
guessed at. OH, PA, VA, MA bundled into phase 4.

### CLAUDE.md S177 carve-out — annual-refresh discipline addendum

The S177 carve-out section now includes:

- **Live table pointers** for both catalogs:
  - `state_deposit_interest_rates` (S188) + `landlord_deposit_interest_rate_overrides` (S190)
  - `state_tax_forms` (S203 schema, S203/S204/S205 seed)
  - Catalog coverage stat: 22 forms / 11 states / ~85% US population
- **Annual-refresh discipline** spelled out:
  - When: November/December research → cut migrations before year-end
  - How: bulk INSERT new effective_year rows, never UPDATE existing
  - Migration filename pattern: `*_state_*_year_NNNN.sql`
  - Verify: every property's state has rate + tax-form rows for
    new year

Future-Claude reading CLAUDE.md at session start now knows the
cadence + how to execute it.

### Files touched (S205)

```
apps/api/src/db/migrations/20260508200000_state_tax_forms_phase3.sql  (NEW — 7 form rows)
apps/api/src/db/schema.sql                                            (regenerated)
CLAUDE.md                                                             (S177 carve-out section: + live table pointers, + annual-refresh discipline cadence)
```

### Verification

- `npm run db:migrate` → applied; schema.sql regenerated
- `psql gam -c "SELECT state_code, COUNT(*) FROM state_tax_forms GROUP BY state_code"` → 12 jurisdictions confirmed
- No code changes (migration + doc only)

## Decisions made (S205)

| Question | Decision |
|---|---|
| Add OH, PA, VA, MA in this session? | Deferred. OH IT-941 + JFS 20127 partial confidence; PA W-3 quarterly-vs-annual cadence ambiguous; VA / MA form codes have multiple variants depending on filer cadence. Tax misinformation risk > coverage gap. |
| MI withholding forms in this round? | UI only. MI's withholding form codes (5080 / 5081 / 5099) have a chained relationship I want to verify before encoding. UIA 1028 quarterly UI is unambiguous. |
| Document the annual-refresh discipline as a separate playbook file or inline in CLAUDE.md? | Inline in CLAUDE.md. CLAUDE.md is the canonical session-start context; a separate playbook would be one more doc to forget. Putting cadence + filename pattern in the existing carve-out paragraph keeps it discoverable. |
| Update DEPOSIT_INTEREST_PLAYBOOK.md or similar? | Not creating. The CLAUDE.md addendum covers both catalogs (deposit interest + tax forms) since they share the carve-out + cadence. One source of truth. |

## Carry-forward — phase 4

### State catalog further expansion

- **OH** — IT-941 (annual W/H reconciliation) + JFS 20127 (quarterly UI)
- **PA** — UC-2 (quarterly UI). PA W-3 cadence needs verification.
- **VA** — FC-20 / FC-21 (quarterly UI Tax + Wage). VA-6 (annual W/H recon) needs verification.
- **MA** — M-941 (quarterly W/H). 0500 UI form code needs verification.
- **MI** — withholding forms (5080 / 5081) verification round.
- **CO** — DR-1093 (annual W/H), UITR-1 (quarterly UI)
- **MN** — Form 9 (quarterly UI), W2 (annual)
- **TN, NV, SD, WY, AK** — no state income tax, only UI quarterly forms

Each state ~30 min of careful research + one INSERT migration.
Bundle 4-6 states per future session.

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

End of S205 handoff.
