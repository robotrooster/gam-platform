import fs from 'fs'
import path from 'path'
import crypto from 'crypto'
import type { PoolClient } from 'pg'
import { query, queryOne, getClient } from '../db'
import { AppError } from '../middleware/errorHandler'
import { renderAcceptancePdf } from './flexsuitePdf'
import { emailFlexsuiteEnrollment } from './email'
import { logger } from '../lib/logger'

// S314: FlexSuite enrollment acceptance — render + persist the
// populated terms text the tenant click-accepted at FlexPay /
// FlexDeposit enrollment. The persisted snapshot is the load-bearing
// audit artifact for the SLA-not-loan / subscription structural
// defense. See migrations/20260518140000_flexsuite_enrollment_acceptances.sql.

export const FLEXPAY_TEMPLATE_VERSION     = '1.0.0'
export const FLEXDEPOSIT_TEMPLATE_VERSION = '1.0.0'

const LEGAL_DIR = path.resolve(__dirname, '..', '..', '..', '..', 'legal')
const FLEXPAY_TEMPLATE_PATH     = path.join(LEGAL_DIR, 'FLEXPAY_SUBSCRIPTION_TERMS.md')
const FLEXDEPOSIT_TEMPLATE_PATH = path.join(LEGAL_DIR, 'FLEXDEPOSIT_SLA_TEMPLATE.md')

type SubstitutionMap = Record<string, string>

function loadTemplate(p: string): string {
  return fs.readFileSync(p, 'utf8')
}

function substitute(template: string, vars: SubstitutionMap): string {
  let out = template
  for (const [k, v] of Object.entries(vars)) {
    out = out.split(`{{${k}}}`).join(v)
  }
  return out.replace(/\{\{[A-Za-z0-9_]+\}\}/g, '[Not Provided]')
}

function isoDate(d: Date = new Date()): string {
  return d.toISOString().slice(0, 10)
}

// ── FlexPay ─────────────────────────────────────────────────────

export interface FlexPayAcceptanceContext {
  tenantId:   string
  userId:     string
  pullDay:    number
  fee:        number
  ip:         string | null
  userAgent:  string | null
}

export async function renderFlexPayAcceptanceText(
  ctx: FlexPayAcceptanceContext,
): Promise<{ renderedText: string; populatedContent: Record<string, any> }> {
  const t = await queryOne<{
    first_name: string; last_name: string; email: string;
    bank_last4: string | null
  }>(
    `SELECT u.first_name, u.last_name, u.email, t.bank_last4
       FROM tenants t JOIN users u ON u.id = t.user_id
      WHERE t.id = $1`,
    [ctx.tenantId],
  )
  if (!t) throw new AppError(404, 'Tenant not found for acceptance render')

  const template = loadTemplate(FLEXPAY_TEMPLATE_PATH)
  const vars: SubstitutionMap = {
    Tenant_Full_Legal_Name: `${t.first_name} ${t.last_name}`.trim(),
    Tenant_Email:           t.email,
    Bank_Name:              'Your verified bank account on file',
    Account_Last_4:         t.bank_last4 ?? '[Not on file]',
    Scheduled_Pull_Day:     String(ctx.pullDay),
    Selected_Monthly_Fee:   `${ctx.fee}.00`,
    Signature_Date:         isoDate(),
    Support_Phone_Number:   process.env.SUPPORT_PHONE_NUMBER || '[See support contact in app]',
    Tenant_Signature:       '[Click-accepted electronically; see audit record]',
    Tenant_IP_Address:      ctx.ip || '[Not recorded]',
    Tenant_User_Agent:      ctx.userAgent || '[Not recorded]',
  }

  return {
    renderedText:     substitute(template, vars),
    populatedContent: { pullDay: ctx.pullDay, fee: ctx.fee, bankLast4: t.bank_last4 },
  }
}

// ── FlexDeposit ─────────────────────────────────────────────────

export interface FlexDepositInstallment {
  number:   number
  dueDate:  string  // YYYY-MM-DD
  amount:   number
}

