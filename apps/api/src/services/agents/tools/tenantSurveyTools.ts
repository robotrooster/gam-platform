/**
 * Tenant survey tools (S626).
 *
 * Nic: "the agent should be able to file a maintenance request and fill out and
 * send the survey for the intent to renew their lease."
 *
 * The tenant portal has had a Surveys page since S577 — a landlord authors a
 * questionnaire, sends it to the tenants at one property, and the classic use is
 * asking who intends to renew. The agent had no tool for any of it, so a tenant
 * who asked about a survey in chat was told nothing and had to go and find the
 * page.
 *
 * These mirror routes/surveys.ts exactly: same property scoping through the
 * tenant's ACTIVE leases, same sent-and-active filter, same one-response rule,
 * same validation. A tool that is laxer than the route it shadows is a hole in
 * the route.
 */
import { query, queryOne, getClient } from '../../../db'
import type { AgentTool, AgentActor } from './types'

/** Properties the tenant currently holds an active lease at. Surveys are
 *  property-scoped, so this is the whole of their visibility. */
async function propertyIds(tenantId: string): Promise<string[]> {
  const rows = await query<{ property_id: string }>(
    `SELECT DISTINCT u.property_id
       FROM lease_tenants lt
       JOIN leases l ON l.id = lt.lease_id
       JOIN units u ON u.id = l.unit_id
      WHERE lt.tenant_id = $1 AND lt.status = 'active' AND u.property_id IS NOT NULL`,
    [tenantId])
  return rows.map((r) => r.property_id)
}

export const getMySurveys: AgentTool = {
  name: 'get_my_surveys',
  description:
    'Surveys the tenant’s landlord has sent them, with every question and whether they have already ' +
    'answered. Use for “do I have any surveys?”, “what is this survey about?”, and — the common one — ' +
    'anything about a renewal-intent questionnaire (“am I supposed to say if I’m staying?”). Read the ' +
    'questions out conversationally rather than as a form, then offer to submit their answers with ' +
    'submit_survey_response. Multiple-choice questions list their allowed options; an answer must be ' +
    'one of them word for word. Read-only.',
  parameters: { type: 'object', properties: {} },
  audiences: ['tenant'],

  async execute(_args, actor: AgentActor) {
    const props = await propertyIds(actor.profileId)
    if (props.length === 0) return { ok: true, surveys: [], note: 'No active lease, so no surveys are addressed to them.' }
    const surveys = await query<any>(
      `SELECT s.id, s.title, s.description, s.sent_at, s.anonymous,
              EXISTS (SELECT 1 FROM survey_responses r
                       WHERE r.survey_id = s.id AND r.tenant_id = $2) AS responded
         FROM surveys s
        WHERE s.property_id = ANY($1) AND s.status = 'sent' AND s.is_active = true
        ORDER BY s.sent_at DESC NULLS LAST
        LIMIT 20`,
      [props, actor.profileId])
    if (surveys.length === 0) return { ok: true, surveys: [], note: 'Their landlord has not sent them any surveys.' }

    const qs = await query<any>(
      `SELECT id, survey_id, position, question_type, prompt, options, required
         FROM survey_questions WHERE survey_id = ANY($1) ORDER BY position, id`,
      [surveys.map((s) => s.id)])

    return {
      ok: true,
      surveys: surveys.map((s) => ({
        surveyId: s.id,
        title: s.title,
        description: s.description,
        sentAt: s.sent_at,
        alreadyAnswered: s.responded,
        // Worth telling them: it changes what they are willing to say.
        anonymousToLandlord: s.anonymous,
        questions: qs.filter((q) => q.survey_id === s.id).map((q) => ({
          questionId: q.id,
          prompt: q.prompt,
          type: q.question_type,
          options: q.question_type === 'multiple_choice' ? (q.options ?? []) : undefined,
          required: q.required,
        })),
      })),
      note:
        'EVERY question must be answered — the landlord gets an answer to each, and a tenant who has ' +
        'nothing to say on one answers "NA". A survey can only be submitted ONCE, so read their answers ' +
        'back and get an explicit yes before calling submit_survey_response. If it is marked ' +
        'anonymousToLandlord, say so: it changes what people are willing to write.',
    }
  },
}

