/**
 * S655 money plan P2 — write the credit ledger's history, once, at deploy.
 *
 * Runs AFTER the M1–M12 migrations and BEFORE the new code (the old code keeps
 * spending credit its old way until the restart, so run it in a quiet window
 * and re-run its guard if the deploy slips). One transaction, with
 * `SET LOCAL gam.credit_backfill = 'on'`: every use it writes is source
 * 'backfill' and records a spend that ALREADY lowered a credit's balance, so
 * the ledger trigger leaves amount_remaining alone.
 *
 * DRY BY DEFAULT: prints what it would write and rolls back. DRY=0 commits.
 *   cd ~/gam/apps/api && npx ts-node -T src/scripts/oct3_money_history_backfill.ts
 *   cd ~/gam/apps/api && DRY=0 npx ts-node -T src/scripts/oct3_money_history_backfill.ts
 *
 * What it writes:
 *   1. FUNDING. Every paid-ahead credit gets funded_by and received_at. All of
 *      production's were money the landlord took (desk surpluses, a posted
 *      check): 'landlord', received the moment the money was taken (the
 *      receipt's settle time, else when it was recorded). One that came through
 *      Stripe (a card or bank remittance) or a platform-held payment is 'gam'.
 *   2. RECEIPTS. One tenant_remittances receipt per historical desk action
 *      (settled cash, check and money-order rows grouped by tenant, landlord,
 *      the same settled_at and method; gross_amount NULL — no card fee). Its
 *      amount is what was handed over: Σ (row − credit known to have paid part
 *      of it) + any paid-ahead money banked in that same action (same lease,
 *      same second) as unapplied_amount, and that credit points back at it.
 *      remittance_applications per row with money on it. A desk action with no
 *      money in it ($0 rows) writes none; prior arrangements write none; rows a
 *      receipt already covers (a posted payment) are left alone.
 *   3. SPENDS as credit_uses ('applied', dated when they happened):
 *      - Kim Harland: the $450 Move In Special on her September rent (desk,
 *        9/9, on her money-order receipt). The trigger sets that rent's
 *        issued_credit_amount = 450, so Oak Park's September drops $450 under
 *        "Money received" (a credit the landlord gives is never income).
 *      - the Oct 1 bill-run draws of paid-ahead money (lease_prepaid_credit_draws:
 *        RV 52 $14.70, MH 04 $460, MH 08 $460, RV 33 $5.22), each matched to the
 *        one charge it settled.
 *      - Russ Fuller (decision): his $37.60 "carried-forward overpayment" was
 *        CASH paid ahead before GAM (received Aug 12), not a landlord credit. It
 *        is re-recorded as landlord-held paid-ahead money; its three spends
 *        ($5.22 and $25.00 at the Oct 1 bill run, $7.38 at the desk Oct 1 17:03)
 *        move onto it; the tenant credit is restored to $37.60 and voided; the
 *        two Oct 1 notes say "paid from money paid ahead (Aug 12)".
 *   4. WITHDRAWN. Kim Harland's $0.55 (4cd989a7) — Nic, 10/3: the money order
 *      was $485.45, typed in as $486.00; nothing was paid ahead. It was zeroed
 *      by hand (2026-10-03 11:09:46 Phoenix — voided_at records THAT moment,
 *      not this run's); it is now withdrawn the ledger's way (voided_at,
 *      reason, and its remaining restored so the books add up). Her receipt is
 *      $485.45.
 *      PRECONDITION FOR DRY=0 — ENFORCED: a withdrawn credit keeps
 *      amount_remaining (I1 needs original = remaining + uses), so every reader
 *      of lease_prepaid_credits.amount_remaining must already filter
 *      `voided_at IS NULL`, or the $0.55 shows again — and the move-out pool
 *      would refund money that never arrived. Before it commits, the script
 *      scans the code it ships with (unfilteredPaidAheadReaders) and REFUSES
 *      DRY=0 while any such read lacks the filter; a dry run lists them. Still
 *      unfiltered on 10/3: routes/leases.ts ~314 (prepaid_credit_remaining,
 *      the monthly-draw control: no step owns that line yet) and
 *      services/depositReturn.ts (the move-out preview ~367 and the finalize
 *      pool ~650, Step 9). (Russ's tenant credit is voided with status 'void';
 *      every tenant_credits reader already filters status = 'active'.)
 *      The OLD code that runs until the restart (P3) filters nothing — it has
 *      no voided_at — so run DRY=0 right before the restart, never hours ahead.
 *   5. Manual receipts get gross_amount NULL (the admin "moved through Stripe"
 *      card summed Glenda's $460 check).
 * MH 25's $10 and every other untouched credit stay exactly as they are.
 *
 * THE GUARD: it refuses (and writes nothing) if it finds a charge noted
 * "covered by account credit" or "covered by prepaid credit" that it does not
 * know, a draw it cannot match to exactly one charge, or any credit whose
 * spent amount it cannot fully explain (a desk payment netted by credit it
 * does not know about shows up here: the credit dropped with no record).
 * It ends with invariants I1–I3 and refuses if any fails. Re-running is safe:
 * everything already written is recognized and skipped.
 */
