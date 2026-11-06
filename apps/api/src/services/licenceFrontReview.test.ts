/**
 * ── 10/29 (Nic): THE PERSON WHO LOOKS AT THE PICTURE ───────────────────────
 *
 *   "Maybe we can have it where gam to-do list for gam admin people is
 *    verifying the front photo and typing it in by hand, or like letting the
 *    parser try to read the license and matching it up, and then we can flag a
 *    percentage of accuracy."
 *
 * Two things these tests hold: only what the OCR could NOT settle reaches a
 * person, and the person's answer becomes the answer key — which is the only
 * way a state whose cards arrive one-sided ever earns a percentage.
 */
import { describe, it, expect, beforeEach } from 'vitest'
import { db } from '../db'
import type { PoolClient } from 'pg'
import { cleanupAllSchema, seedLandlord, seedProperty, seedUnit } from '../test/dbHelpers'
import { recordFrontRead, FRONT_OCR_MIN_SAMPLE, type FrontRead } from './licenceFrontOcr'
import {
  frontReviewQueue, frontAccuracyByState, decideFrontReview, frontReviewCount,
} from './licenceFrontReview'

beforeEach(cleanupAllSchema)

const read = (o: Partial<FrontRead> = {}): FrontRead => ({
  idNumber: 'D1234567', dateOfBirth: '1979-03-14', issuingState: 'AZ',
  confidence: 94, text: 'ARIZONA DRIVER LICENSE', ...o,
})

interface World { c: PoolClient; userId: string; landlordId: string; unitId: string }

async function world(): Promise<World> {
  const c = await db.connect()
  try {
    const { userId, landlordId } = await seedLandlord(c)
    const propertyId = await seedProperty(c, { landlordId, ownerUserId: userId, managedByUserId: userId })
    const unitId = await seedUnit(c, { propertyId, landlordId })
    return { c, userId, landlordId, unitId }
  } catch (e) { c.release(); throw e }
}

async function identification(w: World, o: { idNumber?: string; state?: string | null; dob?: string | null } = {}) {
  const b = await w.c.query<{ id: string }>(
    `INSERT INTO unit_bookings (unit_id, landlord_id, lease_type, check_in, check_out, guest_name)
     VALUES ($1,$2,'nightly',CURRENT_DATE, CURRENT_DATE + 2,'Dale Pruitt') RETURNING id`,
    [w.unitId, w.landlordId])
  const i = await w.c.query<{ id: string }>(
    `INSERT INTO tenant_identifications
       (booking_id, id_type, id_number, issuing_state, date_of_birth, captured_how,
        document_front_url, document_url)
     VALUES ($1,'drivers_license',$2,$3,$4::date,'scanned','/f.jpg','/b.jpg') RETURNING id`,
    [b.rows[0].id, o.idNumber ?? 'D1234567', o.state === undefined ? 'AZ' : o.state,
     o.dob === undefined ? '1979-03-14' : o.dob])
  return i.rows[0].id
}

/**
 * Enough graded reads in one state to make its figure mean something. Each one
 * hangs off a real card on a real booking, because the history table requires
 * it — a figure assembled out of orphan rows would measure nothing.
 */
async function gradedReads(w: World, state: string, n: number, correct: number) {
  for (let k = 0; k < n; k++) {
    const b = await w.c.query<{ id: string }>(
      `INSERT INTO unit_bookings (unit_id, landlord_id, lease_type, check_in, check_out)
       VALUES ($1,$2,'nightly', CURRENT_DATE + $3::int, CURRENT_DATE + $3::int + 1) RETURNING id`,
      [w.unitId, w.landlordId, 100 + k * 2])
    const i = await w.c.query<{ id: string }>(
      `INSERT INTO tenant_identifications
         (booking_id, id_type, id_number, issuing_state, captured_how)
       VALUES ($1,'drivers_license',$2,$3,'scanned') RETURNING id`,
      [b.rows[0].id, `D${1000000 + k}`, state])
    const ok = k < correct
    await w.c.query(
      `INSERT INTO id_front_reads
         (identification_id, issuing_state, read_id_number, truth_id_number,
          id_number_agreed, dob_agreed)
       VALUES ($1,$2,$3,$3,$4,$4)`,
      [i.rows[0].id, state, `D${1000000 + k}`, ok])
  }
}

