# Session 199 — closed

## Theme

Sublease subsystem closing pieces: end-of-term auto-termination
cron + credit-ledger event types for the full sublease lifecycle.
Closes the two cleanest gaps from S198 carry-forward.

This session also ground-truthed an inaccurate claim from
prior handoffs: I'd been calling the "Stripe Connect S113 rebuild"
the biggest pre-launch blocker. Recon shows it's substantially
shipped — `services/stripeConnect.ts` (S114-S115) has
ensureConnectAccount, createOnboardingSession, fetchAccountStatus,
createRentDestinationCharge, createPmCompanyTransfer, all webhook
handlers (recordPayoutEvent / recordDisputeEvent /
recordAccountUpdated). Frontend embedded onboarding via
`@stripe/connect-js + ConnectAccountOnboarding` lives in landlord
+ pm-company BankingPages. The "rebuild" is mostly polish from
here, not a multi-session unbuilt monster.

## What S199 shipped

### Five new credit-ledger event types

`packages/shared/src/index.ts` `CREDIT_EVENT_TYPES`:

- `sublease_requested`
- `sublease_approved`
- `sublease_denied`
- `sublease_completed_natural`  (end-of-term reached as planned)
- `sublease_terminated_early`   (any party ended early)

All five are subjected against the **sublessor** (their behavior
in subletting). The sublessee's signal flows through master-lease
payment events when they pay their portion. Only
`sublease_completed_natural` joins `POSITIVE_EVENT_TYPES` —
completing as agreed is positive tenancy_stability; the others
are neutral / context-dependent.

### Emission wired in `routes/subleases.ts`

- POST → `sublease_requested` (with `auto_approved` flag in event_data)
- PATCH /decision → `sublease_approved` or `sublease_denied`
- PATCH /terminate → `sublease_terminated_early` with `triggered_by`
  and `reason`

All emissions best-effort wrapped in try/catch; ledger failure
doesn't roll back the workflow update. Visibility set to
`visible_to_current_landlord` (not network-wide; sublease context
may contain sensitive tenant relationships).

### `sublease_completed_natural` emission via daily cron

New job `apps/api/src/jobs/subleaseEndOfTerm.ts` exporting
`processSubleaseEndOfTerm()`. Scheduled at `30 2 * * *` Phoenix
(daily 2:30am, after the existing late-fee + lease-end
processors). For each `status='active'` sublease where
`end_date < CURRENT_DATE`:

1. UPDATE status='terminated', terminated_at=NOW(),
   terminated_reason='end_of_term: reached end_date <YYYY-MM-DD>'
2. Emit `sublease_completed_natural` credit-ledger event
3. Notify all three parties (sublessor / sublessee / landlord) via
   `notifySubleaseTerminated`

Best-effort: ledger or notification failure logs but doesn't fail
the row update. Batch limit 500 per run (sane backlog cap; daily
cadence catches up).

### Frontend EVENT_LABEL maps updated

`apps/landlord/src/pages/TenantScreeningPage.tsx` and
`apps/tenant/src/main.tsx`: five new entries in EVENT_LABEL,
`sublease_completed_natural` added to POSITIVE_EVENT_TYPES on the
landlord side.

### Files touched (S199)

```
packages/shared/src/index.ts                                            (+ 5 sublease event types in CREDIT_EVENT_TYPES)
apps/api/src/routes/subleases.ts                                        (+ appendEvent emission at request / decision / terminate)
apps/api/src/jobs/subleaseEndOfTerm.ts                                  (NEW — daily processor)
apps/api/src/jobs/scheduler.ts                                          (+ daily cron at 2:30am Phoenix)
apps/landlord/src/pages/TenantScreeningPage.tsx                         (+ EVENT_LABEL entries + POSITIVE_EVENT_TYPES addition)
apps/tenant/src/main.tsx                                                (+ EVENT_LABEL entries)
```

### Verification

- `cd packages/shared && npx tsc -b` → 0
- `cd apps/api && npx tsc --noEmit` → 0
- `cd apps/landlord && npx tsc --noEmit` → 0
- `cd apps/tenant && npx tsc --noEmit` → 0
- No schema migrations
- No formula version bump — events recorded but not yet scored;
  v1.1.0 publish migration would assign weights when product
  decides what subletting means for a credit score

## Decisions made (S199)

| Question | Decision |
|---|---|
| Cron cadence — daily, hourly, or weekly? | Daily at 2:30am Phoenix. End-of-term has day-granularity precision (date column, not timestamp), so hourly would only re-run the same query. Daily catches each sublease the day after end_date. |
| Event subject — sublessor only, or both parties? | Sublessor only. Their behavior in subletting is the audit signal. Sublessee's reliability flows through their own payment events (paying the sublessor / master) — that's the existing payment_received_* event family. |
| Visibility — visible_to_current_landlord or visible_to_gam_network? | current_landlord. Sublease context may include unit-mate dynamics or financial pressure signals that don't generalize to other landlords' decisions. Per-current-landlord is conservative. Can be widened in v1.1.0 if Nic decides. |
| Bump formula version (v1.0.0 → v1.1.0) to assign scoring weights to sublease events? | No. Five new event types added forward-compat to the catalog; events flow through the ledger but don't move the score until a future formula publish. Sublease scoring is a product calibration call (does completing a sublease as agreed boost score? does denial of a sublease request hurt the sublessor?) — out of scope this session. |
| Notify all three parties on auto-termination, or skip the "trigger"? | All three. The cron triggered, not a party — there's no skip-the-trigger logic. Each party gets a "your sublease ended at end of term" ping. |
| Reuse `notifySubleaseTerminated` with a synthetic triggered_by, or add a dedicated `notifySubleaseCompleted` helper? | Reuse with synthetic. The body text ("End of term reached (YYYY-MM-DD)") communicates what happened; adding a separate helper for one cron path was scope creep. |
| End-of-term cron also emits a notification to admin? | No. Routine sublease completion isn't an admin concern. Admin notifications are reserved for system-failure cases (charge failed, etc.). |

## Carry-forward

### Sublease subsystem (phase 3 still open)

- **Sublessee invite-by-email** — currently sublessee must already be a GAM tenant.
- **Sub-tenant billing wire-up** — the sublease records `sub_monthly_amount` and `master_share_amount` but no payments rows flow yet. Wire sublessee → sublessor (or → master rent split) under Stripe Connect destination charges.

### Stripe Connect — what's actually open

Per recon this session, the rebuild is largely shipped (S114-S115).
Open items would need a focused audit:
- 1099 retrieval surface (mentioned in CLAUDE.md S113 native dashboard list)
- Native dispute response surface (CLAUDE.md said GAM hosts these)
- Disbursement firing under Connect Payouts (S78 batch 2 was bank-rail-TBD; S113 obviated that — verify the disbursement firing service is actually using Connect Payouts vs old bank-rail stub)
- PM Companies money-flow refactor (S107-S112 schema; verify the active money flow)

### Already-known carry-forward (unchanged)

- B1+B2 material-change workflow (multi-session)
- C1 50-state property tax form catalog (multi-session)
- POS Terminal hardware + EOD
- B3 thread polish (S191)
- A3 thread continuations (S188-S194)
- Primary manager urgency tier (S185)
- Owner-financial-escalation pattern (S186)
- Other POS tables for property scoping (S192)
- D2 Flex tenant suite (launch-flag gated)
- CSV imports (vendor format specs)
- E2 npm upgrades (risky)
- F1 Marketing rebuild

---

End of S199 handoff.
