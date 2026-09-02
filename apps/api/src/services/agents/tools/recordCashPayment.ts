/**
 * Tool: record_cash_payment (landlord ACTION, confirm-first). S626.
 *
 * The highest-frequency thing a landlord does that the agent could not do. Rent
 * arrives as cash, a check or a money order constantly, and until now recording
 * it meant leaving the conversation to find the Payments page.
 *
 * Goes through settleManualRentPayment — the SAME service POST
 * /payments/:id/record-manual calls, so the fee waiver rules, the fee routing
 * and the settle itself are the route's, not a second copy. It re-applies the
 * route's own guards: rent only, an open charge only, ownership, and the
 * eviction pause.
 *
 * MONEY, AND IT MOVES A LEGAL CLOCK. Marking rent settled stops late fees and
 * can reset an eviction timeline, so this confirms the tenant, the charge and
 * the amount before it writes, and refuses to guess which charge when there is
 * more than one open.
 */
import { MANUAL_PAYMENT_METHODS } from '@gam/shared'
import { getClient } from '../../../db'
import { settleManualRentPayment } from '../../manualPaymentSettle'
import { actorLandlordIds, type AgentTool, type AgentActor } from './types'

const NOT_A_NAME = new Set([
  'what', "what's", 'whats', 'who', "who's", 'the', 'a', 'my', 'tenant', 'for',
  'paid', 'pay', 'rent', 'cash', 'check', 'cheque', 'money', 'order', 'me', 'in',
])
function cleanName(raw: string): string {
  const w = String(raw ?? '').trim().split(/\s+/).filter(Boolean)
  while (w.length && NOT_A_NAME.has(w[0].toLowerCase())) w.shift()
  while (w.length && NOT_A_NAME.has(w[w.length - 1].toLowerCase())) w.pop()
  return w.join(' ')
}

export const recordCashPayment: AgentTool = {
  name: 'record_cash_payment',
  description:
    'Record that a tenant paid rent OFF-PLATFORM — cash, a check, or a money order. This settles the ' +
    'rent charge without GAM moving any money, exactly as Payments → record a manual payment does in ' +
    'the portal. Use when the landlord says a tenant handed them rent: "Frank gave me $750 cash for ' +
    'August", "got a check from apt 204".\\n' +
    'CONFIRM FIRST — name the tenant, the charge you are settling and its amount, and get an explicit ' +
    'yes. This marks rent paid, which stops late fees and can affect an eviction timeline. It is not ' +
    'something to do on a maybe.\\n' +
    'If more than one rent charge is open it will NOT guess — it returns them and you ask which. ' +
    'Take the check or money-order number when there is one; it is the audit trail.\\n' +
    'Rent only. A fee or a utility bill cannot be settled this way. There is a manual-payment fee on ' +
    'all but a migrating tenant’s first payment — mention it if they ask, and never quote a figure ' +
    'you have not been given.',
  parameters: {
    type: 'object',
    properties: {
      tenant: { type: 'string', description: 'The tenant’s name or unit, in the landlord’s words.' },
      method: { type: 'string', description: `One of: ${MANUAL_PAYMENT_METHODS.join(', ')}` },
      reference: { type: 'string', description: 'Check or money-order number, if there is one.' },
      paymentId: { type: 'string', description: 'Which charge — only when a previous call returned more than one.' },
    },
    required: ['tenant', 'method'],
  },
  audiences: ['landlord'],

  async execute(args, actor: AgentActor) {
    const method = String(args.method ?? '').trim().toLowerCase()
    if (!(MANUAL_PAYMENT_METHODS as readonly string[]).includes(method)) {
      return { ok: false, error: `"${args.method}" is not a payment method.`, allowed: MANUAL_PAYMENT_METHODS }
    }
    const needle = cleanName(String(args.tenant ?? ''))
    if (!needle && !args.paymentId) return { ok: false, error: 'Which tenant paid? A name or a unit is enough.' }

    const client = await getClient()
    try {
      await client.query('BEGIN')
      // Same lock the route takes, and the same joins — a concurrent /pay must
      // not settle this row underneath us.
      const open = (await client.query<any>(
        `SELECT p.id, p.type, p.status, p.landlord_id, p.tenant_id, p.unit_id, p.lease_id,
                p.amount::float AS amount, p.due_date::text AS due_date,
                u.payment_block, u.unit_number,
                COALESCE(par.manual_fee_payer, 'tenant') AS manual_fee_payer,
                t.background_check_status,
                us.first_name, us.last_name
           FROM payments p
           JOIN units u ON u.id = p.unit_id
           LEFT JOIN tenants t ON t.id = p.tenant_id
           LEFT JOIN users us ON us.id = t.user_id
           LEFT JOIN property_allocation_rules par ON par.property_id = u.property_id
          WHERE p.landlord_id = ANY($1::uuid[]) AND p.type = 'rent' AND p.status IN ('pending','failed')
            AND ($2::uuid IS NULL OR p.id = $2::uuid)
            AND ($3 = '' OR us.first_name ILIKE '%'||$3||'%' OR us.last_name ILIKE '%'||$3||'%'
                 OR (us.first_name||' '||us.last_name) ILIKE '%'||$3||'%' OR u.unit_number ILIKE '%'||$3||'%')
          ORDER BY p.due_date
          FOR UPDATE OF p`,
        [actorLandlordIds(actor), args.paymentId ?? null, needle])).rows

      if (open.length === 0) {
        await client.query('ROLLBACK')
        return { ok: false, error: `No open rent charge for "${args.tenant}". They may already be settled, or the name may not match.` }
      }
      if (open.length > 1 && !args.paymentId) {
        await client.query('ROLLBACK')
        return {
          ok: false, needsChoice: true,
          error: 'More than one rent charge is open — do not guess which one they paid.',
          openCharges: open.map((r: any) => ({
            paymentId: r.id, amount: r.amount, dueDate: r.due_date,
            tenant: `${r.first_name ?? ''} ${r.last_name ?? ''}`.trim(), unit: r.unit_number,
          })),
          tellThem: 'Read the charges out with their dates and amounts and ask which one the money was for.',
        }
      }

      const pmt = open[0]
      if (pmt.payment_block) {
        await client.query('ROLLBACK')
        return { ok: false, error: 'That unit is in eviction mode, so recording a payment is paused. This has to be handled off the assistant.' }
      }

      const result: any = await settleManualRentPayment(client, {
        payment: pmt, method: method as any,
        reference: args.reference != null ? String(args.reference).slice(0, 120) : undefined,
        provenance: 'recorded by the assistant',
      } as any)
      await client.query('COMMIT')

      return {
        ok: true, recorded: true,
        paymentId: pmt.id,
        tenant: `${pmt.first_name ?? ''} ${pmt.last_name ?? ''}`.trim(),
        unit: pmt.unit_number,
        amount: pmt.amount, dueDate: pmt.due_date, method,
        feeWaived: result?.feeWaived,
        note:
          'Settled. Tell them it is recorded against that charge and the tenant now reads as paid — ' +
          'GAM has not moved any money, since they are holding it.' +
          (result?.feeWaived === false ? ' A manual-payment fee applies to this one.' : '') +
          (result?.feeWaived === true ? ' No manual-payment fee on this one — it is their first.' : ''),
      }
    } catch (e) {
      try { await client.query('ROLLBACK') } catch { /* the throw is what matters */ }
      throw e
    } finally { client.release() }
  },
}