export interface FlexDepositAcceptanceContext {
  tenantId:           string
  userId:             string
  depositId:          string
  installmentCount:   number
  installments:       FlexDepositInstallment[]
  gamAdvanceAmount:   number  // dollars
  totalInstallmentAmount: number  // dollars (sum of all installment amounts)
  moveInDate:         string  // YYYY-MM-DD
  ip:                 string | null
  userAgent:          string | null
}

// Strip the static installment-table rows beyond installmentCount so
// the rendered SLA only shows rows for the actual schedule.
function trimFlexDepositTemplate(template: string, installmentCount: number): string {
  const lines = template.split('\n')
  const kept: string[] = []
  for (const line of lines) {
    const m = line.match(/^\|\s*(\d+)\s*\|\s*\{\{Installment_(\d+)_Date\}\}/)
    if (m && parseInt(m[2], 10) > installmentCount) continue
    kept.push(line)
  }
  return kept.join('\n')
}

export async function renderFlexDepositAcceptanceText(
  ctx: FlexDepositAcceptanceContext,
): Promise<{ renderedText: string; populatedContent: Record<string, any> }> {
  const t = await queryOne<{
    first_name: string; last_name: string; email: string;
    bank_last4: string | null;
    property_name: string | null; property_address: string | null; unit_number: string | null;
    landlord_name: string | null;
  }>(
    `SELECT u.first_name, u.last_name, u.email, t.bank_last4,
            p.name AS property_name,
            (p.street1
              || COALESCE(', ' || NULLIF(p.street2,''), '')
              || ', ' || p.city
              || ', ' || p.state
              || ' '  || p.zip) AS property_address,
            un.unit_number,
            (lu.first_name || ' ' || lu.last_name) AS landlord_name
       FROM tenants t
       JOIN users u                ON u.id  = t.user_id
       LEFT JOIN security_deposits sd ON sd.id = $2
       LEFT JOIN leases l          ON l.id  = sd.lease_id
       LEFT JOIN units un          ON un.id = l.unit_id
       LEFT JOIN properties p      ON p.id  = un.property_id
       LEFT JOIN landlords ld      ON ld.id = p.landlord_id
       LEFT JOIN users lu          ON lu.id = ld.user_id
      WHERE t.id = $1`,
    [ctx.tenantId, ctx.depositId],
  )
  if (!t) throw new AppError(404, 'Tenant not found for acceptance render')

  const trimmed = trimFlexDepositTemplate(loadTemplate(FLEXDEPOSIT_TEMPLATE_PATH), ctx.installmentCount)

  const vars: SubstitutionMap = {
    Tenant_Full_Legal_Name:   `${t.first_name} ${t.last_name}`.trim(),
    Tenant_Email:             t.email,
    Bank_Name:                'Your verified bank account on file',
    Account_Last_4:           t.bank_last4 ?? '[Not on file]',
    Routing_Last_4:           '[Not on file]',
    Property_Address:         t.property_address || '[Not Provided]',
    Unit_Number:              t.unit_number      || '[Not Provided]',
    Landlord_Display_Name:    t.landlord_name    || '[Not Provided]',
    Move_In_Date:             ctx.moveInDate,
    Total_Installments:       String(ctx.installmentCount),
    Total_Installment_Amount: ctx.totalInstallmentAmount.toFixed(2),
    Advance_Amount:           ctx.gamAdvanceAmount.toFixed(2),
    Signature_Date:           isoDate(),
    Tenant_Signature:         '[Click-accepted electronically; see audit record]',
    Tenant_IP_Address:        ctx.ip || '[Not recorded]',
    Tenant_User_Agent:        ctx.userAgent || '[Not recorded]',
  }

  for (const inst of ctx.installments) {
    vars[`Installment_${inst.number}_Date`]   = inst.dueDate
    vars[`Installment_${inst.number}_Amount`] = inst.amount.toFixed(2)
  }

  return {
    renderedText: substitute(trimmed, vars),
    populatedContent: {
      depositId:              ctx.depositId,
      installmentCount:       ctx.installmentCount,
      installments:           ctx.installments,
      gamAdvanceAmount:       ctx.gamAdvanceAmount,
      totalInstallmentAmount: ctx.totalInstallmentAmount,
      moveInDate:             ctx.moveInDate,
      bankLast4:              t.bank_last4,
    },
  }
}

