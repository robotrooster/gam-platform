/**
 * 10/14 (Nic) — "Monthly property report PDF/email: itemized lines under each
 * group." Against a company whose reports read its books: each Summary group
 * carries the itemized lines of its own money — mobile home lot rent and
 * park-owned trailer rent (the space's subtype beneath), RV long-term rent
 * for a lease under Space rent, and under Stays and pay links a February
 * month sold by the month as RV long-term rent ("month stays are long-term")
 * beside four weeks sold by the week as RV short-term stays. The lines add up
 * to their group in every column, and the emailed PDF prints them indented
 * beneath it.
 */
import zlib from 'zlib'
import { describe, it, expect, beforeEach, afterEach, afterAll } from 'vitest'
import { db } from '../db'
import { tenantCo, addLease, bill, receipt, cleanupTenantLedger } from '../test/ledgerTenantFixtures'
import { inTx } from '../test/ledgerFixtures'
import { booking, siteDeposit } from '../test/ledgerP5Fixtures'
import { markLedgerLive } from '../test/ledgerReportFixtures'
import { seedUnit } from '../test/dbHelpers'
import { drainLedgerOutbox } from './ledgerEngine'
import { registerProductionLedgerProjectors, unregisterProductionLedgerProjectors } from './ledgerProjectors'
import { buildMonthlyPropertyReport } from './monthlyPropertyReport'
import { renderMonthlyReportPdf } from './monthlyReportPdf'

beforeEach(async () => {
  await cleanupTenantLedger()
  registerProductionLedgerProjectors()
})
afterEach(() => unregisterProductionLedgerProjectors())
afterAll(async () => { await cleanupTenantLedger() })

/** pdf-lib deflates its streams and draws text as <hex> Tj: inflate and decode them (as monthlyReportPdf.test). */
function pdfWords(buf: Buffer): string {
  const hay = buf.toString('latin1')
  const out: string[] = []
  for (const m of hay.matchAll(/<<([^>]*)>>\s*stream\r?\n([\s\S]*?)\r?\nendstream/g)) {
    if (!/\/Filter\s*\/FlateDecode/.test(m[1] ?? '')) continue
    const raw = Buffer.from(m[2] ?? '', 'latin1')
    for (const f of [() => zlib.inflateSync(raw), () => zlib.inflateSync(Buffer.concat([raw, Buffer.from('\r', 'latin1')])),
                     () => zlib.inflateSync(raw, { finishFlush: zlib.constants.Z_SYNC_FLUSH })]) {
      try { out.push(f().toString('latin1')); break } catch { /* next */ }
    }
  }
  return out.join('\n').replace(/<([0-9A-Fa-f\s]+)>\s*Tj/g, (_, hex: string) => {
    const h = hex.replace(/\s+/g, '')
    const bytes: number[] = []
    for (let i = 0; i + 1 < h.length; i += 2) bytes.push(parseInt(h.slice(i, i + 2), 16))
    return Buffer.from(bytes).toString('latin1')
  })
}

/** February 2027 at one park: a park-owned trailer (Double wide), an RV lease, a month stay and four weeks on RV sites. */
async function february() {
  const co = await tenantCo()
  await inTx(async (c) => {
    await c.query(`UPDATE properties SET name = 'Alpha Park' WHERE id = $1`, [co.propertyId])
    await c.query(`UPDATE units SET unit_type = 'mobile_home', dwelling_ownership = 'landlord', lot_rent_amount = 300 WHERE id = $1`, [co.unitId])
    const st = await c.query<{ id: string }>(
      `INSERT INTO property_unit_subtypes (property_id, unit_type, name) VALUES ($1, 'mobile_home', 'Double wide') RETURNING id`, [co.propertyId])
    await c.query(`INSERT INTO unit_subtype_links (unit_id, subtype_id) VALUES ($1, $2)`, [co.unitId, st.rows[0].id])
  })
  const home = await bill(co, { amount: 1000, due: '2027-02-01' })
  await receipt(co, { method: 'cash', settledAt: '2027-02-03T17:00:00Z', apps: [{ paymentId: home, amount: 1000 }] })
  const rv = await addLease(co, co.propertyId)
  await db.query(`UPDATE units SET unit_type = 'rv_spot' WHERE id = $1`, [rv.unitId])
  await bill(co, { amount: 550, due: '2027-02-01', unitId: rv.unitId, leaseId: rv.leaseId })
  const site = async () => ({ ...co, unitId: await inTx(c => seedUnit(c, { propertyId: co.propertyId, landlordId: co.landlordId, unitType: 'rv_spot' })) })
  const a = await site(), b = await site()
  const month = await booking(a, { checkIn: '2027-02-01', checkOut: '2027-03-01', leaseType: 'month_to_month', stayTerms: 'stay' })
  await siteDeposit(a, month, { toward: 589, lodgingTax: 0, held: 589, at: '2027-01-25 18:00:00+00' })
  const weeks = await booking(b, { checkIn: '2027-02-01', checkOut: '2027-03-01', leaseType: 'weekly' })
  await siteDeposit(b, weeks, { toward: 1076, lodgingTax: 76, held: 1076, at: '2027-01-25 18:00:00+00' })
  expect(await drainLedgerOutbox()).toMatchObject({ failed: 0 })
  await markLedgerLive(co.landlordId)
  return co
}

