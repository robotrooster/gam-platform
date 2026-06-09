# Session 178 — closed

## Theme

D1 from the S177 product walkthrough. Restore the architecture
recorded at S90: utilities are line items on the rent invoice,
not separate bills. Subsequent sessions (S122 webhook + S171
tenant frontend Pay flow) had drifted into a parallel
standalone-utility-payment model that broke "one bill per cycle"
UX. S178 wires utility_bills into the invoice generation cron
as type='utility' payment children — matching the existing fee
model — and rips the standalone Pay surface.

## What S178 shipped

### Backend — `jobs/invoiceGeneration.ts` extended

The `runGeneration` shared loop now folds `utility_bills` into
the rent invoice for each cycle. For each lease being invoiced
on a given due_date:

1. **Pre-query** unbilled utility bills via:
   ```sql
   SELECT id, charge_amount FROM utility_bills
    WHERE lease_id = $1
      AND payment_id IS NULL
      AND status IN ('unbilled','billed')
      AND billing_cycle_month <= date_trunc('month', $2::date)::date
    ORDER BY billing_cycle_month ASC, id ASC
   ```
   Catches current-cycle bills + prior-cycle stragglers (late
   meter readings). Future-cycle bills wait their turn.
2. **Compute** combined invoice total: rent + fees + utilities.
3. **Insert** invoice with `subtotal_utilities` set to sum of
   utility children.
4. **Insert** rent + fee children (existing behavior) **+ a
   `payments` row per utility_bill** with `type='utility'`,
   `entry_description='UTILITY'`, `invoice_id` linked.
5. **Stamp** `utility_bills.payment_id`, `status='billed'`,
   `billed_at = COALESCE(billed_at, NOW())` so subsequent invoice
   runs don't double-bill.
6. **Track** counts via the new `utilitiesInserted` field on
   `InvoiceGenResult`.

The dry-run path mirrors the same pre-query (read-only) and
counts what would land. The admin backfill endpoint at
`POST /api/admin/invoices/backfill` automatically picks up the
new field via its `...result` spread on the audit log metadata.

### Backend — `POST /api/utility/bills/:id/pay` retired

The route is now a 410 Gone stub. Pre-S178 it created a separate
`payments` row + fired its own Stripe destination charge — the
exact drift S178 corrects. Stub keeps the route registered so any
cached frontend or third-party caller gets a clean error pointing
to the new path:

```
410 Gone
This endpoint was retired in S178. Pay this utility through
POST /api/payments/<linked_payment_id>/pay (utility now invoices
as a line item on the rent invoice).
```

