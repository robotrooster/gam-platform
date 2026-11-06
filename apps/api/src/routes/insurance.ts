/**
 * 11/01 — INSURANCE, OVER THE WIRE.
 *
 * One surface for all three kinds of certificate an operator keeps:
 *
 *   a property's building or premises-liability policy  (subject: propertyId)
 *   a resident's renters / liability policy             (subject: leaseId)
 *   a vendor's general liability and bond               (subject: vendorId)
 *
 * …plus the thing none of them had before: GET /lapses, which answers "what has
 * expired, and what expires within N days" for the asking company's own
 * properties, residents and vendors. A certificate on file that lapsed three
 * months ago is worse than no certificate, because the operator believes they
 * are covered; until this list existed, nothing in GAM ever said so.
 *
 * ── PER-ROW AUTHORIZATION ───────────────────────────────────────────────────
 *
 * Every read — the list, the lapse list, one policy, and the certificate file —
 * goes through services/insurancePolicies.ts, which resolves the owning company
 * FROM THE SUBJECT and has one definition of "whose policy is this". There is no
 * other way to fetch a policy in this file. That is deliberate: reading another
 * landlord's row (or another landlord's uploaded file) is the recurring bug class
 * here, and its cause every time is the same check written again at each call
 * site, so one call site is written without it.
 *
 * Another company's policy answers 404, never 403 — "Forbidden" on a guessed id
 * confirms the id is real, which is how one landlord learns another landlord's
 * record exists. Same rule the property task list follows.
 *
 * The certificate PDF is served ONLY by GET /:id/proof, which authorizes the
 * policy row and then hands the path to streamStoredFile. `proof_url` is never
 * in a response body and nothing under uploads/ is served statically
 * ([[gam-nothing-public-rule]]).
 *
 * ── WHO MAY DO WHAT ─────────────────────────────────────────────────────────
 *
 * insurance.view reads; insurance.manage records, edits, verifies and voids.
 * Owner roles pass both by requirePerm. The front desk collects a resident's
 * certificate at move-in and maintenance checks a contractor's before letting
 * them on site, so these are jobs that genuinely get handed out.
 *
 * A TENANT REACHES NOTHING HERE. There is no tenant route and no tenant role
 * passes requirePerm, so a resident cannot even read their own policy row on
 * this surface — recording their own renters insurance is a tenant-portal
 * surface that does not exist yet, and it is better refused than half-built.
 *
 * ── NO LEGAL GATE ───────────────────────────────────────────────────────────
 *
 * No minimum coverage amount, no required policy, no state rule, no "your state
 * requires X". coverage_amount is recorded and never checked against anything.
 * What an operator asks of a resident or a vendor is the operator's to decide.
 */
import { Router } from 'express'
import { z } from 'zod'
import path from 'path'
import fs from 'fs'
import crypto from 'crypto'
import multer from 'multer'
import {
  INSURANCE_COVERAGE_TYPES,
  INSURANCE_COVERAGE_BY_SUBJECT,
  INSURANCE_COVERAGE_LABEL,
  INSURANCE_SUBJECT_LABEL,
  type InsuranceCoverageType,
  type InsuranceSubject,
} from '@gam/shared'
import { query, queryOne } from '../db'
import { requireAuth, requirePerm, assertPropertyInScope } from '../middleware/auth'
import { canAccessLandlordResource } from '../middleware/scope'
import { AppError } from '../middleware/errorHandler'
import { streamStoredFile } from '../lib/fileServe'
import {
  getPolicyForUser,
  getPolicyProofForUser,
  listPoliciesForUser,
  lapseListForUser,
  lapseWindowDays,
} from '../services/insurancePolicies'

export const insuranceRouter = Router()
insuranceRouter.use(requireAuth)

const UUID = z.string().uuid()
const COVERAGE = z.enum(INSURANCE_COVERAGE_TYPES as unknown as [InsuranceCoverageType, ...InsuranceCoverageType[]])

/**
 * The subject, as the request names it. Exactly one, matching the database's own
 * one-subject CHECK — a certificate about nothing records nothing, and a
 * certificate about two things has two answers to "whose is it".
 */
