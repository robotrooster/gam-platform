import { Router } from 'express'
import {
  emailNewBackgroundCheck,
  emailBackgroundDecision,
  emailPoolMatchInterest,
  emailPoolTenantInterested,
  emailAdverseActionNotice,
} from '../services/email'
import { buildAdverseActionNoticeText } from '../lib/adverseAction'
import { calculateRiskScore } from '../services/riskScore'
import { getProvider } from '../services/backgroundProvider'
import { query, queryOne } from '../db'
import { requireAuth, requireAdmin, requirePerm } from '../middleware/auth'
import { AppError } from '../middleware/errorHandler'
import { resolveUploadPath } from '../lib/uploadPaths'
import crypto from 'crypto'
import multer from 'multer'
import path from 'path'
import fs from 'fs'
import Stripe from 'stripe'
import { logger } from '../lib/logger'

// S83: real Stripe PaymentIntents for applicant intake fee + landlord pool
// unlock fee. When STRIPE_SECRET_KEY is unset (dev mode without Stripe
// credentials) the helpers fall back to mock IDs so the dev server still
// boots — verifyPaymentIntent then accepts the mock prefix in non-production.
const stripeForBgc: Stripe | null = process.env.STRIPE_SECRET_KEY
  ? new Stripe(process.env.STRIPE_SECRET_KEY, { apiVersion: '2023-10-16' })
  : null
const STRIPE_LIVE = !!stripeForBgc

function isMockIntentId(id: string): boolean {
  return id.startsWith('pi_intake_mock_') || id.startsWith('pi_pool_mock_')
}

export const backgroundRouter = Router()

// ── ENCRYPTION KEY (fail-fast in production) ─────────────────
// SSNs are encrypted at rest only between row insert and provider hand-off.
// In production, the env var is required and must not be the dev default.
const DEFAULT_KEY = 'a'.repeat(64)
const ENCRYPTION_KEY = process.env.ENCRYPTION_KEY || DEFAULT_KEY
if (process.env.NODE_ENV === 'production' && (ENCRYPTION_KEY === DEFAULT_KEY || ENCRYPTION_KEY.length < 64)) {
  throw new Error('ENCRYPTION_KEY env var missing or default — refusing to start in production')
}
const IV_LENGTH = 16

// Pricing — read once at module load. Adjust BACKGROUND_CHECK_APPLICANT_FEE_USD
// once the screening provider is selected and we know the wholesale cost.
const APPLICANT_FEE_USD = parseFloat(process.env.BACKGROUND_CHECK_APPLICANT_FEE_USD || '45')
const POOL_REPORT_UNLOCK_USD = parseFloat(process.env.POOL_REPORT_UNLOCK_USD || '1')

function encrypt(text: string): string {
  const key = Buffer.from(ENCRYPTION_KEY.slice(0, 64), 'hex')
  const iv = crypto.randomBytes(IV_LENGTH)
  const cipher = crypto.createCipheriv('aes-256-cbc', key, iv)
  let enc = cipher.update(text)
  enc = Buffer.concat([enc, cipher.final()])
  return iv.toString('hex') + ':' + enc.toString('hex')
}

// ── ID DOCUMENT UPLOAD STORAGE ───────────────────────────────
const idDir = path.join(process.cwd(), 'uploads', 'id-documents')
if (!fs.existsSync(idDir)) fs.mkdirSync(idDir, { recursive: true })
const idStorage = multer.diskStorage({
  destination: idDir,
  filename: (_req, file, cb) =>
    cb(null, Date.now() + '-' + crypto.randomBytes(8).toString('hex') + path.extname(file.originalname)),
})
const idUpload = multer({
  storage: idStorage,
  limits: { fileSize: 10 * 1024 * 1024 },
  fileFilter: (_req, file, cb) => {
    if (['image/jpeg', 'image/png', 'application/pdf'].includes(file.mimetype)) cb(null, true)
    else cb(new Error('JPEG PNG PDF only'))
  },
})

// ── HELPERS ──────────────────────────────────────────────────
async function geocodeAddress(street1: string, city: string, state: string, zip: string): Promise<{ lat: string | null, lon: string | null }> {
  try {
    const addr = encodeURIComponent(`${street1} ${city} ${state} ${zip} USA`)
    const url = `https://nominatim.openstreetmap.org/search?q=${addr}&format=json&limit=1`
    const r = await fetch(url, {
      headers: { 'User-Agent': 'GAM-Platform/1.0' },
      signal: AbortSignal.timeout(3000),
    })
    const data: any = await r.json()
    if (data?.[0]) return { lat: data[0].lat, lon: data[0].lon }
  } catch (_) { /* timeout or network — fall through */ }
  return { lat: null, lon: null }
}

// Pool eligibility: tenant consented + risk gate. Approved tenants are
// housed and don't need leads; only denials and speculative completes
// route here.
function isPoolEligible(check: any): boolean {
  if (!check.consent_pool) return false
  if (check.risk_level === 'very_high') return false
  return true
}

// Idempotent pool-entry create. Backfills pool_entry_id pointer on bgc.
async function upsertPoolEntry(check: any) {
  const existing = await queryOne<any>(
    'SELECT id FROM application_pool WHERE background_check_id=$1',
    [check.id]
  )
  if (existing) return existing
  const geo = check.street1 && check.city
    ? await geocodeAddress(check.street1, check.city, check.state, check.zip)
    : { lat: null, lon: null }
  const entry = await queryOne<any>(`
    INSERT INTO application_pool
      (background_check_id, user_id, status, consent_pool, employment_status, monthly_income, city, state, zip, lat, lon, risk_level, risk_score)
    VALUES ($1, $2, 'available', TRUE, $3, $4, $5, $6, $7, $8, $9, $10, $11)
    RETURNING id
  `, [
    check.id, check.user_id,
    check.employment_status, check.monthly_income,
    check.city, check.state, check.zip,
    geo.lat, geo.lon,
    check.risk_level, check.risk_score,
  ])
  await query('UPDATE background_checks SET pool_entry_id=$1 WHERE id=$2', [entry!.id, check.id])
  return entry
}

// ── PRICING + PAYMENT INTENT (mock Stripe) ───────────────────
backgroundRouter.get('/price', async (_req, res) => {
  res.json({ success: true, data: { applicantFee: APPLICANT_FEE_USD, poolUnlockFee: POOL_REPORT_UNLOCK_USD } })
})

