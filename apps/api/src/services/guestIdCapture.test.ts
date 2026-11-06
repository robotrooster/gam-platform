/**
 * ── 10/29 (Nic): A BAD PHOTO IS A RETAKE, NOT A DEAD END ────────────────────
 *
 *   "If the customer scans a picture of their ID and it can't be read, it
 *    should know that and prompt the customer, hey, that picture was bad,
 *    either retake it. It gives them a chance to retake it or a couple of
 *    chances to retake it. And then if it can't be collected, then they just
 *    type it in. Or they can skip straight to typing it in the first place."
 *
 * Which is three paths through one step, and all three end with the guest able
 * to pay their deposit. The decode runs on the SERVER — the phone only takes a
 * photograph — so there is one implementation for every phone rather than a
 * decoder that works on Android and not on an iPhone.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import fs from 'fs'
import os from 'os'
import path from 'path'
import { db } from '../db'
import { cleanupAllSchema, seedLandlord, seedProperty, seedUnit } from '../test/dbHelpers'
import { captureGuestId, readLicencePhoto, ID_READ_FAILED } from './guestIdCapture'

beforeEach(cleanupAllSchema)

const tmp: string[] = []
afterEach(() => { for (const f of tmp.splice(0)) { try { fs.unlinkSync(f) } catch { /* gone */ } } })

/** A real PDF417, the symbol that is on the back of every licence. */
async function licencePhoto(payload: string): Promise<string> {
  const bwipjs = await import('bwip-js')
  const png = await (bwipjs as any).default.toBuffer({
    bcid: 'pdf417', text: payload, scale: 3, height: 14, includetext: false,
    // The decoder cannot find a symbol with no quiet zone around it — which is
    // a real-world failure too: a guest who crops tight to the barcode.
    paddingwidth: 20, paddingheight: 20, backgroundcolor: 'FFFFFF',
  })
  const f = path.join(os.tmpdir(), `lic-${Date.now()}-${Math.random().toString(36).slice(2)}.png`)
  fs.writeFileSync(f, png)
  tmp.push(f)
  return f
}

const PAYLOAD = '@\n\u001e\rANSI 636026080102DL00410288ZA03290015DLDAQD1234567\n'
  + 'DCSWISENER\nDACDALE\nDBB03141979\nDAJAZ\nDCGUSA\n'

/** A photograph with no barcode in it — the front of the card, or a blur. */
async function unreadablePhoto(): Promise<string> {
  const Jimp = (await import('jimp')).default as any
  const img = new Jimp(400, 250, 0xCCCCCCFF)
  const f = path.join(os.tmpdir(), `blur-${Date.now()}-${Math.random().toString(36).slice(2)}.png`)
  await img.writeAsync(f)
  tmp.push(f)
  return f
}

async function booking() {
  const c = await db.connect()
  try {
    const { userId, landlordId } = await seedLandlord(c)
    const propertyId = await seedProperty(c, { landlordId, ownerUserId: userId, managedByUserId: userId })
    const unitId = await seedUnit(c, { propertyId, landlordId })
    const b = await c.query<{ id: string }>(
      `INSERT INTO unit_bookings (unit_id, landlord_id, lease_type, check_in, check_out, guest_name)
       VALUES ($1,$2,'weekly',CURRENT_DATE, CURRENT_DATE + 7,'Dale Wisener') RETURNING id`,
      [unitId, landlordId])
    return b.rows[0].id
  } finally { c.release() }
}

const inTx = async <T>(fn: (c: any) => Promise<T>): Promise<T> => {
  const c = await db.connect()
  try { await c.query('BEGIN'); const r = await fn(c); await c.query('COMMIT'); return r }
  catch (e) { await c.query('ROLLBACK'); throw e } finally { c.release() }
}

describe('reading the photo the guest sends', () => {
  it('reads a licence and says so', async () => {
    const r = await readLicencePhoto(await licencePhoto(PAYLOAD))
    expect(r.ok).toBe(true)
    if (r.ok) {
      expect(r.fields.idNumber).toBe('D1234567')
      expect(r.fields.dateOfBirth).toBe('1979-03-14')
    }
  })

  it('says WHY when it cannot, in words a guest can act on', async () => {
    const r = await readLicencePhoto(await unreadablePhoto())
    expect(r.ok).toBe(false)
    if (!r.ok) {
      // The barcode is on the back — the commonest mistake and the one thing
      // worth saying, since a missing symbol and a blurred one look identical.
      expect(r.reason).toBe(ID_READ_FAILED)
      expect(r.reason).toMatch(/back/i)
    }
  })

  it('does not throw on a file that is not an image at all', async () => {
    const f = path.join(os.tmpdir(), `junk-${Date.now()}.png`)
    fs.writeFileSync(f, 'not an image')
    tmp.push(f)
    expect((await readLicencePhoto(f)).ok).toBe(false)
  })
})

