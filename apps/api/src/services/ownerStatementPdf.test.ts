/**
 * PM readiness 4 — the owner statement as a PDF, drawn from a REAL statement.
 *
 * Deliberately database-backed rather than a hand-built object. The whole
 * hazard of this document is that it disagrees with the screen: it goes to
 * somebody who is not a GAM customer, does not sign in, and will tie its total
 * to their bank. So the test seeds money, runs services/ownerStatement over
 * it, and asserts that the figures the renderer PUT ON THE PAGE are the ones
 * the statement computed — including the one that is easiest to get wrong
 * (another owner's park must not appear).
 */
import zlib from 'zlib'
import { describe, it, expect, beforeEach } from 'vitest'
import { PDFDocument } from 'pdf-lib'
import { getClient } from '../db'
import { ownerStatement, type OwnerStatement } from './ownerStatement'
import { renderOwnerStatementPdf, ownerStatementFilename } from './ownerStatementPdf'
import {
  cleanupAllSchema, seedLandlord, seedProperty, seedUnit, seedUserBankAccount, seedPmCompany,
} from '../test/dbHelpers'

beforeEach(cleanupAllSchema)

const M = '2026-08-01'

/** pdf-lib deflates its streams and draws text as <hex> Tj: inflate and decode them. */
function pdfWords(buf: Buffer): string {
  const hay = buf.toString('latin1')
  const out: string[] = []
  for (const m of hay.matchAll(/<<([^>]*)>>\s*stream\r?\n([\s\S]*?)\r?\nendstream/g)) {
    if (!/\/Filter\s*\/FlateDecode/.test(m[1] ?? '')) continue
    const raw = Buffer.from(m[2] ?? '', 'latin1')
    for (const f of [() => zlib.inflateSync(raw),
                     () => zlib.inflateSync(Buffer.concat([raw, Buffer.from('\r', 'latin1')])),
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

const meta = (over: Partial<Parameters<typeof renderOwnerStatementPdf>[1]> = {}) => ({
  entityName: 'Olive Owner LLC',
  ownerName: 'Olive Owner',
  pmCompanyName: 'Hilltop Management',
  monthLabel: 'August 2026',
  generatedAt: '2026-09-03T15:00:00.000Z',
  ...over,
})

interface Seeded { landlordId: string; userId: string; pmCompanyId: string; propertyIds: string[] }

/**
 * One owner entity with `names` properties under one manager, each with money
 * on it, plus a SECOND owner with a park and money of their own — the park
 * that must never appear on this document.
 */
async function seedPortfolio(client: any, names: string[]): Promise<Seeded> {
  const { userId, landlordId } = await seedLandlord(client)
  await client.query(`UPDATE landlords SET business_name = 'Olive Owner LLC' WHERE id = $1`, [landlordId])
  const bankId = await seedUserBankAccount(client, { userId })
  const pmCompanyId = await seedPmCompany(client, { bankAccountId: bankId, name: 'Hilltop Management' })
  const propertyIds: string[] = []
  for (const [i, name] of names.entries()) {
    const propertyId = await seedProperty(client, {
      landlordId, ownerUserId: userId, managedByUserId: userId })
    await client.query(`UPDATE properties SET name = $2, pm_company_id = $3 WHERE id = $1`,
      [propertyId, name, pmCompanyId])
    await seedUnit(client, { propertyId, landlordId, rentAmount: 1000 })
    for (const [type, amount] of [
      ['allocation_owner_share', 880 + i * 100],
      ['allocation_pm_company_fee', 100 + i * 10],
    ] as const) {
      await client.query(
        `INSERT INTO user_balance_ledger (user_id, type, amount, balance_after, property_id, created_at)
         VALUES ($1,$2,$3,0,$4,$5::date + INTERVAL '9 days')`,
        [userId, type, amount.toFixed(2), propertyId, M])
    }
    await client.query(
      `INSERT INTO landlord_expenses
         (landlord_id, property_id, category, amount, description, vendor, expense_date, status)
       VALUES ($1,$2,'repairs',$3,'Water heater element','Ace Plumbing',$4::date,'active')`,
      [landlordId, propertyId, (150 + i * 25).toFixed(2), M])
    propertyIds.push(propertyId)
  }
  return { landlordId, userId, pmCompanyId, propertyIds }
}

/** The other owner's park and the money on it — never this owner's business. */
async function seedSomebodyElse(client: any, pmCompanyId: string): Promise<void> {
  const { userId, landlordId } = await seedLandlord(client)
  await client.query(`UPDATE landlords SET business_name = 'Somebody Else Holdings' WHERE id = $1`, [landlordId])
  const propertyId = await seedProperty(client, {
    landlordId, ownerUserId: userId, managedByUserId: userId })
  await client.query(`UPDATE properties SET name = 'Not Your Park', pm_company_id = $2 WHERE id = $1`,
    [propertyId, pmCompanyId])
  await seedUnit(client, { propertyId, landlordId, rentAmount: 1000 })
  await client.query(
    `INSERT INTO user_balance_ledger (user_id, type, amount, balance_after, property_id, created_at)
     VALUES ($1,'allocation_owner_share','7654.32',0,$2,$3::date + INTERVAL '9 days')`,
    [userId, propertyId, M])
}

describe('the owner statement PDF', () => {
  it('renders a real seeded statement, with every figure the statement computed', async () => {
    const client = await getClient()
    let s: OwnerStatement
    try {
      const seeded = await seedPortfolio(client, ['Cedar Grove', 'Birch Hollow'])
      s = await ownerStatement({
        landlordId: seeded.landlordId, periodMonth: M, pmCompanyId: seeded.pmCompanyId })
    } finally { client.release() }

    // What the statement says, so the page can be checked against it.
    expect(s.properties.map(p => p.propertyName).sort()).toEqual(['Birch Hollow', 'Cedar Grove'])
    expect(s.totals.ownerShare).toBe(1860)       // 880 + 980
    expect(s.totals.managementFee).toBe(210)     // 100 + 110
    expect(s.totals.expenses).toBe(325)          // 150 + 175
    expect(s.totals.net).toBe(1535)              // 1860 - 325

    const pdf = await renderOwnerStatementPdf(s, meta())
    expect(Buffer.isBuffer(pdf)).toBe(true)
    expect(pdf.subarray(0, 5).toString()).toBe('%PDF-')

    const doc = await PDFDocument.load(pdf)
    // A cover, then one page per property.
    expect(doc.getPageCount()).toBe(3)
    expect(doc.getTitle()).toBe('Owner statement - Olive Owner LLC - August 2026')
    expect(doc.getAuthor()).toBe('Gold Asset Management')

    const words = pdfWords(pdf)
    expect(words).toContain('OWNER STATEMENT')
    expect(words).toContain('Olive Owner LLC')
    expect(words).toContain('managed by Hilltop Management')
    expect(words).toContain('August 2026')
    // Both parks, and both of their names on their own section.
    expect(words).toContain('Cedar Grove')
    expect(words).toContain('Birch Hollow')
    // The figures, formatted the way the page formats them.
    expect(words).toContain('$1,535.00')   // net to you
    expect(words).toContain('$1,860.00')   // owner share
    expect(words).toContain('$210.00')     // the manager's cut, shown and not absorbed
    expect(words).toContain('$325.00')     // bills paid on their behalf
    // The expense LINES, because a disputed statement is disputed one line at a time.
    expect(words).toContain('Water heater element')
    expect(words).toContain('Ace Plumbing')
    expect(words).toContain('$150.00')
    expect(words).toContain('$175.00')
    // The sentence that stops the first support call: GAM's fee is not on here.
    expect(words).toMatch(/GAM.{0,4}s own fee is not on this statement/)
    // A footer on every page.
    expect(words).toContain('Page 1 of 3')
    expect(words).toContain('Page 3 of 3')
  })

  it('never puts another owner\'s park or money on the page', async () => {
    const client = await getClient()
    let s: OwnerStatement
    try {
      const seeded = await seedPortfolio(client, ['Cedar Grove'])
      // Same manager, different owner — the realistic shape of the mistake.
      await seedSomebodyElse(client, seeded.pmCompanyId)
      s = await ownerStatement({
        landlordId: seeded.landlordId, periodMonth: M, pmCompanyId: seeded.pmCompanyId })
    } finally { client.release() }

    const words = pdfWords(await renderOwnerStatementPdf(s, meta()))
    expect(words).toContain('Cedar Grove')
    expect(words).not.toContain('Not Your Park')
    expect(words).not.toContain('Somebody Else Holdings')
    expect(words).not.toContain('$7,654.32')
  })

  it('says a month with no properties was empty rather than printing a page of zeros', async () => {
    const client = await getClient()
    let s: OwnerStatement
    try {
      const { userId, landlordId } = await seedLandlord(client)
      const bankId = await seedUserBankAccount(client, { userId })
      const pmCompanyId = await seedPmCompany(client, { bankAccountId: bankId, name: 'Hilltop Management' })
      s = await ownerStatement({ landlordId, periodMonth: M, pmCompanyId })
    } finally { client.release() }

    expect(s.properties).toHaveLength(0)
    const pdf = await renderOwnerStatementPdf(s, meta())
    const doc = await PDFDocument.load(pdf)
    expect(doc.getPageCount()).toBe(1)
    const words = pdfWords(pdf)
    expect(words).toContain('No properties were under Hilltop Management in August 2026.')
  })

  it('survives words Helvetica cannot draw instead of crashing mid-render', async () => {
    const client = await getClient()
    let s: OwnerStatement
    try {
      const seeded = await seedPortfolio(client, ['Søren’s Résidence — 日本'])
      s = await ownerStatement({
        landlordId: seeded.landlordId, periodMonth: M, pmCompanyId: seeded.pmCompanyId })
    } finally { client.release() }

    const pdf = await renderOwnerStatementPdf(s, meta({ entityName: 'Olive’s — 株式会社' }))
    expect(pdf.subarray(0, 5).toString()).toBe('%PDF-')
    const words = pdfWords(pdf)
    // The Latin-1 characters survive; the rest become '?' rather than a throw.
    expect(words).toMatch(/S\xf8ren's R\xe9sidence/)
  })

  it('names the file for the owner and the month', () => {
    expect(ownerStatementFilename({ entityName: 'Olive Owner LLC' }, '2026-08-01'))
      .toBe('Owner-statement-Olive-Owner-LLC-2026-08.pdf')
    // A name with nothing usable in it still produces a filename.
    expect(ownerStatementFilename({ entityName: '—' }, '2026-08'))
      .toBe('Owner-statement-owner-2026-08.pdf')
  })
})