// POST /api/background/payment-intent
// Creates the Stripe PaymentIntent for the applicant intake fee.
// Frontend confirms it via Stripe Elements with the returned clientSecret,
// then passes the intentId to /submit which verifies status=succeeded
// + metadata.userId match before letting the bg check insert through.
//
// Metadata.kind = 'background_check_intake' so the verifier can reject
// PIs created for unrelated charges. Metadata.userId locks the PI to
// the caller — re-using someone else's intent id is rejected.
backgroundRouter.post('/payment-intent', requireAuth, async (req, res, next) => {
  try {
    if (!STRIPE_LIVE) {
      const mockId = 'pi_intake_mock_' + crypto.randomBytes(12).toString('hex')
      return res.json({
        success: true,
        data: { clientSecret: mockId + '_secret', intentId: mockId, amount: APPLICANT_FEE_USD, testMode: true },
      })
    }
    const intent = await stripeForBgc!.paymentIntents.create({
      amount: Math.round(APPLICANT_FEE_USD * 100),
      currency: 'usd',
      payment_method_types: ['card'],
      description: 'GAM background check intake fee',
      metadata: {
        kind:   'background_check_intake',
        userId: req.user!.userId,
        feeUsd: String(APPLICANT_FEE_USD),
      },
    })
    res.json({
      success: true,
      data: {
        clientSecret: intent.client_secret,
        intentId:     intent.id,
        amount:       APPLICANT_FEE_USD,
        testMode:     false,
      },
    })
  } catch (e) { next(e) }
})

// Verifies a Stripe PaymentIntent against expected metadata + amount.
// Used by /submit (intake fee) and /pool/match/:matchId/purchase-report
// (pool unlock fee). Mock IDs from the dev fallback are accepted in
// non-production only.
async function verifyPaymentIntent(
  intentId: string,
  expected: { kind: 'background_check_intake' | 'pool_report_unlock'; amountUsd: number; userId?: string; matchId?: string },
): Promise<void> {
  if (isMockIntentId(intentId)) {
    if (process.env.NODE_ENV === 'production') {
      throw new AppError(400, 'Mock payment intents are not accepted in production')
    }
    return
  }
  if (!STRIPE_LIVE) {
    throw new AppError(500, 'Stripe not configured but a non-mock intent id was supplied')
  }
  let pi: Stripe.PaymentIntent
  try {
    pi = await stripeForBgc!.paymentIntents.retrieve(intentId)
  } catch {
    throw new AppError(400, 'Payment intent not found')
  }
  if (pi.status !== 'succeeded') {
    throw new AppError(400, `Payment not yet succeeded (status: ${pi.status})`)
  }
  if (pi.metadata?.kind !== expected.kind) {
    throw new AppError(400, 'Payment intent kind mismatch')
  }
  if (expected.userId && pi.metadata?.userId !== expected.userId) {
    throw new AppError(403, 'Payment intent does not belong to this user')
  }
  if (expected.matchId && pi.metadata?.matchId !== expected.matchId) {
    throw new AppError(403, 'Payment intent does not belong to this match')
  }
  // Stripe amounts are in cents; allow 1¢ tolerance for any rounding.
  const expectedCents = Math.round(expected.amountUsd * 100)
  if (Math.abs(pi.amount - expectedCents) > 1) {
    throw new AppError(400, `Payment amount mismatch (got ${pi.amount}¢, expected ${expectedCents}¢)`)
  }
}

