# Session 188 — closed

## Theme

A3 deposit interest accrual engine. Per CLAUDE.md S177 carve-out
(hard regulatory accommodation: "many states require landlords to
pay interest on held tenant deposits at a state-specific rate"):
hardcoded per-state rates, annual-refresh migration cadence,
monthly accrual job, accrued interest added to deposit refund pool
at lease end.

This session also marks a meta-shift: Nic called out that I'd been
labeling substantive items "Nic-blocked / needs product call" when
direction was already on file. Saved feedback memory
`feedback_dont_overdefer.md`. A3 was on the deferral list for
exactly this reason — locked architecture, just needed execution.

## What S188 shipped

### Schema — two new tables

Migration `20260508130000_deposit_interest.sql`:

1. **`state_deposit_interest_rates`** — per-state, per-effective-year
   rate catalog. PK `(state_code, effective_year)`. Columns:
   `annual_rate_pct numeric(6,4)`, `statute_citation text NOT NULL`,
   `source_url text`, `notes text`. Annual-refresh cadence: future
   migrations INSERT new effective_year rows rather than mutating
   existing ones.

2. **`security_deposit_interest_accruals`** — per-month, per-deposit
   accrual log. UNIQUE`(security_deposit_id, accrual_month)` for
   idempotency. Columns: `state_code`, `effective_year`,
   `annual_rate_pct`, `principal_amount`, `days_held`,
   `days_in_month`, `interest_amount numeric(10,4)`. CHECK enforces
   `accrual_month` is a day-1 date. FK to
   `state_deposit_interest_rates(state_code, effective_year)`
   anchors the rate snapshot at the row that was active when the
   month was accrued.

`security_deposits.interest_accrued` was already a column from the
initial schema (pre-staged). The engine writes the cumulative sum
back to it so consumers (deposit-return service) don't have to
re-aggregate.

### Initial state seed

Three fixed-rate states with clear statutory citation:

| State | Rate | Statute |
|---|---|---|
| MA | 5.0000% | Mass. Gen. Laws Ch. 186 § 15B(2)(a) |
| MD | 1.5000% | Md. Code Ann., Real Prop. § 8-203(e)(1) |
| MN | 1.0000% | Minn. Stat. § 504B.178 |

Variable-rate states (NY, NJ, CT, IL statewide, PA, NH) intentionally
EXCLUDED — those use per-bank or per-year lookups that don't fit
the hardcoded model. Carry-forward: separate landlord-self-service
path for variable-rate states (TBD).

### Service — `services/depositInterest.ts`

- `computeMonthlyAccrual(deposit, monthStartIso)` — math kernel.
  Returns `null` when the deposit's state has no rate, or when the
  deposit wasn't held during any part of the month. Formula:
  `interest = principal * (annual_rate_pct / 100) * (days_held / 365)`.
  Handles partial first month (deposit funded mid-month) and
  partial last month (deposit disbursed mid-month) via clamping
  the held window to the month boundary.

- `runMonthlyAccrual(monthStartIso)` — iterates every active
  deposit (`status IN ('funded','partial','claimed')`,
  `collected_amount > 0`, `held_by = 'gam_escrow'`), inserts an
  accrual row, advances `security_deposits.interest_accrued`. One
  transaction per deposit; ON CONFLICT DO NOTHING on the unique
  constraint makes the job idempotent.

- `runPreviousMonthAccrual()` — convenience wrapper for the cron
  to accrue the just-completed month on day 1.

- `getAccrualHistory(securityDepositId)` — read accessor for
  future tenant/landlord dashboard surfaces.

### Cron — monthly at day-1 3am Phoenix

Added to `jobs/scheduler.ts`. Fires after the existing manager-fee
(1am) and platform-fee (1:30am) accruals; 3am Phoenix gives buffer
without competing for advisory locks. Scheduled via `cron.schedule
('0 3 1 * *', ...)`.

### Wired into deposit return — refund pool now includes interest

`services/depositReturn.ts` `calculateDepositReturn`,
`applyDeductionsToDraft`, `finalizeDepositReturn` all updated:

- Pull live `interest_accrued` from `security_deposits` (re-pull
  on every read so the cron's mid-flight advance is honored)
- New `tenantPool = total_deposit + interest_accrued`
- `refund_amount = MAX(0, tenantPool - total_deductions)`
- `gap_amount = MAX(0, total_deductions - tenantPool)`

Tenant gets principal + interest minus deductions. Gap fires only
when deductions exceed the full pool.

`GET /api/leases/:id/deposit-return` existing-draft branch attaches
live `interest_accrued` to the response so the frontend can render
the line.

### Frontend — DepositReturnPage shows interest

- New `interest_accrued` field on `DepositReturnState`
- `normalize()` reads it from both branches (existing row + preview)
- New summary tile "Interest accrued" rendered when > 0
- Helper copy below the summary explaining the math when interest
  is non-zero
- `tenantPool` math mirrors the server side

### Files touched (S188)

```
apps/api/src/db/migrations/20260508130000_deposit_interest.sql      (NEW — 2 tables + 3 seed rows)
apps/api/src/db/schema.sql                                          (regenerated)
apps/api/src/services/depositInterest.ts                            (NEW — accrual engine)
apps/api/src/services/depositReturn.ts                              (calculate + applyDeductions + finalize: interest in tenant pool)
apps/api/src/routes/leases.ts                                       (GET deposit-return existing-draft branch attaches interest_accrued)
apps/api/src/jobs/scheduler.ts                                      (+ monthly cron 0 3 1 * *)
apps/landlord/src/pages/DepositReturnPage.tsx                       (+ interest_accrued field + summary tile + helper copy)
~/.claude/projects/-Users-gold-Downloads-gam/memory/feedback_dont_overdefer.md  (NEW — meta lesson on Nic-blocked overdeferral)
~/.claude/projects/-Users-gold-Downloads-gam/memory/MEMORY.md                   (+ pointer)
```

### Verification

- `npm run db:migrate` → applied; schema.sql regenerated
- `psql gam -c "SELECT * FROM state_deposit_interest_rates"` → 3 rows
- `cd apps/api && npx tsc --noEmit` → 0
- `cd apps/landlord && npx tsc --noEmit` → 0
- Cron registered; will fire 1st of next month. Manual trigger:
  `node -e "require('./apps/api/src/services/depositInterest').runPreviousMonthAccrual().then(console.log)"`

## Decisions made (S188)

| Question | Decision |
|---|---|
| Interest as a refund-pool addition vs separate line? | Pool addition. `tenantPool = principal + interest`. Refund draws against pool; gap fires only when deductions exceed pool. Matches every state statute's framing — interest is the tenant's money, comparable to principal. |
| Variable-rate states (NY, NJ, CT, IL, PA, NH) — include in initial seed? | No. Variable rates require per-bank or per-year lookup, doesn't fit the hardcoded model. Three fixed-rate states (MA, MD, MN) ship now; variable-rate states get a separate landlord-self-service rate-entry surface in a future session. |
| Day granularity vs month granularity for interest? | Day-fraction within month. `interest = principal * (rate/100) * (days_held/365)`. Handles partial first/last month accurately while staying simple. Daily compounding wasn't required by any of the three statutes. |
| Where to store running total — recompute or persist? | Persist on `security_deposits.interest_accrued` (column already existed pre-staged). Cumulative sum from the accrual log is the authoritative source; consumers read the cached scalar. Re-aggregation on every deposit-return read would burn cycles for no benefit. |
| Accrue for `held_by = 'landlord'` deposits too? | No. Statutory interest is the holder's obligation. When GAM holds via escrow, GAM (via the platform) accrues. When the landlord holds directly, that's the landlord's compliance — out of scope for the platform. Filter is `held_by = 'gam_escrow'` in `runMonthlyAccrual`. |
| Frontend — surface accrual history on a separate page? | Deferred. The deposit-return page now shows the cumulative `interest_accrued` total. Per-month history is nice-to-have but not blocking. Tenant-facing surface (their own deposit + interest view) also deferred — `getAccrualHistory` exposed for whoever builds it next. |

## Carry-forward — what S189+ should target

### Specific to A3 thread

- **Tenant-facing deposit interest view.** Tenant should see what
  they're accruing in real-time. New page or section under tenant
  /payments showing principal + accrued interest + projected at
  lease end. `getAccrualHistory` is the data accessor. Half-session.
- **Variable-rate state self-service.** NY/NJ/CT/IL/PA/NH require
  per-bank or per-year lookup. UI for landlord to enter their
  bank's rate annually + a `landlord_deposit_interest_rate_overrides`
  table. Half-to-full session.
- **Annual rate refresh discipline.** When 2027 rolls around, a
  new migration extends the catalog. Document the cadence
  somewhere stable (CLAUDE.md addendum?) so future-Claude knows to
  add the next year's rows in November/December.
- **Add more states.** The 3-state starter is conservative.
  Researching every state with deposit-interest statute (CA, IL
  Chicago RLTO, etc.) and adding to the catalog is a multi-hour
  but doable task.

### Already-known carry-forward (still open)

- Primary manager urgency tier (S185 question)
- Owner-financial-escalation pattern (S186 question)
- pos_items.property_id schema (S183 carry)
- Sublease subsystem
- B1+B2 material-change workflow
- C1 50-state property tax form catalog
- B3 booking acknowledgment surface UI
- D2 Flex tenant suite (launch-flag gated)
- POS Terminal hardware + EOD
- CSV imports
- E2 npm upgrades
- F1 Marketing rebuild
- `leases.security_deposit` deprecation into `lease_fees`

---

End of S188 handoff.
