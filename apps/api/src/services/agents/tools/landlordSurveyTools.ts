/**
 * Landlord survey tools (S626).
 *
 * The tenant half went in earlier this session; this is the other end — a
 * landlord asking their tenants something without leaving the chat.
 *
 * THE CONSTRAINT THAT SHAPES BOTH TOOLS. Every survey on GAM is ALWAYS
 * ANONYMOUS, enforced server-side in routes/surveys.ts regardless of what the
 * request asks for. It is Nic's own S577 decision and the reason is in the code:
 * "Anonymous protects tenants from retaliation (landlord-tenant power dynamic)."
 *
 * So a survey can tell a landlord that fourteen of twenty intend to stay. It can
 * never tell them WHICH fourteen — multiple choice comes back as a tally and
 * free-text answers have the respondent stripped. An agent that offers a survey
 * to find out who is renewing has promised something the platform forbids, and
 * the landlord will only discover it after the answers are in and unrepeatable.
 * Both descriptions say so up front, and point at the tools that DO answer it
 * per-tenant.
 */
import { query, queryOne, getClient } from '../../../db'
import { createNotification } from '../../notifications'
import type { AgentTool, AgentActor } from './types'

async function resolveProperty(landlordId: string, name: string) {
  const needle = String(name ?? '').trim()
  if (!needle) return { error: 'Which property? A survey goes to the tenants at one property.' }
  const rows = await query<{ id: string; name: string }>(
    `SELECT id, name FROM properties WHERE landlord_id = $1 AND name ILIKE '%' || $2 || '%' LIMIT 6`,
    [landlordId, needle])
  if (rows.length === 0) return { error: `No property of theirs matches "${needle}".` }
  if (rows.length > 1) return { ambiguous: rows.map((r) => r.name) }
  return { property: rows[0] }
}