// ── Persist ─────────────────────────────────────────────────────

export async function recordAcceptance(args: {
  client:           PoolClient
  tenantId:         string
  userId:           string
  productType:      'flexpay' | 'flexdeposit'
  templateVersion:  string
  populatedContent: Record<string, any>
  renderedText:     string
  ip:               string | null
  userAgent:        string | null
}): Promise<string> {
  const hash = crypto.createHash('sha256').update(args.renderedText, 'utf8').digest('hex')
  const r = await args.client.query<{ id: string }>(
    `INSERT INTO flexsuite_enrollment_acceptances
       (tenant_id, user_id, product_type, template_version,
        populated_content, rendered_text, content_hash,
        accepted_ip, accepted_user_agent)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
     RETURNING id`,
    [
      args.tenantId, args.userId, args.productType, args.templateVersion,
      JSON.stringify(args.populatedContent), args.renderedText, hash,
      args.ip, args.userAgent,
    ],
  )
  return r.rows[0].id
}

// S322: post-enrollment best-effort PDF-attached confirmation email.
// Fetches the tenant's user + email + name, renders the rendered_text
// to a PDF buffer, calls emailFlexsuiteEnrollment. Throws only on
// catastrophic logic errors; the caller wraps in .catch() so an email
// failure never affects the user-visible enrollment commit.
export async function fireFlexsuiteAcceptanceEmail(args: {
  tenantId:         string
  product:          'flexpay' | 'flexdeposit'
  acceptanceId:     string
  templateVersion:  string
  renderedText:     string
}): Promise<void> {
  const tenant = await queryOne<{
    email: string; first_name: string; last_name: string
  }>(
    `SELECT u.email, u.first_name, u.last_name
       FROM tenants t JOIN users u ON u.id = t.user_id
      WHERE t.id = $1`,
    [args.tenantId],
  )
  if (!tenant?.email) {
    logger.warn({ ctx: args.tenantId, acceptance: args.acceptanceId },
      '[flexsuite-email] tenant has no email — skipping confirmation send')
    return
  }
  const acceptance = await queryOne<{ content_hash: string; accepted_at: string }>(
    `SELECT content_hash, accepted_at::text AS accepted_at
       FROM flexsuite_enrollment_acceptances WHERE id = $1`,
    [args.acceptanceId],
  )
  if (!acceptance) {
    logger.warn({ ctx: args.acceptanceId }, '[flexsuite-email] acceptance row missing — skipping')
    return
  }
  const tenantName = `${tenant.first_name ?? ''} ${tenant.last_name ?? ''}`.trim() || tenant.email
  const acceptedAt = new Date(acceptance.accepted_at)
  const pdfBuffer = await renderAcceptancePdf({
    product:         args.product,
    tenantName,
    tenantEmail:     tenant.email,
    templateVersion: args.templateVersion,
    acceptedAt,
    contentHash:     acceptance.content_hash,
    renderedText:    args.renderedText,
    acceptanceId:    args.acceptanceId,
  })
  await emailFlexsuiteEnrollment({
    to:              tenant.email,
    tenantName,
    product:         args.product,
    acceptedAt,
    templateVersion: args.templateVersion,
    acceptanceId:    args.acceptanceId,
    pdfBuffer,
  })
}

// ── Re-acceptance (S323) ────────────────────────────────────────
//
// When FLEXPAY_TEMPLATE_VERSION or FLEXDEPOSIT_TEMPLATE_VERSION bumps,
// tenants whose latest acceptance is on an older version are prompted
// at next tenant-portal load to accept the new populated terms. The
// new acceptance row carries the current template version forward;
// the prior row stays in place as historical evidence that the OLD
// terms were valid at the time of original enrollment. Re-acceptance
// is informational, not blocking — the OLD acceptance still covers
// the OLD enrollment if a tenant declines.

export interface PendingReAcceptance {
  product:          'flexpay' | 'flexdeposit'
  currentVersion:   string  // version on latest acceptance row (null if none)
  latestVersion:    string  // CURRENT template version
  // Context the modal needs to render a friendly summary:
  flexpayPullDay?:        number
  flexpayMonthlyFee?:     number
  flexdepositInstallmentCount?: number
}

