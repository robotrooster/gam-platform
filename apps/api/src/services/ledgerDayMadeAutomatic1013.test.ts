/**
 * 10/13 (Nic) — GAM Books ledger: "show fixes on the day made" — automatic
 * changes SHOW ON THE DAY they happen; only GAM's rebuilds keep original dates.
 *
 *   Nic, 10/13 (morning): "GAM's own rebuilds keep original dates; only
 *   people's fixes show on the day made." Nic, 10/13 (afternoon): "day-made
 *   mode: automatic changes SHOW ON THE DAY."
 *
 * The engine (services/ledgerEngine postSource, fixDay) never asks who made a
 * change: a source that re-projects differently through the minute drain (a
 * person's fix, a Stripe fee true-up, a webhook updating a payment) or through
 * the nightly check's repair (a projector rule that changed) is a fix — under
 * "show fixes on the day made" its take-back and its new version land on the
 * day it happened. Only a rebuild GAM runs (ledger:rebuild, a run id) restates
 * in place, keeping the dates it had; under "restate" every fix to an open
 * month changes that month. These tests hold the engine to exactly that.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { db } from '../db'
import { cleanupAllSchema } from '../test/dbHelpers'
import { ledgerCompany, postingsOf, companyToday, memProjector, markChanged, roleNet, type LedgerCompany } from '../test/ledgerFixtures'
import {
  drainLedgerOutbox, registerLedgerProjector, unregisterLedgerProjector, registeredLedgerSourceTypes, type DesiredPosting,
} from './ledgerEngine'
import { setLedgerSettings } from './ledgerClose'
import { checkOwner } from './ledgerCheck'
import { rebuildOwner } from './ledgerRebuild'

beforeEach(async () => {
  await cleanupAllSchema()
})
afterEach(() => {
  for (const t of registeredLedgerSourceTypes()) unregisterLedgerProjector(t)
})

/** A card payment of $100 received on 9/10, its processing fee taken from it ($2.90 at first). */
function payment(co: LedgerCompany, feeCents: number): DesiredPosting[] {
  return [{ owner: co.owner, intendedDate: '2026-09-10', memo: 'Card payment', lines: [
    { role: 'due_from_gam', debitCents: 10000 - feeCents, propertyId: co.propertyId },
    { role: 'processing_fees', debitCents: feeCents, propertyId: co.propertyId },
    { role: 'other_income', creditCents: 10000, propertyId: co.propertyId },
  ] }]
}

const brief = async (id: string) => (await postingsOf('payment', id)).map(p => [p.role, p.intended_date, p.accounting_date])

async function dayMade(co: LedgerCompany) {
  await setLedgerSettings({ landlordId: co.landlordId, actorUserId: co.ownerUserId, openMonthFixes: 'day_made' })
}

describe('"show fixes on the day made": an automatic change shows on the day it happens', () => {
  it('a Stripe fee true-up (or a webhook updating a payment) re-posts through the drain: taken back and posted again today', async () => {
    const co = await ledgerCompany()
    await dayMade(co)
    const m = memProjector('payment')
    registerLedgerProjector(m.projector)
    const id = 'stripe-true-up'
    m.wants.set(id, payment(co, 290))
    await markChanged('payment', id, co.landlordId)
    await drainLedgerOutbox()
    // Stripe's real fee arrives later: the system — no person — changes the record.
    m.wants.set(id, payment(co, 305))
    await markChanged('payment', id, co.landlordId)
    await drainLedgerOutbox()
    const today = await companyToday()
    expect(await brief(id)).toEqual([
      ['post', '2026-09-10', '2026-09-10'], ['reversal', '2026-09-10', today], ['post', '2026-09-10', today],
    ])
    // September keeps what it showed; the fee's change shows today.
    expect(await roleNet(co.landlordId, 'processing_fees', '2026-09-30')).toBe(-2.9)
    expect(await roleNet(co.landlordId, 'processing_fees')).toBe(-3.05)
  })

  it('a projector rule that changed is re-posted by the nightly check on the day it runs; a rebuild GAM runs keeps the original dates', async () => {
    const co = await ledgerCompany()
    await dayMade(co)
    // Two records of two kinds, posted under rule version 1.
    const nightly1 = memProjector('payment', 1)
    const rebuilt1 = memProjector('remittance', 1)
    registerLedgerProjector(nightly1.projector)
    registerLedgerProjector(rebuilt1.projector)
    nightly1.wants.set('nightly', payment(co, 290))
    rebuilt1.wants.set('rebuilt', payment(co, 290))
    await markChanged('payment', 'nightly', co.landlordId)
    await markChanged('remittance', 'rebuilt', co.landlordId)
    await drainLedgerOutbox()
    // Rule version 2 ships: the same records now want different lines.
    const nightly2 = memProjector('payment', 2)
    const rebuilt2 = memProjector('remittance', 2)
    nightly2.wants.set('nightly', payment(co, 305))
    rebuilt2.wants.set('rebuilt', payment(co, 305))
    registerLedgerProjector(nightly2.projector)
    registerLedgerProjector(rebuilt2.projector)
    const today = await companyToday()
    const of = async (type: string, id: string) => (await postingsOf(type, id)).map(p => [p.role, p.intended_date, p.accounting_date])
    // GAM rebuilds one kind (a run id): restated in place, on its own day.
    expect((await rebuildOwner(co.owner, { mode: 'apply', sourceType: 'remittance' })).counts)
      .toMatchObject({ posted: 1, reversed: 1, failed: 0 })
    expect(await of('remittance', 'rebuilt')).toEqual([
      ['post', '2026-09-10', '2026-09-10'], ['reversal', '2026-09-10', '2026-09-10'], ['post', '2026-09-10', '2026-09-10'],
    ])
    // The other is found by the nightly check and re-posted from its source: an automatic change, shown today.
    const check = await checkOwner(co.owner)
    expect(check.repaired).toBe(1)
    expect(await of('payment', 'nightly')).toEqual([
      ['post', '2026-09-10', '2026-09-10'], ['reversal', '2026-09-10', today], ['post', '2026-09-10', today],
    ])
    expect((await checkOwner(co.owner)).findings.filter(f => f.severity === 'integrity' || f.severity === 'drift')).toEqual([])
    const b = (await db.query<{ dr: string; cr: string }>(
      `SELECT sum(debit)::text AS dr, sum(credit)::text AS cr FROM ledger_posting_lines WHERE landlord_id = $1`, [co.landlordId])).rows[0]
    expect(b.dr).toBe(b.cr)
  })

  it('under "restate" (the default) the same automatic change restates the month it belongs to', async () => {
    const co = await ledgerCompany()
    const m = memProjector('payment')
    registerLedgerProjector(m.projector)
    m.wants.set('restated', payment(co, 290))
    await markChanged('payment', 'restated', co.landlordId)
    await drainLedgerOutbox()
    m.wants.set('restated', payment(co, 305))
    await markChanged('payment', 'restated', co.landlordId)
    await drainLedgerOutbox()
    expect(await brief('restated')).toEqual([
      ['post', '2026-09-10', '2026-09-10'], ['reversal', '2026-09-10', '2026-09-10'], ['post', '2026-09-10', '2026-09-10'],
    ])
    expect(await roleNet(co.landlordId, 'processing_fees', '2026-09-30')).toBe(-3.05)
  })
})