describe('what reaches a person, and what does not', () => {
  it('a front that agrees with the barcode files itself', async () => {
    const w = await world()
    try {
      const id = await identification(w)
      const out = await recordFrontRead({
        client: w.c, identificationId: id, read: read(),
        truth: { idNumber: 'D1234567', dateOfBirth: '1979-03-14' } })
      expect(out.needsReview).toBe(false)
      expect(await frontReviewCount()).toBe(0)
      expect(await frontReviewQueue()).toEqual([])
    } finally { w.c.release() }
  })

  it('a front that disagrees with the barcode goes to a person, with both pictures', async () => {
    const w = await world()
    try {
      const id = await identification(w)
      await recordFrontRead({
        client: w.c, identificationId: id, read: read({ idNumber: 'D7654321' }),
        truth: { idNumber: 'D1234567', dateOfBirth: '1979-03-14' } })
      const q = await frontReviewQueue()
      expect(q).toHaveLength(1)
      expect(q[0]).toMatchObject({
        identificationId: id, who: 'Dale Pruitt', issuingState: 'AZ',
        readIdNumber: 'D7654321', truthIdNumber: 'D1234567',
        frontUrl: '/f.jpg', backUrl: '/b.jpg', readConfidence: 94,
      })
      expect(q[0].reviewReason).toContain('do not agree')
    } finally { w.c.release() }
  })

  /** Silence is not a pass: a state nobody has measured is not a trusted state. */
  it('no barcode in an unmeasured state goes to a person', async () => {
    const w = await world()
    try {
      const id = await identification(w)
      const out = await recordFrontRead({ client: w.c, identificationId: id, read: read(), truth: null })
      expect(out.needsReview).toBe(true)
      expect(out.reason).toContain('not read enough')
    } finally { w.c.release() }
  })

  it('no barcode in a state that reads well goes straight through', async () => {
    const w = await world()
    try {
      await gradedReads(w, 'AZ', FRONT_OCR_MIN_SAMPLE, FRONT_OCR_MIN_SAMPLE)
      const id = await identification(w)
      const out = await recordFrontRead({ client: w.c, identificationId: id, read: read(), truth: null })
      expect(out.needsReview).toBe(false)
    } finally { w.c.release() }
  })

  it('no barcode in a state that reads badly is confirmed by hand', async () => {
    const w = await world()
    try {
      // 30% — Nic's own example of the state that always needs a person.
      await gradedReads(w, 'AZ', 30, 9)
      const id = await identification(w)
      const out = await recordFrontRead({ client: w.c, identificationId: id, read: read(), truth: null })
      expect(out.needsReview).toBe(true)
      expect(out.reason).toContain('30%')
      const q = await frontReviewQueue()
      expect(q[0].stateAccuracyPct).toBe(30)
      expect(q[0].stateAccuracySample).toBe(30)
    } finally { w.c.release() }
  })
})