export const createAndSendSurvey: AgentTool = {
  name: 'create_and_send_survey',
  description:
    'Write a survey and send it to every tenant with an active lease at ONE of the landlord’s ' +
    'properties. They get a notification and an email. Use for “ask everyone at Oak Street whether ' +
    'they plan to renew”, “find out what people think about the parking”.\\n' +
    'ANSWERS ARE ANONYMOUS AND THAT CANNOT BE TURNED OFF. Say this before you send. The landlord sees ' +
    'counts for multiple-choice questions and the text of written answers with no name attached — ' +
    'never who said what. If what they actually want is which INDIVIDUAL tenants are renewing, a ' +
    'survey cannot tell them: use get_lease_expirations to see whose lease is ending and message them ' +
    'directly. Sending a survey for that leaves them with a number they cannot act on.\\n' +
    'EVERY question is required for the tenant — there is no optional question, and a tenant with ' +
    'nothing to say answers "NA". Keep it to a handful; this lands in someone’s evening.\\n' +
    'CONFIRM FIRST: read back the property, the questions and that it goes out anonymously to every ' +
    'active tenant there. It cannot be unsent.',
  parameters: {
    type: 'object',
    properties: {
      property: { type: 'string', description: 'The property, in the landlord’s own words — "Oak Street".' },
      title: { type: 'string', description: 'Short subject the tenants will see.' },
      description: { type: 'string', description: 'Optional line explaining why you are asking.' },
      questions: {
        type: 'array',
        description: 'One to ten questions, in order.',
        items: {
          type: 'object',
          properties: {
            prompt: { type: 'string', description: 'The question as a tenant will read it.' },
            type: { type: 'string', description: '"multiple_choice" or "text".' },
            options: { type: 'array', items: { type: 'string' }, description: 'Required for multiple_choice: the exact choices.' },
          },
          required: ['prompt', 'type'],
        },
      },
    },
    required: ['property', 'title', 'questions'],
  },
  audiences: ['landlord'],

  async execute(args, actor: AgentActor) {
    const r: any = await resolveProperty(actor.profileId, String(args.property ?? ''))
    if (r.error) return { ok: false, error: r.error }
    if (r.ambiguous) {
      return { ok: false, needsNarrowing: true, options: r.ambiguous,
        error: 'That matches more than one property — ask which, then call again.' }
    }
    const title = String(args.title ?? '').trim().slice(0, 200)
    if (!title) return { ok: false, error: 'The survey needs a title — it is what the tenant sees first.' }

    const raw = Array.isArray(args.questions) ? args.questions : []
    if (raw.length === 0) return { ok: false, error: 'A survey needs at least one question.' }
    if (raw.length > 10) return { ok: false, error: 'Ten questions is the most that should go out at once.' }

    const questions: { prompt: string; type: string; options: string[] }[] = []
    for (const q of raw as any[]) {
      const prompt = String(q?.prompt ?? '').trim().slice(0, 500)
      const type = String(q?.type ?? '').trim()
      if (!prompt) return { ok: false, error: 'Every question needs wording.' }
      if (type !== 'multiple_choice' && type !== 'text') {
        return { ok: false, error: `"${type}" is not a question type. Use "multiple_choice" or "text".` }
      }
      const options = Array.isArray(q?.options) ? q.options.map((o: any) => String(o).trim()).filter(Boolean).slice(0, 20) : []
      if (type === 'multiple_choice' && options.length < 2) {
        return { ok: false, error: `"${prompt}" is multiple choice, so it needs at least two options.` }
      }
      questions.push({ prompt, type, options })
    }

    const client = await getClient()
    let surveyId: string
    try {
      await client.query('BEGIN')
      const s = await client.query(
        `INSERT INTO surveys (landlord_id, property_id, created_by, title, description, anonymous, status)
         VALUES ($1,$2,$3,$4,$5,true,'draft') RETURNING id`,
        [actor.profileId, r.property.id, (actor as any).userId, title,
         args.description != null ? String(args.description).slice(0, 1000) : null])
      surveyId = s.rows[0].id
      for (let i = 0; i < questions.length; i++) {
        const q = questions[i]
        await client.query(
          `INSERT INTO survey_questions (survey_id, position, question_type, prompt, options, required)
           VALUES ($1,$2,$3,$4,$5,true)`,
          [surveyId, i, q.type, q.prompt, JSON.stringify(q.options)])
      }
      await client.query(`UPDATE surveys SET status='sent', sent_at=NOW(), closed_at=NULL WHERE id=$1`, [surveyId])
      await client.query('COMMIT')
    } catch (e) {
      try { await client.query('ROLLBACK') } catch { /* the throw below is what matters */ }
      throw e
    } finally { client.release() }

    // Same recipient rule the route uses: active tenants on active leases at
    // that property. Notifications are best-effort — the survey is already
    // committed and must not be lost because one email bounced.
    const recipients = await query<any>(
      `SELECT DISTINCT t.user_id, u.email
         FROM lease_tenants lt
         JOIN leases l ON l.id = lt.lease_id AND l.status='active'
         JOIN units un ON un.id = l.unit_id
         JOIN tenants t ON t.id = lt.tenant_id
         JOIN users u ON u.id = t.user_id
        WHERE un.property_id=$1 AND lt.status='active' AND t.user_id IS NOT NULL`,
      [r.property.id])
    let delivered = 0
    for (const rec of recipients) {
      try {
        await createNotification({
          userId: rec.user_id, landlordId: actor.profileId, type: 'survey_sent',
          title: 'New survey from your landlord',
          body: `Please share your input: "${title}"`,
          actionUrl: '/communication?tab=surveys',
          sendEmail: true, emailTo: rec.email, emailSubject: `Survey: ${title}`,
        })
        delivered++
      } catch { /* keep going; the survey exists either way */ }
    }

    return {
      ok: true, sent: true, surveyId, property: r.property.name,
      sentTo: delivered, tenantsAtProperty: recipients.length,
      note: delivered === 0
        ? 'The survey exists but nobody has an active lease at that property right now, so it reached no one. Say that plainly.'
        : `Sent to ${delivered} tenant(s). Remind them answers come back ANONYMOUSLY — they will see counts and unattributed comments, never who said what.`,
    }
  },
}

