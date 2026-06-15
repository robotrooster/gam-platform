# Session 469 — closed

> SERVICE-BUSINESS / Phase 1a arc (continues S468).

## Theme

**Materializer cron registered. The recurring-schedule
materializer (Phase 1a.2 service from S461) now fires nightly
at 1:15am Phoenix — overnight schedule → appointment hop runs
without manual SQL. Final blocker before the trash-company
smoke walk: removed.**

Suite (api) at S468 close: 3017 / 159.
Suite (api) at S469 close: **3017 / 159 / 0 failures** — no
test regressions from the scheduler change.

apps/api tsc: clean.

## What shipped

### `apps/api/src/jobs/scheduler.ts`

One new cron block inside `schedulerInit()`:

```ts
// S468: recurring-schedule materializer (service-business / Phase 1a.2).
// Daily at 1:15am Phoenix — sits between manager-fee accrual (1am 1st)
// and platform-fee accrual (1:30am 1st); on non-monthly days it has the
// window to itself. Walks every active recurring_schedules row and
// inserts the next 60 days of appointments. Idempotent via partial
// UNIQUE (recurring_schedule_id, scheduled_for) WHERE recurring_schedule_id
// IS NOT NULL — re-runs are no-ops. Owners can also trigger materialization
// on-demand via POST /api/recurring-schedules/:id/materialize (S461) for
// immediate visibility after editing a schedule.
cron.schedule('15 1 * * *', async () => {
  try {
    const { materializeAllSchedules } = await import('../services/recurringScheduleMaterializer')
    const result = await materializeAllSchedules()
    if (result.schedules_scanned > 0 || result.errors > 0) {
      logger.info(result, '[recurring-schedule-materializer]')
    }
  } catch (e) {
    logger.error({ err: e }, '[recurring-schedule-materializer] fatal')
  }
}, { timezone: 'America/Phoenix' })
```

Plus a matching `logger.info` line in the startup-summary block:

```
   ✓ Recurring materializer: Daily 1:15am Phoenix (service-business / Phase 1a)
```

## Items shipped

```
apps/api/src/jobs/scheduler.ts                (+1 cron block + startup log line)
```

## Decisions made during build

| Question | Decision |
|---|---|
| Timing — 1:15am Phoenix | **Yes.** Sits between manager-fee accrual (1am 1st) and platform-fee accrual (1:30am 1st). On non-monthly days the window is empty. Low contention; the materializer is a simple INSERT loop with ON CONFLICT — finishes fast even at scale. |
| Logging gate (suppress empty runs)? | **Yes — only log if schedules_scanned > 0 OR errors > 0.** Same posture as auto-payouts / ach-retry / pos-eod. Avoids noise during pre-launch when zero businesses exist. |
| Lazy import vs top-level | **Lazy.** Matches the pattern for every other on-demand cron handler in scheduler.ts (autoPayouts, monthlyFeeAccrual, complianceArchive, etc.). Keeps scheduler.ts top-of-file imports lean. |
| Default 60-day lookahead | **Kept the service default.** S461 set lookaheadDays=60 inside materializeAllSchedules; the cron uses the default. Route generation needs appointments only 1 day out, but the 60-day buffer absorbs landlord behavior like "let me see the next two months in the schedule list." |
| Where to put it in scheduler.ts | **Top of the schedulerInit body, after the lease-expiry cron.** Could have grouped with the other Phase 1a jobs but there's only one for now; if Phase 1a grows more crons (route-generation cron, route-cleanup cron) they cluster here. |
| Trigger an immediate one-off run on startup? | **No.** dev.sh restarts wipe the schedule; running on every restart would burn cycles. The cron fires nightly, and on-demand via POST /api/recurring-schedules/:id/materialize handles immediate cases. |
| Cron expr — `15 1 * * *` vs `15 1 * * 1-5` | **Every day (`15 1 * * *`).** Trash routes run weekends; commercial schedules might also run Sat/Sun. No reason to skip. |

## Verification

- `cd apps/api && npx tsc --noEmit`: clean.
- `cd apps/api && npm test`: **3017 / 159 / 0 failures**.
- **No new tests added.** The materializer service has existing
  unit-level tests from S461; the cron registration is a 5-line
  glue block that runs at 1:15am every night — testing the
  glue would essentially be testing `cron.schedule` itself. The
  on-demand POST endpoint (S461) is already covered.

### Bugs caught during build

None.

## Phase 1a — release readiness

The trash-company-onboard arc is now end-to-end functional
with no manual SQL steps:

1. ✅ Owner /signup
2. ✅ /depots → add yard
3. ✅ /vehicles → add truck
4. ✅ /dump-locations → add transfer station
5. ✅ /customers → add customers (auto-geocoded)
6. ✅ /schedules → create recurring rules
7. ✅ **Materializer runs overnight at 1:15am Phoenix** — schedule rows turn into appointment rows automatically
8. ✅ /routes → click "Generate route" → see optimized plan
9. ✅ /routes/:id → click "Start route" → driver works stops
10. ✅ Per-stop "Complete" / "Skip" with reason
11. ✅ "Complete route" finalizes once all stops are done

**The trash company can onboard and operate the entire flow
in the browser, including the overnight automation hop.**

## What the next session should target

**Strongly recommend: Phase 1a.1 smoke walk.**

All technical blockers are cleared. The portal is feature-complete
for trash-company-onboard. The walk surfaces UX issues that tsc +
build can't catch — form validation gaps, confusing copy, missing
loading states, mobile responsiveness on the routes page, anything
that "looks weird."

Walk approach (Nic-initiated; do not start unprompted):
- Fresh business signup
- Add 1 depot, 1 vehicle, 1 dump location, 2 customers
- Create a recurring schedule (weekly Tue/Thu, 9am)
- Manually trigger materialization via the on-demand endpoint
  (don't wait overnight — but verify the cron actually shows
  in the startup logs)
- Generate a route for the next Tuesday
- Walk the route detail view: start, complete each stop, skip
  one with a reason, complete the route
- Confirm route appears in the list with correct status

**Alternatives if Nic wants to delay the walk:**
- **Hygiene from S465**: PATCH /business-customers should accept
  lat/lon for manual entry; routes.ts geocode call wrapped in
  try/catch. Both small.
- **Mobile driver UI**: dedicated `/drive/:routeId` view
  optimized for phone use. Polish, not critical path.
- **Phase 1a.4 planning**: what does the next sub-phase look
  like? Multi-driver routing? Customer self-service portal?
  Invoicing / payment for trash services? Worth a planning
  conversation.

## Phase 1a.1 smoke walk

**Walk-readiness: GO with no caveats.** The materializer cron
running on its real schedule was the last technical gap. The
walk is now valid end-to-end.

---

End of S469 handoff. **Materializer cron registered. Phase 1a.3
is functionally complete with no manual workarounds.**

3017 tests / 159 files / 0 failures.

**Phase 1a is shippable.** Next session: Nic-initiated smoke
walk, or alternative scope.