const subjectSchema = z.object({
  propertyId: UUID.optional(),
  leaseId:    UUID.optional(),
  vendorId:   UUID.optional(),
})

/**
 * Every fact on the certificate except the carrier is optional, and nullable as
 * well as absent: a client clearing a field sends null, and on a create the two
 * mean the same thing. An operator who has the carrier and the expiry date off a
 * phone call has something worth recording — a recorded expiry date is what the
 * lapse list reads — so nothing beyond the carrier is demanded.
 */
const createSchema = subjectSchema.extend({
  coverageType:   COVERAGE,
  carrierName:    z.string().trim().min(1, 'Type the carrier that wrote the policy').max(200),
  policyNumber:   z.string().trim().max(120).nullable().optional(),
  // Recorded as the certificate states it. Never compared to a minimum.
  coverageAmount: z.number().min(0).max(999_999_999.99).nullable().optional(),
  effectiveDate:  z.string().regex(/^\d{4}-\d{2}-\d{2}$/).nullable().optional(),
  expiryDate:     z.string().regex(/^\d{4}-\d{2}-\d{2}$/).nullable().optional(),
  notes:          z.string().trim().max(2000).nullable().optional(),
  /** A person saying they have read the certificate — their name goes on it. */
  verified:       z.boolean().optional(),
})

const patchSchema = z.object({
  carrierName:    z.string().trim().min(1, 'Type the carrier that wrote the policy').max(200).optional(),
  policyNumber:   z.string().trim().max(120).nullable().optional(),
  coverageAmount: z.number().min(0).max(999_999_999.99).nullable().optional(),
  effectiveDate:  z.string().regex(/^\d{4}-\d{2}-\d{2}$/).nullable().optional(),
  expiryDate:     z.string().regex(/^\d{4}-\d{2}-\d{2}$/).nullable().optional(),
  notes:          z.string().trim().max(2000).nullable().optional(),
  verified:       z.boolean().optional(),
})

const voidSchema = z.object({
  reason: z.string().trim().min(1, 'Say why this policy is coming off the record').max(500),
})

/** Plain English, not a zod dump. */
function parsed<T>(schema: z.ZodType<T>, body: unknown): T {
  const r = schema.safeParse(body)
  if (!r.success) throw new AppError(400, r.error.errors[0]?.message || 'That is not a policy GAM can record')
  return r.data
}

/**
 * Which subject this request names, refusing zero and refusing two before
 * anything is looked up. The sentences name the three things an operator keeps
 * certificates for, because "subject_kind required" tells an operator nothing.
 */
function subjectOf(body: { propertyId?: string; leaseId?: string; vendorId?: string }):
  { kind: InsuranceSubject; id: string } {
  const named = [
    body.propertyId ? { kind: 'property' as InsuranceSubject, id: body.propertyId } : null,
    body.leaseId    ? { kind: 'resident' as InsuranceSubject, id: body.leaseId }    : null,
    body.vendorId   ? { kind: 'vendor'   as InsuranceSubject, id: body.vendorId }   : null,
  ].filter(Boolean) as Array<{ kind: InsuranceSubject; id: string }>
  if (named.length === 0) {
    throw new AppError(400, 'Say whose insurance this is: a property, a resident\'s lease, or a vendor.')
  }
  if (named.length > 1) {
    throw new AppError(400,
      'A policy belongs to one thing — a property, a resident\'s lease, or a vendor. Record a separate policy for each.')
  }
  return named[0]
}

/** The pairing the database also enforces, refused here so the message is readable. */
function assertCoverageFitsSubject(kind: InsuranceSubject, coverageType: InsuranceCoverageType) {
  if (INSURANCE_COVERAGE_BY_SUBJECT[kind].includes(coverageType)) return
  const allowed = INSURANCE_COVERAGE_BY_SUBJECT[kind].map(c => INSURANCE_COVERAGE_LABEL[c]).join(' or ')
  throw new AppError(400,
    `${INSURANCE_COVERAGE_LABEL[coverageType]} is not a kind of cover a ${INSURANCE_SUBJECT_LABEL[kind].toLowerCase()} carries. `
    + `For a ${INSURANCE_SUBJECT_LABEL[kind].toLowerCase()}, record ${allowed}.`)
}

