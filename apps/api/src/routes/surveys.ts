import { Router } from 'express'
import { z } from 'zod'
import { query, queryOne, getClient } from '../db'
import { requireAuth, requirePerm } from '../middleware/auth'
import { AppError } from '../middleware/errorHandler'
import { resolveLandlordIdForUser } from '../lib/scope'
import { canManageLandlordResource } from '../middleware/scope'
import { createNotification } from '../services/notifications'
import { SURVEY_QUESTION_TYPES } from '@gam/shared'

// ============================================================
// S577 — Property-scoped tenant surveys (Nic).
//
// Landlord authors a Google-Forms-style questionnaire, sends it to the tenants
// of ONE property, and reads the aggregated results. HARD RULE: a survey belongs
// to exactly one property; responses are never mixed across properties. Running
// the same survey elsewhere is a COPY (own survey + own responses).
//
// NOT the removed bulletin board and NOT tenant-authored.
//
// Landlord routes gate on notifications.send_bulk (a survey is a bulk tenant
// communication; the owner always passes). Tenant routes carry no landlord perm.
// ============================================================

export const surveysRouter = Router()
surveysRouter.use(requireAuth)

// ── SHARED SHAPES ────────────────────────────────────────────

// S577 (Nic): every question is REQUIRED and every survey is ALWAYS ANONYMOUS —
// both enforced server-side regardless of the request body. Anonymous protects
// tenants from retaliation (landlord-tenant power dynamic); required means the
// landlord gets an answer to each question (tenant types "NA" if not applicable).
const questionSchema = z.object({
  questionType: z.enum(SURVEY_QUESTION_TYPES as unknown as [string, ...string[]]),
  prompt: z.string().trim().min(1).max(500),
  options: z.array(z.string().trim().min(1).max(200)).max(20).optional().default([]),
})

const surveyBodySchema = z.object({
  propertyId: z.string().uuid(),
  title: z.string().trim().min(1).max(200),
  description: z.string().trim().max(2000).optional().nullable(),
  questions: z.array(questionSchema).min(1).max(50),
})

// A multiple_choice question must carry >= 2 options; text questions carry none.
function validateQuestions(questions: z.infer<typeof questionSchema>[]) {
  questions.forEach((q, i) => {
    if (q.questionType === 'multiple_choice' && (q.options?.length ?? 0) < 2) {
      throw new AppError(400, `Question ${i + 1}: multiple choice needs at least 2 options`)
    }
  })
}

// Load a survey and verify the caller has landlord authority over it.
async function getSurveyForLandlord(id: string, user: any) {
  const survey = await queryOne<any>('SELECT * FROM surveys WHERE id=$1 AND is_active=true', [id])
  if (!survey) throw new AppError(404, 'Survey not found')
  if (!canManageLandlordResource(user, survey.landlord_id, ['property_manager'])) {
    throw new AppError(403, 'Forbidden')
  }
  return survey
}

// The set of property IDs a tenant (by user) currently has an active lease at,
// plus the tenant row id used to record responses.
async function tenantContext(userId: string): Promise<{ tenantId: string; propertyIds: string[] } | null> {
  const t = await queryOne<{ id: string }>('SELECT id FROM tenants WHERE user_id=$1 ORDER BY created_at LIMIT 1', [userId])
  if (!t) return null
  const rows = await query<{ property_id: string }>(
    `SELECT DISTINCT un.property_id
       FROM lease_tenants lt
       JOIN leases l ON l.id = lt.lease_id AND l.status = 'active'
       JOIN units un ON un.id = l.unit_id
      WHERE lt.tenant_id = $1 AND lt.status = 'active'`,
    [t.id]
  )
  return { tenantId: t.id, propertyIds: rows.map(r => r.property_id) }
}

// ════════════════════════════════════════════════════════════
// TENANT ROUTES (no landlord perm) — placed before /:id so the
// literal '/tenant' segment can't be captured as a survey id.
// ════════════════════════════════════════════════════════════