// ── INTAKE: APPLICANT PAYS + SUBMITS ATOMICALLY ──────────────
// Two intake modes inferred from landlordId presence:
//   targeted (landlordId provided): applies to a specific property
//   speculative (no landlordId): goes straight into pool on completion
// Both require consent_credit + consent_criminal. Speculative also requires consent_pool.
backgroundRouter.post('/submit', requireAuth, async (req, res, next) => {
  try {
    const {
      firstName, lastName, dateOfBirth, ssn, street1, street2, city, state, zip, yearsAtAddress,
      employmentStatus, employerName, employerPhone, monthlyIncome,
      prevLandlordName, prevLandlordPhone, prevLandlordEmail,
      idDocumentUrl, incomeDocUrls, consentCredit, consentCriminal, consentPool,
      timeToComplete, applicantPaymentIntentId,
    } = req.body
    const { landlordId, unitId } = req.body
    const isSpeculative = !landlordId

    if (!firstName || !lastName || !dateOfBirth || !ssn) throw new AppError(400, 'Required fields missing')
    if (!consentCredit || !consentCriminal) throw new AppError(400, 'Both screening consents required')
    if (isSpeculative && !consentPool) throw new AppError(400, 'Pool consent required for speculative applications')
    if (!applicantPaymentIntentId) throw new AppError(400, 'Payment required')

    // S83: verify the PaymentIntent really succeeded, belongs to this user,
    // and is for the right fee. Idempotency comes from the UNIQUE index on
    // background_checks.applicant_payment_intent_id below — Postgres rejects
    // a second insert with the same intent id.
    await verifyPaymentIntent(applicantPaymentIntentId, {
      kind:      'background_check_intake',
      amountUsd: APPLICANT_FEE_USD,
      userId:    req.user!.userId,
    })

    const ssnClean = (ssn as string).replace(/\D/g, '')
    if (ssnClean.length < 9) throw new AppError(400, 'Full SSN required')
    const ssnLast4 = ssnClean.slice(-4)
    const ssnEncrypted = encrypt(ssnClean)
    const ipAddr = (req.headers['x-forwarded-for'] || req.socket.remoteAddress || '').toString()
    const ua = (req.headers['user-agent'] || '').toString()

    const tenant = await queryOne<any>('SELECT * FROM tenants WHERE user_id=$1', [req.user!.userId])
    if (tenant && tenant.platform_status === 'blocked') {
      throw new AppError(403, 'Account is blocked from submitting applications')
    }

    // S423: resolve the provider per-landlord. Pre-S423 the route
    // hardcoded 'mock' at both the INSERT and the getProvider call.
    // Now: read landlords.background_provider for the targeted-
    // submission case; default to 'mock' for speculative (no landlord)
    // since the row will be claimed by a landlord later via the pool
    // and re-run under their provider then.
    let providerName: string = 'mock'
    if (landlordId) {
      const landlordRow = await queryOne<{ background_provider: string }>(
        'SELECT background_provider FROM landlords WHERE id=$1',
        [landlordId]
      )
      if (!landlordRow) throw new AppError(404, 'Landlord not found')
      providerName = landlordRow.background_provider
    }

    let check: any
    try {
      check = await queryOne<any>(`
        INSERT INTO background_checks (
          tenant_id, user_id, landlord_id, unit_id, status,
          first_name, last_name, date_of_birth, ssn_encrypted, ssn_last4,
          street1, street2, city, state, zip, years_at_address,
          employment_status, employer_name, employer_phone, monthly_income,
          prev_landlord_name, prev_landlord_phone, prev_landlord_email,
          id_document_url, income_document_urls,
          consent_credit, consent_criminal, consent_pool, consent_signed_at, consent_ip,
          ip_address, user_agent, provider_name,
          applicant_payment_intent_id
        ) VALUES (
          $1, $2, $3, $4, 'pending',
          $5, $6, $7, $8, $9,
          $10, $11, $12, $13, $14, $15,
          $16, $17, $18, $19,
          $20, $21, $22,
          $23, $24,
          $25, $26, $27, NOW(), $28,
          $29, $30, $31,
          $32
        ) RETURNING id`,
        [
          tenant?.id || null, req.user!.userId, landlordId || null, unitId || null,
          firstName, lastName, dateOfBirth, ssnEncrypted, ssnLast4,
          street1, street2 || null, city, state, zip, yearsAtAddress || null,
          employmentStatus || null, employerName || null, employerPhone || null, monthlyIncome || null,
          prevLandlordName || null, prevLandlordPhone || null, prevLandlordEmail || null,
          idDocumentUrl || null, JSON.stringify(incomeDocUrls || []),
          !!consentCredit, !!consentCriminal, !!consentPool, ipAddr,
          ipAddr, ua, providerName,
          applicantPaymentIntentId,
        ])
    } catch (e: any) {
      // Postgres unique violation on background_checks_applicant_pi_uniq —
      // the same PI was already used to fund another submission.
      if (e?.code === '23505' && e?.constraint === 'background_checks_applicant_pi_uniq') {
        throw new AppError(409, 'This payment has already been used to submit a background check')
      }
      throw e
    }

    // Risk score (intake-fraud only — disposable email, SSN patterns, IP velocity, prior denials)
    let riskLevel: string | null = null
    try {
      let unitRent: number | null = null
      if (unitId) {
        const u = await queryOne<any>('SELECT rent_amount FROM units WHERE id=$1', [unitId]).catch(() => null)
        unitRent = u?.rent_amount || null
      }
      const risk = await calculateRiskScore({
        firstName, lastName,
        email: (req as any).user.email,
        phone: null,
        ssn: ssnClean, dob: dateOfBirth, state, zip,
        employmentStatus: employmentStatus || 'unknown',
        monthlyIncome: monthlyIncome || null,
        timeToComplete: timeToComplete || null,
        ipAddress: ipAddr, userAgent: ua,
        landlordId: landlordId || '', unitRent,
      })
      riskLevel = risk.level
      await query(
        'UPDATE background_checks SET risk_score=$1, risk_level=$2, risk_flags=$3 WHERE id=$4',
        [risk.score, risk.level, JSON.stringify(risk.flags), check!.id]
      )
    } catch (e) { logger.error({ err: e }, '[RISK]') }

    // Hand off to provider. After successful initiate, drop ssn_encrypted —
    // provider has it now; we keep ssn_last4 for duplicate detection.
    // S423: use the per-landlord provider resolved above.
    const provider = getProvider(providerName)
    let providerStatus = 'pending'
    try {
      const initRes = await provider.initiate({
        backgroundCheckId: check!.id,
        firstName, lastName,
        email: (req as any).user.email,
        dateOfBirth, ssnLast4,
        street1, street2: street2 || null, city, state, zip,
        consentCredit: !!consentCredit, consentCriminal: !!consentCriminal,
      })
      providerStatus = initRes.status
      await query(`
        UPDATE background_checks
        SET provider_ref=$1, applicant_redirect_url=$2, status=$3, failure_reason=$4, ssn_encrypted=NULL
        WHERE id=$5`,
        [initRes.providerRef || null, initRes.applicantRedirectUrl || null, initRes.status, initRes.failureReason || null, check!.id])
    } catch (e) {
      logger.error({ err: e }, '[PROVIDER INITIATE]')
      await query("UPDATE background_checks SET status='failed', failure_reason=$1 WHERE id=$2",
        [e instanceof Error ? e.message : 'provider error', check!.id])
      providerStatus = 'failed'
    }

    if (tenant) {
      await query(
        "UPDATE tenants SET background_check_status='submitted', background_check_id=$1 WHERE id=$2",
        [check!.id, tenant.id]
      )
    }

    if (!isSpeculative && landlordId) {
      try {
        const lu = await queryOne<any>(
          'SELECT u.email, u.first_name, u.last_name FROM landlords l JOIN users u ON u.id=l.user_id WHERE l.id=$1',
          [landlordId]
        )
        const u = unitId
          ? await queryOne<any>('SELECT u.unit_number, p.name FROM units u JOIN properties p ON p.id=u.property_id WHERE u.id=$1', [unitId])
          : null
        if (lu) {
          await emailNewBackgroundCheck(
            lu.email, lu.first_name + ' ' + lu.last_name,
            firstName + ' ' + lastName,
            u?.name || 'Your Property', u?.unit_number || '—',
            riskLevel || 'unknown',
            undefined,
            { landlordId, backgroundCheckId: check!.id }
          )
        }
      } catch (e) { logger.error({ err: e }, '[EMAIL]') }
    }

    res.status(201).json({
      success: true,
      data: { id: check!.id, status: providerStatus, mode: isSpeculative ? 'speculative' : 'targeted' },
    })
  } catch (e) { next(e) }
})

// ── TENANT: VIEW STATUS ──────────────────────────────────────
backgroundRouter.get('/status', requireAuth, async (req, res, next) => {
  try {
    const tenant = await queryOne<any>('SELECT * FROM tenants WHERE user_id=$1', [req.user!.userId])
    const check = tenant?.background_check_id
      ? await queryOne<any>(
          `SELECT id, status, created_at, decided_at, decision_notes, first_name, last_name, ssn_last4, expires_at
           FROM background_checks WHERE id=$1`,
          [tenant.background_check_id]
        )
      : await queryOne<any>(
          `SELECT id, status, created_at, decided_at, decision_notes, first_name, last_name, ssn_last4, expires_at
           FROM background_checks WHERE user_id=$1 ORDER BY created_at DESC LIMIT 1`,
          [req.user!.userId]
        )
    res.json({
      success: true,
      data: { status: tenant?.background_check_status || (check?.status || 'not_started'), check },
    })
  } catch (e) { next(e) }
})