/**
 * The subject exists AND is this caller's — resolved before a row is written, so
 * a policy can never be filed against another company's property, lease or
 * vendor. 404 throughout: a landlord must not learn what exists elsewhere.
 */
async function assertSubjectIsTheirs(req: any, subject: { kind: InsuranceSubject; id: string }) {
  const user = req.user
  if (subject.kind === 'property') {
    const p = await queryOne<{ landlord_id: string }>(
      `SELECT landlord_id FROM properties WHERE id = $1`, [subject.id])
    if (!p || !canAccessLandlordResource(user, p.landlord_id)) throw new AppError(404, 'Property not found')
    await assertPropertyInScope(user, subject.id, { perm: 'insurance.manage' })
    return
  }
  if (subject.kind === 'resident') {
    const l = await queryOne<{ landlord_id: string; property_id: string | null }>(
      `SELECT l.landlord_id, u.property_id FROM leases l
         LEFT JOIN units u ON u.id = l.unit_id
        WHERE l.id = $1`, [subject.id])
    if (!l || !canAccessLandlordResource(user, l.landlord_id)) throw new AppError(404, 'Lease not found')
    if (l.property_id) await assertPropertyInScope(user, l.property_id, { perm: 'insurance.manage' })
    return
  }
  // A vendor belongs to a company, not to a property, so there is no property
  // lock to apply. A vendor on the business portal's own list (business_id, no
  // landlord_id) resolves to no company and is simply not found here.
  const v = await queryOne<{ landlord_id: string | null }>(
    `SELECT landlord_id FROM books_vendors WHERE id = $1`, [subject.id])
  if (!v?.landlord_id || !canAccessLandlordResource(user, v.landlord_id)) {
    throw new AppError(404, 'Vendor not found')
  }
}

/** The dates on the certificate have to make sense before the CHECK says so. */
function assertDatesSane(effective: string | null | undefined, expiry: string | null | undefined) {
  if (effective && expiry && expiry < effective) {
    throw new AppError(400,
      'The expiry date is before the day the policy starts — check the dates on the certificate.')
  }
}

// ── READS ───────────────────────────────────────────────────────────────────

/**
 * Every certificate in the caller's scope, newest-expiring first. Filter by
 * subject (?propertyId / ?leaseId / ?vendorId) or by kind (?coverageType).
 * Voided rows are kept forever and are off the list unless ?includeVoided=true.
 */
insuranceRouter.get('/', requirePerm('insurance.view', 'insurance.manage'), async (req, res, next) => {
  try {
    const q = parsed(z.object({
      propertyId:    UUID.optional(),
      leaseId:       UUID.optional(),
      vendorId:      UUID.optional(),
      coverageType:  COVERAGE.optional(),
      includeVoided: z.enum(['true', 'false']).optional(),
    }), req.query)
    const data = await listPoliciesForUser(req.user!, {
      propertyId:    q.propertyId,
      leaseId:       q.leaseId,
      vendorId:      q.vendorId,
      coverageType:  q.coverageType,
      includeVoided: q.includeVoided === 'true',
    })
    res.json({ success: true, data })
  } catch (e) { next(e) }
})

/**
 * THE LAPSE LIST. What has already expired, and what expires within ?days
 * (default 30, max 365), scoped to the caller's own properties, residents and
 * vendors. Declared before '/:id' so the word is not read as an id.
 */
insuranceRouter.get('/lapses', requirePerm('insurance.view', 'insurance.manage'), async (req, res, next) => {
  try {
    const days = lapseWindowDays(req.query.days)
    if (days === null) {
      throw new AppError(400, 'Ask for a window between 0 and 365 days.')
    }
    res.json({ success: true, data: await lapseListForUser(req.user!, days) })
  } catch (e) { next(e) }
})

insuranceRouter.get('/:id', requirePerm('insurance.view', 'insurance.manage'), async (req, res, next) => {
  try {
    const policy = await getPolicyForUser(req.user!, parsed(UUID, req.params.id))
    if (!policy) throw new AppError(404, 'Policy not found')
    res.json({ success: true, data: policy })
  } catch (e) { next(e) }
})