/**
 * Returns the list of products this tenant is enrolled in but for which
 * the latest acceptance row is missing or on an outdated template
 * version. Empty array = nothing to prompt.
 */
export async function getPendingReAcceptances(
  tenantId: string,
): Promise<PendingReAcceptance[]> {
  const out: PendingReAcceptance[] = []

  // FlexPay: enrolled flag + latest acceptance row check
  const fp = await queryOne<{
    enrolled: boolean; pull_day: number | null; monthly_fee: string | null;
    latest_version: string | null
  }>(
    `SELECT t.flexpay_enrolled AS enrolled,
            t.flexpay_pull_day AS pull_day,
            t.flexpay_monthly_fee::text AS monthly_fee,
            (SELECT a.template_version
               FROM flexsuite_enrollment_acceptances a
              WHERE a.tenant_id = t.id AND a.product_type = 'flexpay'
              ORDER BY a.accepted_at DESC
              LIMIT 1) AS latest_version
       FROM tenants t WHERE t.id = $1`,
    [tenantId],
  )
  if (fp?.enrolled && fp.latest_version !== FLEXPAY_TEMPLATE_VERSION) {
    out.push({
      product:           'flexpay',
      currentVersion:    fp.latest_version ?? '(none)',
      latestVersion:     FLEXPAY_TEMPLATE_VERSION,
      flexpayPullDay:    fp.pull_day ?? undefined,
      flexpayMonthlyFee: fp.monthly_fee != null ? Number(fp.monthly_fee) : undefined,
    })
  }

  // FlexDeposit: any active/accelerated plan + latest acceptance row check
  const fd = await queryOne<{
    enrolled: boolean; installment_count: number | null;
    latest_version: string | null
  }>(
    `SELECT EXISTS (
              SELECT 1 FROM security_deposits sd
               WHERE sd.tenant_id = $1
                 AND sd.flex_deposit_enabled = TRUE
                 AND sd.flex_deposit_plan_status IN ('active','accelerated')
            ) AS enrolled,
            (SELECT installment_count FROM security_deposits
              WHERE tenant_id = $1 AND flex_deposit_enabled = TRUE
              ORDER BY created_at DESC LIMIT 1) AS installment_count,
            (SELECT a.template_version
               FROM flexsuite_enrollment_acceptances a
              WHERE a.tenant_id = $1 AND a.product_type = 'flexdeposit'
              ORDER BY a.accepted_at DESC
              LIMIT 1) AS latest_version`,
    [tenantId],
  )
  if (fd?.enrolled && fd.latest_version !== FLEXDEPOSIT_TEMPLATE_VERSION) {
    out.push({
      product:                     'flexdeposit',
      currentVersion:              fd.latest_version ?? '(none)',
      latestVersion:               FLEXDEPOSIT_TEMPLATE_VERSION,
      flexdepositInstallmentCount: fd.installment_count ?? undefined,
    })
  }

  return out
}

/**
 * Render the populated terms at the CURRENT template version for a
 * tenant who's already enrolled. Used by the re-acceptance preview
 * endpoint + the re-acceptance commit. Pulls the tenant's existing
 * enrollment context (pullDay / installmentCount / etc.) — no body
 * params needed from the caller; the values are whatever the tenant
 * is currently enrolled at.
 */