// GET /api/surveys/tenant/mine — sent surveys for this tenant's property(ies),
// each flagged with whether the tenant has already responded.
surveysRouter.get('/tenant/mine', async (req, res, next) => {
  try {
    const ctx = await tenantContext(req.user!.userId)
    if (!ctx || ctx.propertyIds.length === 0) return res.json({ success: true, data: [] })
    const rows = await query<any>(
      `SELECT s.id, s.title, s.description, s.sent_at, s.status,
              (SELECT COUNT(*) FROM survey_questions q WHERE q.survey_id = s.id)::int AS question_count,
              EXISTS (SELECT 1 FROM survey_responses r WHERE r.survey_id = s.id AND r.tenant_id = $2) AS responded
         FROM surveys s
        WHERE s.property_id = ANY($1) AND s.status = 'sent' AND s.is_active = true
        ORDER BY s.sent_at DESC NULLS LAST`,
      [ctx.propertyIds, ctx.tenantId]
    )
    res.json({ success: true, data: rows })
  } catch (e) { next(e) }
})

// GET /api/surveys/tenant/:id — a sent survey (+ questions) the tenant may answer.
surveysRouter.get('/tenant/:id', async (req, res, next) => {
  try {
    const ctx = await tenantContext(req.user!.userId)
    if (!ctx) throw new AppError(403, 'Forbidden')
    const survey = await queryOne<any>(
      `SELECT id, title, description, property_id, status FROM surveys
        WHERE id=$1 AND status='sent' AND is_active=true`, [req.params.id])
    if (!survey || !ctx.propertyIds.includes(survey.property_id)) throw new AppError(404, 'Survey not found')
    const questions = await query<any>(
      `SELECT id, position, question_type, prompt, options, required
         FROM survey_questions WHERE survey_id=$1 ORDER BY position, id`, [survey.id])
    const existing = await queryOne<any>(
      'SELECT id FROM survey_responses WHERE survey_id=$1 AND tenant_id=$2', [survey.id, ctx.tenantId])
    res.json({ success: true, data: { ...survey, questions, responded: !!existing } })
  } catch (e) { next(e) }
})

// POST /api/surveys/tenant/:id/respond — submit answers (once).
surveysRouter.post('/tenant/:id/respond', async (req, res, next) => {
  const client = await getClient()
  try {
    const ctx = await tenantContext(req.user!.userId)
    if (!ctx) throw new AppError(403, 'Forbidden')
    const survey = await queryOne<any>(
      `SELECT id, property_id FROM surveys WHERE id=$1 AND status='sent' AND is_active=true`, [req.params.id])
    if (!survey || !ctx.propertyIds.includes(survey.property_id)) throw new AppError(404, 'Survey not found')

    const answers = z.array(z.object({
      questionId: z.string().uuid(),
      answerText: z.string().trim().max(4000).optional().nullable(),
    })).parse(req.body?.answers)

    const questions = await query<any>(
      'SELECT id, question_type, options, required FROM survey_questions WHERE survey_id=$1', [survey.id])
    const byId = new Map(questions.map((q: any) => [q.id, q]))
    const answerMap = new Map(answers.map(a => [a.questionId, (a.answerText ?? '').trim()]))

    // Validate: required answered; MC answer is one of the offered options.
    for (const q of questions) {
      const val = answerMap.get(q.id) ?? ''
      if (!val) throw new AppError(400, 'Please answer every question (type "NA" if it does not apply)')
      if (val && q.question_type === 'multiple_choice') {
        const opts: string[] = Array.isArray(q.options) ? q.options : []
        if (!opts.includes(val)) throw new AppError(400, 'Invalid choice for a multiple-choice question')
      }
    }

    await client.query('BEGIN')
    const resp = await client.query(
      'INSERT INTO survey_responses (survey_id, tenant_id) VALUES ($1,$2) ON CONFLICT (survey_id, tenant_id) DO NOTHING RETURNING id',
      [survey.id, ctx.tenantId])
    if (resp.rows.length === 0) { await client.query('ROLLBACK'); throw new AppError(409, 'You have already responded to this survey') }
    const responseId = resp.rows[0].id
    for (const q of questions) {
      const val = answerMap.get(q.id) ?? ''
      if (!val) continue
      if (!byId.has(q.id)) continue
      await client.query(
        'INSERT INTO survey_answers (response_id, question_id, answer_text) VALUES ($1,$2,$3)',
        [responseId, q.id, val])
    }
    await client.query('COMMIT')
    res.json({ success: true })
  } catch (e) { try { await client.query('ROLLBACK') } catch {} ; next(e) }
  finally { client.release() }
})