// ── TENANT NOTIFICATIONS ─────────────────────────────────────
// MUST be declared before the landlord `/:id` route below: Express matches
// in definition order, so a literal `/notifications` registered after `/:id`
// gets captured as id="notifications" and hits the landlord-only permission
// gate — which 403'd tenants and white-screened the tenant notifications page.
backgroundRouter.get('/notifications', requireAuth, async (req, res, next) => {
  try {
    const notifs = await query<any>(
      'SELECT * FROM tenant_notifications WHERE user_id=$1 ORDER BY created_at DESC LIMIT 20',
      [req.user!.userId]
    )
    res.json({ success: true, data: notifs })
  } catch (e) { next(e) }
})

backgroundRouter.patch('/notifications/:id/read', requireAuth, async (req, res, next) => {
  try {
    await query(
      'UPDATE tenant_notifications SET read=TRUE WHERE id=$1 AND user_id=$2',
      [req.params.id, req.user!.userId]
    )
    res.json({ success: true })
  } catch (e) { next(e) }
})

// ── LANDLORD: LIST + DETAIL ──────────────────────────────────
backgroundRouter.get('/', requireAuth, requirePerm('tenants.run_background_check'), async (req, res, next) => {
  try {
    const checks = await query<any>(`
      SELECT bc.id, bc.status, bc.first_name, bc.last_name, bc.ssn_last4, bc.date_of_birth,
        bc.street1, bc.city, bc.state, bc.zip,
        bc.employment_status, bc.employer_name, bc.employer_phone, bc.monthly_income,
        bc.prev_landlord_name, bc.prev_landlord_phone, bc.prev_landlord_email,
        bc.id_document_url, bc.income_document_urls,
        bc.consent_credit, bc.consent_criminal,
        bc.decision_notes, bc.decided_at, bc.created_at, bc.expires_at,
        bc.risk_score, bc.risk_level, bc.risk_flags,
        bc.provider_name, bc.provider_ref, bc.report_summary,
        u.email,
        un.unit_number, p.name as property_name
      FROM background_checks bc
      JOIN users u ON u.id = bc.user_id
      LEFT JOIN units un ON un.id = bc.unit_id
      LEFT JOIN properties p ON p.id = un.property_id
      WHERE bc.landlord_id = $1
      ORDER BY bc.created_at DESC`, [req.user!.profileId])
    res.json({ success: true, data: checks })
  } catch (e) { next(e) }
})

backgroundRouter.get('/:id', requireAuth, requirePerm('tenants.run_background_check'), async (req, res, next) => {
  try {
    const check = await queryOne<any>(
      'SELECT * FROM background_checks WHERE id=$1 AND landlord_id=$2',
      [req.params.id, req.user!.profileId]
    )
    if (!check) throw new AppError(404, 'Not found')
    delete check.ssn_encrypted
    res.json({ success: true, data: check })
  } catch (e) { next(e) }
})

// ── LANDLORD: DECIDE ─────────────────────────────────────────
// Approval sets expires_at (6mo from now). Denial may create pool entry.
// Approval flips any existing pool entry to inactive — tenant is housed.
backgroundRouter.patch('/:id/decision', requireAuth, requirePerm('tenants.run_background_check'), async (req, res, next) => {
  try {
    const { decision, notes } = req.body
    if (!['approved', 'denied'].includes(decision)) throw new AppError(400, 'Invalid decision')
    const check = await queryOne<any>(
      'SELECT * FROM background_checks WHERE id=$1 AND landlord_id=$2',
      [req.params.id, req.user!.profileId]
    )
    if (!check) throw new AppError(404, 'Not found')
    if (!['complete', 'submitted', 'processing'].includes(check.status)) {
      throw new AppError(400, `Cannot decide a check with status '${check.status}'`)
    }

    const expiresClause = decision === 'approved'
      ? ", expires_at = NOW() + INTERVAL '6 months'"
      : ''
    await query(
      `UPDATE background_checks SET status=$1, decision_notes=$2, decided_at=NOW(), decided_by=$3${expiresClause} WHERE id=$4`,
      [decision, notes || null, req.user!.userId, check.id]
    )
    if (check.tenant_id) {
      await query('UPDATE tenants SET background_check_status=$1 WHERE id=$2', [decision, check.tenant_id])
    }

    if (decision === 'denied' && isPoolEligible(check)) {
      try { await upsertPoolEntry(check) } catch (e) { logger.error({ err: e }, '[POOL CREATE]') }
    }
    if (decision === 'approved' && check.pool_entry_id) {
      await query("UPDATE application_pool SET status='inactive' WHERE id=$1", [check.pool_entry_id])
    }

    const tu = await queryOne<any>('SELECT email, first_name, last_name FROM users WHERE id=$1', [check.user_id])
    if (tu?.email) {
      const u = check.unit_id
        ? await queryOne<any>('SELECT u.unit_number, p.name FROM units u JOIN properties p ON p.id=u.property_id WHERE u.id=$1', [check.unit_id])
        : null
      try {
        await emailBackgroundDecision(
          tu.email, tu.first_name || 'there',
          decision as 'approved' | 'denied',
          u?.name || 'the property', u?.unit_number || '—',
          notes || undefined,
          undefined,
          { landlordId: check.landlord_id, backgroundCheckId: check.id }
        )
      } catch (e) { logger.error({ err: e }, '[EMAIL]') }
    }

    // S87: FCRA §615(a) adverse action notice. Required when an applicant
    // is denied based in whole or in part on a consumer report. We send
    // it whenever the decision is 'denied' and the check ran through a
    // CRA (provider_name set). The applicant's credit/criminal consents
    // are a precondition of the check itself, so by the time we're here
    // they exist.
    if (decision === 'denied' && check.provider_name && tu?.email) {
      try {
        const provider = getProvider(check.provider_name)
        const cra = provider.craDisclosure()
        const landlord = await queryOne<any>(
          `SELECT COALESCE(l.business_name, u.first_name || ' ' || u.last_name) AS name
             FROM landlords l JOIN users u ON u.id = l.user_id WHERE l.id = $1`,
          [check.landlord_id]
        )
        const noticeText = buildAdverseActionNoticeText({
          applicantFirstName: tu.first_name || check.first_name || '',
          applicantLastName:  tu.last_name  || check.last_name  || '',
          landlordName:       landlord?.name || 'your landlord',
          cra,
          decisionBasis:      notes || undefined,
          disputeWindowDays:  60,
          decisionDate:       new Date(),
        })
        const messageId = await emailAdverseActionNotice({
          to: tu.email,
          applicantFirstName: tu.first_name || check.first_name || 'Applicant',
          noticeText,
          ctx: { landlordId: check.landlord_id, backgroundCheckId: check.id },
        })
        try {
          await query(
            `INSERT INTO adverse_action_notices
               (background_check_id, tenant_user_id, landlord_id,
                cra_name, cra_address, cra_phone, cra_website,
                decision_basis, risk_factors, notice_text,
                dispute_window_days, email_message_id)
             VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)`,
            [
              check.id, check.user_id, check.landlord_id,
              cra.name, cra.address, cra.phone, cra.website || null,
              notes || null,
              JSON.stringify(check.risk_flags || []),
              noticeText, 60, messageId,
            ]
          )
        } catch (insErr: any) {
          // 23505 = UNIQUE on background_check_id — notice already exists
          // (re-decision after a previous denial). Don't double-insert; the
          // original notice is the legal record.
          if (insErr?.code !== '23505') throw insErr
          logger.warn(`[ADVERSE ACTION] notice already exists for check ${check.id} — skipping duplicate`)
        }
      } catch (e) {
        logger.error({ err: e }, '[ADVERSE ACTION]')
        // Email/insert failure must not block the denial. Log + continue;
        // the audit trail can be reconciled by an admin later.
      }
    }

    res.json({ success: true, data: { decision } })
  } catch (e) { next(e) }
})

