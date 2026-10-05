/**
 * Tool: record_cash_payment (landlord ACTION, confirm-first). S626.
 *
 * The highest-frequency thing a landlord does that the agent could not do. Rent
 * arrives as cash, a check or a money order constantly, and until now recording
 * it meant leaving the conversation to find the Payments page.
 *
 * Goes through settleManualRentPayment — the SAME service POST
 * /payments/:id/record-manual calls, so the settle is the desk's, not a second
 * copy: the household's whole balance with this company (S652), pay in full,
 * the old balance paid last, a receipt for what was handed over. S654: no fee —
 * cash, check and money order are free.
 *
 * S655 (money plan, bug 2): credit is NEVER spent without the landlord saying
 * so. Whenever the account carries credit that could pay part of the bill the
 * tool stops and asks — "use the $X credit (they owe $Y) or save it (they owe
 * $Z)?" — and only records once `credit` is 'use' or 'save'. Cash over the bill
 * is change or credit, said out loud; a check or money order over the bill is
 * confirmed against the amount written on it first.
 *
 * MONEY, AND IT MOVES A LEGAL CLOCK. Marking rent settled stops late fees and
 * can reset an eviction timeline, so this confirms the tenant, the bill and the
 * amount before it writes, and refuses to guess between two households.
 */
import { MANUAL_PAYMENT_METHODS } from '@gam/shared'
import { getClient } from '../../../db'
import { lockHousehold, bankPayableRowSql } from '../../moneyPredicates'
import { settleManualRentPayment, deskQuote, DESK_SURPLUS_HANDLING } from '../../manualPaymentSettle'
import { runWholeBillCheckAfterCommit } from '../../creditUse'
import { AppError } from '../../../middleware/errorHandler'
import { actorLandlordIds, type AgentTool, type AgentActor } from './types'

const NOT_A_NAME = new Set([
  'what', "what's", 'whats', 'who', "who's", 'the', 'a', 'my', 'tenant', 'for',
  'paid', 'pay', 'rent', 'cash', 'check', 'check', 'money', 'order', 'me', 'in',
])
function cleanName(raw: string): string {
  const w = String(raw ?? '').trim().split(/\s+/).filter(Boolean)
  while (w.length && NOT_A_NAME.has(w[0].toLowerCase())) w.shift()
  while (w.length && NOT_A_NAME.has(w[w.length - 1].toLowerCase())) w.pop()
  return w.join(' ')
}

const CREDIT_ANSWERS = ['use', 'save'] as const