// ════════════════════════════════════════════════════════════
// LANDLORD ROUTES (require notifications.send_bulk)
// ════════════════════════════════════════════════════════════

const requireSurveyPerm = requirePerm('notifications.send_bulk')

// GET /api/surveys?propertyId= — landlord's surveys (with response counts).
surveysRouter.get('/', requireSurveyPerm, async (req, res, next) => {
  try {
    const landlordId = await resolveLandlordIdForUser(req.user)
    if (!landlordId) throw new AppError(403, 'No landlord scope')
    const propertyId = typeof req.query.propertyId === 'string' ? req.query.propertyId : null
    const rows = await query<any>(
      `SELECT s.id, s.title, s.description, s.property_id, p.name AS property_name,
              s.status, s.anonymous, s.created_at, s.sent_at, s.closed_at,
              (SELECT COUNT(*) FROM survey_questions q WHERE q.survey_id=s.id)::int AS question_count,
              (SELECT COUNT(*) FROM survey_responses r WHERE r.survey_id=s.id)::int AS response_count
         FROM surveys s
         JOIN properties p ON p.id = s.property_id
        WHERE s.landlord_id=$1 AND s.is_active=true
          AND ($2::uuid IS NULL OR s.property_id=$2)
        ORDER BY s.created_at DESC`,
      [landlordId, propertyId]
    )
    res.json({ success: true, data: rows })
  } catch (e) { next(e) }
})

// POST /api/surveys — create a draft survey with its questions.
surveysRouter.post('/', requireSurveyPerm, async (req, res, next) => {
  const client = await getClient()
  try {
    const body = surveyBodySchema.parse(req.body)
    validateQuestions(body.questions)
    const landlordId = await resolveLandlordIdForUser(req.user)
    if (!landlordId) throw new AppError(403, 'No landlord scope')
    const prop = await queryOne<any>('SELECT id FROM properties WHERE id=$1 AND landlord_id=$2', [body.propertyId, landlordId])
    if (!prop) throw new AppError(404, 'Property not found')

    await client.query('BEGIN')
    const s = await client.query(
      `INSERT INTO surveys (landlord_id, property_id, created_by, title, description, anonymous)
       VALUES ($1,$2,$3,$4,$5,$6) RETURNING id`,
      [landlordId, body.propertyId, req.user!.userId, body.title, body.description ?? null, true])
    const surveyId = s.rows[0].id
    await insertQuestions(client, surveyId, body.questions)
    await client.query('COMMIT')
    res.status(201).json({ success: true, data: { id: surveyId } })
  } catch (e) { try { await client.query('ROLLBACK') } catch {} ; next(e) }
  finally { client.release() }
})

// GET /api/surveys/:id — full survey with questions.
surveysRouter.get('/:id', requireSurveyPerm, async (req, res, next) => {
  try {
    const survey = await getSurveyForLandlord(req.params.id, req.user)
    const questions = await query<any>(
      `SELECT id, position, question_type, prompt, options, required
         FROM survey_questions WHERE survey_id=$1 ORDER BY position, id`, [survey.id])
    const rc = await queryOne<{ c: number }>('SELECT COUNT(*)::int AS c FROM survey_responses WHERE survey_id=$1', [survey.id])
    res.json({ success: true, data: { ...survey, questions, response_count: rc?.c ?? 0 } })
  } catch (e) { next(e) }
})

