/**
 * ── 10/29 (Nic): OCR THE FRONT, BUT KNOW WHEN NOT TO TRUST IT ───────────────
 *
 *   "Let's do local OCR, I guess, but let's have a human verification for
 *    things that are either potentially wrong or knowingly need to be looked
 *    at... we're getting 99% accuracy in this state, and this state is only
 *    30%, and so these ones need to be always verified by a real person."
 *
 * The barcode on the back is the answer key: where a guest sent both sides it
 * says what the front should have said, so every read grades itself on a real
 * card from a real state, free.
 */
import { describe, it, expect, beforeEach } from 'vitest'
import fs from 'fs'
import os from 'os'
import path from 'path'
import { db } from '../db'
import { cleanupAllSchema, seedLandlord, seedProperty, seedUnit } from '../test/dbHelpers'
import {
  extractFrontFields, recordFrontRead, stateFrontAccuracy, readLicenceFront,
  FRONT_OCR_MIN_SAMPLE, FRONT_OCR_TRUST_PCT, type FrontRead,
} from './licenceFrontOcr'

beforeEach(cleanupAllSchema)

/** What tesseract gives back off an Arizona card. */
const AZ_TEXT = `ARIZONA DRIVER LICENSE
DL D1234567

LN WISENER

FN DALE JAMES

DOB 03/14/1979

EXP 03/14/2028`

const read = (o: Partial<FrontRead> = {}): FrontRead => ({
  idNumber: 'D1234567', dateOfBirth: '1979-03-14', issuingState: 'AZ',
  confidence: 94, text: AZ_TEXT, ...o,
})

async function identification() {
  const c = await db.connect()
  try {
    const { userId, landlordId } = await seedLandlord(c)
    const propertyId = await seedProperty(c, { landlordId, ownerUserId: userId, managedByUserId: userId })
    const unitId = await seedUnit(c, { propertyId, landlordId })
    const b = await c.query<{ id: string }>(
      `INSERT INTO unit_bookings (unit_id, landlord_id, lease_type, check_in, check_out)
       VALUES ($1,$2,'weekly',CURRENT_DATE, CURRENT_DATE + 7) RETURNING id`, [unitId, landlordId])
    const i = await c.query<{ id: string }>(
      `INSERT INTO tenant_identifications (booking_id, id_type, id_number, captured_how)
       VALUES ($1,'drivers_license','D1234567','scanned') RETURNING id`, [b.rows[0].id])
    return i.rows[0].id
  } finally { c.release() }
}

const inTx = async <T>(fn: (c: any) => Promise<T>): Promise<T> => {
  const c = await db.connect()
  try { await c.query('BEGIN'); const r = await fn(c); await c.query('COMMIT'); return r }
  catch (e) { await c.query('ROLLBACK'); throw e } finally { c.release() }
}

describe('pulling fields off what the OCR saw', () => {
  it('reads the number, the birthday, the expiry and the state by their labels', () => {
    expect(extractFrontFields(AZ_TEXT)).toEqual({
      idNumber: 'D1234567', dateOfBirth: '1979-03-14',
      expiryDate: '2028-03-14', issuingState: 'AZ',
    })
  })

  /**
   * The header names the state in full on every US card; the two-letter code
   * only shows up in the address. Reading a bare code would make "LA PAZ" a
   * Louisiana licence, so a code counts only where a ZIP follows it.
   */
  it('reads the state from the header name, longest name first', () => {
    expect(extractFrontFields('WEST VIRGINIA DRIVER LICENSE').issuingState).toBe('WV')
    expect(extractFrontFields('NEW MEXICO DRIVER LICENSE').issuingState).toBe('NM')
  })

  it('falls back to the postal code only in address position', () => {
    expect(extractFrontFields('DL D1234567\n1 MAIN ST\nPHOENIX AZ 85001').issuingState).toBe('AZ')
    expect(extractFrontFields('DL D1234567\n142 LA PAZ RD\nSOMEWHERE').issuingState).toBeUndefined()
  })

  it('tells the birthday from the expiry by the label, not the order', () => {
    const f = extractFrontFields('EXP 03/14/2028\nDOB 03/14/1979')
    expect(f.dateOfBirth).toBe('1979-03-14')
    expect(f.expiryDate).toBe('2028-03-14')
  })

  /**
   * Guessing which loose number on a card is the licence number is how a
   * matcher ends up confidently wrong about who somebody is. No label, no
   * field.
   */
  /**
   * 10/29 (review): a day that does not exist used to pass as a date and then
   * raise on the ::date cast downstream — inside the caller's open transaction,
   * which took the guest's whole capture with it. February 31st is an ordinary
   * OCR misread of a 21 or a 24.
   */
  it('refuses a day that is not a real day of that month', () => {
    expect(extractFrontFields('DOB 02/31/1980').dateOfBirth).toBeUndefined()
    expect(extractFrontFields('DOB 04/31/1980').dateOfBirth).toBeUndefined()
    expect(extractFrontFields('DOB 02/29/1979').dateOfBirth).toBeUndefined()  // not a leap year
    // ...and still takes the real ones, leap day included.
    expect(extractFrontFields('DOB 02/29/1980').dateOfBirth).toBe('1980-02-29')
    expect(extractFrontFields('DOB 01/31/1980').dateOfBirth).toBe('1980-01-31')
  })

  it('takes no number at all when the label was not read', () => {
    expect(extractFrontFields('WISENER DALE\n1200 W GURLEY ST\n86301').idNumber).toBeUndefined()
  })

  it('ignores a word it mistook for a number', () => {
    expect(extractFrontFields('DL DRIVERLICENSE').idNumber).toBeUndefined()
  })
})