// ── ADVERSE ACTION NOTICE: AUDIT FETCH ───────────────────────
// Returns the FCRA notice for a denied check. Accessible to:
//   - the landlord (or scoped worker with tenants.run_background_check)
//     who decided the check
//   - the applicant whose check it is (for their own records)
//   - admin / super_admin
backgroundRouter.get('/:id/adverse-action', requireAuth, async (req, res, next) => {
  try {
    const check = await queryOne<any>(
      'SELECT id, landlord_id, user_id FROM background_checks WHERE id=$1',
      [req.params.id]
    )
    if (!check) throw new AppError(404, 'Background check not found')

    const role = req.user!.role
    const isAdmin = role === 'admin' || role === 'super_admin'
    const isApplicant = check.user_id === req.user!.userId
    const isLandlord = role === 'landlord' && check.landlord_id === req.user!.profileId
    const isWorker = ['property_manager','onsite_manager','maintenance'].includes(role)
      && req.user!.landlordId === check.landlord_id
      && req.user!.permissions?.['tenants.run_background_check'] === true
    if (!isAdmin && !isApplicant && !isLandlord && !isWorker) {
      throw new AppError(403, 'Forbidden')
    }

    const notice = await queryOne<any>(
      'SELECT * FROM adverse_action_notices WHERE background_check_id=$1',
      [req.params.id]
    )
    if (!notice) throw new AppError(404, 'No adverse action notice on file for this check')
    res.json({ success: true, data: notice })
  } catch (e) { next(e) }
})

// ── APPLICANT: CANCEL OWN PRE-COMPLETE CHECK ─────────────────
backgroundRouter.post('/:id/cancel', requireAuth, async (req, res, next) => {
  try {
    const check = await queryOne<any>(
      'SELECT * FROM background_checks WHERE id=$1 AND user_id=$2',
      [req.params.id, req.user!.userId]
    )
    if (!check) throw new AppError(404, 'Not found')
    if (['complete', 'approved', 'denied', 'expired', 'cancelled', 'failed'].includes(check.status)) {
      throw new AppError(400, `Cannot cancel a check with status '${check.status}'`)
    }
    await query("UPDATE background_checks SET status='cancelled' WHERE id=$1", [check.id])
    if (check.tenant_id) {
      await query("UPDATE tenants SET background_check_status='cancelled' WHERE id=$1", [check.tenant_id])
    }
    res.json({ success: true })
  } catch (e) { next(e) }
})

// ── ID FILE UPLOAD + AUTH-GATED DOWNLOAD ─────────────────────
backgroundRouter.post('/upload-id', requireAuth, idUpload.single('file'), async (req: any, res: any, next: any) => {
  try {
    if (!req.file) throw new AppError(400, 'No file')
    res.json({ success: true, data: { url: '/api/background/id-files/' + req.file.filename, filename: req.file.originalname } })
  } catch (e) { next(e) }
})

// Auth gate per S58 /files/:filename pattern: applicant or owning landlord only.
backgroundRouter.get('/id-files/:filename', requireAuth, async (req, res, next) => {
  try {
    const fp = resolveUploadPath(idDir, req.params.filename)
    if (!fp || !fs.existsSync(fp)) throw new AppError(404, 'Not found')
    const url = '/api/background/id-files/' + req.params.filename
    const owner = await queryOne<any>(
      'SELECT user_id, landlord_id FROM background_checks WHERE id_document_url=$1',
      [url]
    )
    if (!owner) throw new AppError(404, 'Not found')
    const isApplicant = owner.user_id === req.user!.userId
    const isLandlord = owner.landlord_id && owner.landlord_id === req.user!.profileId
    if (!isApplicant && !isLandlord) throw new AppError(403, 'Not authorized')
    res.removeHeader('Content-Security-Policy')
    res.removeHeader('Cross-Origin-Resource-Policy')
    res.sendFile(fp)
  } catch (e) { next(e) }
})

// ── ADDRESS HELPERS (Nominatim proxy, 3s timeout) ────────────
backgroundRouter.get('/verify-address', async (req, res) => {
  try {
    const { street, city, state, zip } = req.query as Record<string, string>
    const q = encodeURIComponent(`${street}, ${city}, ${state} ${zip}, USA`)
    const url = `https://nominatim.openstreetmap.org/search?q=${q}&format=json&addressdetails=1&limit=1&countrycodes=us`
    const r = await fetch(url, {
      headers: { 'User-Agent': 'GAM-Platform/1.0 (contact@gamplatform.com)' },
      signal: AbortSignal.timeout(3000),
    })
    const data: any = await r.json()
    const valid = Array.isArray(data) && data.length > 0
    const m = valid ? data[0] : null
    res.json({
      success: true,
      data: { valid, displayName: m?.display_name || null, lat: m?.lat || null, lon: m?.lon || null, addressComponents: m?.address || null },
    })
  } catch (_) {
    res.json({ success: true, data: { valid: null, error: 'verification_unavailable' } })
  }
})