export const submitSurveyResponse: AgentTool = {
  name: 'submit_survey_response',
  description:
    'Submit the tenant’s answers to one survey. CONFIRM FIRST — read every answer back and get an ' +
    'explicit yes, because a survey can only be answered once and there is no edit afterwards. ' +
    'Every question must have an answer ("NA" where it does not apply), and a multiple-choice answer ' +
    'must match one of that question’s options exactly. Get the questionIds from get_my_surveys.',
  parameters: {
    type: 'object',
    properties: {
      surveyId: { type: 'string', description: 'The survey being answered (from get_my_surveys).' },
      answers: {
        type: 'array',
        description: 'One entry per question on the survey.',
        items: {
          type: 'object',
          properties: {
            questionId: { type: 'string', description: 'The question id from get_my_surveys.' },
            answerText: { type: 'string', description: 'Their answer in their own words, or the exact option text for multiple choice.' },
          },
          required: ['questionId', 'answerText'],
        },
      },
    },
    required: ['surveyId', 'answers'],
  },
  audiences: ['tenant'],

  async execute(args, actor: AgentActor) {
    const surveyId = String(args.surveyId ?? '').trim()
    if (!surveyId) return { ok: false, error: 'Which survey? Call get_my_surveys first.' }
    const props = await propertyIds(actor.profileId)
    if (props.length === 0) return { ok: false, error: 'No active lease, so there is no survey to answer.' }

    const survey = await queryOne<any>(
      `SELECT id, title, property_id FROM surveys
        WHERE id = $1 AND status = 'sent' AND is_active = true`, [surveyId])
    // Same 404 the route gives for a survey at someone else's property — a
    // tenant must never learn that a survey they cannot see exists.
    if (!survey || !props.includes(survey.property_id)) {
      return { ok: false, error: 'No such survey for this tenant.' }
    }

    const questions = await query<any>(
      'SELECT id, prompt, question_type, options, required FROM survey_questions WHERE survey_id = $1', [surveyId])
    if (questions.length === 0) return { ok: false, error: 'That survey has no questions.' }

    const given = new Map<string, string>()
    for (const a of (Array.isArray(args.answers) ? args.answers : []) as any[]) {
      given.set(String(a?.questionId ?? ''), String(a?.answerText ?? '').trim().slice(0, 4000))
    }

    // Validate BEFORE writing anything — the route does, and a half-submitted
    // survey cannot be retried because the response row is unique per tenant.
    const missing = questions.filter((q) => !given.get(q.id))
    if (missing.length) {
      return {
        ok: false,
        error: 'Every question needs an answer before this can be sent.',
        stillNeeded: missing.map((q) => ({ questionId: q.id, prompt: q.prompt })),
        tellThem: 'Ask them for the missing ones. If one does not apply to them, "NA" is the accepted answer.',
      }
    }
    for (const q of questions) {
      if (q.question_type !== 'multiple_choice') continue
      const opts: string[] = Array.isArray(q.options) ? q.options : []
      const val = given.get(q.id)!
      if (!opts.includes(val)) {
        return {
          ok: false,
          error: `"${val}" is not one of the choices for "${q.prompt}".`,
          allowedOptions: opts,
          tellThem: 'Offer them the actual options and use their wording exactly.',
        }
      }
    }

    const client = await getClient()
    try {
      await client.query('BEGIN')
      const resp = await client.query(
        `INSERT INTO survey_responses (survey_id, tenant_id) VALUES ($1, $2)
         ON CONFLICT (survey_id, tenant_id) DO NOTHING RETURNING id`,
        [surveyId, actor.profileId])
      if (resp.rows.length === 0) {
        await client.query('ROLLBACK')
        return { ok: false, alreadyAnswered: true, error: 'They have already answered this survey — it cannot be answered twice.' }
      }
      const responseId = resp.rows[0].id
      for (const q of questions) {
        await client.query(
          'INSERT INTO survey_answers (response_id, question_id, answer_text) VALUES ($1, $2, $3)',
          [responseId, q.id, given.get(q.id)!])
      }
      await client.query('COMMIT')
      return {
        ok: true,
        submitted: true,
        surveyTitle: survey.title,
        note: 'Sent to their landlord. Tell them it is in and that it cannot be changed now.',
      }
    } catch (e) {
      try { await client.query('ROLLBACK') } catch { /* the error below is the one that matters */ }
      throw e
    } finally {
      client.release()
    }
  },
}