import type { PoolClient } from 'pg'
import { checkMoneyInvariants, printInvariantReport, type InvariantReport } from './oct3_money_invariants_check'

// ─── What production's history is ─────────────────────────────────────────────

export interface KnownSpend {
  paymentId: string
  amount: number
  /** When it was spent (the settle that used it). */
  appliedAt: string
  billingMonth: string
  /** Spent at the desk: the use rides that desk action's receipt. */
  deskAction?: boolean
  /** Appended to the charge's note. */
  appendNote?: string
}

export interface KnownHistory {
  /** Landlord-issued credit that paid part of a charge. */
  issuedSpends: Array<KnownSpend & { tenantCreditId: string; label: string }>
  /** Tenant credits that were really cash paid ahead (re-recorded as paid-ahead money). */
  reRecorded: Array<{
    tenantCreditId: string; leaseId: string; receivedAt: string; note: string; voidNote: string
    spends: KnownSpend[]; label: string
  }>
  /**
   * Paid-ahead credits zeroed by hand that were never really there. voidedAt:
   * when it was withdrawn (zeroed by hand); without it, the credit's
   * updated_at as it stands before this run touches the row.
   */
  voidedPaidAhead: Array<{ creditId: string; reason: string; label: string; voidedAt?: string }>
}

export const PRODUCTION_HISTORY: KnownHistory = {
  issuedSpends: [{
    label: 'Kim Harland — Move In Special on September rent',
    tenantCreditId: 'e063a957-d1c4-43da-b57d-a379ca75c9b3',
    paymentId: '76262ebb-9cd5-4a8b-ba33-cc10d1c5ca46',
    amount: 450,
    appliedAt: '2026-09-09T11:27:54.174213-07:00',
    billingMonth: '2026-09-01',
    deskAction: true,
  }],
  reRecorded: [{
    label: 'Russ Fuller — $37.60 cash paid ahead before GAM',
    tenantCreditId: '5dded090-e217-48f5-b795-632f82f45430',
    leaseId: 'f5d6de02-863c-488f-b0df-53b52b6f5c26',
    receivedAt: '2026-08-12T12:00:00-07:00',
    note: 'Paid ahead before GAM (was entered as a credit)',
    voidNote: 're-recorded as cash paid ahead (received Aug 12)',
    spends: [
      { paymentId: '9d85d800-d82b-4a54-ab84-7a0d5b6fea1a', amount: 5.22, appliedAt: '2026-10-01T07:00:01.126724-07:00', billingMonth: '2026-10-01', appendNote: 'paid from money paid ahead (Aug 12)' },
      { paymentId: 'bfa97588-4142-4eb9-b7c2-4904835aebcd', amount: 25.00, appliedAt: '2026-10-01T07:00:01.126724-07:00', billingMonth: '2026-10-01', appendNote: 'paid from money paid ahead (Aug 12)' },
      { paymentId: 'abeb37a9-f8f6-4448-9bba-d027322ba85f', amount: 7.38, appliedAt: '2026-10-01T17:03:42.064346-07:00', billingMonth: '2026-10-01', deskAction: true },
    ],
  }],
  voidedPaidAhead: [{
    label: 'Kim Harland — $0.55 that was never paid ahead',
    creditId: '4cd989a7-60e2-4090-9cef-ceb3908a88de',
    reason: 'Money order 55109266912 was $485.45, typed in as $486.00 — nothing was paid ahead (Nic, 10/3)',
    // When Nic zeroed it by hand (production updated_at, read-only check 10/3).
    voidedAt: '2026-10-03T11:09:46.700475-07:00',
  }],
}

const RECEIPT_NOTE = 'Desk receipt recorded from history (S655)'
const cents = (v: number | string | null | undefined): number => Math.round(Number(v ?? 0) * 100)
const dollars = (c: number): string => (c / 100).toFixed(2)

// ─── The report ───────────────────────────────────────────────────────────────

export interface BackfillReport {
  fundingStamped: Array<{ creditId: string; fundedBy: string; receivedAt: string }>
  voided: Array<{ creditId: string; restoredTo: string; reason: string; voidedAt: string }>
  reRecordedCredits: Array<{ tenantCreditId: string; paidAheadCreditId: string; amount: string }>
  receipts: Array<{
    remittanceId: string; tenantId: string; landlordId: string; leaseId: string | null; method: string
    settledAt: string; amount: string; applied: string; unapplied: string; rows: number; creditIds: string[]
  }>
  skippedActions: Array<{ tenantId: string; settledAt: string; method: string; reason: string }>
  uses: Array<{ useId: string; credit: string; paymentId: string; amount: string; appliedAt: string; remittanceId: string | null }>
  tenantCreditsVoided: Array<{ tenantCreditId: string; restoredTo: string }>
  notesAppended: string[]
  grossCleared: number
  invariants: InvariantReport
}