describe('the three ways a guest gets through the step', () => {
  it('photo that reads: everything is filled from the card', async () => {
    const bookingId = await booking()
    const photo = await licencePhoto(PAYLOAD)
    const r = await inTx(c => captureGuestId({
      client: c, bookingId, filePath: photo, documentUrl: '/api/x/lic.png',
    }))
    expect(r.filed).toBe(true)
    if (r.filed) {
      expect(r.capturedHow).toBe('scanned')
      expect(r.fields.idNumber).toBe('D1234567')
      expect(r.readFailed).toBeUndefined()
    }
    // The birthday also lands on the booking, where the matcher looks for a
    // guest who has no tenant record at all.
    const b = (await db.query<any>(
      `SELECT guest_date_of_birth::text AS dob FROM unit_bookings WHERE id = $1`, [bookingId])).rows[0]
    expect(b.dob).toBe('1979-03-14')
  })

  it('photo that does not read: nothing is filed, and they are told to retake', async () => {
    const bookingId = await booking()
    const photo = await unreadablePhoto()
    const r = await inTx(c => captureGuestId({
      client: c, bookingId, filePath: photo, documentUrl: '/api/x/blur.png',
    }))
    expect(r.filed).toBe(false)
    expect((r as any).readFailed).toBe(ID_READ_FAILED)
    // No half-record identifying nobody.
    const n = (await db.query<{ c: string }>(
      `SELECT COUNT(*)::text AS c FROM tenant_identifications WHERE booking_id = $1`, [bookingId])).rows[0]
    expect(Number(n.c)).toBe(0)
  })

  it('typed instead, with no photo at all — the guest who skips straight to it', async () => {
    const bookingId = await booking()
    const r = await inTx(c => captureGuestId({
      client: c, bookingId, filePath: null, documentUrl: null,
      typed: { idNumber: 'D7654321', dateOfBirth: '1984-06-02', issuingState: 'AZ' },
    }))
    expect(r.filed).toBe(true)
    if (r.filed) {
      expect(r.capturedHow).toBe('typed')
      expect(r.fields.idNumber).toBe('D7654321')
    }
  })

  it('done retaking: the photo is kept even unread, which is the copy the park wanted', async () => {
    const bookingId = await booking()
    const photo = await unreadablePhoto()
    const r = await inTx(c => captureGuestId({
      client: c, bookingId, filePath: photo,
      documentUrl: '/api/x/blur.png', keepUnreadable: true,
    }))
    expect(r.filed).toBe(true)
    if (r.filed) expect(r.readFailed).toBe(ID_READ_FAILED)
    const row = (await db.query<any>(
      `SELECT document_url, captured_how FROM tenant_identifications WHERE booking_id = $1`,
      [bookingId])).rows[0]
    expect(row.document_url).toBe('/api/x/blur.png')
    expect(row.captured_how).toBe('typed')     // nothing was read off it
  })

  /**
   * 10/29 (Nic): "We should get the picture of the front and the back."
   *
   * The front is never machine-read — that is OCR, a different engine. It is
   * kept because it is the side a person reads and the copy a park wants on
   * file, and because the guest types from it when the barcode will not take.
   */
  it('keeps both sides when the guest sends both', async () => {
    const bookingId = await booking()
    const photo = await licencePhoto(PAYLOAD)
    const r = await inTx(c => captureGuestId({
      client: c, bookingId, filePath: photo,
      documentUrl: '/api/x/back.png', frontUrl: '/api/x/front.png',
    }))
    expect(r.filed).toBe(true)
    const row = (await db.query<any>(
      `SELECT document_url, document_front_url FROM tenant_identifications WHERE booking_id = $1`,
      [bookingId])).rows[0]
    expect(row.document_url).toBe('/api/x/back.png')
    expect(row.document_front_url).toBe('/api/x/front.png')
  })

  it('a front on its own is still worth filing', async () => {
    // They photographed the front, the back would not read, and they gave up
    // on retaking. The park still has the copy it wanted.
    const bookingId = await booking()
    const r = await inTx(c => captureGuestId({
      client: c, bookingId, filePath: null, documentUrl: null,
      frontUrl: '/api/x/front.png', keepUnreadable: true,
    }))
    expect(r.filed).toBe(true)
    const row = (await db.query<any>(
      `SELECT document_front_url, document_url FROM tenant_identifications WHERE booking_id = $1`,
      [bookingId])).rows[0]
    expect(row.document_front_url).toBe('/api/x/front.png')
    expect(row.document_url).toBeNull()
  })

  it('retaking only the back does not wipe the front already given', async () => {
    const bookingId = await booking()
    await inTx(c => captureGuestId({
      client: c, bookingId, filePath: null, documentUrl: null,
      frontUrl: '/api/x/front.png', keepUnreadable: true,
    }))
    const photo = await licencePhoto(PAYLOAD)
    await inTx(c => captureGuestId({
      client: c, bookingId, filePath: photo, documentUrl: '/api/x/back.png',
    }))
    const row = (await db.query<any>(
      `SELECT document_url, document_front_url, id_number
         FROM tenant_identifications WHERE booking_id = $1`, [bookingId])).rows[0]
    expect(row.document_front_url).toBe('/api/x/front.png')   // still there
    expect(row.document_url).toBe('/api/x/back.png')
    expect(row.id_number).toBe('D1234567')
  })

  it('a second attempt replaces the first, never stacks', async () => {
    const bookingId = await booking()
    await inTx(c => captureGuestId({
      client: c, bookingId, filePath: null, documentUrl: null,
      typed: { idNumber: 'WRONG123', dateOfBirth: '1984-06-02' },
    }))
    const photo = await licencePhoto(PAYLOAD)
    await inTx(c => captureGuestId({
      client: c, bookingId, filePath: photo, documentUrl: '/api/x/lic.png',
    }))
    const rows = await db.query<any>(
      `SELECT id_number FROM tenant_identifications WHERE booking_id = $1`, [bookingId])
    expect(rows.rows).toHaveLength(1)
    expect(rows.rows[0].id_number).toBe('D1234567')
  })
})