/**
 * ── 10/29: THE ENGINE ACTUALLY READS, FROM OUR OWN MODEL ────────────────────
 *
 * Everything else in this file tests the PARSING — extractFrontFields over a
 * string, recordFrontRead over a read object. Nothing loaded the model, so when
 * the langPath fix shipped pointing at an uncompressed file while the library
 * was looking for a .gz, the whole reader broke and all 16,315 tests stayed
 * green. It fails safe (errorHandler swallows it, every read comes back
 * unreadable, everything goes to a person) which is exactly why nothing
 * noticed.
 *
 * So one test runs the real engine end to end: rendered text in, fields out.
 * It is the guard on three things at once — that the model is committed where
 * langPath says, that gzip matches the file we ship, and that no runtime fetch
 * or cwd write is needed to read a licence.
 */
describe('the reader, end to end on its own model', () => {
  it('reads a rendered card from the committed model, fetching and writing nothing', async () => {
    const Jimp = (await import('jimp')) as any
    const J = Jimp.default ?? Jimp
    const img = await J.create(900, 260, 0xffffffff)
    const font = await J.loadFont(J.FONT_SANS_64_BLACK)
    img.print(font, 20, 20, 'ARIZONA DRIVER LICENSE')
    img.print(font, 20, 100, 'DL D1234567')
    img.print(font, 20, 180, 'DOB 03/14/1979')
    const shot = path.join(os.tmpdir(), `gam-ocr-${Date.now()}.png`)
    await img.writeAsync(shot)

    // Nothing may be written into the working directory: a read-only or
    // ephemeral container would refuse it, and it means a runtime download.
    const strayBefore = fs.existsSync(path.join(process.cwd(), 'eng.traineddata'))

    try {
      const got = await readLicenceFront(shot)
      expect(got).not.toBeNull()
      expect(got!.idNumber).toBe('D1234567')
      expect(got!.dateOfBirth).toBe('1979-03-14')
      expect(got!.issuingState).toBe('AZ')
      expect(fs.existsSync(path.join(process.cwd(), 'eng.traineddata'))).toBe(strayBefore)
    } finally { try { fs.unlinkSync(shot) } catch { /* gone */ } }
  }, 60_000)
})

