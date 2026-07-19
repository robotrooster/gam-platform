/**
 * S542: platform-originated tenant questionnaires (Nic).
 *
 * The platform watches for fixed-income indicators and privately asks
 * the tenant a two-question fit check; a positive answer funnels into
 * flexpay_inquiries (the S541 demand-test review queue).
 *
 * HARD RULE: LANDLORD-INVISIBLE. No landlord route may select from or
 * join tenant_questionnaires — tenant + admin surfaces only. The
 * questionnaire copy lives in the tenant portal; this service owns
 * creation guards + answer funneling.
 *
 * Triggers (one-shot per tenant per trigger):
 *   late_fee_fixed_income — fired inline when the late-fee engine
 *     writes a fee row for a tenant.
 *   ssi_ssdi_signal — daily sweep over tenants already flagged
 *     ssi_ssdi (import/onboarding) who never engaged with FlexPay.
 */
import { query, queryOne } from '../db'
import { isFeatureEnabled } from './systemFeatures'
import { logger } from '../lib/logger'
import { benefitScheduleToDay, type BenefitSchedule } from '@gam/shared'
import type { QuestionnaireTrigger, QuestionnaireIncome } from '@gam/shared'

/**
 * Create a pending questionnaire for a tenant if — and only if — it
 * could lead somewhere: FlexPay rollout visible, tenant not already
 * enrolled, no existing FlexPay inquiry, and this trigger hasn't
 * already asked (UNIQUE guard makes the insert race-safe).
 * Never throws: callers are billing/cron paths that must not break
 * on a product-discovery failure.
 */
export async function maybeCreateQuestionnaire(
  tenantId: string,
  trigger: QuestionnaireTrigger,
): Promise<boolean> {
  try {
    if (!(await isFeatureEnabled('flexpay_rollout_visible'))) return false
    const res = await query(
      `INSERT INTO tenant_questionnaires (tenant_id, trigger_type)
       SELECT t.id, $2
         FROM tenants t
        WHERE t.id = $1
          AND t.flexpay_enrolled = FALSE
          AND NOT EXISTS (SELECT 1 FROM flexpay_inquiries fi WHERE fi.tenant_id = t.id)
       ON CONFLICT (tenant_id, trigger_type) DO NOTHING
       RETURNING id`,
      [tenantId, trigger],
    )
    return res.length > 0
  } catch (e) {
    logger.error({ err: e, tenantId, trigger }, '[questionnaire] create failed (non-fatal)')
    return false
  }
}

/**
 * Daily sweep: tenants already flagged ssi_ssdi with an active lease
 * who never engaged with FlexPay get the ssi_ssdi_signal ask. Single
 * INSERT..SELECT; the UNIQUE constraint keeps it idempotent.
 */
export async function sweepSsiSsdiQuestionnaires(): Promise<number> {
  if (!(await isFeatureEnabled('flexpay_rollout_visible'))) return 0
  const res = await query(
    `INSERT INTO tenant_questionnaires (tenant_id, trigger_type)
     SELECT t.id, 'ssi_ssdi_signal'
       FROM tenants t
      WHERE t.ssi_ssdi = TRUE
        AND t.flexpay_enrolled = FALSE
        AND NOT EXISTS (SELECT 1 FROM flexpay_inquiries fi WHERE fi.tenant_id = t.id)
        AND EXISTS (
          SELECT 1 FROM lease_tenants lt
            JOIN leases l ON l.id = lt.lease_id
           WHERE lt.tenant_id = t.id AND lt.status = 'active'
             AND l.status IN ('active', 'pending'))
     ON CONFLICT (tenant_id, trigger_type) DO NOTHING
     RETURNING id`,
    [],
  )
  if (res.length > 0) logger.info({ created: res.length }, '[questionnaire] ssi_ssdi_signal sweep')
  return res.length
}