backgroundRouter.get('/suggest-address', async (req, res) => {
  try {
    const { q, lat, lon } = req.query as Record<string, string>
    if (!q || q.length < 4) { res.json({ success: true, data: [] }); return }
    const encoded = encodeURIComponent(q + ' USA')
    let viewbox = ''
    if (lat && lon) {
      const la = parseFloat(lat), lo = parseFloat(lon)
      viewbox = `&viewbox=${lo - 0.15},${la - 0.15},${lo + 0.15},${la + 0.15}`
    }
    const url = `https://nominatim.openstreetmap.org/search?q=${encoded}&format=json&addressdetails=1&limit=10&countrycodes=us${viewbox}`
    const r = await fetch(url, { headers: { 'User-Agent': 'GAM-Platform/1.0' }, signal: AbortSignal.timeout(3000) })
    const data: any = await r.json()
    res.json({ success: true, data: Array.isArray(data) ? data : [] })
  } catch (_) {
    res.json({ success: true, data: [] })
  }
})

// ── PROVIDER WEBHOOK ─────────────────────────────────────────
// HMAC-verified per provider. Mock provider passes through if no secret set.
// NOTE: real provider HMAC verification needs raw-body wiring in index.ts —
// the global JSON parser strips the raw form. Mock works without it because
// the secret is optional. Raw-body wiring is a deferred follow-up.
backgroundRouter.post('/webhook/:providerName', async (req, res, next) => {
  try {
    const provider = getProvider(req.params.providerName)
    // S422: req.body is a Buffer here because the express.raw()
    // middleware in index.ts intercepts /api/background/webhook before
    // express.json() can parse it. Pre-S422 this was a parsed object
    // and the route re-stringified it for HMAC verification —
    // production HMAC vectors (computed by Checkr against THEIR exact
    // bytes) would never match the re-stringified shape (key order,
    // whitespace), so every Checkr webhook would 401 in prod.
    // Now: verify against the raw bytes received, parse JSON only
    // after verification passes.
    const rawBody = Buffer.isBuffer(req.body)
      ? req.body.toString('utf8')
      : typeof req.body === 'string'
        ? req.body
        : JSON.stringify(req.body)  // defensive fallback if middleware misroutes
    if (!provider.verifyWebhook(req.headers as any, rawBody)) {
      throw new AppError(401, 'Invalid webhook signature')
    }
    const update = provider.parseWebhook(rawBody)
    const check = await queryOne<any>(
      'SELECT * FROM background_checks WHERE provider_ref=$1 AND provider_name=$2',
      [update.providerRef, provider.name]
    )
    if (!check) throw new AppError(404, 'Unknown provider_ref')

    const expiresClause = update.status === 'complete'
      ? ", expires_at = NOW() + INTERVAL '6 months'"
      : ''
    await query(`
      UPDATE background_checks
      SET status=$1, report_summary=$2, failure_reason=$3, webhook_received_at=NOW()${expiresClause}
      WHERE id=$4`,
      [update.status, update.reportSummary ? JSON.stringify(update.reportSummary) : null, update.failureReason || null, check.id])

    // Speculative path: complete → pool (if eligible). No landlord decision step.
    if (update.status === 'complete' && !check.landlord_id) {
      const fresh = await queryOne<any>('SELECT * FROM background_checks WHERE id=$1', [check.id])
      if (fresh && isPoolEligible(fresh)) {
        try { await upsertPoolEntry(fresh) } catch (e) { logger.error({ err: e }, '[POOL CREATE]') }
      }
    }

    res.json({ success: true })
  } catch (e) { next(e) }
})

// DEV-only: fire a fake provider webhook for local testing. Predictable —
// no setTimeout, no background timer. Survives server restart.
backgroundRouter.post('/dev-mock-webhook', requireAuth, requireAdmin, async (req, res, next) => {
  try {
    if (process.env.NODE_ENV === 'production') throw new AppError(403, 'Not available in production')
    const { providerRef, status, reportSummary, failureReason } = req.body
    if (!providerRef || !status) throw new AppError(400, 'providerRef + status required')
    const payload = JSON.stringify({ providerRef, status, reportSummary: reportSummary || null, failureReason: failureReason || null })
    const provider = getProvider('mock')
    const update = provider.parseWebhook(payload)
    const check = await queryOne<any>(
      "SELECT * FROM background_checks WHERE provider_ref=$1 AND provider_name='mock'",
      [update.providerRef]
    )
    if (!check) throw new AppError(404, 'Unknown provider_ref')
    const expiresClause = update.status === 'complete' ? ", expires_at = NOW() + INTERVAL '6 months'" : ''
    await query(`
      UPDATE background_checks
      SET status=$1, report_summary=$2, failure_reason=$3, webhook_received_at=NOW()${expiresClause}
      WHERE id=$4`,
      [update.status, update.reportSummary ? JSON.stringify(update.reportSummary) : null, update.failureReason || null, check.id])
    if (update.status === 'complete' && !check.landlord_id) {
      const fresh = await queryOne<any>('SELECT * FROM background_checks WHERE id=$1', [check.id])
      if (fresh && isPoolEligible(fresh)) {
        try { await upsertPoolEntry(fresh) } catch (e) { logger.error({ err: e }, '[POOL CREATE]') }
      }
    }
    res.json({ success: true })
  } catch (e) { next(e) }
})

// ── DEV: RESET TENANT BGC STATE ──────────────────────────────
backgroundRouter.post('/dev-reset', requireAuth, requireAdmin, async (req, res, next) => {
  try {
    if (process.env.NODE_ENV === 'production') throw new AppError(403, 'Not available in production')
    const tenant = await queryOne<any>('SELECT * FROM tenants WHERE user_id=$1', [req.user!.userId])
    if (tenant) {
      await query("UPDATE tenants SET background_check_status='not_started', background_check_id=NULL WHERE id=$1", [tenant.id])
    }
    res.json({ success: true })
  } catch (e) { next(e) }
})

// ── POOL: TENANT WITHDRAW ────────────────────────────────────
// Tenant says "no longer interested" — flips their pool entry to inactive.
// In-flight match requests are unchanged; tenant won't see new ones because
// the entry is no longer 'available' for landlord searches.
backgroundRouter.post('/pool/withdraw', requireAuth, async (req, res, next) => {
  try {
    const entry = await queryOne<any>(
      "SELECT id FROM application_pool WHERE user_id=$1 AND status='available'",
      [req.user!.userId]
    )
    if (!entry) throw new AppError(404, 'No active pool entry')
    await query("UPDATE application_pool SET status='inactive' WHERE id=$1", [entry.id])
    res.json({ success: true })
  } catch (e) { next(e) }
})