/**
 * The certificate itself. The POLICY ROW is authorized first and the path never
 * leaves this process — streamStoredFile owns path safety only and says so.
 */
insuranceRouter.get('/:id/proof', requirePerm('insurance.view', 'insurance.manage'), async (req, res, next) => {
  try {
    const row = await getPolicyProofForUser(req.user!, parsed(UUID, req.params.id))
    if (!row) throw new AppError(404, 'Policy not found')
    if (!row.proof_url) throw new AppError(404, 'No certificate has been uploaded for this policy yet')
    streamStoredFile(res, row.proof_url, row.proof_mime_type)
  } catch (e) { next(e) }
})

// ── WRITES ──────────────────────────────────────────────────────────────────

insuranceRouter.post('/', requirePerm('insurance.manage'), async (req, res, next) => {
  try {
    const body = parsed(createSchema, req.body)
    const subject = subjectOf(body)
    assertCoverageFitsSubject(subject.kind, body.coverageType)
    assertDatesSane(body.effectiveDate, body.expiryDate)
    await assertSubjectIsTheirs(req, subject)

    const userId = req.user!.userId
    const rows = await query<{ id: string }>(
      `INSERT INTO insurance_policies
         (property_id, lease_id, vendor_id, coverage_type, carrier_name, policy_number,
          coverage_amount, effective_date, expiry_date, notes,
          recorded_by_user_id, verified_at, verified_by_user_id)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11,
               CASE WHEN $12::boolean THEN NOW() ELSE NULL END,
               CASE WHEN $12::boolean THEN $11::uuid ELSE NULL END)
       RETURNING id`,
      [
        subject.kind === 'property' ? subject.id : null,
        subject.kind === 'resident' ? subject.id : null,
        subject.kind === 'vendor'   ? subject.id : null,
        body.coverageType,
        body.carrierName,
        body.policyNumber ?? null,
        body.coverageAmount ?? null,
        body.effectiveDate ?? null,
        body.expiryDate ?? null,
        body.notes ?? null,
        userId,
        body.verified === true,
      ],
    )
    res.status(201).json({ success: true, data: await getPolicyForUser(req.user!, rows[0].id) })
  } catch (e) { next(e) }
})

insuranceRouter.patch('/:id', requirePerm('insurance.manage'), async (req, res, next) => {
  try {
    const id = parsed(UUID, req.params.id)
    const body = parsed(patchSchema, req.body)
    const existing = await getPolicyForUser(req.user!, id)
    if (!existing) throw new AppError(404, 'Policy not found')
    if (existing.voided_at) {
      throw new AppError(409,
        'This policy was taken off the record. Record the new certificate instead — the old one is kept as it was.')
    }

    // The dates are checked against what the row will SAY after the edit, not
    // against what was sent: changing only the expiry date still has to agree
    // with the start date already on the row.
    const nextEffective = body.effectiveDate === undefined ? existing.effective_date : body.effectiveDate
    const nextExpiry    = body.expiryDate === undefined ? existing.expiry_date : body.expiryDate
    assertDatesSane(nextEffective, nextExpiry)

    // Appended, never inserted: a placeholder put in the middle repoints every
    // $N after it ([[sql-bind-param-mid-array]]).
    const sets: string[] = []
    const params: unknown[] = [id]
    const set = (col: string, value: unknown) => { sets.push(`${col} = $${params.push(value)}`) }

    if (body.carrierName !== undefined)    set('carrier_name', body.carrierName)
    if (body.policyNumber !== undefined)   set('policy_number', body.policyNumber)
    if (body.coverageAmount !== undefined) set('coverage_amount', body.coverageAmount)
    if (body.effectiveDate !== undefined)  set('effective_date', body.effectiveDate)
    if (body.expiryDate !== undefined)     set('expiry_date', body.expiryDate)
    if (body.notes !== undefined)          set('notes', body.notes)

    // Verifying stamps WHO and WHEN; unverifying clears both together, which is
    // what the verified_together CHECK insists on. Re-verifying an already
    // verified policy leaves the original name and time alone — the first
    // person to read the certificate is the one who read it.
    if (body.verified === true && !existing.verified) {
      sets.push(`verified_at = NOW()`)
      set('verified_by_user_id', req.user!.userId)
    } else if (body.verified === false && existing.verified) {
      sets.push(`verified_at = NULL`, `verified_by_user_id = NULL`)
    }

    if (!sets.length) throw new AppError(400, 'Nothing was changed on this policy.')

    await query(`UPDATE insurance_policies SET ${sets.join(', ')} WHERE id = $1`, params)
    res.json({ success: true, data: await getPolicyForUser(req.user!, id) })
  } catch (e) { next(e) }
})