The 409 sub-state covers the in-flight case ("This utility bill
has not been invoiced yet. It will appear as a line item on your
next rent invoice.") so a tenant who somehow hits the old route
between bill generation and the next invoice cycle gets a
human-readable explanation rather than a 500.

The pre-S178 implementation (~150 lines) was deleted outright —
no commented-out parking-spot. Per the standing "no
half-finished implementations" rule.

### Frontend — `apps/tenant/src/pages/UtilitiesPage.tsx` reverted to view-only

S171 added a Pay Now flow + saved-methods card + add-method
modals against the now-retired endpoint. Reverted to view-only:

- Header simplified: just title + subtitle, no Add bank/card
  buttons.
- Banner now reads "Utility bills appear as line items on your
  monthly rent invoice. Pay them on the [Payments] page along
  with your rent. This page is for usage history."
- Table reduced: removed the "actions" column. Columns kept:
  Cycle / Utility / Meter / Usage / Amount / Status.
- Removed mounts: `<PayNowModal>`, `<AddPaymentMethodModal>`,
  `<SavedMethodsCard>`. Removed the `useTenantPaymentMethods()`
  hook usage. Removed `payTarget` / `addMethodOpen` state +
  associated handlers.
- Imports trimmed: dropped `useState`, `useQueryClient`,
  `apiPost` (none of the shared payShared exports), added
  `Link` from react-router-dom for the inline /payments link.

The S171 column-fix (real wire-response field names —
`chargeAmount`, `billingCycleMonth`, `utilityType`, etc.) is
preserved; only the Pay surface and its imports got removed.

### Files touched (S178)

```
apps/api/src/jobs/invoiceGeneration.ts                                  (+ utility children fold-in; + utilitiesInserted counter; + dry-run pre-query)
apps/api/src/routes/utility.ts                                          (POST /bills/:id/pay → 410 Gone stub; pre-S178 impl deleted)
apps/tenant/src/pages/UtilitiesPage.tsx                                 (reverted to view-only; Pay Now + add-method UI removed; banner + Link to /payments)
```

### Verification

- `cd apps/api && npx tsc --noEmit` exit 0
- `cd apps/landlord && npx tsc --noEmit` exit 0
- `cd apps/tenant && npx tsc --noEmit` exit 0
- `services/utilityBilling.ts` (the engine that creates
  utility_bills) untouched — bill generation still happens via
  `POST /api/utility/generate-bills`. Difference: those rows
  now wait for invoice generation instead of being paid
  separately.
- The S122 webhook handler at `routes/webhooks.ts` is unchanged
  — it already flips `utility_bills.status='paid'` when a
  matching `payments.type='utility'` row settles. With S178 the
  matching row is now a child of the rent invoice; the webhook
  branch still fires correctly because the lookup keys on
  `utility_bills.payment_id`, which S178 now stamps via the
  invoice cron instead of the standalone pay endpoint.

## Decisions made (S178)

| Question | Decision |
|---|---|
| Single Stripe charge per cycle (rent + utilities + fees combined) vs separate child payment rows that all link to the invoice? | Separate child rows, matching the existing fee model. Each row carries the right NACHA `entry_description` (RENT / UTILITY / SUBSCRIP); a combined-charge approach would force one entry_description for the whole batch which is the wrong NACHA shape. From the tenant's perspective they still pay all the lines for a cycle together via the unified /payments page. |
| Backfill old standalone utility payments rows into the new shape? | No. utility_bills with no `payment_id` will get folded in by the next invoice generation pass; bills that already have a `payment_id` from the pre-S178 standalone pay endpoint stay linked to those historical payments. New flow applies forward only. |
| Keep the retired `/api/utility/bills/:id/pay` route as a 410 stub vs delete entirely? | 410 stub. Frontend caches, third-party integrations, or a forgotten cron could still hit the old path. A 410 with a pointer to the right endpoint is far more debuggable than a 404. The stub is ~10 lines; cost is trivial. |
| Should the standalone-utility-pay impl be kept commented as a parking spot? | No. The first edit attempt parked it as a `_RETIRED_*` const arrow; reverted to a clean delete after the fact. Per the standing "no half-finished implementations" rule + "If you are certain that something is unused, you can delete it completely" guidance. |
| Late utility readings (entered after the cycle's rent invoice has been generated/paid) — bill how? | Roll into the NEXT cycle's invoice. The pre-query filter (`billing_cycle_month <= date_trunc('month', $2::date)::date AND payment_id IS NULL`) catches stragglers automatically — a late reading for May creates a utility_bill row that the June invoice picks up. Confirmed in S177 walkthrough. |

## What this session did NOT do

- **No invoice-grouping UI on tenant /payments.** The tenant
  /payments page still renders a flat list of all payments
  (rent, fees, utilities, late fees as separate rows). Each
  shares an `invoiceId` so a future UI session could collapse
  them into per-cycle sections ("May 2026 Bill — $1,332"
  expands into rent / utility / fee lines). Out of scope this
  session — the architectural correction was the priority.
- **No backfill migration for pre-S178 utility_bills.** Bills
  generated before this session that already have `payment_id`
  set from the standalone pay flow stay as-is (historical
  record). Bills with `payment_id IS NULL` get picked up by
  the next invoice cron run.
- **No `payments.type='utility'` audit pass.** The webhook +
  allocation engine already treat type='utility' the same as
  type='rent' for settlement / allocation purposes (per S122
  comments at `webhooks.ts:69`). Not separately verified
  end-to-end this session — flagged in the next-session smoke.

## Carry-forward — what S179 should target

Per S177 product walkthrough, the locked pre-launch queue.
Recommend the order below (sized + sequenced for impact):

1. **A1+A2** — depositReturn extension + admin "Bill X fee"
   button. Move-out balance sweep is the next clean theme;
   touches deposit return, lease detail UI, and a small admin
   surface for the one-off fee path.
2. **A3** — state-hardcoded deposit interest engine. New
   migration with per-state rates, monthly accrual job,
   surfacing on landlord deposit-summary page.
3. **A4** — confirm-no-cosigner-code grep (S177 already
   confirmed zero refs; this is just a tombstone in
   DEFERRED).
4. **B1+B2 coupled** — material-change new-lease workflow +
   late-fee edit confirm modal + addendum generator (notice-
   period-aware).
5. **B3** — per-property `requires_booking_acknowledgment`
   toggle + e-sign integration on bookings.
6. **C1** — 50-state property-state form catalog. Schema +
   seed data + landlord-side dashboard surface (~2 sessions).
7. **D2** — Flex tenant suite + OTP landlord-side + launch-hide
   flag (~3-5 sessions).
8. **Sublease subsystem.**
9. **POS multi-terminal sync + Stripe Terminal + EOD.**
10. **CSV imports for 8 competitors** (parallelizable).
11. **E2** — 4 npm upgrades.
12. **F1** — Marketing rebuild (after Nic's positioning
    paragraph).

Plus DEFERRED's remaining smaller-tracked items.

### Tenant smoke walk (manual; needs Stripe sandbox creds)

Now updated to verify the S178 architecture works end-to-end:
1. Landlord generates a utility_bills row (e.g. via meter
   reading + `POST /api/utility/generate-bills`).
2. Daily invoice cron runs → invoice for the next cycle gets
   created with rent line + utility line.
3. Tenant /payments page shows both rows (rent + utility).
4. Tenant pays the utility row via standard /payments Pay Now
   flow.
5. Webhook flips both `payments.status='settled'` and the
   linked `utility_bills.status='paid'`.
6. Tenant /utilities shows the bill with `status='paid'`.

---

End of S178 handoff.