// ── POOL: LANDLORD SEARCH (REDACTED PREVIEW) ─────────────────
// No name, contact info, or SSN in the preview. Full record only after $1 unlock.
//
// S512 #30: the pool is presented as a proximity-sorted reach-out list
// (income/state/risk filtering removed). There is no street-level distance
// yet — properties carry no lat/lon (geocoder self-host is deferred), so
// proximity is administrative tiering against the landlord's property
// zip / city / state:
//   0 same ZIP · 1 same city+state · 2 same ZIP3 region · 3 same state · 4 elsewhere
// Ties break on risk_score then recency (the prior ordering, now within a
// tier). When the landlord owns no properties every row lands in tier 4 and
// the result is the old risk/recency sort. When property geocoding lands,
// the proximity_rank CASE can be swapped for a haversine ORDER BY.
backgroundRouter.get('/pool/search', requireAuth, requirePerm('tenants.run_background_check'), async (req, res, next) => {
  try {
    const landlordId = req.user!.profileId
    const pool = await query<any>(`
      WITH props AS (
        SELECT DISTINCT zip, lower(city) AS city, state
          FROM properties WHERE landlord_id = $1
      )
      SELECT ap.id, ap.employment_status, ap.monthly_income, ap.city, ap.state, ap.zip,
             ap.risk_level, ap.risk_score, ap.created_at,
             CASE
               WHEN ap.zip IS NOT NULL AND ap.zip IN (SELECT zip FROM props) THEN 0
               WHEN lower(ap.city) IN (SELECT city FROM props WHERE state = ap.state) THEN 1
               WHEN ap.zip IS NOT NULL AND left(ap.zip, 3) IN (SELECT left(zip, 3) FROM props) THEN 2
               WHEN ap.state IN (SELECT state FROM props) THEN 3
               ELSE 4
             END AS proximity_rank,
             CASE WHEN mr.id IS NOT NULL THEN TRUE ELSE FALSE END as already_contacted
        FROM application_pool ap
        LEFT JOIN pool_match_requests mr ON mr.pool_entry_id = ap.id AND mr.landlord_id = $1
       WHERE ap.status = 'available'
       ORDER BY proximity_rank ASC, ap.risk_score ASC NULLS LAST, ap.created_at DESC
       LIMIT 50`, [landlordId])
    res.json({ success: true, data: pool })
  } catch (e) { next(e) }
})

// ── POOL: LANDLORD'S OUTGOING MATCH REQUESTS ─────────────────
// S233: lists this landlord's pool_match_requests with the pool entry's
// redacted preview + unit info + status. Tenant identity (name, email,
// phone) is exposed only on rows where status='report_purchased' — the
// pre-purchase rows show the same redacted preview as /pool/search even
// after the tenant has expressed interest, until the $1 unlock fires.
backgroundRouter.get('/pool/matches', requireAuth, requirePerm('tenants.run_background_check'), async (req, res, next) => {
  try {
    const matches = await query<any>(`
      SELECT mr.id, mr.status, mr.landlord_message, mr.tenant_response,
             mr.requested_at, mr.responded_at, mr.purchased_at,
             mr.report_fee_paid,
             mr.pool_entry_id,
             ap.employment_status, ap.monthly_income, ap.city, ap.state, ap.zip,
             ap.risk_level, ap.risk_score,
             u.id AS unit_id, u.unit_number,
             p.name AS property_name,
             CASE WHEN mr.status = 'report_purchased' THEN tu.first_name END AS tenant_first,
             CASE WHEN mr.status = 'report_purchased' THEN tu.last_name  END AS tenant_last,
             CASE WHEN mr.status = 'report_purchased' THEN tu.email      END AS tenant_email,
             CASE WHEN mr.status = 'report_purchased' THEN tu.phone      END AS tenant_phone
        FROM pool_match_requests mr
        JOIN application_pool ap ON ap.id = mr.pool_entry_id
        JOIN users tu            ON tu.id = ap.user_id
        LEFT JOIN units u        ON u.id  = mr.unit_id
        LEFT JOIN properties p   ON p.id  = u.property_id
       WHERE mr.landlord_id = $1
       ORDER BY mr.requested_at DESC`,
      [req.user!.profileId])
    res.json({ success: true, data: matches })
  } catch (e) { next(e) }
})

// ── POOL: LANDLORD EXPRESSES INTEREST (FREE) ─────────────────
backgroundRouter.post('/pool/:poolId/reach-out', requireAuth, requirePerm('tenants.run_background_check'), async (req, res, next) => {
  try {
    const { unitId, message } = req.body
    const entry = await queryOne<any>(
      "SELECT * FROM application_pool WHERE id=$1 AND status='available'",
      [req.params.poolId]
    )
    if (!entry) throw new AppError(404, 'Pool entry not found')

    const existing = await queryOne<any>(
      'SELECT id FROM pool_match_requests WHERE pool_entry_id=$1 AND landlord_id=$2',
      [entry.id, req.user!.profileId]
    )
    if (existing) throw new AppError(400, 'Already contacted this applicant')

    const match = await queryOne<any>(`
      INSERT INTO pool_match_requests (pool_entry_id, landlord_id, unit_id, status, landlord_message)
      VALUES ($1, $2, $3, 'pending', $4) RETURNING id`,
      [entry.id, req.user!.profileId, unitId || null, message || null]
    )

    const unit = unitId
      ? await queryOne<any>(
          'SELECT u.*, p.name as property_name FROM units u JOIN properties p ON p.id=u.property_id WHERE u.id=$1',
          [unitId]
        )
      : null
    const landlordUser = await queryOne<any>(
      'SELECT u.first_name, u.last_name FROM landlords l JOIN users u ON u.id=l.user_id WHERE l.id=$1',
      [req.user!.profileId]
    )

    await query(`
      INSERT INTO tenant_notifications (user_id, type, title, body, data)
      VALUES ($1, 'match_interest', 'A landlord is interested in you', $2, $3)`,
      [
        entry.user_id,
        `${landlordUser?.first_name || ''} ${landlordUser?.last_name || ''}`.trim() +
          ` has a vacancy that matches your profile${unit ? ` at ${unit.property_name} Unit ${unit.unit_number}` : ''}. Are you interested?`,
        JSON.stringify({ matchRequestId: match!.id, unitId: unitId || null, landlordMessage: message || null }),
      ])

    try {
      const tu = await queryOne<any>('SELECT email, first_name FROM users WHERE id=$1', [entry.user_id])
      if (tu) {
        await emailPoolMatchInterest(
          tu.email, tu.first_name || 'there',
          `${landlordUser?.first_name || ''} ${landlordUser?.last_name || ''}`.trim(),
          unit?.property_name || 'a property',
          unit?.unit_number || '—',
          message || null,
          undefined,
          { landlordId: req.user!.profileId, matchRequestId: match!.id }
        )
      }
    } catch (e) { logger.error({ err: e }, '[EMAIL]') }

    res.json({ success: true, data: { matchRequestId: match!.id } })
  } catch (e) { next(e) }
})