describe('deciding whether a person has to look', () => {
  it('flags a disagreement between the front and the barcode', async () => {
    const id = await identification()
    const r = await inTx(c => recordFrontRead({
      client: c, identificationId: id, read: read({ idNumber: 'D7654321' }),
      truth: { idNumber: 'D1234567', dateOfBirth: '1979-03-14' },
    }))
    expect(r.needsReview).toBe(true)
    expect(r.reason).toMatch(/do not agree/i)
    const row = (await db.query<any>(
      `SELECT needs_review, review_reason FROM tenant_identifications WHERE id = $1`, [id])).rows[0]
    expect(row.needs_review).toBe(true)
    expect(row.review_reason).toMatch(/look at the pictures/i)
  })

  it('trusts a front the barcode agrees with', async () => {
    const id = await identification()
    const r = await inTx(c => recordFrontRead({
      client: c, identificationId: id, read: read(),
      truth: { idNumber: 'D1234567', dateOfBirth: '1979-03-14' },
    }))
    expect(r.needsReview).toBe(false)
  })

  /** Silence is not a pass: an unmeasured state goes to a person. */
  it('flags a front with no barcode when the state has never been measured', async () => {
    const id = await identification()
    const r = await inTx(c => recordFrontRead({
      client: c, identificationId: id, read: read(), truth: null,
    }))
    expect(r.needsReview).toBe(true)
    expect(r.reason).toMatch(/not read enough AZ/i)
  })

  it('stops flagging once a state has proved itself', async () => {
    // Enough clean reads for Arizona to earn its figure.
    for (let i = 0; i < FRONT_OCR_MIN_SAMPLE; i++) {
      const id = await identification()
      await inTx(c => recordFrontRead({
        client: c, identificationId: id, read: read(),
        truth: { idNumber: 'D1234567', dateOfBirth: '1979-03-14' },
      }))
    }
    const acc = await stateFrontAccuracy(db, 'AZ')
    expect(acc).not.toBeNull()
    expect(acc!.pct).toBe(100)
    expect(acc!.sample).toBe(FRONT_OCR_MIN_SAMPLE)

    // Now a front on its own is taken on trust.
    const id = await identification()
    const r = await inTx(c => recordFrontRead({ client: c, identificationId: id, read: read(), truth: null }))
    expect(r.needsReview).toBe(false)
  })

  /**
   * ── 10/29 (review): ONE CARD IS ONE SAMPLE ────────────────────────────────
   *
   * Every read was its own row, and the guest's page can be POSTed as often as
   * they like against one booking. So one crisp card photographed ten times
   * supplied half a state's sample and could carry it over the trust threshold
   * on two physical cards — or, retaken while worn, push a genuinely good state
   * under it and flood the queue.
   */
  it('counts one card once, however many times it was photographed', async () => {
    const id = await identification()
    for (let i = 0; i < 10; i++) {
      await inTx(c => recordFrontRead({
        client: c, identificationId: id, read: read(),
        truth: { idNumber: 'D1234567', dateOfBirth: '1979-03-14' },
      }))
    }
    // Ten rows, one card: not a sample yet, so a front still goes to a person.
    expect(await stateFrontAccuracy(db, 'AZ')).toBeNull()
  })

  /**
   * ── 10/29 (review): NO BIRTHDAY TO CHECK IS NOT A WRONG ANSWER ────────────
   *
   * The denominator asked for a graded NUMBER but the numerator demanded the
   * birthday agreed too — and that stays NULL whenever there was no birthday to
   * grade against. A NULL is not a hit, so twenty perfectly-read cards with no
   * DOB on file reported "0% of 20", which meant the hand confirmations that
   * are supposed to let a state earn its percentage guaranteed it never could.
   */
  it('scores a read with no birthday to check on the number alone', async () => {
    for (let i = 0; i < FRONT_OCR_MIN_SAMPLE; i++) {
      const id = await identification()
      await inTx(c => recordFrontRead({
        client: c, identificationId: id,
        read: read({ dateOfBirth: undefined }),
        // A barcode that carried no DBB — the number is all there is to grade.
        truth: { idNumber: 'D1234567' },
      }))
    }
    const acc = await stateFrontAccuracy(db, 'AZ')
    expect(acc).not.toBeNull()
    expect(acc!.sample).toBe(FRONT_OCR_MIN_SAMPLE)
    expect(acc!.pct).toBe(100)          // was 0, which could never be earned back
  })

  it('keeps flagging a state that reads badly, however many are seen', async () => {
    // Twenty Illinois cards, only a quarter of them read right.
    for (let i = 0; i < FRONT_OCR_MIN_SAMPLE; i++) {
      const id = await identification()
      const wrong = i % 4 !== 0
      await inTx(c => recordFrontRead({
        client: c, identificationId: id,
        read: read({ issuingState: 'IL', idNumber: wrong ? 'WRONG999' : 'D1234567' }),
        truth: { idNumber: 'D1234567', dateOfBirth: '1979-03-14' },
      }))
    }
    const acc = await stateFrontAccuracy(db, 'IL')
    expect(acc!.pct).toBeLessThan(FRONT_OCR_TRUST_PCT)

    const id = await identification()
    const r = await inTx(c => recordFrontRead({
      client: c, identificationId: id, read: read({ issuingState: 'IL' }), truth: null,
    }))
    expect(r.needsReview).toBe(true)
    expect(r.reason).toMatch(/only 25% of the time in IL/i)
  })

  it('flags a read that could not even say which state it was', async () => {
    const id = await identification()
    const r = await inTx(c => recordFrontRead({
      client: c, identificationId: id, read: read({ issuingState: undefined }), truth: null,
    }))
    expect(r.needsReview).toBe(true)
    expect(r.reason).toMatch(/which state/i)
  })
})