export class BackfillRefused extends Error {
  constructor(public refusals: string[]) {
    super(`The money history backfill refused — nothing was written:\n  - ${refusals.join('\n  - ')}`)
  }
}

interface DeskRow {
  id: string; tenant_id: string; landlord_id: string; lease_id: string | null; settled_at: string
  settled_key: string; manual_method: string; amount: string; notes: string | null; has_app: boolean
}
interface DrawRow {
  id: string; lease_id: string; credit_id: string; payment_id: string | null; amount: string
  billing_month: string; created_at: string; matches: string[]
}

/**
 * Write the history on the caller's client, inside the caller's transaction.
 * Throws BackfillRefused (the caller rolls back) when the guard or I1–I3 fail.
 */
export async function runMoneyHistoryBackfill(client: PoolClient, history: KnownHistory = PRODUCTION_HISTORY): Promise<BackfillReport> {
  await client.query(`SET LOCAL gam.credit_backfill = 'on'`)
  const report: BackfillReport = {
    fundingStamped: [], voided: [], reRecordedCredits: [], receipts: [], skippedActions: [],
    uses: [], tenantCreditsVoided: [], notesAppended: [], grossCleared: 0,
    invariants: { ok: false, results: [] },
  }
  const refusals: string[] = []

  // ── Read everything first ──────────────────────────────────────────────────
  const draws = (await client.query<DrawRow>(
    `SELECT d.id, d.lease_id, d.credit_id, d.payment_id, d.amount::text AS amount,
            to_char(d.billing_month, 'YYYY-MM-DD') AS billing_month, d.created_at::text AS created_at,
            CASE WHEN d.payment_id IS NOT NULL THEN ARRAY[d.payment_id::text]
                 ELSE ARRAY(SELECT p.id::text FROM payments p
                             WHERE p.lease_id = d.lease_id AND p.settled_at = d.created_at
                               AND p.amount = d.amount AND p.status = 'settled'
                               AND p.notes ILIKE '%covered by prepaid credit%'
                             ORDER BY p.id) END AS matches
       FROM lease_prepaid_credit_draws d ORDER BY d.created_at, d.id`)).rows
  for (const d of draws) {
    if (d.matches.length !== 1) {
      refusals.push(`draw ${d.id} ($${d.amount} on lease ${d.lease_id} at ${d.created_at}) matches ${d.matches.length} charges`)
    }
  }
  const drawPayment = (d: DrawRow): string | null => (d.matches.length === 1 ? d.matches[0] : null)

  const existingUses = (await client.query<{ tenant_credit_id: string | null; prepaid_credit_id: string | null; payment_id: string | null; status: string; amount: string; source: string }>(
    `SELECT tenant_credit_id, prepaid_credit_id, payment_id, status, amount::text, source FROM credit_uses`)).rows
  const useExists = (creditId: string, paymentId: string) =>
    existingUses.some(u => (u.tenant_credit_id === creditId || u.prepaid_credit_id === creditId) && u.payment_id === paymentId)
  const liveUses = (creditId: string) => existingUses
    .filter(u => (u.tenant_credit_id === creditId || u.prepaid_credit_id === creditId) && (u.status === 'held' || u.status === 'applied'))
    .reduce((s, u) => s + cents(u.amount), 0)

  // Russ's re-recorded credit, if an earlier run already wrote it.
  const reRecordedIds = new Map<string, string>()
  for (const rr of history.reRecorded) {
    const ex = await client.query<{ id: string }>(
      `SELECT id FROM lease_prepaid_credits WHERE lease_id = $1 AND note = $2 ORDER BY created_at LIMIT 1`, [rr.leaseId, rr.note])
    if (ex.rows[0]) reRecordedIds.set(rr.tenantCreditId, ex.rows[0].id)
  }

  // ── The guard: every credit-noted charge known ─────────────────────────────
  const knownPayments = new Set<string>([
    ...history.issuedSpends.map(s => s.paymentId),
    ...history.reRecorded.flatMap(r => r.spends.map(s => s.paymentId)),
    ...draws.map(drawPayment).filter((x): x is string => !!x),
  ])
  const noted = (await client.query<{ id: string; notes: string }>(
    `SELECT id, notes FROM payments
      WHERE notes ILIKE '%covered by account credit%' OR notes ILIKE '%covered by prepaid credit%'
      ORDER BY id`)).rows
  for (const n of noted) {
    if (!knownPayments.has(n.id)) refusals.push(`charge ${n.id} is noted "${n.notes.slice(0, 80)}" but the backfill does not know that spend`)
  }
  for (const pid of knownPayments) {
    const ok = await client.query(`SELECT 1 FROM payments WHERE id = $1`, [pid])
    if (!ok.rowCount) refusals.push(`known charge ${pid} is missing`)
  }

  // ── The guard: every credit's spent amount explained ───────────────────────
  const tcs = (await client.query<{ id: string; amount_original: string; amount_remaining: string; status: string }>(
    `SELECT id, amount_original::text, amount_remaining::text, status FROM tenant_credits ORDER BY id`)).rows
  const voidRestores: Array<{ id: string; to: number }> = []
  for (const tc of tcs) {
    const gap = cents(tc.amount_original) - cents(tc.amount_remaining)
    const rr = history.reRecorded.find(r => r.tenantCreditId === tc.id)
    if (rr) {
      if (tc.status === 'void') continue   // done on an earlier run
      const spent = rr.spends.reduce((s, x) => s + cents(x.amount), 0)
      if (gap !== spent || liveUses(tc.id) !== 0) refusals.push(`credit ${tc.id} (${rr.label}): $${dollars(gap)} spent, $${dollars(spent)} known`)
      continue
    }
    const pending = history.issuedSpends.filter(s => s.tenantCreditId === tc.id && !useExists(tc.id, s.paymentId))
      .reduce((s, x) => s + cents(x.amount), 0)
    const explained = liveUses(tc.id) + pending
    if (gap === explained) continue
    if (tc.status === 'void' && gap > explained) {
      // The old void route zeroed what was left. A void now leaves it alone.
      voidRestores.push({ id: tc.id, to: cents(tc.amount_original) - explained })
      continue
    }
    refusals.push(`credit ${tc.id}: $${dollars(gap)} spent, only $${dollars(explained)} explained`)
  }

  const pcs = (await client.query<{ id: string; amount_original: string; amount_remaining: string; voided_at: string | null }>(
    `SELECT id, amount_original::text, amount_remaining::text, voided_at::text FROM lease_prepaid_credits ORDER BY id`)).rows
  for (const pc of pcs) {
    if ([...reRecordedIds.values()].includes(pc.id)) continue
    const gap = cents(pc.amount_original) - cents(pc.amount_remaining)
    const kv = history.voidedPaidAhead.find(v => v.creditId === pc.id)
    const pendingDraws = draws.filter(d => d.credit_id === pc.id && drawPayment(d) && !useExists(pc.id, drawPayment(d)!))
      .reduce((s, d) => s + cents(d.amount), 0)
    const explained = liveUses(pc.id) + pendingDraws
    if (kv && !pc.voided_at) {
      if (explained !== 0) refusals.push(`paid-ahead ${pc.id} (${kv.label}) has spends; it cannot be withdrawn`)
      continue
    }
    if (gap !== explained) refusals.push(`paid-ahead ${pc.id}: $${dollars(gap)} spent, only $${dollars(explained)} explained`)
  }

  if (refusals.length) throw new BackfillRefused(refusals)

  // When each withdrawn credit was zeroed by hand — read BEFORE step 1, whose
  // funding stamp moves updated_at to this run's time.
  const withdrawnAt = new Map<string, string>()
  for (const v of history.voidedPaidAhead) {
    const r = await client.query<{ updated_at: string }>(
      `SELECT updated_at::text AS updated_at FROM lease_prepaid_credits WHERE id = $1 AND voided_at IS NULL`, [v.creditId])
    if (r.rows[0]) withdrawnAt.set(v.creditId, v.voidedAt ?? r.rows[0].updated_at)
  }

  // ── 1. Funding ─────────────────────────────────────────────────────────────
  const unstamped = (await client.query<{ id: string; gam: boolean; received_at: string }>(
    `SELECT c.id,
            ((r.payment_method IN ('ach','card') AND r.stripe_payment_intent_id IS NOT NULL)
              OR COALESCE(sp.platform_held, false)) AS gam,
            COALESCE(r.settled_at, c.created_at)::text AS received_at
       FROM lease_prepaid_credits c
       LEFT JOIN tenant_remittances r ON r.id = c.source_remittance_id
       LEFT JOIN payments sp ON sp.id = c.source_payment_id
      WHERE c.funded_by IS NULL
      ORDER BY c.id`)).rows
  for (const u of unstamped) {
    const fundedBy = u.gam ? 'gam' : 'landlord'
    await client.query(
      `UPDATE lease_prepaid_credits SET funded_by = $2, received_at = COALESCE(received_at, $3::timestamptz), updated_at = now()
        WHERE id = $1`, [u.id, fundedBy, u.received_at])
    report.fundingStamped.push({ creditId: u.id, fundedBy, receivedAt: u.received_at })
  }

  // ── 4. Withdrawn paid-ahead (before receipts: it is not "banked in the action") ──
  for (const v of history.voidedPaidAhead) {
    const at = withdrawnAt.get(v.creditId)
    if (!at) continue   // already withdrawn on an earlier run
    const r = await client.query<{ amount_original: string; voided_at: string }>(
      `UPDATE lease_prepaid_credits
          SET amount_remaining = amount_original, voided_at = $3::timestamptz, void_reason = $2, updated_at = now()
        WHERE id = $1 AND voided_at IS NULL
        RETURNING amount_original::text, voided_at::text`, [v.creditId, v.reason, at])
    if (r.rows[0]) report.voided.push({ creditId: v.creditId, restoredTo: r.rows[0].amount_original, reason: v.reason, voidedAt: r.rows[0].voided_at })
  }

  // ── 3a. Russ: the re-recorded paid-ahead credit ────────────────────────────
  for (const rr of history.reRecorded) {
    if (reRecordedIds.has(rr.tenantCreditId)) continue
    const tc = (await client.query<{ tenant_id: string; amount_original: string }>(
      `SELECT tenant_id, amount_original::text FROM tenant_credits WHERE id = $1`, [rr.tenantCreditId])).rows[0]
    const spent = rr.spends.reduce((s, x) => s + cents(x.amount), 0)
    const ins = await client.query<{ id: string }>(
      `INSERT INTO lease_prepaid_credits
         (lease_id, tenant_id, amount_original, amount_remaining, note, funded_by, received_at)
       VALUES ($1, $2, $3, $4, $5, 'landlord', $6) RETURNING id`,
      [rr.leaseId, tc.tenant_id, tc.amount_original, dollars(cents(tc.amount_original) - spent), rr.note, rr.receivedAt])
    reRecordedIds.set(rr.tenantCreditId, ins.rows[0].id)
    report.reRecordedCredits.push({ tenantCreditId: rr.tenantCreditId, paidAheadCreditId: ins.rows[0].id, amount: tc.amount_original })
  }

  // ── 2. Receipts for desk actions ───────────────────────────────────────────
  const known = new Map<string, number>()   // credit known to have paid part of a row
  for (const s of history.issuedSpends) known.set(s.paymentId, (known.get(s.paymentId) ?? 0) + cents(s.amount))
  for (const rr of history.reRecorded) for (const s of rr.spends) known.set(s.paymentId, (known.get(s.paymentId) ?? 0) + cents(s.amount))
  for (const d of draws) { const p = drawPayment(d); if (p) known.set(p, (known.get(p) ?? 0) + cents(d.amount)) }

  const desk = (await client.query<DeskRow>(
    `SELECT p.id, p.tenant_id, p.landlord_id, p.lease_id, p.settled_at::text AS settled_at,
            to_char(p.settled_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US') AS settled_key,
            p.manual_method, p.amount::text AS amount, p.notes,
            EXISTS (SELECT 1 FROM remittance_applications ra WHERE ra.payment_id = p.id) AS has_app
       FROM payments p
      WHERE p.status = 'settled' AND p.manual_method IN ('cash','check','money_order')
        AND p.tenant_id IS NOT NULL AND p.settled_at IS NOT NULL
      ORDER BY p.settled_at, p.id`)).rows
  const actions = new Map<string, DeskRow[]>()
  for (const r of desk) {
    const k = `${r.tenant_id}|${r.landlord_id}|${r.settled_key}|${r.manual_method}`
    actions.set(k, [...(actions.get(k) ?? []), r])
  }
  const receiptOfPayment = new Map<string, string>()
  for (const rows of actions.values()) {
    const first = rows[0]
    if (rows.some(r => r.has_app)) {
      // A receipt already covers this action (a posted payment); find it for the uses.
      const ra = await client.query<{ remittance_id: string }>(
        `SELECT remittance_id FROM remittance_applications WHERE payment_id = ANY($1::uuid[]) LIMIT 1`, [rows.map(r => r.id)])
      for (const r of rows) if (ra.rows[0]) receiptOfPayment.set(r.id, ra.rows[0].remittance_id)
      continue
    }
    const money = rows.map(r => ({ row: r, c: Math.max(0, cents(r.amount) - (known.get(r.id) ?? 0)) }))
    const appliedC = money.reduce((s, m) => s + m.c, 0)
    const leaseIds = [...new Set(rows.map(r => r.lease_id).filter((x): x is string => !!x))]
    const banked = leaseIds.length === 0 ? [] : (await client.query<{ id: string; amount_original: string }>(
      `SELECT c.id, c.amount_original::text
         FROM lease_prepaid_credits c
        WHERE c.lease_id = ANY($1::uuid[]) AND c.voided_at IS NULL AND c.source_remittance_id IS NULL
          AND c.source_payment_id IS NULL
          AND abs(extract(epoch FROM c.created_at - $2::timestamptz)) < 1
        ORDER BY c.id`, [leaseIds, first.settled_at])).rows
    const unappliedC = banked.reduce((s, b) => s + cents(b.amount_original), 0)
    const totalC = appliedC + unappliedC
    if (totalC <= 0) {
      report.skippedActions.push({ tenantId: first.tenant_id, settledAt: first.settled_at, method: first.manual_method, reason: 'no money in this action' })
      continue
    }
    if (banked.length > 1) {
      // One receipt funds at most one paid-ahead credit (ux_lease_prepaid_credits_source_remittance).
      throw new BackfillRefused([`desk action ${first.settled_at} (tenant ${first.tenant_id}) banked ${banked.length} paid-ahead credits`])
    }
    const counts = new Map<string, number>()
    for (const r of rows) if (r.lease_id) counts.set(r.lease_id, (counts.get(r.lease_id) ?? 0) + 1)
    const leaseId = [...counts.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))[0]?.[0] ?? null
    const ref = rows.map(r => /\(ref ([^)]+)\)/.exec(r.notes ?? '')?.[1]).find(Boolean) ?? null
    const rem = await client.query<{ id: string }>(
      `INSERT INTO tenant_remittances
         (tenant_id, lease_id, landlord_id, amount, applied_amount, unapplied_amount, status, payment_method,
          gross_amount, processing_fee_amount, settled_at, created_at, reference, notes)
       VALUES ($1, $2, $3, $4, $5, $6, 'settled', $7, NULL, 0, $8::timestamptz, $8::timestamptz, $9, $10)
       RETURNING id`,
      [first.tenant_id, leaseId, first.landlord_id, dollars(totalC), dollars(appliedC), dollars(unappliedC),
       first.manual_method, first.settled_at, ref, RECEIPT_NOTE])
    const remittanceId = rem.rows[0].id
    for (const m of money) {
      receiptOfPayment.set(m.row.id, remittanceId)
      if (m.c > 0) {
        await client.query(
          `INSERT INTO remittance_applications (remittance_id, payment_id, amount_applied, created_at)
           VALUES ($1, $2, $3, $4::timestamptz)`, [remittanceId, m.row.id, dollars(m.c), first.settled_at])
      }
    }
    for (const b of banked) {
      await client.query(`UPDATE lease_prepaid_credits SET source_remittance_id = $2, updated_at = now() WHERE id = $1`, [b.id, remittanceId])
    }
    report.receipts.push({
      remittanceId, tenantId: first.tenant_id, landlordId: first.landlord_id, leaseId, method: first.manual_method,
      settledAt: first.settled_at, amount: dollars(totalC), applied: dollars(appliedC), unapplied: dollars(unappliedC),
      rows: rows.length, creditIds: banked.map(b => b.id),
    })
  }

  // ── 3b. The spends ─────────────────────────────────────────────────────────
  const writeUse = async (credit: { tenantCreditId?: string; prepaidCreditId?: string }, s: KnownSpend, leaseOf: string | null) => {
    const creditId = (credit.tenantCreditId ?? credit.prepaidCreditId)!
    if (useExists(creditId, s.paymentId)) return
    const lease = leaseOf ?? (await client.query<{ lease_id: string }>(`SELECT lease_id FROM payments WHERE id = $1`, [s.paymentId])).rows[0].lease_id
    const remittanceId = s.deskAction ? (receiptOfPayment.get(s.paymentId) ?? null) : null
    const r = await client.query<{ id: string }>(
      `INSERT INTO credit_uses
         (tenant_credit_id, prepaid_credit_id, payment_id, remittance_id, lease_id, amount, billing_month,
          source, status, held_at, applied_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7::date, 'backfill', 'applied', $8::timestamptz, $8::timestamptz)
       RETURNING id`,
      [credit.tenantCreditId ?? null, credit.prepaidCreditId ?? null, s.paymentId, remittanceId, lease,
       dollars(cents(s.amount)), s.billingMonth, s.appliedAt])
    existingUses.push({ tenant_credit_id: credit.tenantCreditId ?? null, prepaid_credit_id: credit.prepaidCreditId ?? null, payment_id: s.paymentId, status: 'applied', amount: dollars(cents(s.amount)), source: 'backfill' })
    report.uses.push({ useId: r.rows[0].id, credit: creditId, paymentId: s.paymentId, amount: dollars(cents(s.amount)), appliedAt: s.appliedAt, remittanceId })
  }
  for (const s of history.issuedSpends) await writeUse({ tenantCreditId: s.tenantCreditId }, s, null)
  for (const rr of history.reRecorded) {
    for (const s of rr.spends) await writeUse({ prepaidCreditId: reRecordedIds.get(rr.tenantCreditId)! }, s, rr.leaseId)
  }
  for (const d of draws) {
    const pid = drawPayment(d)!
    await writeUse({ prepaidCreditId: d.credit_id }, { paymentId: pid, amount: Number(d.amount), appliedAt: d.created_at, billingMonth: d.billing_month }, d.lease_id)
  }

  // ── Russ's tenant credit: restored whole, then voided ──────────────────────
  for (const rr of history.reRecorded) {
    const r = await client.query<{ amount_original: string }>(
      `UPDATE tenant_credits
          SET amount_remaining = amount_original, status = 'void', voided_at = now(), updated_at = now(),
              reason = COALESCE(reason || ' — ', '') || 'void: ' || $2
        WHERE id = $1 AND status = 'active'
        RETURNING amount_original::text`, [rr.tenantCreditId, rr.voidNote])
    if (r.rows[0]) report.tenantCreditsVoided.push({ tenantCreditId: rr.tenantCreditId, restoredTo: r.rows[0].amount_original })
    for (const s of rr.spends) {
      if (!s.appendNote) continue
      const n = await client.query(
        `UPDATE payments SET notes = COALESCE(notes || ' — ', '') || $2
          WHERE id = $1 AND COALESCE(notes, '') NOT LIKE '%' || $2 || '%'`, [s.paymentId, s.appendNote])
      if (n.rowCount) report.notesAppended.push(s.paymentId)
    }
  }
  for (const v of voidRestores) {
    await client.query(`UPDATE tenant_credits SET amount_remaining = $2, updated_at = now() WHERE id = $1`, [v.id, dollars(v.to)])
    report.tenantCreditsVoided.push({ tenantCreditId: v.id, restoredTo: dollars(v.to) })
  }

  // ── 5. Manual receipts carry no gross ──────────────────────────────────────
  const g = await client.query(
    `UPDATE tenant_remittances SET gross_amount = NULL, updated_at = now()
      WHERE payment_method IN ('cash','check','money_order') AND gross_amount IS NOT NULL`)
  report.grossCleared = g.rowCount ?? 0

  // ── I1–I3 ──────────────────────────────────────────────────────────────────
  report.invariants = await checkMoneyInvariants(client, { only: ['I1', 'I2', 'I3'] })
  if (!report.invariants.ok) {
    throw new BackfillRefused(report.invariants.results
      .filter(r => r.violations > 0)
      .map(r => `${r.id} (${r.label}) fails on ${r.violations}: ${JSON.stringify(r.sample.slice(0, 3))}`))
  }
  return report
}

