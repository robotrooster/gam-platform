# SESSION 539 HANDOFF

## Theme
Small, single-target session: tenant-facing FIFO polish (S537 deferred
#4 / S538 deferred #2) — the per-line "where every dollar went"
breakdown from remittance_applications, stored since S537 but never
surfaced, now renders in the tenant portal.

## Shipped (tsc clean api+tenant; suite green; verified live in browser)

### 1. GET /api/payments/remittances (tenant-only)
- routes/payments.ts, added between balance-context and pay-balance
  (no GET /:id on this router, so no ordering hazard).
- Returns the tenant's last 50 tenant_remittances (amount, applied,
  unapplied, status, method, created/settled) each with its
  remittance_applications lines joined to the covered payment rows
  (type, due_date, entry_description, payment_status), lines ordered
  oldest-first — same order the allocator applied them.
- Also returns prepaidRemaining = SUM(lease_prepaid_credits.
  amount_remaining) for the tenant (credits not yet consumed by
  invoice generation).

### 2. Tenant PaymentsPage — "Payments you've made" card
- New RemittancesCard between the SecurityDepositCard and the charges
  table. Renders ONLY when the tenant has remittances or prepaid
  credit (no clutter for tenants who never used Pay Now).
- Header: prepaid-credit chip ("$X — applies to your next bill
  automatically", green) when remaining > 0.
- Each remittance = one expandable row (date, amount, ACH/Card badge,
  status badge via existing STATUS_BADGE map). Expanded: per-line
  table (Applied to / Due / Amount) + a green "Paid ahead" line for
  unapplied_amount (copy switches banked vs will-bank on settle
  status). Failed remittances show "nothing was applied — charges
  returned to your outstanding balance" above the lines.
- Read-only by design — same posture as the outstanding ledger; the
  tenant never picks targets but always sees where each dollar went.
- Entry descriptions that just restate the type (RENT/LATEFEE) are
  suppressed next to the humanized type badge (norm() compare).
- refetchAll invalidates 'remittances' alongside the other queries.

### 3. Tests
- s537-payment-fifo.test.ts extended (4→6 cases, all green):
  full-flow case (pay 550 over fee 60 + rent 440 → settle webhook →
  GET returns lines [late_fee 60, rent 440] oldest-first with charge
  context, applied 500 / unapplied 50, prepaidRemaining 50) + 403 for
  non-tenant callers.
- Rent settle runs the allocation engine, so the new case seeds
  seedAllocationRule + a GUARDED processing-rate insert
  (platform_processing_rates survives cleanupAllSchema — suite
  convention is INSERT ... WHERE NOT EXISTS; a raw seedProcessingRate
  would stack rows across runs).

## Fix-it-right catches
- First render showed "Invalid Date"/missing fields: the API's global
  response transformer camelCases all keys (createdAt, amountApplied,
  dueDate...). Frontend types/usages written snake_case initially —
  fixed to camelCase. NOTE: the route tests hit paymentsRouter
  directly (no transformer middleware), so test assertions correctly
  use snake_case; don't "fix" that mismatch.
- dueDate is a plain YYYY-MM-DD string → sliced + 'T00:00:00' before
  new Date() so Phoenix TZ doesn't display the prior day (per the
  standing dates rule).

## Verification
- 6/6 s537-payment-fifo suite; tsc clean on api + tenant.
- Live: seeded a settled $2,350 remittance (May+June rent full cover
  + $50 pay-ahead) + matching prepaid credit for alice@tenant.dev,
  verified card, expansion, oldest-first lines, paid-ahead line, and
  prepaid chip in the browser (DOM + network + console clean), then
  DELETED the seed rows (tenant_remittances count back to 0).
- Browser-pane screenshots were serving stale/black frames this
  session (pane compositor glitch, same ghost-frame class as the S537
  macOS forensics); DOM/text/network reads were used as proof instead.
  Not an app issue — console was clean throughout.

## Decisions made
- Claude (flag if wrong): card placement below SecurityDepositCard /
  above the charges table; card hidden entirely when there's nothing
  to show; remittance list capped at last 50.

## Files touched
- api: routes/payments.ts (new GET /payments/remittances),
  routes/s537-payment-fifo.test.ts (2 new cases + guarded rate seed).
- tenant: pages/PaymentsPage.tsx (RemittancesCard + types + query).
- No migrations. No shared-package changes.

## Deferred / next session targets
(unchanged from S538 — this session closed S538 deferred #2)
1. Storefront subdomains + customer-facing recurring product orders
   (explicitly future per Nic 2026-07-11).
2. Nic-gated: Stripe live keys → FlexPay flip + tap test + launch
   flips; Checkr key; W-56 work-trade walk; DoorLoop tenants export
   for Oak Park; bless business fee numbers (terminal 2.9%+10¢,
   invoice 3.25%+30¢); bless STR fold-under-min.

## Watchouts
- The landlord side has no remittance surface yet — landlords see the
  split rows in Payments but not the grouped "one Pay Now covered
  these N charges" view. Build if Nic wants parity.
- payments/:id/pay endpoint still live (unchanged from S537 watchout).