// PATCH /api/surveys/:id — edit title/description/questions. DRAFT only (a sent
// survey is locked so responses stay comparable).
surveysRouter.patch('/:id', requireSurveyPerm, async (req, res, next) => {
  const client = await getClient()
  try {
    const survey = await getSurveyForLandlord(req.params.id, req.user)
    if (survey.status !== 'draft') throw new AppError(400, 'A survey can only be edited while it is a draft')
    const body = surveyBodySchema.partial({ propertyId: true }).parse(req.body)
    if (body.questions) validateQuestions(body.questions)

    await client.query('BEGIN')
    await client.query(
      `UPDATE surveys SET title=COALESCE($2,title), description=$3, anonymous=TRUE WHERE id=$1`,
      [survey.id, body.title ?? null, body.description ?? null])
    if (body.questions) {
      await client.query('DELETE FROM survey_questions WHERE survey_id=$1', [survey.id])
      await insertQuestions(client, survey.id, body.questions)
    }
    await client.query('COMMIT')
    res.json({ success: true })
  } catch (e) { try { await client.query('ROLLBACK') } catch {} ; next(e) }
  finally { client.release() }
})

// POST /api/surveys/:id/send — publish to the property's active tenants + notify.
surveysRouter.post('/:id/send', requireSurveyPerm, async (req, res, next) => {
  try {
    const survey = await getSurveyForLandlord(req.params.id, req.user)
    if (survey.status === 'sent') throw new AppError(400, 'Survey already sent')
    const qc = await queryOne<{ c: number }>('SELECT COUNT(*)::int AS c FROM survey_questions WHERE survey_id=$1', [survey.id])
    if ((qc?.c ?? 0) === 0) throw new AppError(400, 'Add at least one question before sending')

    await query(`UPDATE surveys SET status='sent', sent_at=NOW(), closed_at=NULL WHERE id=$1`, [survey.id])

    const recipients = await query<any>(
      `SELECT DISTINCT t.user_id, u.email
         FROM lease_tenants lt
         JOIN leases l ON l.id = lt.lease_id AND l.status='active'
         JOIN units un ON un.id = l.unit_id
         JOIN tenants t ON t.id = lt.tenant_id
         JOIN users u ON u.id = t.user_id
        WHERE un.property_id=$1 AND lt.status='active' AND t.user_id IS NOT NULL`,
      [survey.property_id])

    for (const r of recipients) {
      await createNotification({
        userId: r.user_id,
        landlordId: survey.landlord_id,
        type: 'survey_sent',
        title: 'New survey from your landlord',
        body: `Please share your input: "${survey.title}"`,
        actionUrl: '/communication?tab=surveys',
        sendEmail: true,
        emailTo: r.email,
        emailSubject: `Survey: ${survey.title}`,
      })
    }
    res.json({ success: true, data: { recipients: recipients.length } })
  } catch (e) { next(e) }
})

// POST /api/surveys/:id/close — stop accepting responses.
surveysRouter.post('/:id/close', requireSurveyPerm, async (req, res, next) => {
  try {
    const survey = await getSurveyForLandlord(req.params.id, req.user)
    if (survey.status !== 'sent') throw new AppError(400, 'Only a sent survey can be closed')
    await query(`UPDATE surveys SET status='closed', closed_at=NOW() WHERE id=$1`, [survey.id])
    res.json({ success: true })
  } catch (e) { next(e) }
})

// POST /api/surveys/:id/copy — duplicate this survey (+ questions) to another
// property as a fresh DRAFT with its own, separate responses.
surveysRouter.post('/:id/copy', requireSurveyPerm, async (req, res, next) => {
  const client = await getClient()
  try {
    const survey = await getSurveyForLandlord(req.params.id, req.user)
    const targetPropertyId = z.string().uuid().parse(req.body?.targetPropertyId)
    const prop = await queryOne<any>('SELECT id FROM properties WHERE id=$1 AND landlord_id=$2', [targetPropertyId, survey.landlord_id])
    if (!prop) throw new AppError(404, 'Target property not found')
    const questions = await query<any>(
      'SELECT position, question_type, prompt, options, required FROM survey_questions WHERE survey_id=$1 ORDER BY position, id', [survey.id])

    await client.query('BEGIN')
    const s = await client.query(
      `INSERT INTO surveys (landlord_id, property_id, created_by, title, description, anonymous)
       VALUES ($1,$2,$3,$4,$5,$6) RETURNING id`,
      [survey.landlord_id, targetPropertyId, req.user!.userId, survey.title, survey.description, true])
    const newId = s.rows[0].id
    for (const q of questions) {
      await client.query(
        `INSERT INTO survey_questions (survey_id, position, question_type, prompt, options, required)
         VALUES ($1,$2,$3,$4,$5,$6)`,
        [newId, q.position, q.question_type, q.prompt, JSON.stringify(q.options ?? []), true])
    }
    await client.query('COMMIT')
    res.status(201).json({ success: true, data: { id: newId } })
  } catch (e) { try { await client.query('ROLLBACK') } catch {} ; next(e) }
  finally { client.release() }
})