export function printBackfillReport(r: BackfillReport, log: (s: string) => void = console.log): void {
  log(`Funding stamped on ${r.fundingStamped.length} paid-ahead credit(s):`)
  for (const f of r.fundingStamped) log(`   ${f.creditId}  ${f.fundedBy}  received ${f.receivedAt}`)
  for (const v of r.voided) {
    log(`Withdrawn ${v.creditId} as of ${v.voidedAt} (restored to $${v.restoredTo}): ${v.reason}`)
    log(`   it keeps $${v.restoredTo} remaining for the ledger — every paid-ahead balance read must filter voided_at IS NULL before DRY=0 (see the header)`)
  }
  for (const c of r.reRecordedCredits) log(`Re-recorded tenant credit ${c.tenantCreditId} as paid-ahead ${c.paidAheadCreditId} ($${c.amount})`)
  log(`Receipts written: ${r.receipts.length} for ${r.receipts.reduce((s, x) => s + x.rows, 0)} rows`)
  for (const x of r.receipts) {
    log(`   ${x.settledAt}  ${x.method.padEnd(11)}  $${x.amount.padStart(9)}  (rows $${x.applied}, banked $${x.unapplied})  ${x.rows} row(s)  tenant ${x.tenantId}`)
  }
  for (const s of r.skippedActions) log(`   skipped ${s.settledAt} ${s.method} tenant ${s.tenantId}: ${s.reason}`)
  log(`Credit uses written: ${r.uses.length}`)
  for (const u of r.uses) log(`   $${u.amount.padStart(8)} of ${u.credit} → charge ${u.paymentId} at ${u.appliedAt}${u.remittanceId ? ` (receipt ${u.remittanceId})` : ''}`)
  for (const t of r.tenantCreditsVoided) log(`Tenant credit ${t.tenantCreditId} restored to $${t.restoredTo} and voided`)
  log(`Notes appended on ${r.notesAppended.length} charge(s); gross cleared on ${r.grossCleared} manual receipt(s)`)
  printInvariantReport(r.invariants, log)
}