describe('the answer, which is also the answer key', () => {
  it('confirming what is on file clears it and credits the read', async () => {
    const w = await world()
    try {
      const id = await identification(w)
      await recordFrontRead({ client: w.c, identificationId: id, read: read(), truth: null })
      const said = await decideFrontReview({ identificationId: id, byUserId: w.userId })
      expect(said).toMatchObject({ decided: true, idNumber: 'D1234567', gradedTheRead: true })
      expect(await frontReviewCount()).toBe(0)
      // The read the card came in with now counts as correct, in this state.
      const [az] = await frontAccuracyByState()
      expect(az).toMatchObject({ issuingState: 'AZ', checked: 1, correctPct: 100 })
    } finally { w.c.release() }
  })

  /**
   * The case the queue exists for. The OCR read it wrong, a person typed what
   * the card says — the card is corrected AND the read is marked wrong, so the
   * state's figure falls the way it should.
   */
  it('retyping it corrects the card and marks the read wrong', async () => {
    const w = await world()
    try {
      const id = await identification(w)
      await recordFrontRead({ client: w.c, identificationId: id, read: read({ idNumber: 'DO123456' }), truth: null })
      const said = await decideFrontReview({
        identificationId: id, byUserId: w.userId, idNumber: 'd0123456', note: 'the O is a zero' })
      expect(said).toMatchObject({ decided: true, idNumber: 'D0123456' })
      const row = await db.query<{ id_number: string; verified_by: string; needs_review: boolean; notes: string }>(
        `SELECT id_number, verified_by, needs_review, notes FROM tenant_identifications WHERE id = $1`, [id])
      expect(row.rows[0]).toMatchObject({
        id_number: 'D0123456', verified_by: w.userId, needs_review: false })
      expect(row.rows[0].notes).toContain('the O is a zero')
      const [az] = await frontAccuracyByState()
      expect(az).toMatchObject({ issuingState: 'AZ', checked: 1, correctPct: 0, trusted: false })
    } finally { w.c.release() }
  })

  /** A second answer means two people disagreed. Worth seeing, not overwriting. */
  it('refuses a second decision instead of overwriting the first', async () => {
    const w = await world()
    try {
      const id = await identification(w)
      await recordFrontRead({ client: w.c, identificationId: id, read: read(), truth: null })
      await decideFrontReview({ identificationId: id, byUserId: w.userId })
      const again = await decideFrontReview({ identificationId: id, byUserId: w.userId, idNumber: 'D9999999' })
      expect(again).toMatchObject({ decided: false })
      const row = await db.query<{ id_number: string }>(
        `SELECT id_number FROM tenant_identifications WHERE id = $1`, [id])
      expect(row.rows[0].id_number).toBe('D1234567')
    } finally { w.c.release() }
  })

  it('and refuses one for a card that is not on file', async () => {
    const w = await world()
    try {
      const said = await decideFrontReview({
        identificationId: '00000000-0000-0000-0000-000000000000', byUserId: w.userId })
      expect(said).toMatchObject({ decided: false })
    } finally { w.c.release() }
  })

  /** A card already graded by its own barcode is not re-graded by a person. */
  it('does not overwrite a grade the barcode already gave', async () => {
    const w = await world()
    try {
      const id = await identification(w)
      await recordFrontRead({
        client: w.c, identificationId: id, read: read({ idNumber: 'D7654321' }),
        truth: { idNumber: 'D1234567', dateOfBirth: '1979-03-14' } })
      const said = await decideFrontReview({ identificationId: id, byUserId: w.userId, idNumber: 'D1234567' })
      expect(said).toMatchObject({ decided: true, gradedTheRead: false })
      const g = await db.query<{ id_number_agreed: boolean; truth_id_number: string }>(
        `SELECT id_number_agreed, truth_id_number FROM id_front_reads WHERE identification_id = $1`, [id])
      expect(g.rows[0]).toMatchObject({ id_number_agreed: false, truth_id_number: 'D1234567' })
    } finally { w.c.release() }
  })
})

describe('how every state is doing', () => {
  it('says in words why a figure is not trusted yet', async () => {
    const w = await world()
    try {
      await gradedReads(w, 'NV', 5, 5)
      const [nv] = await frontAccuracyByState()
      expect(nv).toMatchObject({ issuingState: 'NV', checked: 5, correctPct: 100, trusted: false })
      expect(nv.note).toContain(`needs ${FRONT_OCR_MIN_SAMPLE}`)
    } finally { w.c.release() }
  })

  it('and names the two states differently when they read differently', async () => {
    const w = await world()
    try {
      await gradedReads(w, 'AZ', 30, 30)
      await gradedReads(w, 'IL', 30, 9)
      const byState = await frontAccuracyByState()
      const az = byState.find((r) => r.issuingState === 'AZ')!
      const il = byState.find((r) => r.issuingState === 'IL')!
      expect(az.trusted).toBe(true)
      expect(il.trusted).toBe(false)
      expect(il.note).toContain('confirmed by hand')
    } finally { w.c.release() }
  })
})