export interface QuestionnaireAnswers {
  incomeSource: QuestionnaireIncome
  interested:   boolean
  // S542c: the day their benefit arrives — feeds the float-need queue
  // ordering when the answer funnels into a FlexPay inquiry.
  benefitDay?:  number
  // S545b: the pay PATTERN (SSI 1st / SSDI 3rd or Nth Wednesday /
  // fixed day) — preferred over a raw day when present.
  benefitSchedule?: BenefitSchedule
}

/**
 * Record the tenant's answers. A positive fit (SSI or SSDI income +
 * interested) auto-files a FlexPay inquiry into the S541 review queue,
 * carrying the questionnaire context as the tenant note. Guarded so a
 * pre-existing inquiry is never duplicated.
 */
export async function answerQuestionnaire(args: {
  tenantId: string
  questionnaireId: string
  answers: QuestionnaireAnswers
}): Promise<{ ok: true; inquiryFiled: boolean } | { ok: false; reason: string }> {
  const row = await queryOne<{ id: string; status: string; trigger_type: string }>(
    `SELECT id, status, trigger_type FROM tenant_questionnaires
      WHERE id = $1 AND tenant_id = $2`,
    [args.questionnaireId, args.tenantId],
  )
  if (!row) return { ok: false, reason: 'Questionnaire not found' }
  if (row.status !== 'pending') return { ok: false, reason: 'Already completed' }

  await query(
    `UPDATE tenant_questionnaires
        SET status = 'answered', answers = $2, answered_at = NOW()
      WHERE id = $1`,
    [row.id, JSON.stringify(args.answers)],
  )

  // S545 (Nic): EVERY interested answer files an inquiry — SSI/SSDI
  // go to tier 1; other income types file tier-2 rows that wait
  // behind them (approval income-held until expansion opens).
  const positiveFit = args.answers.interested === true
  let inquiryFiled = false
  if (positiveFit) {
    const derivedDay = args.answers.benefitSchedule
      ? benefitScheduleToDay(args.answers.benefitSchedule, args.answers.benefitDay ?? null)
      : args.answers.benefitDay ?? null
    const ins = await query(
      `INSERT INTO flexpay_inquiries (tenant_id, claimed_income_source, desired_pull_day, benefit_schedule, tenant_note)
       VALUES ($1, $2, $3, $4, $5)
       ON CONFLICT (tenant_id) DO NOTHING
       RETURNING id`,
      [args.tenantId, args.answers.incomeSource,
       derivedDay,
       args.answers.benefitSchedule ?? null,
       `Via ${row.trigger_type} questionnaire`],
    )
    inquiryFiled = ins.length > 0
    if (inquiryFiled) {
      // S545c: silent birthdate-consistency check (no tenant signal).
      const { runBirthdateCheck } = await import('./flexpayVerification')
      await runBirthdateCheck((ins[0] as any).id)
    }
    if (inquiryFiled) {
      try {
        const { createAdminNotification } = await import('./adminNotifications')
        await createAdminNotification({
          severity: 'info',
          category: 'flexpay_inquiry',
          title: 'New FlexPay interest (via questionnaire)',
          body: `Tenant ${args.tenantId} answered the ${row.trigger_type} questionnaire positively (${args.answers.incomeSource.toUpperCase()}). Review in Admin → FlexPay Requests.`,
          context: { tenant_id: args.tenantId, questionnaire_id: row.id },
        })
      } catch (e) {
        logger.error({ err: e }, '[questionnaire] admin notification failed (non-fatal)')
      }
    }
  }
  return { ok: true, inquiryFiled }
}

export async function dismissQuestionnaire(tenantId: string, questionnaireId: string): Promise<boolean> {
  const res = await query(
    `UPDATE tenant_questionnaires SET status = 'dismissed', answered_at = NOW()
      WHERE id = $1 AND tenant_id = $2 AND status = 'pending'
      RETURNING id`,
    [questionnaireId, tenantId],
  )
  return res.length > 0
}