// ─── The DRY=0 precondition: every paid-ahead balance read leaves out withdrawn credit ─

export interface UnfilteredRead { file: string; line: number; sql: string }

/**
 * The reads of lease_prepaid_credits.amount_remaining in one source file whose
 * SQL does not filter `voided_at`: the query level that names the table (the
 * innermost parenthesized SELECT around it, else the whole statement) reads
 * amount_remaining and says nothing of voided_at outside its own subqueries.
 * An INSERT of a new credit is not a read. SQL is found in template literals
 * and string literals only (the TypeScript parser: a comment naming the table
 * is not a read). A read that loads whole rows (SELECT *) and adds them up in
 * code is not seen — the known readers are all SQL sums.
 */
export function unfilteredPaidAheadReads(file: string, text: string): UnfilteredRead[] {
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const ts = require('typescript') as typeof import('typescript')
  const src = ts.createSourceFile(file, text, ts.ScriptTarget.ES2020, true,
    file.endsWith('.js') ? ts.ScriptKind.JS : ts.ScriptKind.TS)
  const out: UnfilteredRead[] = []
  const check = (sql: string, n: import('typescript').Node) => {
    if (!/lease_prepaid_credits/i.test(sql)) return
    // The k-th mention in the SQL is the k-th in the literal's source: its line.
    const start = n.getStart(src)
    const raw = text.slice(start, n.getEnd())
    const at: number[] = []
    for (let r = /lease_prepaid_credits/gi, x: RegExpExecArray | null; (x = r.exec(raw));) at.push(start + x.index)
    const re = /lease_prepaid_credits/gi
    let m: RegExpExecArray | null
    for (let k = 0; (m = re.exec(sql)); k++) {
      const level = enclosingLevel(sql, m.index)
      if (!/amount_remaining/i.test(level)) continue
      const own = withoutSubqueries(level)
      if (/insert\s+into\s+lease_prepaid_credits/i.test(own)) continue
      if (/voided_at/i.test(own)) continue
      out.push({
        file,
        line: src.getLineAndCharacterOfPosition(at[k] ?? start).line + 1,
        sql: level.replace(/\s+/g, ' ').trim().slice(0, 160),
      })
    }
  }
  const visit = (n: import('typescript').Node) => {
    if (ts.isNoSubstitutionTemplateLiteral(n) || ts.isStringLiteral(n)) {
      check(n.text, n)
    } else if (ts.isTemplateExpression(n)) {
      // ${...} is code, not SQL: it stands in as one opaque word.
      check(n.head.text + n.templateSpans.map(s => ' ? ' + s.literal.text).join(''), n)
    }
    ts.forEachChild(n, visit)
  }
  visit(src)
  return out
}