export async function renderReAcceptanceTerms(args: {
  tenantId:  string
  userId:    string
  product:   'flexpay' | 'flexdeposit'
  ip:        string | null
  userAgent: string | null
}): Promise<{ renderedText: string; populatedContent: Record<string, any> }> {
  if (args.product === 'flexpay') {
    const t = await queryOne<{ pull_day: number | null; monthly_fee: string | null }>(
      `SELECT flexpay_pull_day AS pull_day, flexpay_monthly_fee::text AS monthly_fee
         FROM tenants WHERE id = $1`,
      [args.tenantId],
    )
    if (!t?.pull_day || t.monthly_fee == null) {
      throw new AppError(409, 'Not enrolled in FlexPay — re-acceptance unavailable')
    }
    return renderFlexPayAcceptanceText({
      tenantId:  args.tenantId,
      userId:    args.userId,
      pullDay:   t.pull_day,
      fee:       Number(t.monthly_fee),
      ip:        args.ip,
      userAgent: args.userAgent,
    })
  }
  // flexdeposit
  const dep = await queryOne<{
    id: string; total_amount: string; installment_count: number;
    lease_id: string; start_date: string; rent_due_day: number;
    gam_advance_amount: string; installment_amount: string
  }>(
    `SELECT sd.id, sd.total_amount::text, sd.installment_count,
            sd.lease_id, sd.gam_advance_amount::text,
            sd.installment_amount::text,
            l.start_date::text, l.rent_due_day
       FROM security_deposits sd
       JOIN leases l ON l.id = sd.lease_id
      WHERE sd.tenant_id = $1
        AND sd.flex_deposit_enabled = TRUE
        AND sd.flex_deposit_plan_status IN ('active','accelerated')
      ORDER BY sd.created_at DESC LIMIT 1`,
    [args.tenantId],
  )
  if (!dep) throw new AppError(409, 'Not enrolled in FlexDeposit — re-acceptance unavailable')

  // Re-compute installment dates from the installments table (or
  // recompute from start_date). Reading the actual rows is cheaper +
  // more honest than recomputing — the persisted schedule is the
  // source of truth post-enrollment.
  const installmentRows = await query<{
    installment_number: number; due_date: string; amount: string
  }>(
    `SELECT installment_number, due_date::text AS due_date, amount::text
       FROM flex_deposit_installments
      WHERE security_deposit_id = $1
      ORDER BY installment_number ASC`,
    [dep.id],
  )
  const installments: FlexDepositInstallment[] = installmentRows.map(r => ({
    number:  r.installment_number,
    dueDate: r.due_date,
    amount:  Number(r.amount),
  }))
  const totalInstallmentAmount = installments.reduce((s, x) => s + x.amount, 0)

  return renderFlexDepositAcceptanceText({
    tenantId:               args.tenantId,
    userId:                 args.userId,
    depositId:              dep.id,
    installmentCount:       dep.installment_count,
    installments,
    gamAdvanceAmount:       Number(dep.gam_advance_amount),
    totalInstallmentAmount,
    moveInDate:             dep.start_date.slice(0, 10),
    ip:                     args.ip,
    userAgent:              args.userAgent,
  })
}

/**
 * Commit a re-acceptance. Inserts a new flexsuite_enrollment_acceptances
 * row at the current template version. The prior row stays in place as
 * historical evidence. Returns the new acceptance ID.
 */
export async function commitReAcceptance(args: {
  tenantId:  string
  userId:    string
  product:   'flexpay' | 'flexdeposit'
  ip:        string | null
  userAgent: string | null
}): Promise<string> {
  const { renderedText, populatedContent } = await renderReAcceptanceTerms(args)
  const version = args.product === 'flexpay' ? FLEXPAY_TEMPLATE_VERSION : FLEXDEPOSIT_TEMPLATE_VERSION

  const client = await getClient()
  try {
    await client.query('BEGIN')
    const acceptanceId = await recordAcceptance({
      client,
      tenantId:         args.tenantId,
      userId:           args.userId,
      productType:      args.product,
      templateVersion:  version,
      populatedContent,
      renderedText,
      ip:               args.ip,
      userAgent:        args.userAgent,
    })
    await client.query('COMMIT')

    // Best-effort confirmation email — same shape as the original
    // enrollment-confirmation send. Reuses the renderedText we just
    // rendered (avoids a second template-load round-trip).
    fireFlexsuiteAcceptanceEmail({
      tenantId:        args.tenantId,
      product:         args.product,
      acceptanceId,
      templateVersion: version,
      renderedText,
    }).catch(err => logger.error({ err, ctx: acceptanceId }, '[flexsuite-re-accept] email failed'))

    return acceptanceId
  } catch (e) {
    await client.query('ROLLBACK').catch(() => {})
    throw e
  } finally {
    client.release()
  }
}