export const recordCashPayment: AgentTool = {
  name: 'record_cash_payment',
  description:
    'Record that a tenant paid OFF-PLATFORM — cash, a check, or a money order — against everything they owe ' +
    'this company, exactly as Payments → Record payment does in the portal. GAM moves no money. Use when the ' +
    'landlord says a tenant handed them rent: "Frank gave me $750 cash", "got a check for $460 from apt 204".\\n' +
    'CONFIRM FIRST — name the tenant, what they owe and the amount handed over, and get an explicit yes. ' +
    'This marks rent paid, which stops late fees and can affect an eviction timeline.\\n' +
    'If the account has credit that could pay part of the bill, the tool stops and asks: you must ask the ' +
    'landlord whether to use it or save it and pass credit: "use" or "save" with creditAvailable — never decide for them.\\n' +
    'Cash over the bill: ask whether they gave change or kept it as credit (surplus). A check or money order ' +
    'over the bill: confirm the amount written on it (writtenAmountConfirmed).\\n' +
    'If more than one tenant matches it will NOT guess — it returns them and you ask which. Take the check or ' +
    'money-order number when there is one. Recording it is free.',
  parameters: {
    type: 'object',
    properties: {
      tenant: { type: 'string', description: 'The tenant’s name or unit, in the landlord’s words.' },
      method: { type: 'string', description: `One of: ${MANUAL_PAYMENT_METHODS.join(', ')}` },
      amount: { type: 'number', description: 'The amount handed over, in dollars.' },
      reference: { type: 'string', description: 'Check or money-order number, if there is one.' },
      credit: { type: 'string', description: 'Only when asked: "use" to use the account credit, "save" to keep it.' },
      creditAvailable: { type: 'number', description: 'With credit: the creditAvailable figure you read to the landlord.' },
      surplus: { type: 'string', description: 'Cash over the bill only: "change" if they handed it back, "credit" if they kept it on the account.' },
      towardOldBalance: { type: 'number', description: 'Only if the landlord says part of it is for an old carried-over balance: how much.' },
      writtenAmountConfirmed: { type: 'boolean', description: 'A check or money order over the bill: true once the landlord confirmed the amount written on it.' },
      paymentId: { type: 'string', description: 'Which tenant — only when a previous call returned more than one.' },
    },
    required: ['tenant', 'method', 'amount'],
  },
  audiences: ['landlord'],

  async execute(args, actor: AgentActor) {
    const method = String(args.method ?? '').trim().toLowerCase()
    if (!(MANUAL_PAYMENT_METHODS as readonly string[]).includes(method)) {
      return { ok: false, error: `"${args.method}" is not a payment method.`, allowed: MANUAL_PAYMENT_METHODS }
    }
    const amount = Number(args.amount)
    if (!Number.isFinite(amount) || amount < 0) {
      return { ok: false, error: 'How much did they hand over? An amount in dollars is needed.' }
    }
    const credit = args.credit == null ? null : String(args.credit).trim().toLowerCase()
    if (credit != null && !(CREDIT_ANSWERS as readonly string[]).includes(credit)) {
      return { ok: false, error: 'The credit answer is "use" or "save".' }
    }
    const surplus = args.surplus == null ? undefined : String(args.surplus).trim().toLowerCase()
    if (surplus != null && !(DESK_SURPLUS_HANDLING as readonly string[]).includes(surplus)) {
      return { ok: false, error: 'For cash over the bill, the answer is "change" or "credit".' }
    }
    const needle = cleanName(String(args.tenant ?? ''))
    if (!needle && !args.paymentId) return { ok: false, error: 'Which tenant paid? A name or a unit is enough.' }

    // decisions.md #48.4: a card hold on this company's bills that nobody
    // confirmed in time is released before the bill is read, so a bill whose
    // hold ran out is found open (never "nothing open" over a stale hold).
    // Before BEGIN: the release takes the household lock on its own connection.
    try {
      const { releaseUnconfirmedCardCharges } = await import('../../../jobs/paymentReconcile')
      const { getStripe } = await import('../../../lib/stripe')
      await releaseUnconfirmedCardCharges(getStripe, { landlordIds: actorLandlordIds(actor) })
    } catch { /* the five-minute sweep tries again */ }

    const client = await getClient()
    try {
      await client.query('BEGIN')
      // Every open charge the desk could take that matches, grouped by
      // household (a person with one company) — never by single charge.
      const matches = (await client.query<any>(
        `SELECT p.id, p.tenant_id, p.landlord_id, p.unit_id, p.lease_id, p.due_date::text AS due_date,
                p.amount::float AS amount, u.payment_block, u.unit_number,
                us.first_name, us.last_name, pr.name AS property_name
           FROM payments p
           JOIN units u ON u.id = p.unit_id
           JOIN properties pr ON pr.id = u.property_id
           JOIN tenants t ON t.id = p.tenant_id
           LEFT JOIN users us ON us.id = t.user_id
          WHERE p.landlord_id = ANY($1::uuid[]) AND ${bankPayableRowSql('p')}
            AND ($2::uuid IS NULL OR (p.tenant_id, p.landlord_id) =
                 (SELECT x.tenant_id, x.landlord_id FROM payments x WHERE x.id = $2::uuid))
            AND ($3 = '' OR us.first_name ILIKE '%'||$3||'%' OR us.last_name ILIKE '%'||$3||'%'
                 OR (us.first_name||' '||us.last_name) ILIKE '%'||$3||'%' OR u.unit_number ILIKE '%'||$3||'%')
          ORDER BY p.due_date, p.id`,
        [actorLandlordIds(actor), args.paymentId ?? null, args.paymentId ? '' : needle])).rows

      if (matches.length === 0) {
        await client.query('ROLLBACK')
        return { ok: false, error: `Nothing open to record for "${args.tenant}". They may already be paid up, or the name may not match.` }
      }
      const households = new Map<string, any[]>()
      for (const m of matches) {
        const k = `${m.tenant_id}|${m.landlord_id}`
        households.set(k, [...(households.get(k) ?? []), m])
      }
      if (households.size > 1) {
        await client.query('ROLLBACK')
        return {
          ok: false, needsChoice: true,
          error: 'More than one tenant matches — do not guess who paid.',
          // S636 (Nic, DIRECTIVE): NAME THE PROPERTY. Unit numbers repeat across parks.
          tenants: [...households.values()].map(rows => ({
            paymentId: rows[0].id,
            tenant: `${rows[0].first_name ?? ''} ${rows[0].last_name ?? ''}`.trim(),
            unit: rows[0].unit_number, property: rows[0].property_name,
            owed: Math.round(rows.reduce((s: number, r: any) => s + Number(r.amount), 0) * 100) / 100,
          })),
          tellThem: 'Read them out with their property and what each owes, and ask which one paid.',
        }
      }
      const anchor = matches[0]
      if (matches.some((m: any) => m.payment_block)) {
        await client.query('ROLLBACK')
        return { ok: false, error: 'That space is in eviction mode, so recording a payment is paused. This has to be handled off the assistant.' }
      }

      await lockHousehold(client, anchor.tenant_id, anchor.landlord_id)
      const q = await deskQuote(client, { tenantId: anchor.tenant_id, landlordId: anchor.landlord_id, lock: true })
      const name = `${anchor.first_name ?? ''} ${anchor.last_name ?? ''}`.trim()
      const askAgain = (why: string) => ({
        ok: false, needsCreditChoice: true,
        error: `${why} Nothing was recorded.`,
        owedIfUsed: q.owedIfUsed, owedIfSaved: q.owedIfSaved, creditAvailable: q.usableCredit,
        tellThem: `Ask: use the $${q.usableCredit.toFixed(2)} credit (they owe $${q.owedIfUsed.toFixed(2)}) or save it (they owe $${q.owedIfSaved.toFixed(2)})? Then call again with credit "use" or "save" and creditAvailable ${q.usableCredit.toFixed(2)}.`,
      })
      if (q.usableCredit > 0 && credit == null) {
        await client.query('ROLLBACK')
        return askAgain(`${name} has $${q.usableCredit.toFixed(2)} of account credit that can pay part of this bill.`)
      }
      // S655 (shelved 8): the answer counts only for the figure the landlord
      // was told. A credit that moved since — or an answer sent without the
      // figure it answered — is asked again, never spent on a guess.
      const toldCents = args.creditAvailable == null || !Number.isFinite(Number(args.creditAvailable))
        ? null : Math.round(Number(args.creditAvailable) * 100)
      const usableCents = Math.round(q.usableCredit * 100)
      if (credit === 'use' && usableCents === 0) {
        await client.query('ROLLBACK')
        return {
          ok: false, creditChanged: true, creditAvailable: 0, owed: q.owedIfSaved,
          error: `There is no account credit to use now, so they owe $${q.owedIfSaved.toFixed(2)}. Nothing was recorded.`,
          tellThem: `Tell the landlord there is no credit to use and they owe $${q.owedIfSaved.toFixed(2)}; once they confirm the amount, call again without credit.`,
        }
      }
      if (credit != null && usableCents > 0) {
        if (toldCents == null) {
          await client.query('ROLLBACK')
          return askAgain(`Send creditAvailable — the $${q.usableCredit.toFixed(2)} credit figure you read to the landlord — with their answer.`)
        }
        if (toldCents !== usableCents) {
          await client.query('ROLLBACK')
          return askAgain(`The credit changed — it is now $${q.usableCredit.toFixed(2)}.`)
        }
      }

      const r = await settleManualRentPayment(client, {
        payment: {
          id: anchor.id, landlord_id: anchor.landlord_id, tenant_id: anchor.tenant_id, unit_id: anchor.unit_id,
          lease_id: anchor.lease_id, due_date: anchor.due_date,
        },
        method: method as any,
        settledAt: null,
        reference: args.reference != null ? String(args.reference).slice(0, 120) : null,
        provenance: 'recorded by the assistant',
        settleHousehold: true,
        amountTendered: amount,
        creditToUse: q.usableCredit > 0 ? (credit === 'use' ? q.usableCredit : 0) : null,
        surplusHandling: surplus as any,
        towardOldBalance: args.towardOldBalance != null ? Number(args.towardOldBalance) : null,
        confirmWrittenAmount: args.writtenAmountConfirmed === true,
        takenBy: actor.userId,
        source: 'landlord_agent',
      })
      await client.query('COMMIT')
      await r.afterCommit()
      if (r.creditId) await runWholeBillCheckAfterCommit({ tenantId: anchor.tenant_id, landlordId: anchor.landlord_id })

      return {
        ok: true, recorded: true,
        tenant: name, unit: anchor.unit_number, property: anchor.property_name,
        method, handedOver: amount,
        paidOnBill: r.amountSettled, creditUsed: r.creditUsed,
        towardOldBalance: r.towardOldBalance,
        changeGiven: r.changeGiven, keptAsCredit: r.creditId ? r.surplus : 0,
        stillOpenOnline: q.payOnlineTotal,
        note:
          'Recorded. Tell them what it paid, any credit used, and any change or credit — GAM has not moved any ' +
          'money, since they are holding it. There is no fee for it.' +
          (q.payOnlineTotal > 0 ? ` $${q.payOnlineTotal.toFixed(2)} of GAM charges on the bill stays open; the tenant pays that online.` : ''),
      }
    } catch (e) {
      try { await client.query('ROLLBACK') } catch { /* the throw is what matters */ }
      // A refusal the landlord can act on (short, a surplus not answered, a
      // check amount to confirm, a credit that moved) is said plainly.
      if (e instanceof AppError && e.statusCode >= 400 && e.statusCode < 500) {
        return { ok: false, error: e.message, nothingRecorded: true }
      }
      throw e
    } finally { client.release() }
  },
}