/** The innermost parenthesized group around `at` (a subquery), else the whole text. */
function enclosingLevel(sql: string, at: number): string {
  let start = 0
  for (let i = at - 1, depth = 0; i >= 0; i--) {
    if (sql[i] === ')') depth++
    else if (sql[i] === '(') { if (depth === 0) { start = i + 1; break } depth-- }
  }
  let end = sql.length
  for (let i = at, depth = 0; i < sql.length; i++) {
    if (sql[i] === '(') depth++
    else if (sql[i] === ')') { if (depth === 0) { end = i; break } depth-- }
  }
  return sql.slice(start, end)
}

/** The level with every nested (SELECT ...) taken out: their filters are theirs, not this level's. */
function withoutSubqueries(level: string): string {
  let out = ''
  for (let i = 0; i < level.length; i++) {
    if (level[i] === '(' && /^\(\s*select\b/i.test(level.slice(i, i + 20))) {
      let depth = 0
      for (; i < level.length; i++) {
        if (level[i] === '(') depth++
        else if (level[i] === ')' && --depth === 0) break
      }
      out += ' ? '
      continue
    }
    out += level[i]
  }
  return out
}

/**
 * Every unfiltered read in the code this script ships with (the src or dist
 * tree it runs from): tests, migrations, contract SQL and scripts are not app
 * readers. Empty = DRY=0 may run.
 */
export function unfilteredPaidAheadReaders(root: string = require('path').resolve(__dirname, '..')): UnfilteredRead[] {
  const fs = require('fs') as typeof import('fs')
  const path = require('path') as typeof import('path')
  const skipDir = /(^|[\\/])(node_modules|test|scripts|migrations|contract|post-deploy)$/
  const out: UnfilteredRead[] = []
  const walk = (dir: string) => {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const p = path.join(dir, e.name)
      if (e.isDirectory()) { if (!skipDir.test(p)) walk(p); continue }
      if (!/\.(ts|js)$/.test(e.name) || /\.d\.ts$/.test(e.name) || /\.test\.(ts|js)$/.test(e.name)) continue
      const text = fs.readFileSync(p, 'utf8')
      if (!text.includes('lease_prepaid_credits')) continue
      out.push(...unfilteredPaidAheadReads(path.relative(root, p), text))
    }
  }
  walk(root)
  return out
}