export const getSurveyResults: AgentTool = {
  name: 'get_survey_results',
  description:
    'What the landlord’s tenants answered. Multiple-choice questions come back as counts; written ' +
    'answers come back WITHOUT a name, because every survey is anonymous and that cannot be changed. ' +
    'Also reports how many were invited against how many replied. Use for “what did people say about ' +
    'the parking survey?”. If they ask who gave a particular answer, tell them plainly that surveys ' +
    'do not carry names — do not guess and do not imply you could find out. Read-only.',
  parameters: {
    type: 'object',
    properties: { surveyTitle: { type: 'string', description: 'Which survey, by title or part of it. Omit for the most recent.' } },
  },
  audiences: ['landlord'],

  async execute(args, actor: AgentActor) {
    const needle = String(args.surveyTitle ?? '').trim()
    const survey = await queryOne<any>(
      `SELECT s.id, s.title, s.property_id, s.sent_at, p.name AS property_name
         FROM surveys s JOIN properties p ON p.id = s.property_id
        WHERE s.landlord_id = $1 AND s.is_active = true
          AND ($2 = '' OR s.title ILIKE '%' || $2 || '%')
        ORDER BY s.sent_at DESC NULLS LAST LIMIT 1`,
      [actor.profileId, needle])
    if (!survey) return { ok: true, found: false, note: needle ? `No survey of theirs matches "${needle}".` : 'They have not sent any surveys.' }

    const questions = await query<any>(
      `SELECT id, position, question_type, prompt, options FROM survey_questions
        WHERE survey_id=$1 ORDER BY position, id`, [survey.id])
    const responded = (await queryOne<{ c: number }>(
      'SELECT COUNT(*)::int AS c FROM survey_responses WHERE survey_id=$1', [survey.id]))?.c ?? 0
    const invited = (await queryOne<{ c: number }>(
      `SELECT COUNT(DISTINCT lt.tenant_id)::int AS c
         FROM lease_tenants lt
         JOIN leases l ON l.id = lt.lease_id AND l.status='active'
         JOIN units un ON un.id = l.unit_id
        WHERE un.property_id=$1 AND lt.status='active'`, [survey.property_id]))?.c ?? 0

    const results = []
    for (const q of questions) {
      if (q.question_type === 'multiple_choice') {
        const counts = await query<any>(
          `SELECT answer_text AS option, COUNT(*)::int AS n FROM survey_answers
            WHERE question_id=$1 AND answer_text IS NOT NULL GROUP BY answer_text`, [q.id])
        const by = new Map(counts.map((c: any) => [c.option, c.n]))
        const opts: string[] = Array.isArray(q.options) ? q.options : []
        results.push({ prompt: q.prompt, type: q.question_type, tally: opts.map((o) => ({ option: o, count: by.get(o) ?? 0 })) })
      } else {
        // No join to users at all. The route NULLs the name for anonymous
        // surveys and every survey is anonymous, so there is nothing to null.
        const texts = await query<any>(
          `SELECT a.answer_text AS text FROM survey_answers a
             JOIN survey_responses r ON r.id = a.response_id
            WHERE a.question_id=$1 AND a.answer_text IS NOT NULL
            ORDER BY r.submitted_at DESC LIMIT 50`, [q.id])
        results.push({ prompt: q.prompt, type: q.question_type, answers: texts.map((t: any) => t.text) })
      }
    }

    return {
      ok: true, found: true,
      survey: { title: survey.title, property: survey.property_name, sentAt: survey.sent_at },
      invited, responded, results,
      note:
        'Answers are ANONYMOUS — there is no name behind any of these and there is no way to look one ' +
        'up. If they ask who said something, say so plainly rather than guessing.',
    }
  },
}