/**
 * The certificate upload. 20 MB and the formats a carrier actually emails: a
 * PDF, or a photograph of the paper.
 */
const proofDir = path.join(process.cwd(), 'uploads', 'insurance')
if (!fs.existsSync(proofDir)) fs.mkdirSync(proofDir, { recursive: true })
const proofUpload = multer({
  storage: multer.diskStorage({
    destination: (_req, _file, cb) => cb(null, proofDir),
    // Generated, never the uploader's filename: a name off the wire is a path
    // somebody else chose.
    filename: (_req, file, cb) => cb(null,
      `${Date.now()}-${crypto.randomBytes(8).toString('hex')}${path.extname(file.originalname).toLowerCase() || '.pdf'}`),
  }),
  limits: { fileSize: 20 * 1024 * 1024 },
  fileFilter: (_req, file, cb) => {
    if (/^(application\/pdf|image\/(jpeg|png|webp|heic))$/.test(file.mimetype)) cb(null, true)
    else cb(new AppError(400, 'Upload the certificate as a PDF or a photo (JPEG, PNG, WebP or HEIC)'))
  },
})

insuranceRouter.post('/:id/proof', requirePerm('insurance.manage'), proofUpload.single('file'),
  async (req: any, res, next) => {
    try {
      const id = parsed(UUID, req.params.id)
      if (!req.file) throw new AppError(400, 'No certificate was uploaded')
      // Authorized AFTER multer has written the file, which is the order every
      // upload route here uses; a file nobody can reach is harmless and the row
      // is never touched. The policy is the caller's or this 404s.
      const existing = await getPolicyForUser(req.user!, id)
      if (!existing) throw new AppError(404, 'Policy not found')
      if (existing.voided_at) {
        throw new AppError(409, 'This policy was taken off the record — nothing more can be attached to it.')
      }
      const url = `/uploads/insurance/${req.file.filename}`
      await query(
        `UPDATE insurance_policies
            SET proof_file_name = $2, proof_url = $3, proof_mime_type = $4,
                proof_file_size_bytes = $5, proof_uploaded_at = NOW(), proof_uploaded_by_user_id = $6
          WHERE id = $1`,
        [id, req.file.originalname, url, req.file.mimetype, req.file.size, req.user!.userId],
      )
      res.status(201).json({ success: true, data: await getPolicyForUser(req.user!, id) })
    } catch (e) { next(e) }
  })

/**
 * Off the record, with a reason — never deleted ([[gam-data-retention-keep-
 * everything]]). "There was a certificate on file and somebody took it off" is
 * exactly the fact a later argument turns on, so the row and its reason stay.
 */
insuranceRouter.post('/:id/void', requirePerm('insurance.manage'), async (req, res, next) => {
  try {
    const id = parsed(UUID, req.params.id)
    const { reason } = parsed(voidSchema, req.body)
    const existing = await getPolicyForUser(req.user!, id)
    if (!existing) throw new AppError(404, 'Policy not found')
    if (existing.voided_at) throw new AppError(409, 'This policy is already off the record.')
    await query(
      `UPDATE insurance_policies
          SET voided_at = NOW(), voided_by_user_id = $2, void_reason = $3
        WHERE id = $1`,
      [id, req.user!.userId, reason],
    )
    res.json({ success: true, data: await getPolicyForUser(req.user!, id) })
  } catch (e) { next(e) }
})