/**
 * ── 10/29 (review): THE SECOND SUBMISSION MUST NOT DESTROY THE FIRST ────────
 *
 * The upsert kept every field it already had EXCEPT the licence number, which
 * was written unconditionally from an idNumber-or-empty-string placeholder. So
 * a guest doing exactly what the page asked — coming back to add the front
 * picture — wiped the one identity point the whole feature exists to hold, and
 * the row still read as verified with nothing in it.
 */
describe('coming back to add the other side', () => {
  const idRow = async (bookingId: string) => (await db.query<any>(
    `SELECT id_number, captured_how, needs_review, document_url, document_front_url
       FROM tenant_identifications WHERE booking_id = $1`, [bookingId])).rows[0]

  it('keeps the scanned number when the second go reads nothing', async () => {
    const bookingId = await booking()
    const back = await licencePhoto(PAYLOAD)
    await inTx(c => captureGuestId({
      client: c, bookingId, filePath: back, documentUrl: '/uploads/guest-licences/back.jpg' }))
    expect((await idRow(bookingId)).id_number).toBe('D1234567')

    // Front only, unreadable, nothing typed — the retake the park asked for.
    const blank = await unreadablePhoto()
    await inTx(c => captureGuestId({
      client: c, bookingId, filePath: null, documentUrl: null,
      frontUrl: '/uploads/guest-licences/front.jpg', frontPath: blank, keepUnreadable: true }))

    const after = await idRow(bookingId)
    expect(after.id_number).toBe('D1234567')          // NOT blanked
    expect(after.captured_how).toBe('scanned')        // NOT downgraded to typed
    expect(after.document_url).toBe('/uploads/guest-licences/back.jpg')
    expect(after.document_front_url).toBe('/uploads/guest-licences/front.jpg')
  })

  it('still takes a BETTER number when the second go reads one', async () => {
    const bookingId = await booking()
    const blank = await unreadablePhoto()
    await inTx(c => captureGuestId({
      client: c, bookingId, filePath: blank, documentUrl: '/uploads/guest-licences/a.jpg',
      keepUnreadable: true }))
    const back = await licencePhoto(PAYLOAD)
    await inTx(c => captureGuestId({
      client: c, bookingId, filePath: back, documentUrl: '/uploads/guest-licences/b.jpg' }))
    expect((await idRow(bookingId)).id_number).toBe('D1234567')
  })
})

/**
 * ── 10/29 (review): A FAILED READ MUST NOT TAKE THE CAPTURE WITH IT ─────────
 *
 * recordFrontRead writes on the CALLER's transaction. Catching its error was
 * not enough — a Postgres error had already aborted that transaction, so the
 * identification was gone and the caller's COMMIT became a silent ROLLBACK.
 * The guest was told their licence was on file and nothing existed. A SAVEPOINT
 * is what lets a best-effort read fail on its own.
 */
describe('the front reader falling over', () => {
  it('files the identification even when grading the front raises', async () => {
    const bookingId = await booking()
    const back = await licencePhoto(PAYLOAD)
    // A path that is not an image at all: the reader returns null, and anything
    // it does raise is contained by the savepoint.
    const notAnImage = path.join(os.tmpdir(), `gam-not-an-image-${Date.now()}.jpg`)
    fs.writeFileSync(notAnImage, 'this is not a picture')
    tmp.push(notAnImage)

    const out = await inTx(c => captureGuestId({
      client: c, bookingId, filePath: back, documentUrl: '/uploads/guest-licences/back.jpg',
      frontUrl: '/uploads/guest-licences/front.jpg', frontPath: notAnImage }))

    expect(out.filed).toBe(true)
    // The row COMMITTED — the whole point. Before the savepoint this read empty.
    const row = (await db.query<any>(
      `SELECT id_number FROM tenant_identifications WHERE booking_id = $1`, [bookingId])).rows[0]
    expect(row).toBeTruthy()
    expect(row.id_number).toBe('D1234567')
  })
})