// GET /api/surveys/:id/results — aggregated results (respecting anonymity).
surveysRouter.get('/:id/results', requireSurveyPerm, async (req, res, next) => {
  try {
    const survey = await getSurveyForLandlord(req.params.id, req.user)
    const questions = await query<any>(
      `SELECT id, position, question_type, prompt, options FROM survey_questions WHERE survey_id=$1 ORDER BY position, id`, [survey.id])
    const responseCount = (await queryOne<{ c: number }>(
      'SELECT COUNT(*)::int AS c FROM survey_responses WHERE survey_id=$1', [survey.id]))?.c ?? 0
    const invited = (await queryOne<{ c: number }>(
      `SELECT COUNT(DISTINCT lt.tenant_id)::int AS c
         FROM lease_tenants lt
         JOIN leases l ON l.id = lt.lease_id AND l.status='active'
         JOIN units un ON un.id=l.unit_id
        WHERE un.property_id=$1 AND lt.status='active'`, [survey.property_id]))?.c ?? 0

    const results = []
    for (const q of questions) {
      if (q.question_type === 'multiple_choice') {
        const counts = await query<any>(
          `SELECT a.answer_text AS option, COUNT(*)::int AS n
             FROM survey_answers a WHERE a.question_id=$1 AND a.answer_text IS NOT NULL
            GROUP BY a.answer_text`, [q.id])
        const byOption = new Map(counts.map((c: any) => [c.option, c.n]))
        const opts: string[] = Array.isArray(q.options) ? q.options : []
        results.push({
          ...q,
          tally: opts.map(o => ({ option: o, count: byOption.get(o) ?? 0 })),
        })
      } else {
        const texts = await query<any>(
          `SELECT a.answer_text AS text,
                  CASE WHEN $2 THEN NULL ELSE (u.first_name || ' ' || u.last_name) END AS respondent
             FROM survey_answers a
             JOIN survey_responses r ON r.id = a.response_id
             JOIN tenants t ON t.id = r.tenant_id
             JOIN users u ON u.id = t.user_id
            WHERE a.question_id=$1 AND a.answer_text IS NOT NULL
            ORDER BY r.submitted_at DESC`, [q.id, survey.anonymous])
        results.push({ ...q, answers: texts })
      }
    }
    res.json({ success: true, data: { survey, responseCount, invited, results } })
  } catch (e) { next(e) }
})

// DELETE /api/surveys/:id — soft delete (keep-everything rule).
surveysRouter.delete('/:id', requireSurveyPerm, async (req, res, next) => {
  try {
    const survey = await getSurveyForLandlord(req.params.id, req.user)
    await query('UPDATE surveys SET is_active=false WHERE id=$1', [survey.id])
    res.json({ success: true })
  } catch (e) { next(e) }
})

// ── helpers ──────────────────────────────────────────────────
async function insertQuestions(client: any, surveyId: string, questions: z.infer<typeof questionSchema>[]) {
  for (let i = 0; i < questions.length; i++) {
    const q = questions[i]
    await client.query(
      `INSERT INTO survey_questions (survey_id, position, question_type, prompt, options, required)
       VALUES ($1,$2,$3,$4,$5,$6)`,
      [surveyId, i, q.questionType, q.prompt, JSON.stringify(q.questionType === 'multiple_choice' ? (q.options ?? []) : []), true])
  }
}