if (require.main === module) {
  ;(async () => {
    const dry = process.env.DRY !== '0'
    // The precondition (header, step 4): no DRY=0 while a balance read would
    // show Kim's withdrawn $0.55 again or pool it into a move-out refund.
    const unfiltered = unfilteredPaidAheadReaders()
    if (unfiltered.length > 0) {
      const list = unfiltered.map(u => `   ${u.file}:${u.line}  ${u.sql}`).join('\n')
      if (!dry) {
        console.error(`REFUSED — nothing was written. These reads of paid-ahead balances do not leave out withdrawn credit (voided_at IS NULL):\n${list}`)
        process.exit(1)
      }
      console.log(`NOTE — DRY=0 will refuse until these reads leave out withdrawn credit (voided_at IS NULL):\n${list}`)
    }
    const { getClient } = await import('../db')
    const c = await getClient()
    let code = 0
    try {
      await c.query('BEGIN')
      const r = await runMoneyHistoryBackfill(c)
      printBackfillReport(r)
      if (dry) { await c.query('ROLLBACK'); console.log('DRY RUN — rolled back. DRY=0 to apply.') }
      else { await c.query('COMMIT'); console.log('COMMITTED') }
    } catch (e) {
      await c.query('ROLLBACK').catch(() => {})
      console.error(e instanceof Error ? e.message : e)
      code = 1
    } finally {
      c.release()
      process.exit(code)
    }
  })()
}