// ── POOL: TENANT RESPONDS ────────────────────────────────────
backgroundRouter.patch('/pool/match/:matchId/respond', requireAuth, async (req, res, next) => {
  try {
    const { interested, message } = req.body
    const match = await queryOne<any>(`
      SELECT mr.*, ap.user_id FROM pool_match_requests mr
      JOIN application_pool ap ON ap.id=mr.pool_entry_id
      WHERE mr.id=$1`, [req.params.matchId])
    if (!match) throw new AppError(404, 'Match request not found')
    if (match.user_id !== req.user!.userId) throw new AppError(403, 'Not your match request')
    if (match.status !== 'pending') throw new AppError(400, 'Already responded')

    const status = interested ? 'interested' : 'not_interested'
    await query(
      'UPDATE pool_match_requests SET status=$1, tenant_response=$2, responded_at=NOW() WHERE id=$3',
      [status, message || null, match.id]
    )

    if (interested) {
      try {
        const lu = await queryOne<any>(
          'SELECT u.email, u.first_name FROM landlords l JOIN users u ON u.id=l.user_id WHERE l.id=$1',
          [match.landlord_id]
        )
        if (lu?.email) await emailPoolTenantInterested(
          lu.email, lu.first_name || 'there',
          undefined,
          { landlordId: match.landlord_id, matchRequestId: match.id }
        )
      } catch (e) { logger.error({ err: e }, '[EMAIL]') }
    }

    res.json({ success: true, data: { status } })
  } catch (e) { next(e) }
})

// ── POOL: LANDLORD CREATES UNLOCK PAYMENT INTENT ─────────────
// S83: two-step pool unlock. First call returns a Stripe clientSecret;
// landlord confirms via Elements (or saved card) on the frontend; then
// /purchase-report verifies the resulting intentId and flips fees.
backgroundRouter.post('/pool/match/:matchId/payment-intent', requireAuth, requirePerm('tenants.run_background_check'), async (req, res, next) => {
  try {
    const match = await queryOne<any>(
      `SELECT id, status, report_fee_paid, landlord_id FROM pool_match_requests
       WHERE id=$1 AND landlord_id=$2`,
      [req.params.matchId, req.user!.profileId])
    if (!match) throw new AppError(404, 'Match not found')
    if (match.status !== 'interested') throw new AppError(400, 'Tenant has not confirmed interest yet')
    if (match.report_fee_paid) throw new AppError(400, 'Report already purchased')

    if (!STRIPE_LIVE) {
      const mockId = 'pi_pool_mock_' + crypto.randomBytes(8).toString('hex')
      return res.json({
        success: true,
        data: { clientSecret: mockId + '_secret', intentId: mockId, amount: POOL_REPORT_UNLOCK_USD, testMode: true },
      })
    }
    const intent = await stripeForBgc!.paymentIntents.create({
      amount: Math.round(POOL_REPORT_UNLOCK_USD * 100),
      currency: 'usd',
      payment_method_types: ['card'],
      description: 'GAM applicant pool report unlock',
      metadata: {
        kind:    'pool_report_unlock',
        userId:  req.user!.userId,
        matchId: match.id,
        feeUsd:  String(POOL_REPORT_UNLOCK_USD),
      },
    })
    res.json({
      success: true,
      data: {
        clientSecret: intent.client_secret,
        intentId:     intent.id,
        amount:       POOL_REPORT_UNLOCK_USD,
        testMode:     false,
      },
    })
  } catch (e) { next(e) }
})

// ── POOL: LANDLORD UNLOCKS REPORT ($1) ───────────────────────
// S83: now requires a verified Stripe PaymentIntent in the body. Frontend
// must have confirmed the intent client-side (via clientSecret from
// /pool/match/:matchId/payment-intent) before calling this.
backgroundRouter.post('/pool/match/:matchId/purchase-report', requireAuth, requirePerm('tenants.run_background_check'), async (req, res, next) => {
  try {
    const { paymentIntentId } = req.body as { paymentIntentId?: string }
    if (!paymentIntentId) throw new AppError(400, 'paymentIntentId required')

    const match = await queryOne<any>(`
      SELECT mr.*, ap.background_check_id, ap.user_id FROM pool_match_requests mr
      JOIN application_pool ap ON ap.id=mr.pool_entry_id
      WHERE mr.id=$1 AND mr.landlord_id=$2`,
      [req.params.matchId, req.user!.profileId])
    if (!match) throw new AppError(404, 'Match not found')
    if (match.status !== 'interested') throw new AppError(400, 'Tenant has not confirmed interest yet')
    if (match.report_fee_paid) throw new AppError(400, 'Report already purchased')

    await verifyPaymentIntent(paymentIntentId, {
      kind:      'pool_report_unlock',
      amountUsd: POOL_REPORT_UNLOCK_USD,
      userId:    req.user!.userId,
      matchId:   match.id,
    })

    // Idempotency: payment_intent_id is now load-bearing. If the same PI
    // somehow re-arrives we want a clean conflict, not silent double-flip.
    const updated = await queryOne<any>(
      `UPDATE pool_match_requests
          SET status='report_purchased',
              report_fee_paid=TRUE,
              payment_intent_id=$1,
              purchased_at=NOW()
        WHERE id=$2 AND report_fee_paid=FALSE
        RETURNING id`,
      [paymentIntentId, match.id]
    )
    if (!updated) throw new AppError(409, 'Report unlock already recorded')

    const check = await queryOne<any>(`
      SELECT bc.*, u.email, u.first_name, u.last_name, u.phone
      FROM background_checks bc
      JOIN users u ON u.id = bc.user_id
      WHERE bc.id = $1`, [match.background_check_id])
    if (!check) throw new AppError(404, 'Background check not found')
    const { ssn_encrypted, ...safeCheck } = check as any
    void ssn_encrypted

    res.json({
      success: true,
      data: { report: safeCheck, fee: POOL_REPORT_UNLOCK_USD, paymentId: paymentIntentId },
    })
  } catch (e) { next(e) }
})
