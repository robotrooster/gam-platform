/**
 * S607 — applying credits to a tenant's OPEN balance.
 *
 * Nic: "I think it needs to be applied to an outstanding account balance. Say
 * somebody pays the rent late, the software has already added the late fee to
 * the balance. The credit needs to go to the balance and kind of zero it out so
 * that the landlord's not thinking that the tenant still owes money, the books
 * look good, everything's zeroed out... treat it almost like an internal bank
 * account as far as debits and credits going in and out."
 *
 * THE PROBLEM THIS FIXES. Credits were only ever consumed by invoiceGeneration,
 * i.e. when the NEXT month's invoice is built. So a landlord who forgave $35 of
 * late fees on the 9th watched the tenant's balance keep showing $35 owed for
 * the rest of the month — the books disagreed with the decision, and the tenant
 * could not pay their rent without also paying a fee that had been forgiven
 * (rent is pay-in-full, so an open charge blocks the whole balance).
 *
 * The credit is the same money whenever it lands. What changes here is only WHEN
 * it is applied: immediately, against whatever is currently open, oldest first —
 * with whatever is left over staying on the credit for the next invoice to use.
 *
 * ONE implementation, called from both places. The invoice path and the
 * issue-a-credit path applying credits differently is exactly how a tenant ends
 * up with two different balances depending on which code touched them last.
 */

import type { PoolClient } from 'pg'

export interface CreditApplicationResult {
  /** Dollars actually applied to open charges. */
  applied: number
  /** How many charge rows were settled or reduced. */
  rowsTouched: number
}

/**
 * Draw down a lease's active credits against its OPEN (pending) charges,
 * oldest first.
 *
 * `scope` limits which charges are eligible:
 *   'invoice' — only rows on the given invoice (invoice-generation behaviour)
 *   'lease'   — every open row on the lease, whatever invoice it belongs to
 *               (what a landlord means by "forgive that late fee")
 *
 * S637 — A CREDIT NEVER SPLITS A CHARGE.
 *
 * Nic (DIRECTIVE, verbatim): "Credits do not fucking split charges. I just
 * fucking said that. It's a credit against the overall ledger, not fucking
 * settling partial payments. That's... we don't do partial payments."
 *
 * This used to cover a charge PARTLY: it rewrote the charge down to the covered
 * slice, marked that slice settled, and inserted a fresh pending row for the
 * remainder. Applying $37.60 to $440 of rent turned one rent charge into a
 * $37.60 settled payment plus a $402.40 remainder — which is a split rent
 * payment, the exact thing banned platform-wide, produced by the code meant to
 * help. It also invented a settled rent payment that no money arrived for, and
 * the dashboard's Collected MTD counts settled rent without asking whether cash
 * moved, so a credit inflated collected rent.
 *
 * Now: a charge is covered in FULL or it is not touched. Whatever the credit
 * cannot fully cover stays on the account as a balance — money the landlord
 * owes the tenant — and the owed figures net it off (see routes/balances.ts).
 * That is the rolling ledger: credits and debits in and out, and the balance
 * moves. Nothing is settled until it is genuinely settled.
 */
export async function applyCreditsToOpenCharges(
  client: PoolClient,
  opts: { leaseId: string; scope: 'invoice' | 'lease'; invoiceId?: string },
): Promise<CreditApplicationResult> {
  const credits = await client.query<{ id: string; amount_remaining: string }>(
    `SELECT id, amount_remaining::text FROM tenant_credits
      WHERE lease_id = $1 AND status = 'active' AND amount_remaining > 0
      ORDER BY created_at ASC
      FOR UPDATE`,
    [opts.leaseId])

  let available = credits.rows.reduce((s, c) => s + Number(c.amount_remaining), 0)
  if (available <= 0.005) return { applied: 0, rowsTouched: 0 }

  // Open charges, oldest first. 'invoice' scope keeps the long-standing
  // invoice-generation behaviour; 'lease' scope reaches charges from earlier
  // cycles, which is the whole point when a landlord forgives a late fee that
  // has been sitting on last month's invoice.
  const charges = await client.query<{ id: string; amount: string }>(
    opts.scope === 'invoice'
      ? `SELECT id, amount::text FROM payments
          WHERE invoice_id = $1 AND status = 'pending'
          ORDER BY due_date ASC, created_at ASC
          FOR UPDATE`
      : `SELECT id, amount::text FROM payments
          WHERE lease_id = $1 AND status = 'pending'
            AND stripe_payment_intent_id IS NULL
          ORDER BY due_date ASC, created_at ASC
          FOR UPDATE`,
    [opts.scope === 'invoice' ? opts.invoiceId : opts.leaseId])

  let consumed = 0
  let rowsTouched = 0
  for (const row of charges.rows) {
    if (available <= 0.005) break
    const rowAmt = Number(row.amount)

    // S637: in FULL or not at all. A charge the credit cannot completely cover
    // is skipped — not carved up — and the credit keeps looking for one it can
    // clear. Anything left over stays on the account as a balance the owed
    // figures net off, which is what "a credit against the overall ledger"
    // means. `continue`, not `break`: a $40 credit that cannot clear this
    // month's rent can still clear a $35 late fee sitting behind it.
    if (rowAmt > available + 0.005) continue

    await client.query(
      `UPDATE payments SET status='settled', settled_at=NOW(),
              notes = COALESCE(notes || ' — ', '') || 'covered by account credit'
        WHERE id = $1`, [row.id])
    available -= rowAmt
    consumed += rowAmt
    rowsTouched++
  }

  // Draw the consumed total down across the credits themselves, oldest first.
  let toDraw = consumed
  for (const c of credits.rows) {
    if (toDraw <= 0.005) break
    const draw = Math.min(Number(c.amount_remaining), toDraw)
    await client.query(
      `UPDATE tenant_credits
          SET amount_remaining = amount_remaining - $2::numeric, updated_at = NOW()
        WHERE id = $1`, [c.id, draw.toFixed(2)])
    toDraw -= draw
  }

  return { applied: Math.round(consumed * 100) / 100, rowsTouched }
}