const cols = (x: { received: number; charged: number; owed: number }) => [x.received, x.charged, x.owed]

describe('the monthly property report itemizes each group (10/14, Nic)', () => {
  it('each Summary group carries its own itemized lines, adding up to the group in every column', async () => {
    const co = await february()
    const report = await buildMonthlyPropertyReport({ landlordId: co.landlordId, month: '2027-02', propertyIds: [co.propertyId], asOf: '2027-03-02' })
    const money = report.properties[0].money
    const groups = money.itemized!
    expect(groups.map(g => g.key)).toEqual(['c:space_rent', 'c:stays_and_pay_links'])

    const rent = groups[0]
    expect(rent.lines.map(l => [l.label, ...cols(l)])).toEqual([
      ['Mobile home lot rent', 300, 300, 0],
      ['Park-owned trailer rent', 700, 700, 0],
      ['RV long-term rent', 0, 550, 550],
    ])
    expect(rent.lines[0].subtypes).toEqual([{ name: 'Double wide', received: 300, charged: 300, owed: 0 }])
    // 10/14 (Nic): the February month (28 nights, sold by the month) is RV long-term rent; four weeks stay short-term.
    const stays = groups[1]
    expect(stays.lines.map(l => [l.label, ...cols(l)])).toEqual([
      ['RV long-term rent', 0, 589, 0],
      ['RV short-term stays (under 30 nights)', 0, 1000, 0],
    ])
    // Each group's lines add up to its Summary row, column by column.
    for (const g of groups) {
      const row = money.view.categories.find(c => `c:${c.category}` === g.key)!
      for (const k of ['received', 'charged', 'owed'] as const) {
        expect(Math.round(g.lines.reduce((s, l) => s + l[k], 0) * 100) / 100, `${g.key} ${k}`).toBe(row[k])
      }
    }
  })

  it('the PDF prints each group\'s lines indented beneath it, the subtype beneath its line', async () => {
    const co = await february()
    const report = await buildMonthlyPropertyReport({ landlordId: co.landlordId, month: '2027-02', propertyIds: [co.propertyId], asOf: '2027-03-02' })
    const words = pdfWords(await renderMonthlyReportPdf(report))
    const rentGroup = report.properties[0].money.view.categories.find(c => c.category === 'space_rent')!.label
    const staysGroup = report.properties[0].money.view.categories.find(c => c.category === 'stays_and_pay_links')!.label
    const at = (s: string, from = 0) => words.indexOf(s, from)
    const order = [
      at(rentGroup), at('Mobile home lot rent'), at('Double wide'), at('Park-owned trailer rent'), at('RV long-term rent'),
      at(staysGroup), at('RV long-term rent', at(staysGroup)), at('RV short-term stays (under 30 nights)'),
    ]
    expect(order.every(i => i >= 0)).toBe(true)
    expect([...order].sort((x, y) => x - y)).toEqual(order)
    expect(words).toContain('$1,589.00')
  })

  it('a company whose reports do not read its books yet prints its groups as before (nothing itemized)', async () => {
    const co = await tenantCo()
    await bill(co, { amount: 460, due: '2027-02-01' })
    const report = await buildMonthlyPropertyReport({ landlordId: co.landlordId, month: '2027-02', propertyIds: [co.propertyId], asOf: '2027-03-02' })
    expect(report.properties[0].money.itemized).toEqual([])
    expect(report.properties[0].money.view.categories.map(c => [c.category, c.charged])).toEqual([['space_rent', 460]])
  })
})
