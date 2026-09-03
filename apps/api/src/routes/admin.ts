import os from 'os'
import path from 'path'
import fs from 'fs'
import { Router, type Request } from 'express'
import { z } from 'zod'
import { query, queryOne } from '../db'
import { requireAuth, requireAdmin, requireSuperAdmin, requireOwner, OWNER_EMAIL, isPlatformOwner } from '../middleware/auth'
import { latencyP95, sampleSize, MIN_SAMPLES } from '../lib/apiMetrics'
import { SUPPORT_TEMPLATES } from '../services/supportTemplates'
import { AppError } from '../middleware/errorHandler'
import { logAdminAction } from '../lib/adminAudit'
import { randomUUID } from 'crypto'
import bcrypt from 'bcryptjs'
import { getClient } from '../db'
import { emailAdminInvitation } from '../services/email'
import { backfillInvoices } from '../jobs/invoiceGeneration'
import { PASSWORD_MIN_LEN, PropertyReviewStatus, PLATFORM_FEES, LAUNCH_PLATFORM_FEE, launchPlatformFeeForProperty, SALES_LEAD_STATUSES, SALES_BOOKING_KIND_VALUES } from '@gam/shared'
import { fetchAccountStatus } from '../services/stripeConnect'
import { unproductiveTurnSql } from '../services/agents/turnBudget'
import { emailTenantOnboarded, emailLandlordBankingSetup, emailTenantAchSetup } from '../services/email'
import { getNexusDashboard, recomputeNexusTally, setStateRegistration } from '../services/nexusMonitor'

export const adminRouter = Router()
adminRouter.use(requireAuth)
adminRouter.use((req: any, res: any, next: any) => {
  if (!req.user) return res.status(401).json({ success: false, error: 'Unauthenticated' })
  if (req.user.role !== 'admin' && req.user.role !== 'super_admin') {
    return res.status(403).json({ success: false, error: 'Insufficient permissions' })
  }
  next()
})

// S570 (Nic): platform financials — income projection, reserve/float balances,
// ARR — are super-admin only. The regular admin role (portfolio manager) must
// never see platform projections. The detailed /income/* pies were already
// requireSuperAdmin; /overview was the one hole.
adminRouter.get('/overview', requireSuperAdmin, async (_req, res, next) => {
  try {
    const [platform] = await query<any>(`
      SELECT
        (SELECT COUNT(*)::int FROM landlords) AS total_landlords,
        (SELECT COUNT(*)::int FROM users WHERE role='tenant')   AS total_tenants,
        (SELECT COUNT(*)::int FROM units WHERE status='active') AS active_units,
        (SELECT COUNT(*)::int FROM units WHERE status='vacant') AS vacant_units,
        (SELECT COUNT(*)::int FROM units WHERE payment_block=TRUE) AS eviction_mode_units,
        (SELECT COALESCE(SUM(rent_amount),0) FROM units WHERE status='active') AS monthly_rent_volume,
        (SELECT COALESCE(balance,0) FROM reserve_fund_state LIMIT 1) AS reserve_balance,
        (SELECT COALESCE(balance,0) FROM float_account_state LIMIT 1) AS float_balance,
        -- FlexPay float BANKROLL NEEDED: total monthly rent of the distinct
        -- tenants who inquired about FlexPay AND were INCOME-VERIFIED (inquiry
        -- status='approved' → the admin confirmed qualifying benefit income and
        -- set tenants.ssi_ssdi). Only verified tenants can actually enroll, so
        -- only they represent real float GAM would front. This is the money the
        -- platform is exposed to — the default reserve (3%) sizes off it, not
        -- off total platform rent. (Forward-looking; FlexPay is demand-test gated.)
        (
          SELECT COALESCE(SUM(u.rent_amount), 0)
            FROM (SELECT DISTINCT tenant_id FROM flexpay_inquiries WHERE status = 'approved') fi
            JOIN v_unit_occupancy vuo ON vuo.primary_tenant_id = fi.tenant_id
            JOIN units u ON u.id = vuo.unit_id AND u.status = 'active'
        ) AS flexpay_bankroll,
        (SELECT COUNT(*)::int FROM payments WHERE status='pending') AS pending_payments,
        (SELECT COUNT(*)::int FROM disbursements WHERE status='pending') AS pending_disbursements,
        (SELECT COUNT(*)::int FROM maintenance_requests WHERE status='open') AS open_maintenance,
        (SELECT COUNT(*)::int FROM tenants WHERE on_time_pay_enrolled=TRUE) AS flex_otp,
        (SELECT COUNT(*)::int FROM tenants WHERE credit_reporting_enrolled=TRUE) AS flex_credit,
        (SELECT COUNT(*)::int FROM tenants WHERE flex_deposit_enrolled=TRUE) AS flex_deposit,
        (SELECT COUNT(*)::int FROM tenants WHERE float_fee_active=TRUE) AS flex_pay,
        (SELECT COUNT(*)::int FROM ach_monitoring_log WHERE flagged=TRUE AND resolved=FALSE) AS zero_tolerance_events,
        -- S316: pending CSV imports awaiting review where the
        -- platform/import-type slot is unverified. Matches the
        -- email-notification gate so the tile count equals the
        -- super_admin's actionable backlog.
        (
          SELECT COUNT(*)::int
            FROM csv_import_attempts a
            LEFT JOIN platform_review_status p
              ON p.platform_key = a.platform_key
             AND p.import_type  = a.import_type
           WHERE a.status IN ('validated', 'committed')
             AND COALESCE(p.mapping_status, 'unverified') = 'unverified'
        ) AS csv_imports_pending_review
    `)
    res.json({ success: true, data: platform })
  } catch (e) { next(e) }
})

// GET /api/admin/deposit-trust/summary — S602. What SHOULD be sitting in the
// segregated deposit trust account right now: every tenant deposit GAM is
// holding in escrow (held_by='gam_escrow', collected, not yet disbursed). The
// principal is the cash GAM must have in trust; interest_accrued is the extra
// GAM owes the tenants on top (funded by the trust's own investment return).
// Powers the admin Overview trust tile + by-state pie so we can reconcile the
// on-book liability against the actual account balance once it's stood up.
/**
 * GET /api/admin/rent-volume-trend?months=6 — platform rent ACTUALLY COLLECTED,
 * month by month.
 *
 * S609 — REPLACES FABRICATED DATA. The admin dashboard's "Monthly Rent Volume
 * Trend" was a hardcoded array:
 *
 *     [{m:'Oct',r:1800},{m:'Nov',r:2100},{m:'Dec',r:2400},
 *      {m:'Jan',r:2700},{m:'Feb',r:3000},{m:'Mar',r:<the one real number>}]
 *
 * Five invented points and one real one, mislabelled with a month it wasn't.
 * It drew a tidy upward line no matter what the platform actually did — the
 * worst kind of wrong on a financial dashboard, because it looks like
 * information. Nic spotted it as "the graph stops in March".
 *
 * WHAT THIS COUNTS (S616 — the name and the query disagreed): every TENANT
 * payment that settled — rent, utilities, late fees and one-off charges — by
 * the month it settled in. Money that actually moved, not contracted rent.
 *
 * The card said "Rent Collected" while the query has always summed four types.
 * They coincided only because rent was the sole kind of row that existed. The
 * moment Oak Park bills a trash can or a parking violation, a card labelled
 * "rent" would quietly start including them. Renamed rather than narrowed: for
 * a platform-health heartbeat, what matters is money crossing the rails, and
 * narrowing it to rent would have hidden the utility billing this session
 * exists to enable. Deposits stay out — they are held, not earned. That is what makes a spike mean
 * something: a month where a block of tenants onboarded and paid shows up as a
 * spike, which is exactly the signal Nic wants to see.
 *
 * `paid_via_deposit` counts too — the obligation was met and the money was
 * real, it just came from a deposit already held.
 *
 * EVERY month in the window is returned, including empty ones. A month with no
 * collections is a ZERO, never a missing row: the heartbeat has to flatline
 * rather than silently close the gap and imply continuous activity.
 */
adminRouter.get('/rent-volume-trend', requireSuperAdmin, async (req, res, next) => {
  try {
    // 1..36 — a year is the usual read; 36 supports the long "whole history"
    // view without letting a query walk the entire table.
    const months = Math.min(36, Math.max(1, Number(req.query.months) || 6))
    const rows = await query<{
      month_start: string; label: string; revenue: string
      gross: string; fees: string; in_flight: string
    }>(
      `WITH span AS (
         SELECT generate_series(
           date_trunc('month', CURRENT_DATE) - make_interval(months => $1::int - 1),
           date_trunc('month', CURRENT_DATE),
           interval '1 month'
         ) AS month_start
       )
       SELECT span.month_start::date::text AS month_start,
              TO_CHAR(span.month_start, 'Mon') AS label,
              COALESCE(SUM(p.amount), 0)::text AS revenue,
              -- S616: what actually moved through Stripe, so the card ties out
              -- to the Stripe dashboard rather than approximating it. Sourced
              -- from tenant_remittances (one row per charge) and joined by
              -- month independently of the payments sum — a remittance and the
              -- rows it settles can fall either side of a month boundary, and
              -- forcing them together would make both figures wrong.
              COALESCE((
                SELECT SUM(r.gross_amount) FROM tenant_remittances r
                 WHERE date_trunc('month', COALESCE(r.settled_at, r.created_at)) = span.month_start
                   AND r.status IN ('settled','processing')
                   AND r.gross_amount IS NOT NULL), 0)::text AS gross,
              COALESCE((
                SELECT SUM(r.processing_fee_amount) FROM tenant_remittances r
                 WHERE date_trunc('month', COALESCE(r.settled_at, r.created_at)) = span.month_start
                   AND r.status IN ('settled','processing')), 0)::text AS fees,
              -- S616: of the total above, how much has not cleared yet. Named
              -- rather than netted — a landlord waiting on money is a different
              -- fact from money that has arrived, and both belong on the page.
              COALESCE(SUM(p.amount) FILTER (WHERE p.status = 'processing'), 0)::text AS in_flight
         FROM span
         LEFT JOIN payments p
           ON date_trunc('month', COALESCE(p.settled_at, p.created_at)) = span.month_start
          -- S616 (Nic): "August revenue should be four dollars. I made two
          -- different two dollar payments." He is right and excluding
          -- 'processing' was wrong.
          --
          -- ACH is the primary rail for rent, and Stripe holds an ACH debit
          -- in 'processing' for about four business days AFTER the tenant's bank
          -- has already been debited — his own money left his account the day
          -- after he paid. Counting only settled money means that during the
          -- first week of every month, which is precisely when rent arrives,
          -- this chart reads near zero. A health monitor that flatlines every
          -- time the platform is busiest is not measuring health.
          --
          -- So it counts money the TENANT HAS SENT. What is still in flight is
          -- reported separately below rather than hidden inside the total.
          AND p.status IN ('settled', 'paid_via_deposit', 'processing')
          AND p.type IN ('rent', 'utility', 'late_fee', 'fee')
          -- S616: DEMO LANDLORDS STAY IN, deliberately. I excluded them when
          -- tracing a $2 figure Nic could not place — it was his own live
          -- Stripe test, and the landlord behind it is flagged is_demo, so
          -- excluding it made the month read $0 and hid real money he had
          -- actually spent. Nic: "chart only needed to include demo accounts
          -- for testing. when we launch we can split all demo data out to a
          -- clone server for showing on sales calls but completely its own
          -- thing to prevent data bleed."
          --
          -- That is the right separation and it is not a WHERE clause: demo
          -- data leaves the production database entirely rather than being
          -- filtered out of one query and not the next. Until then this counts
          -- everything, which is what makes it useful for testing.
        GROUP BY span.month_start
        ORDER BY span.month_start ASC`,
      [months])
    res.json({ success: true, data: rows.map(r => ({
      monthStart: r.month_start,
      // 'Mon' alone repeats across years; the caller decides how much to show.
      label: r.label,
      revenue: Number(r.revenue),
      // S616: gross is what Stripe charged; revenue is the obligation it
      // settled; fees is the difference the tenant bore. Reported separately
      // rather than netted so a discrepancy is visible instead of absorbed.
      gross: Number(r.gross),
      fees: Number(r.fees),
      inFlight: Number(r.in_flight),
    })) })
  } catch (e) { next(e) }
})

adminRouter.get('/deposit-trust/summary', requireSuperAdmin, async (_req, res, next) => {
  try {
    const HELD = `sd.held_by = 'gam_escrow'
        AND sd.status IN ('funded','partial','claimed')
        AND sd.disbursed_at IS NULL
        AND sd.collected_amount > 0`
    const [totals] = await query<any>(`
      SELECT
        COUNT(*)::int AS held_count,
        COALESCE(SUM(sd.collected_amount), 0)                              AS total_principal,
        COALESCE(SUM(COALESCE(sd.interest_accrued, 0)), 0)                 AS total_interest,
        COALESCE(SUM(sd.collected_amount + COALESCE(sd.interest_accrued,0)), 0) AS total_liability
      FROM security_deposits sd
      WHERE ${HELD}
    `)
    const byState = await query<any>(`
      SELECT COALESCE(NULLIF(p.state,''),'—') AS state,
             COUNT(*)::int AS count,
             COALESCE(SUM(sd.collected_amount),0)                AS principal,
             COALESCE(SUM(COALESCE(sd.interest_accrued,0)),0)    AS interest
        FROM security_deposits sd
        JOIN leases l     ON l.id = sd.lease_id
        JOIN units u      ON u.id = l.unit_id
        JOIN properties p ON p.id = u.property_id
       WHERE ${HELD}
       GROUP BY COALESCE(NULLIF(p.state,''),'—')
       ORDER BY principal DESC
    `)
    res.json({ success: true, data: {
      heldCount:            totals.held_count,
      totalPrincipal:       Number(totals.total_principal),
      totalInterestAccrued: Number(totals.total_interest),
      totalLiability:       Number(totals.total_liability),
      byState: byState.map((r: any) => ({
        state: r.state, count: r.count,
        principal: Number(r.principal), interest: Number(r.interest),
      })),
    } })
  } catch (e) { next(e) }
})

// GET /api/admin/platform-health — S605 (Nic).
//
// "I'd like to not have to go on those dashboards to know if there's a problem."
// One read-only roll-up of every vendor we depend on (Cloudflare tunnel, Stripe,
// Resend, Vercel) plus our own stack (database, nightly backup, 24h email
// deliverability). Detects and reports; fixing still happens in the vendor's
// console, whose URL each row carries.
//
// SUPER-ADMIN only: this is infrastructure posture, not landlord-facing data.
adminRouter.get('/platform-health', requireSuperAdmin, async (req, res, next) => {
  try {
    const { getPlatformHealth } = await import('../services/platformHealth')
    // ?force=1 skips the 60s cache for a deliberate re-check from the UI.
    res.json({ success: true, data: await getPlatformHealth({ force: req.query.force === '1' }) })
  } catch (e) { next(e) }
})

// GET /api/admin/outreach-status — S605. Did our post-signup outreach actually
// land, and did anyone act on it?
//
// Nic's question was "can we tell if Charlie ever opened the email". Opens are
// not on this list on purpose (pixel + Apple Mail pre-fetch = a number that
// lies in both directions). What IS here is trustworthy: whether the recipient
// server accepted it, whether it bounced, and whether they clicked the booking
// link — which is first-party and proves intent.
// ── SEND EMAIL (S637) ────────────────────────────────────────
// Nic: "let's add a way in the administrative portal for an admin to send
// email to onboarded landlords, tenants, etcetera, all coming from support at
// gold asset management dot com."
//
// Every other sender in services/email.ts fires off an event, so there was no
// way to write one person a note — which is why a human had to ask an
// assistant to do it. These three endpoints are that gap: find a person,
// start from a draft or from nothing, send it from support@.
//
// Deliberately NOT a bulk tool. One recipient per send, and the body that goes
// out is the body the admin read — templates only prefill the box.

// GET /api/admin/email/templates — the preloaded drafts.
adminRouter.get('/email/templates', requireAdmin, async (_req, res) => {
  res.json({ success: true, data: SUPPORT_TEMPLATES.map(t => ({
    id: t.id, label: t.label, when: t.when, audience: t.audience,
    subject: t.subject, paragraphs: t.paragraphs,
  })) })
})

// GET /api/admin/email/recipients?q= — landlords and tenants by name or email.
// Capped and search-only: this is a way to reach ONE person you already have
// in mind, not a way to export an address book.
adminRouter.get('/email/recipients', requireAdmin, async (req, res, next) => {
  try {
    const q = String(req.query.q ?? '').trim()
    if (q.length < 2) return res.json({ success: true, data: [] })
    const like = `%${q}%`
    const rows = await query<any>(`
      SELECT 'landlord' AS kind, u.id AS user_id, u.email,
             u.first_name, u.last_name, l.id AS landlord_id,
             (SELECT COUNT(*) FROM properties p WHERE p.landlord_id = l.id)::int AS property_count
        FROM landlords l JOIN users u ON u.id = l.user_id
       WHERE l.is_system IS NOT TRUE
         AND (u.email ILIKE $1 OR (u.first_name || ' ' || u.last_name) ILIKE $1)
      UNION ALL
      SELECT 'tenant' AS kind, u.id AS user_id, u.email,
             u.first_name, u.last_name, NULL::uuid AS landlord_id,
             NULL::int AS property_count
        FROM tenants t JOIN users u ON u.id = t.user_id
       WHERE (u.email ILIKE $1 OR (u.first_name || ' ' || u.last_name) ILIKE $1)
       ORDER BY 4, 5
       LIMIT 25`, [like])
    res.json({ success: true, data: rows })
  } catch (e) { next(e) }
})

// POST /api/admin/email/send — one note, from support@, logged like any other.
adminRouter.post('/email/send', requireAdmin, async (req, res, next) => {
  try {
    const b = z.object({
      to:         z.string().email().max(200),
      subject:    z.string().trim().min(1).max(200),
      paragraphs: z.array(z.string().max(5000)).min(1).max(40),
      templateId: z.string().max(64).optional(),
    }).parse(req.body)
    if (!b.paragraphs.some(p => p.trim().length > 0)) {
      throw new AppError(400, 'The message is empty')
    }

    // The address must belong to a real person on the platform. Without this
    // an admin account becomes a way to send mail from goldassetmanagement.com
    // to anybody at all, which is a domain-reputation problem before it is
    // anything else.
    const person = await queryOne<{ user_id: string; landlord_id: string | null }>(`
      SELECT u.id AS user_id,
             (SELECT l.id FROM landlords l WHERE l.user_id = u.id LIMIT 1) AS landlord_id
        FROM users u WHERE LOWER(u.email) = LOWER($1) LIMIT 1`, [b.to])
    if (!person) throw new AppError(404, 'No GAM account uses that email address')

    const { emailSupportMessage } = await import('../services/email')
    // Signed by whoever actually pressed send — the recipient replies to a
    // named person, not to a shared mailbox with no author.
    const me = await queryOne<{ first_name: string | null; last_name: string | null }>(
      `SELECT first_name, last_name FROM users WHERE id = $1`, [req.user!.userId])
    const sender = [me?.first_name, me?.last_name].filter(Boolean).join(' ').trim()
    const providerId = await emailSupportMessage({
      to: b.to,
      subject: b.subject,
      paragraphs: b.paragraphs,
      signature: sender || undefined,
      ctx: { landlordId: person.landlord_id, userId: person.user_id },
    })

    await query(
      `INSERT INTO audit_log (user_id, action, entity_type, entity_id, new_value)
       VALUES ($1, 'admin_email_sent', 'user', $2, $3)`,
      [req.user!.userId, person.user_id,
       JSON.stringify({ to: b.to, subject: b.subject, template_id: b.templateId ?? null })])

    res.json({ success: true, data: { sent: !!providerId, providerMessageId: providerId } })
  } catch (e) { next(e) }
})

adminRouter.get('/outreach-status', requireAdmin, async (_req, res, next) => {
  try {
    const rows = await query<any>(`
      SELECT l.id AS landlord_id,
             u.first_name, u.last_name, u.email,
             l.created_at              AS signed_up_at,
             l.welcome_outreach_sent_at,
             (SELECT count(*)::int FROM properties p WHERE p.landlord_id = l.id) AS property_count,
             u.last_login_at,
             e.created_at   AS email_sent_at,
             e.status       AS send_status,
             e.last_event, e.last_event_at,
             t.first_clicked_at, t.click_count,
             s.starts_at    AS booked_call_at, s.status AS booked_call_status
        FROM landlords l
        JOIN users u ON u.id = l.user_id
        -- the most recent outreach email for this landlord
        LEFT JOIN LATERAL (
          SELECT created_at, status, last_event, last_event_at
            FROM email_send_log
           WHERE landlord_id = l.id
             AND category IN ('landlord_welcome_outreach', 'landlord_onboarding_outreach')
           ORDER BY created_at DESC LIMIT 1
        ) e ON TRUE
        LEFT JOIN LATERAL (
          SELECT first_clicked_at, click_count
            FROM landlord_onboarding_booking_tokens
           WHERE landlord_id = l.id
           ORDER BY created_at DESC LIMIT 1
        ) t ON TRUE
        LEFT JOIN LATERAL (
          SELECT starts_at, status FROM sales_call_slots
           WHERE kind = 'onboarding' AND lower(prospect_email) = lower(u.email)
           ORDER BY starts_at DESC LIMIT 1
        ) s ON TRUE
       WHERE l.is_demo = FALSE AND l.is_system = FALSE
         AND e.created_at IS NOT NULL
       ORDER BY e.created_at DESC
       LIMIT 200`)

    res.json({ success: true, data: rows.map((r: any) => ({
      landlordId: r.landlord_id,
      name: [r.first_name, r.last_name].filter(Boolean).join(' ').trim() || r.email,
      email: r.email,
      signedUpAt: r.signed_up_at,
      emailSentAt: r.email_sent_at,
      sendStatus: r.send_status,
      // null = no delivery event seen yet (webhook not configured, or in flight)
      deliveryEvent: r.last_event,
      deliveryEventAt: r.last_event_at,
      clickedAt: r.first_clicked_at,
      clickCount: r.click_count ?? 0,
      bookedCallAt: r.booked_call_at,
      bookedCallStatus: r.booked_call_status,
      // The funnel, in the order it actually happens.
      stage: r.booked_call_at ? 'booked'
           : r.first_clicked_at ? 'clicked'
           : r.last_event === 'bounced' || r.last_event === 'complained' ? 'undeliverable'
           : r.last_event === 'delivered' ? 'delivered'
           : r.send_status === 'sent' ? 'sent'
           : 'failed',
      propertyCount: r.property_count,
      lastLoginAt: r.last_login_at,
    })) })
  } catch (e) { next(e) }
})

// ── S605: deposit-interest catalog + pool spread (super-admin only) ───────
//
// S604 built the whole 50-state interest/custody catalog and the earned-vs-owed
// spread engine, but left them with no route and no UI — the only way to read
// either was psql. This is GAM's largest earning bucket, so "visible only to
// whoever remembers the table names" is not a place to leave it.
//
// SUPER-ADMIN ONLY, deliberately. `spread`, `earned` and `market_rate_pct` are
// GAM's margin. S603/S604 already drew this boundary twice — calcNetPerUnit
// leaked to landlords, and getAccrualHistory (tenant portal) had to have
// earned/market_rate/spread stripped out. Same rule here: this data never
// crosses to a landlord or tenant surface.
adminRouter.get('/deposit-interest/spread', requireSuperAdmin, async (req, res, next) => {
  try {
    const q = z.object({
      from: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
      to:   z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
    }).parse(req.query)
    const { getPoolSpreadByMonth } = await import('../services/depositInterest')
    const months = await getPoolSpreadByMonth({ from: q.from, to: q.to })
    res.json({ success: true, data: {
      months: months.map((m) => ({
        accrualMonth:  m.accrual_month,
        deposits:      m.deposits,
        principal:     Number(m.principal ?? 0),
        owed:          Number(m.owed ?? 0),
        earned:        Number(m.earned ?? 0),
        spread:        Number(m.spread ?? 0),
        marketRatePct: m.market_rate_pct == null ? null : Number(m.market_rate_pct),
      })),
      totals: {
        principal: months.reduce((s, m) => s + Number(m.principal ?? 0), 0),
        owed:      months.reduce((s, m) => s + Number(m.owed ?? 0), 0),
        earned:    months.reduce((s, m) => s + Number(m.earned ?? 0), 0),
        spread:    months.reduce((s, m) => s + Number(m.spread ?? 0), 0),
      },
    } })
  } catch (e) { next(e) }
})

// GET /api/admin/deposit-interest/catalog — the 50-state obligation + custody
// read, joined. Answers the two questions that actually get asked: "what do we
// owe tenants here?" and "may the money physically sit in T-bills here?".
adminRouter.get('/deposit-interest/catalog', requireSuperAdmin, async (_req, res, next) => {
  try {
    const rows = await query<any>(`
      SELECT
        COALESCE(r.state_code, c.state_code) AS state_code,
        r.effective_year, r.annual_rate_pct, r.rate_basis, r.unit_types,
        r.statute_citation, r.actual_share_pct, r.admin_retention_pct,
        r.min_tenure_months, r.min_property_units,
        r.threshold_rule, r.threshold_amount, r.threshold_months_rent,
        c.custody_status, c.allows_treasury_bills, c.institution_test,
        c.geography_test, c.qualifies_with_segregated_account,
        c.statute_citation AS custody_citation
      FROM state_deposit_interest_rates r
      FULL OUTER JOIN state_deposit_custody_rules c ON c.state_code = r.state_code
      WHERE r.effective_year IS NULL
         OR r.effective_year = (SELECT MAX(effective_year) FROM state_deposit_interest_rates)
      ORDER BY 1, r.unit_types
    `)
    // An 'index_linked' state with no published index yet computes $0 owed,
    // which is silently WRONG rather than merely unknown — flag it here so the
    // gap is visible on the surface instead of buried in a notes column.
    const data = rows.map((r: any) => ({
      stateCode: r.state_code,
      effectiveYear: r.effective_year,
      annualRatePct: r.annual_rate_pct == null ? null : Number(r.annual_rate_pct),
      rateBasis: r.rate_basis,
      unitTypes: r.unit_types ?? [],
      statuteCitation: r.statute_citation,
      actualSharePct: r.actual_share_pct == null ? null : Number(r.actual_share_pct),
      adminRetentionPct: r.admin_retention_pct == null ? null : Number(r.admin_retention_pct),
      minTenureMonths: r.min_tenure_months,
      minPropertyUnits: r.min_property_units,
      thresholdRule: r.threshold_rule,
      thresholdAmount: r.threshold_amount == null ? null : Number(r.threshold_amount),
      thresholdMonthsRent: r.threshold_months_rent == null ? null : Number(r.threshold_months_rent),
      custodyStatus: r.custody_status ?? 'needs_research',
      allowsTreasuryBills: r.allows_treasury_bills ?? false,
      institutionTest: r.institution_test,
      geographyTest: r.geography_test,
      qualifiesWithSegregatedAccount: r.qualifies_with_segregated_account,
      custodyCitation: r.custody_citation,
      needsIndexValue: r.rate_basis === 'index_linked' && Number(r.annual_rate_pct ?? 0) === 0,
    }))
    res.json({ success: true, data: {
      states: data,
      summary: {
        obligations:      data.filter((d) => d.rateBasis && d.rateBasis !== 'none').length,
        noObligation:     data.filter((d) => d.rateBasis === 'none').length,
        custodySupported: data.filter((d) => d.custodyStatus === 'supported').length,
        custodyBlocked:   data.filter((d) => d.custodyStatus === 'blocked').length,
        needsIndexValue:  data.filter((d) => d.needsIndexValue).map((d) => d.stateCode),
      },
    } })
  } catch (e) { next(e) }
})

// GET /api/admin/onboarding-metrics — S579. How fast properties onboard onto GAM
// (initial property creation → onboarding-complete), split by e-sign vs
// imported-PDF leases, attributed to the closer/PM. The standard is DAYS, not
// weeks (onboarding overlap = the landlord paying for two softwares) — slow
// onboards surface here as an ops exception. See memory
// gam-screening-grandfather-onboarding-window.
adminRouter.get('/onboarding-metrics', requireAdmin, async (_req, res, next) => {
  try {
    const rows = await query<any>(`
      SELECT
        p.id AS property_id, p.name AS property_name,
        p.onboarding_started_at, p.onboarding_completed_at,
        CASE WHEN p.onboarding_completed_at IS NOT NULL
             THEN ROUND(EXTRACT(EPOCH FROM (p.onboarding_completed_at - p.onboarding_started_at)) / 86400.0, 1)
             ELSE NULL END AS duration_days,
        (lu.first_name || ' ' || lu.last_name) AS landlord_name,
        CASE WHEN pmu.id IS NOT NULL THEN (pmu.first_name || ' ' || pmu.last_name) ELSE NULL END AS closer_name,
        -- S616: service points are not inventory.
        (SELECT COUNT(*)::int FROM units u WHERE u.property_id = p.id
          AND u.status <> 'utility_service') AS unit_count,
        (SELECT COUNT(*)::int FROM lease_documents ld JOIN units u2 ON u2.id = ld.unit_id
           WHERE u2.property_id = p.id AND ld.document_type = 'original_lease') AS esign_lease_count,
        (SELECT COUNT(*)::int FROM pending_tenant_intents pti LEFT JOIN units u3 ON u3.id = pti.unit_id
           WHERE pti.imported_pdf_url IS NOT NULL AND (pti.property_id = p.id OR u3.property_id = p.id)) AS imported_pdf_count
      FROM properties p
      JOIN landlords l ON l.id = p.landlord_id
      JOIN users lu ON lu.id = l.user_id
      LEFT JOIN users pmu ON pmu.id = l.portfolio_manager_id
      WHERE p.onboarding_started_at IS NOT NULL
      ORDER BY p.onboarding_started_at DESC`)
    const completed = rows.filter((r: any) => r.duration_days != null)
    const avgDurationDays = completed.length
      ? Math.round((completed.reduce((s: number, r: any) => s + Number(r.duration_days), 0) / completed.length) * 10) / 10
      : null
    res.json({
      success: true,
      data: {
        properties: rows,
        summary: { total: rows.length, completed: completed.length, ongoing: rows.length - completed.length, avgDurationDays },
      },
    })
  } catch (e) { next(e) }
})

// ── SCALING READINESS (super-admin) ───────────────────────────
// Live trackers for the "stay on the Mac vs. move Postgres/API to Render"
// decision. Each metric reports its value + the watch/move thresholds + a
// status; the overall verdict is the worst status across them. The game-plan
// copy lives on the frontend panel. Admin-level (the whole adminRouter is
// already admin/super_admin only) so the demo admin account can see it.
adminRouter.get('/infra-readiness', requireSuperAdmin, async (_req, res, next) => {
  try {
    const round2 = (n: number) => Math.round(n * 100) / 100
    // higher value = closer to needing a migration
    const statusOf = (v: number, watchAt: number, moveAt: number) =>
      v >= moveAt ? 'move' : v >= watchAt ? 'watch' : 'ok'

    const [biz] = await query<any>(`
      SELECT
        -- Occupied = active + delinquent + suspended (rent-obligation
        -- principle; direct_pay retired W-15/S531).
        (SELECT COUNT(*)::int FROM units WHERE status IN ('active','delinquent','suspended')) AS occupied_units,
        (SELECT COALESCE(SUM(amount),0)::numeric
           FROM payments
          WHERE status='settled' AND settled_at >= date_trunc('month', NOW())) AS monthly_volume`)
    const [db] = await query<any>(`
      SELECT
        (SELECT count(*)::int FROM pg_stat_activity WHERE datname = current_database()) AS active_conns,
        (SELECT setting::int FROM pg_settings WHERE name='max_connections')           AS max_conns`)

    const cores      = os.cpus().length || 1
    const loadPerCore = round2(os.loadavg()[0] / cores)
    const occupied   = parseInt(biz?.occupied_units ?? '0', 10)
    const volume     = round2(parseFloat(biz?.monthly_volume ?? '0'))
    const conns      = parseInt(db?.active_conns ?? '0', 10)
    const maxConns   = parseInt(db?.max_conns ?? '100', 10)
    const connPct    = maxConns > 0 ? (conns / maxConns) * 100 : 0
    const p95        = latencyP95()

    const metrics = [
      { key: 'occupiedUnits', label: 'Occupied units', value: occupied, display: occupied.toLocaleString(),
        watchAt: 300, moveAt: 500, status: statusOf(occupied, 300, 500),
        note: 'Platform-wide occupied units (active + direct-pay). The customer base whose payments an outage would put at risk.' },
      { key: 'monthlyVolume', label: 'Payments this month', value: volume, display: '$' + Math.round(volume).toLocaleString(),
        watchAt: 35000, moveAt: 50000, status: statusOf(volume, 35000, 50000),
        note: 'Settled payment volume this calendar month. At ~$50k+/mo a managed DB is trivial insurance vs. a home-internet outage.' },
      { key: 'cpuLoad', label: 'Mac CPU load (per core)', value: loadPerCore, display: loadPerCore.toFixed(2) + '×',
        watchAt: 0.7, moveAt: 1.0, status: statusOf(loadPerCore, 0.7, 1.0),
        note: `1-min load average ÷ ${cores} cores. Sustained spikes here usually mean the LLM is competing with Postgres/API for the machine.` },
      { key: 'dbConnections', label: 'Postgres connections', value: conns, display: `${conns} / ${maxConns}`,
        watchAt: Math.round(maxConns * 0.7), moveAt: Math.round(maxConns * 0.85), status: statusOf(connPct, 70, 85),
        note: `${conns} of ${maxConns} max connections in use. Regularly near the cap = the database should move first.` },
      // S605: below MIN_SAMPLES the p95 IS the slowest single request, so it
      // swung 25ms↔465ms and flipped the whole panel to "Move" on one slow call
      // — especially right after a deploy, since the buffer is in-memory and
      // starts empty. Say "warming up" instead of inventing a verdict.
      { key: 'apiLatency', label: 'API p95 latency', value: p95 == null ? 0 : Math.round(p95),
        display: p95 == null ? `warming up (${sampleSize()}/${MIN_SAMPLES})` : Math.round(p95) + ' ms',
        watchAt: 300, moveAt: 500, status: p95 == null ? 'ok' : statusOf(p95, 300, 500),
        note: p95 == null
          ? `Needs ${MIN_SAMPLES} requests before a p95 means anything; ${sampleSize()} so far since the last API restart. Vendor-bound routes (LLM, Stripe, Cloudflare, the health panel itself) are excluded — this tracks the Mac, not someone else's servers.`
          : `95th-percentile response time over the last ${sampleSize()} requests. Excludes vendor-bound routes (LLM, Stripe, Checkr, the health panel) so it measures the Mac, not third parties.` },
    ]
    const rank: Record<string, number> = { ok: 0, watch: 1, move: 2 }
    const overall = metrics.reduce((worst, m) => (rank[m.status] > rank[worst] ? m.status : worst), 'ok')

    res.json({ success: true, data: {
      overall, metrics,
      host: { hostname: os.hostname(), cores, uptimeSec: Math.round(os.uptime()) },
    } })
  } catch (e) { next(e) }
})

// S592: NACHA/ACH-compliance monitoring is platform-staff-only (super_admin) —
// requireSuperAdmin's own contract names it as such. Pre-fix this route carried
// only the router-level admin gate, so a regular admin (portfolio manager) could
// read the platform-wide ACH monitoring log (return codes, zero-tolerance/
// velocity flags, tenant names). Match the documented tier.
adminRouter.get('/nacha/monitoring', requireSuperAdmin, async (_req, res, next) => {
  try {
    const logs = await query<any>(`
      SELECT aml.*, tu.first_name, tu.last_name
      FROM ach_monitoring_log aml
      LEFT JOIN tenants t ON t.id = aml.tenant_id
      LEFT JOIN users tu ON tu.id = t.user_id
      ORDER BY aml.created_at DESC LIMIT 100`)
    // S370 fix: pre-S370 the second FILTER referenced `zero_tolerance_flag`
    // which doesn't exist on ach_monitoring_log (the boolean indicator
    // column is `flagged`). Every nacha/monitoring call crashed 500 with
    // "column zero_tolerance_flag does not exist" — admin NACHA page
    // dead. Use event_type='zero_tolerance_block' for the semantic
    // (matches the CHECK constraint values) and `flagged` for the
    // /overview convention; here we want the specific event type, not
    // the broader flagged-any signal.
    const [stats] = await query<any>(`
      SELECT
        COUNT(*) FILTER (WHERE return_code IS NOT NULL) AS total_returns,
        COUNT(*) FILTER (WHERE event_type='zero_tolerance_block') AS zero_tolerance_events,
        COUNT(*) FILTER (WHERE event_type='first_sender') AS first_senders_30d,
        COUNT(*) FILTER (WHERE event_type='velocity_flag') AS velocity_flags_30d
      FROM ach_monitoring_log WHERE created_at > NOW() - INTERVAL '30 days'`)
    res.json({ success: true, data: { logs, stats } })
  } catch (e) { next(e) }
})

// ── ECONOMIC-NEXUS MONITOR (super_admin) — S565 ───────────────
// Read model: GAM own-revenue by customer state vs each state's economic-nexus
// registration threshold + current registration status. MONITORING ONLY — the
// register action flips tax collection, but the dashboard itself charges nothing.
adminRouter.get('/nexus/dashboard', requireSuperAdmin, async (_req, res, next) => {
  try {
    const data = await getNexusDashboard()
    res.json({ success: true, data })
  } catch (e) { next(e) }
})

// Manual tally recompute (the same job the nightly cron runs) — for when an
// admin wants fresh numbers without waiting for 3:20am.
adminRouter.post('/nexus/recompute', requireSuperAdmin, async (req, res, next) => {
  try {
    const result = await recomputeNexusTally()
    await logAdminAction({
      adminUserId: req.user!.userId,
      actionType: 'nexus_tally_recompute',
      metadata: { years: result.years, rows: result.rows },
      ipAddress: req.ip ?? null,
    })
    res.json({ success: true, data: result })
  } catch (e) { next(e) }
})

// Flip a state's registration status. Registering turns ON tax collection for
// that state (subject to the tax catalog's taxable flag + rate). Super-admin +
// audited — this is a real compliance action.
adminRouter.post('/nexus/register', requireSuperAdmin, async (req, res, next) => {
  try {
    const schema = z.object({
      stateCode: z.string().length(2),
      registered: z.boolean(),
      registeredDate: z.string().optional().nullable(),
      notes: z.string().max(500).optional().nullable(),
    })
    const body = schema.parse(req.body)
    await setStateRegistration(body.stateCode, body.registered, {
      registeredDate: body.registeredDate ?? undefined,
      notes: body.notes ?? undefined,
      source: 'manual',
    })
    await logAdminAction({
      adminUserId: req.user!.userId,
      actionType: 'nexus_state_registration',
      targetType: 'state_tax_registration',
      metadata: { state: body.stateCode.toUpperCase(), registered: body.registered },
      ipAddress: req.ip ?? null,
    })
    res.json({ success: true })
  } catch (e) { next(e) }
})

// ── ONBOARDING OVERVIEW (regular admin) ──────────────────────
// S592: exported for the scoped /api/portfolio router — caller-scoped by userId
// (super_admin → platform-wide), identical for a portfolio_manager.
export const onboardingOverviewHandler = async (req: any, res: any, next: any) => {
  try {
    // Portfolio scoping (S567): every count is scoped to the regular admin's
    // portfolio (landlords they own + tenants/units under those landlords);
    // super_admin ($1 NULL) gets the platform-wide totals.
    const scopeId = req.user?.role === 'super_admin' ? null : req.user?.userId
    const [stats] = await query<any>(`
      SELECT
        (SELECT COUNT(*)::int FROM landlords l WHERE l.onboarding_complete=FALSE
           AND ($1::uuid IS NULL OR l.portfolio_manager_id=$1::uuid OR l.service_manager_id=$1::uuid)) AS landlords_incomplete,
        (SELECT COUNT(*)::int FROM landlords l
          WHERE NOT EXISTS (
            SELECT 1 FROM user_bank_accounts ba
             WHERE ba.user_id = l.user_id AND ba.status = 'active'
          )
          AND ($1::uuid IS NULL OR l.portfolio_manager_id=$1::uuid OR l.service_manager_id=$1::uuid)
        ) AS landlords_no_bank,
        (SELECT COUNT(*)::int FROM tenants t WHERE t.ach_verified=FALSE
           AND ($1::uuid IS NULL OR EXISTS (
             SELECT 1 FROM v_lease_active_tenants vlat
             JOIN leases le ON le.id=vlat.lease_id AND le.status='active'
             JOIN units un ON un.id=le.unit_id
             JOIN landlords ld ON ld.id=un.landlord_id
             WHERE vlat.tenant_id=t.id AND (ld.portfolio_manager_id=$1::uuid OR ld.service_manager_id=$1::uuid)))) AS tenants_no_ach,
        (SELECT COUNT(*)::int FROM tenants t
           WHERE t.on_time_pay_enrolled=FALSE AND t.credit_reporting_enrolled=FALSE
             AND t.flex_deposit_enrolled=FALSE AND t.float_fee_active=FALSE
             AND ($1::uuid IS NULL OR EXISTS (
               SELECT 1 FROM v_lease_active_tenants vlat
               JOIN leases le ON le.id=vlat.lease_id AND le.status='active'
               JOIN units un ON un.id=le.unit_id
               JOIN landlords ld ON ld.id=un.landlord_id
               WHERE vlat.tenant_id=t.id AND (ld.portfolio_manager_id=$1::uuid OR ld.service_manager_id=$1::uuid)))) AS tenants_no_flex,
        (SELECT COUNT(*)::int FROM units un WHERE un.status='vacant'
           AND ($1::uuid IS NULL OR EXISTS (
             SELECT 1 FROM landlords ld WHERE ld.id=un.landlord_id
              AND (ld.portfolio_manager_id=$1::uuid OR ld.service_manager_id=$1::uuid)))) AS vacant_units,
        (SELECT COUNT(*)::int FROM v_unit_occupancy vuo WHERE NOT vuo.is_occupied
           AND ($1::uuid IS NULL OR EXISTS (
             SELECT 1 FROM units un JOIN landlords ld ON ld.id=un.landlord_id
              WHERE un.id=vuo.unit_id AND (ld.portfolio_manager_id=$1::uuid OR ld.service_manager_id=$1::uuid)))) AS units_no_tenant
    `, [scopeId])
    res.json({ success: true, data: stats })
  } catch (e) { next(e) }
}
adminRouter.get('/onboarding/overview', onboardingOverviewHandler)

// ── LANDLORD ONBOARDING DETAIL ────────────────────────────────
// S592: exported for the scoped /api/portfolio router (portfolio-scope guard
// is inside the handler — a regular admin / PM can only open a landlord they
// close or service).
export const onboardingLandlordDetailHandler = async (req: any, res: any, next: any) => {
  try {
    const landlord = await queryOne<any>(
      `SELECT l.*, u.first_name, u.last_name, u.email, u.phone,
        EXISTS (
          SELECT 1 FROM user_bank_accounts ba
           WHERE ba.user_id = l.user_id AND ba.status = 'active'
        ) AS bank_account_ready
       FROM landlords l JOIN users u ON u.id = l.user_id
       WHERE l.id = $1`, [req.params.id]
    )
    if (!landlord) throw new Error('Landlord not found')
    // Portfolio scoping (S567): a regular admin can open only a landlord they
    // close or service. Unassigned leads are routed by super_admin.
    if ((req as any).user?.role !== 'super_admin') {
      const uid = (req as any).user?.userId
      if (landlord.portfolio_manager_id !== uid && landlord.service_manager_id !== uid) {
        throw new AppError(403, 'Outside your portfolio')
      }
    }

    const [counts] = await query<any>(
      `SELECT
         COUNT(DISTINCT p.id)::int AS property_count,
         COUNT(DISTINCT u.id)::int AS unit_count,
         COUNT(DISTINCT u.id) FILTER (WHERE vuo.is_occupied)::int AS units_with_tenants,
         COUNT(DISTINCT l.id) FILTER (WHERE l.status='active')::int AS active_leases,
         (
           SELECT COUNT(*)::int FROM user_bank_accounts ba
            WHERE ba.user_id = ld.user_id AND ba.status = 'active'
         ) AS active_bank_accounts
       FROM landlords ld
       LEFT JOIN properties p ON p.landlord_id = ld.id
       LEFT JOIN units u ON u.landlord_id = ld.id
       LEFT JOIN v_unit_occupancy vuo ON vuo.unit_id = u.id
       LEFT JOIN leases l ON l.landlord_id = ld.id
       WHERE ld.id = $1
       GROUP BY ld.id, ld.user_id`, [req.params.id]
    )

    const checklist = [
      { key: 'account_created',   label: 'Account created',         done: true },
      { key: 'bank_account_added', label: 'Bank account added',     done: counts.active_bank_accounts > 0 },
      { key: 'property_added',    label: 'Property added',           done: counts.property_count > 0 },
      { key: 'unit_added',        label: 'Units added',              done: counts.unit_count > 0 },
      { key: 'tenant_invited',    label: 'Tenant invited',           done: counts.units_with_tenants > 0 },
      { key: 'onboarding_complete', label: 'Onboarding complete',    done: landlord.onboarding_complete },
    ]

    res.json({ success: true, data: { landlord, counts, checklist } })
  } catch (e) { next(e) }
}
adminRouter.get('/onboarding/landlord/:id', onboardingLandlordDetailHandler)

// ── PORTFOLIO-MANAGER ATTRIBUTION (S567) ──────────────────────
// Two roles per landlord, each 25¢/occupied unit/mo:
//   closing (portfolio_manager_id) — the rep who won the deal. Set by referral
//     code at signup or super_admin assignment. A self-closed landlord (no
//     closer) sends its closing 25¢ to the pot — it is NOT self-claimable, so
//     nobody can grab credit for a deal they didn't close.
//   service (service_manager_id)   — customer service, mandatory + always paid.
//     When a closer exists the closer does their own CS (service_manager_id
//     stays NULL, the accrual routes CS to the closer). Only a self-closed
//     landlord takes a separate CS specialist, who may CLAIM it, or super_admin
//     assigns. CS is never orphaned / never pots.

// Roster of assignable portfolio managers (super_admin only — the assign UI).
adminRouter.get('/portfolio-managers', requireSuperAdmin, async (_req, res, next) => {
  try {
    const pms = await query<any>(
      `SELECT id, first_name, last_name, email, role
         FROM users WHERE role IN ('admin','super_admin','portfolio_manager')
        ORDER BY last_name, first_name`)
    res.json({ success: true, data: pms })
  } catch (e) { next(e) }
})

// super_admin assigns / reassigns / unassigns either role. A CS-only PM is
// assigned the SERVICE role on self-signed-up (self-closed) landlords here —
// there is no self-serve claim; closing + service otherwise stay together.
adminRouter.post('/landlords/:id/assign', requireSuperAdmin, async (req: any, res, next) => {
  try {
    const schema = z.object({
      role: z.enum(['closing', 'service']),
      managerId: z.string().uuid().nullable(),
    })
    const { role, managerId } = schema.parse(req.body)
    if (managerId) {
      const pm = await queryOne<any>(
        `SELECT id FROM users WHERE id=$1 AND role IN ('admin','super_admin','portfolio_manager')`, [managerId])
      if (!pm) throw new AppError(400, 'Not a valid portfolio manager')
    }
    const ll = await queryOne<any>(`SELECT id FROM landlords WHERE id=$1`, [req.params.id])
    if (!ll) throw new AppError(404, 'Landlord not found')
    const col = role === 'closing' ? 'portfolio_manager_id' : 'service_manager_id'
    await query(
      `UPDATE landlords SET ${col}=$1, updated_at=now() WHERE id=$2`,
      [managerId, req.params.id])
    await logAdminAction({
      adminUserId: req.user.userId,
      actionType: `landlord_${role}_manager_assign`,
      targetType: 'landlord', targetId: req.params.id,
      metadata: { [col]: managerId },
      ipAddress: req.ip ?? null,
    })
    res.json({ success: true })
  } catch (e) { next(e) }
})

// S592: manual re-attach backstop for the PERSON-level referral upline
// (users.referred_by_user_id). The link is normally set automatically (signup
// ref code / co-owner capture) and survives 1031s / new entities, but super_admin
// can correct it here — e.g. re-slot someone into a chain, or fix a bad capture.
// Single-tier is preserved: one upline, no self-reference. Pass null to detach.
adminRouter.post('/users/:userId/referral-upline', requireSuperAdmin, async (req: any, res, next) => {
  try {
    const { uplineUserId } = z.object({ uplineUserId: z.string().uuid().nullable() }).parse(req.body)
    if (uplineUserId === req.params.userId) throw new AppError(400, 'A person cannot be their own upline')
    const target = await queryOne<{ id: string }>(`SELECT id FROM users WHERE id=$1`, [req.params.userId])
    if (!target) throw new AppError(404, 'User not found')
    if (uplineUserId) {
      const upline = await queryOne<{ id: string }>(
        `SELECT id FROM users WHERE id=$1 AND role IN ('landlord','admin','super_admin','portfolio_manager')`,
        [uplineUserId])
      if (!upline) throw new AppError(400, 'Upline must be a landlord or a GAM rep')
    }
    await query(`UPDATE users SET referred_by_user_id=$1 WHERE id=$2`, [uplineUserId, req.params.userId])
    await logAdminAction({
      adminUserId: req.user.userId,
      actionType: 'referral_upline_reattach',
      targetType: 'user', targetId: req.params.userId,
      metadata: { upline_user_id: uplineUserId },
      ipAddress: req.ip ?? null,
    })
    res.json({ success: true })
  } catch (e) { next(e) }
})

// The logged-in rep's personal referral code + shareable signup link. Lazily
// generates the code on first request. Any admin/super_admin/portfolio_manager.
// S592: exported so the scoped /api/portfolio router shares this EXACT handler
// (no duplication) — the logic is caller-scoped by req.user.userId, identical
// for a portfolio_manager.
export const myReferralHandler = async (req: any, res: any, next: any) => {
  try {
    let row = await queryOne<any>(`SELECT referral_code FROM users WHERE id=$1`, [req.user.userId])
    if (!row?.referral_code) {
      // Derive a short, human-ish code from the user id; retry on the tiny
      // chance of a collision against the UNIQUE constraint.
      for (let attempt = 0; attempt < 5; attempt++) {
        const code = (req.user.userId.replace(/-/g, '') + attempt).slice(0, 8).toUpperCase()
        try {
          await query(`UPDATE users SET referral_code=$1 WHERE id=$2`, [code, req.user.userId])
          row = { referral_code: code }
          break
        } catch { /* collision — try next */ }
      }
    }
    const base = process.env.LANDLORD_SIGNUP_URL || 'https://app.goldassetmanagement.com/signup'
    res.json({ success: true, data: {
      referralCode: row?.referral_code ?? null,
      referralLink: row?.referral_code ? `${base}?ref=${row.referral_code}` : null,
    }})
  } catch (e) { next(e) }
}
adminRouter.get('/my-referral', myReferralHandler)

// Commission earnings + pot summary. Regular admin / portfolio_manager → their
// OWN earnings only (myEarnings + myByLandlord); super_admin additionally sees
// the pot balance + a per-manager breakdown. A portfolio_manager is not super,
// so they never see the pot or other managers — safe to share. S592: exported
// for the scoped /api/portfolio router.
export const commissionsSummaryHandler = async (req: any, res: any, next: any) => {
  try {
    const isSuper = req.user?.role === 'super_admin'
    const uid = req.user.userId
    const [mine] = await query<any>(
      `SELECT
         COALESCE(SUM(amount),0) AS all_time,
         COALESCE(SUM(amount) FILTER (WHERE accrual_month = date_trunc('month', now())::date),0) AS this_month
       FROM commission_accruals WHERE manager_id=$1 AND NOT to_pot`, [uid])
    const data: any = { myEarnings: { allTime: +mine.all_time, thisMonth: +mine.this_month } }
    // The requesting PM's own commission broken out by landlord (their units
    // under management) — the only breakdown a portfolio manager sees.
    data.myByLandlord = await query<any>(
      `SELECT ca.landlord_id, lu.first_name, lu.last_name, l.business_name,
              MAX(ca.occupied_units) AS occupied_units,
              COALESCE(SUM(ca.amount),0) AS all_time,
              COALESCE(SUM(ca.amount) FILTER (WHERE ca.accrual_month = date_trunc('month', now())::date),0) AS this_month
         FROM commission_accruals ca
         JOIN landlords l ON l.id = ca.landlord_id
         JOIN users lu ON lu.id = l.user_id
        WHERE ca.manager_id=$1 AND NOT ca.to_pot
        GROUP BY ca.landlord_id, lu.first_name, lu.last_name, l.business_name
        ORDER BY all_time DESC`, [uid])
    if (isSuper) {
      const [pot] = await query<any>(
        `SELECT
           COALESCE(SUM(amount),0) AS all_time,
           COALESCE(SUM(amount) FILTER (WHERE accrual_month = date_trunc('month', now())::date),0) AS this_month
         FROM commission_accruals WHERE to_pot`)
      const byManager = await query<any>(
        `SELECT ca.manager_id, u.first_name, u.last_name,
                COALESCE(SUM(ca.amount),0) AS all_time,
                COALESCE(SUM(ca.amount) FILTER (WHERE ca.accrual_month = date_trunc('month', now())::date),0) AS this_month
           FROM commission_accruals ca JOIN users u ON u.id = ca.manager_id
          WHERE NOT ca.to_pot
          GROUP BY ca.manager_id, u.first_name, u.last_name
          ORDER BY all_time DESC`)
      data.pot = { allTime: +pot.all_time, thisMonth: +pot.this_month }
      data.byManager = byManager
    }
    res.json({ success: true, data })
  } catch (e) { next(e) }
}
adminRouter.get('/commissions/summary', commissionsSummaryHandler)

// On-demand commission accrual for the current month (super_admin). The cron
// runs this on the 1st; this lets an operator preview/backfill it.
adminRouter.post('/commissions/accrue', requireSuperAdmin, async (req: any, res, next) => {
  try {
    const { processCommissionAccrual } = await import('../jobs/commissionAccrual')
    const result = await processCommissionAccrual()
    await logAdminAction({
      adminUserId: req.user.userId,
      actionType: 'commission_accrual_manual_run',
      metadata: { month: result.monthScanned, accrued: result.landlordsAccrued },
      ipAddress: req.ip ?? null,
    })
    res.json({ success: true, data: result })
  } catch (e) { next(e) }
})

// ── TENANT ONBOARDING DETAIL ──────────────────────────────────
// S592: exported for the scoped /api/portfolio router (portfolio-scope guard inside).
export const onboardingTenantDetailHandler = async (req: any, res: any, next: any) => {
  try {
    const tenant = await queryOne<any>(
      `SELECT t.*, u.first_name, u.last_name, u.email, u.phone,
              un.unit_number, p.name AS property_name,
              l.first_name AS landlord_first, l.last_name AS landlord_last,
              ld.portfolio_manager_id AS landlord_pm_id,
              ld.service_manager_id AS landlord_sm_id
       FROM tenants t
       JOIN users u ON u.id = t.user_id
       LEFT JOIN LATERAL (
         SELECT un2.id, un2.unit_number, un2.property_id, un2.landlord_id
         FROM v_lease_active_tenants vlat
         JOIN leases le ON le.id = vlat.lease_id AND le.status = 'active'
         JOIN units un2 ON un2.id = le.unit_id
         WHERE vlat.tenant_id = t.id
         ORDER BY (vlat.role = 'primary') DESC
         LIMIT 1
       ) un ON TRUE
       LEFT JOIN properties p ON p.id = un.property_id
       LEFT JOIN landlords ld ON ld.id = un.landlord_id
       LEFT JOIN users l ON l.id = ld.user_id
       WHERE t.id = $1`, [req.params.id]
    )
    if (!tenant) throw new Error('Tenant not found')
    // Portfolio scoping (S567): a regular admin can only open tenants whose
    // active lease sits under a landlord they close or service.
    if ((req as any).user?.role !== 'super_admin') {
      const uid = (req as any).user?.userId
      if (tenant.landlord_pm_id !== uid && tenant.landlord_sm_id !== uid) {
        throw new AppError(403, 'Outside your portfolio')
      }
    }

    const checklist = [
      { key: 'account_created',   label: 'Account created',         done: true },
      { key: 'ach_enrolled',      label: 'ACH enrolled',            done: !!tenant.bank_last4 },
      { key: 'ach_verified',      label: 'ACH verified',            done: tenant.ach_verified },
      { key: 'flex_deposit',      label: 'FlexDeposit enrolled',    done: tenant.flex_deposit_enrolled },
      // S409 (S376 decision): the column `credit_reporting_enrolled` is
      // the rent-reporting product (tenant pays to have rent payments
      // reported to Equifax/Experian/TransUnion). It is NOT FlexCredit
      // (which is a separate third-party-lender referral product per
      // CLAUDE.md). The "FlexCredit enrolled" label was a mislabel.
      // Key kept as `flex_credit` to avoid breaking the admin frontend
      // checklist key map; label is the user-visible string.
      { key: 'flex_credit',       label: 'Rent reporting enrolled', done: tenant.credit_reporting_enrolled },
      { key: 'flex_pay',          label: 'FlexPay enrolled',        done: tenant.float_fee_active },
    ]

    res.json({ success: true, data: { tenant, checklist } })
  } catch (e) { next(e) }
}
adminRouter.get('/onboarding/tenant/:id', onboardingTenantDetailHandler)

// ── FLEXSUITE ENROLLMENT ACCEPTANCES (S315) ──────────────────
// List the click-accept audit rows for a tenant. Used by the admin
// Tenants detail panel to render the per-enrollment evidence + open
// the full populated terms text on click. Records are immutable
// (insert-only at enrollment via services/flexsuiteAcceptance.ts).
adminRouter.get('/tenants/:tenantId/flexsuite-acceptances', async (req: any, res, next) => {
  try {
    // Portfolio scoping (S592 — parity with /onboarding/tenant/:id): a regular
    // admin can only read acceptances for a tenant under a landlord they close
    // or service. FlexSuite enrollment is SSDI/SSI-gated, so a cross-portfolio
    // read would expose protected-class-adjacent status. super_admin sees all.
    if (req.user?.role !== 'super_admin') {
      const uid = req.user?.userId
      const scoped = await queryOne<{ ok: boolean }>(
        `SELECT EXISTS (
           SELECT 1 FROM v_lease_active_tenants vlat
           JOIN leases le ON le.id = vlat.lease_id AND le.status='active'
           JOIN units un ON un.id = le.unit_id
           JOIN landlords ld ON ld.id = un.landlord_id
           WHERE vlat.tenant_id = $1
             AND (ld.portfolio_manager_id = $2 OR ld.service_manager_id = $2)
         ) AS ok`,
        [req.params.tenantId, uid])
      if (!scoped?.ok) throw new AppError(403, 'Outside your portfolio')
    }
    const rows = await query<{
      id:                  string
      product_type:        'flexpay' | 'flexdeposit'
      template_version:    string
      populated_content:   any
      rendered_text:       string
      content_hash:        string
      accepted_at:         string
      accepted_ip:         string | null
      accepted_user_agent: string | null
      accepter_email:      string | null
    }>(
      `SELECT a.id, a.product_type, a.template_version, a.populated_content,
              a.rendered_text, a.content_hash,
              a.accepted_at, a.accepted_ip, a.accepted_user_agent,
              u.email AS accepter_email
         FROM flexsuite_enrollment_acceptances a
         LEFT JOIN users u ON u.id = a.user_id
        WHERE a.tenant_id = $1
        ORDER BY a.accepted_at DESC`,
      [req.params.tenantId],
    )
    res.json({ success: true, data: rows })
  } catch (e) { next(e) }
})

// ── RESEND ACTIONS ────────────────────────────────────────────
// S592: exported for the scoped /api/portfolio router, with a portfolio-scope
// guard — every wired resend type targets a TENANT (by targetId), so a
// non-super caller (regular admin / portfolio_manager) may only resend to a
// tenant in their own book. super_admin resends to anyone.
export const onboardingResendHandler = async (req: any, res: any, next: any) => {
  try {
    const { type, targetId } = req.body
    if (!targetId) throw new AppError(400, 'targetId is required')

    // Portfolio scoping: a non-super caller may only act inside their own book.
    //
    // S609 — THIS GATE WAS WRONG IN TWO WAYS, and both made the feature
    // unusable for a regular admin rather than merely strict:
    //
    //   1. It assumed targetId is always a TENANT. It isn't — 'bank_verification'
    //      and 'landlord_setup' target a LANDLORD, so the tenant lookup never
    //      matched and a regular admin got 403 for a landlord sitting squarely
    //      in their own book. Always. There was no way to succeed.
    //
    //   2. It required an ACTIVE LEASE. This whole endpoint exists to nudge
    //      people who are still ONBOARDING — the ACH-setup reminder is for a
    //      tenant who has not finished setting up, which is very often before
    //      their lease goes active. So the gate refused precisely the case the
    //      feature was built for.
    //
    // Resolve the target's landlord by whichever kind of thing it is, then check
    // that landlord is in the caller's book. No lease required: being a tenant
    // OF a landlord in my book is what puts them in my book, not the state of
    // their paperwork.
    if (req.user?.role !== 'super_admin') {
      const uid = req.user?.userId
      const inBook = await queryOne<{ ok: boolean }>(
        `SELECT EXISTS (
           SELECT 1 FROM landlords ld
            WHERE (ld.portfolio_manager_id = $2 OR ld.service_manager_id = $2)
              AND (
                -- targetId IS a landlord
                ld.id = $1
                -- or targetId is a tenant of one. ANY lease in ANY state —
                -- a tenant being onboarded is typically on a draft or
                -- pending_add lease, never an active one yet, which is the
                -- second half of the bug described above. A tenant has no
                -- landlord except through a lease, so this is the only link.
                OR EXISTS (
                  SELECT 1 FROM lease_tenants lt
                  JOIN leases le ON le.id = lt.lease_id
                  JOIN units un ON un.id = le.unit_id
                  WHERE lt.tenant_id = $1 AND un.landlord_id = ld.id
                )
              )
         ) AS ok`, [targetId, uid])
      if (!inBook?.ok) throw new AppError(403, 'Outside your portfolio')
    }

    // S553: this endpoint was a STUB — it logged an audit row and returned
    // "queued" while sending NOTHING, so an admin recovering a failed
    // invite got false success. tenant_invite (+ its reminder) is the
    // launch-critical path (resend a tenant's portal invite); it now
    // ACTUALLY sends. The other types aren't wired yet and return an
    // honest error rather than lying.
    if (type === 'tenant_invite' || type === 'tenant_invite_reminder') {
      const t = await queryOne<any>(
        `SELECT u.id AS user_id, u.email, u.first_name, u.email_verified,
                un.unit_number, p.name AS property_name, p.street1, p.city, p.state, p.zip,
                p.landlord_id, (llu.first_name || ' ' || llu.last_name) AS landlord_name
           FROM tenants t
           JOIN users u ON u.id = t.user_id
           LEFT JOIN lease_tenants lt ON lt.tenant_id = t.id AND lt.status IN ('active','pending_add')
           LEFT JOIN leases l ON l.id = lt.lease_id
           LEFT JOIN units un ON un.id = l.unit_id
           LEFT JOIN properties p ON p.id = un.property_id
           LEFT JOIN landlords ll ON ll.id = p.landlord_id
           LEFT JOIN users llu ON llu.id = ll.user_id
          WHERE t.id = $1
          ORDER BY lt.added_at DESC NULLS LAST
          LIMIT 1`, [targetId])
      if (!t) throw new AppError(404, 'Tenant not found')
      // Portfolio scoping (S592 — parity with the other tenant routes): a
      // regular admin may only resend for a tenant under a landlord they close
      // or service. Prevents a portfolio manager from resetting another
      // portfolio's pending invite token.
      if ((req as any).user?.role !== 'super_admin') {
        const uid = (req as any).user?.userId
        const scoped = await queryOne<{ ok: boolean }>(
          `SELECT (ld.portfolio_manager_id = $2 OR ld.service_manager_id = $2) AS ok
             FROM landlords ld WHERE ld.id = $1`, [t.landlord_id, uid])
        if (!scoped?.ok) throw new AppError(403, 'Outside your portfolio')
      }
      if (t.email_verified) throw new AppError(409, 'This tenant has already activated their account — no invite to resend.')

      // Fresh token resets the 7-day expiry (mirrors the onboard route).
      const inviteToken = require('crypto').randomBytes(32).toString('hex')
      await query(
        `UPDATE users SET tenant_invite_token=$1, tenant_invite_expires_at=now()+interval '7 days', updated_at=now() WHERE id=$2`,
        [inviteToken, t.user_id])
      const tenantAppUrl = process.env.TENANT_APP_URL || 'http://localhost:3002'
      const activationUrl = `${tenantAppUrl}/accept-invite?token=${inviteToken}`
      const propertyAddress = [t.street1, t.city, t.state, t.zip].filter(Boolean).join(', ')
      const unitLabel = t.property_name ? `${t.property_name} — Unit ${t.unit_number}` : 'your unit'
      await emailTenantOnboarded(
        t.email, t.first_name, t.landlord_name || 'Your landlord', propertyAddress, unitLabel, activationUrl,
        { landlordId: t.landlord_id, tenantId: targetId })

      await logAdminAction({
        adminUserId: req.user!.userId, actionType: 'resend_tenant_invite',
        targetId, targetType: 'tenant', notes: 'Portal invite resent (fresh token)', ipAddress: req.ip ?? null,
      })
      return res.json({ success: true, data: { message: `Invite resent to ${t.email}` } })
    }

    // S554: bank_verification → nudge the LANDLORD (targetId = landlords.id)
    // to finish Stripe Connect so rent can route.
    if (type === 'bank_verification') {
      const ll = await queryOne<any>(
        `SELECT l.id AS landlord_id, u.email, (u.first_name || ' ' || u.last_name) AS name
           FROM landlords l JOIN users u ON u.id = l.user_id WHERE l.id = $1`, [targetId])
      if (!ll?.email) throw new AppError(404, 'Landlord not found')
      const bankingUrl = `${process.env.LANDLORD_APP_URL || 'http://localhost:3001'}/banking`
      await emailLandlordBankingSetup({ to: ll.email, landlordName: ll.name || 'there', bankingUrl, ctx: { landlordId: ll.landlord_id } })
      await logAdminAction({
        adminUserId: req.user!.userId, actionType: 'resend_bank_verification',
        targetId, targetType: 'landlord', notes: 'Banking-setup nudge resent', ipAddress: req.ip ?? null,
      })
      return res.json({ success: true, data: { message: `Banking-setup reminder sent to ${ll.email}` } })
    }

    // S554: ach_enrollment → nudge the TENANT (targetId = tenants.id) to add a
    // bank account so they can pay rent online.
    if (type === 'ach_enrollment') {
      const t = await queryOne<any>(
        `SELECT u.email, u.first_name AS name, p.landlord_id
           FROM tenants t
           JOIN users u ON u.id = t.user_id
           LEFT JOIN lease_tenants lt ON lt.tenant_id = t.id AND lt.status IN ('active','pending_add')
           LEFT JOIN leases l ON l.id = lt.lease_id
           LEFT JOIN units un ON un.id = l.unit_id
           LEFT JOIN properties p ON p.id = un.property_id
          WHERE t.id = $1 ORDER BY lt.added_at DESC NULLS LAST LIMIT 1`, [targetId])
      if (!t?.email) throw new AppError(404, 'Tenant not found')
      const paymentsUrl = `${process.env.TENANT_APP_URL || 'http://localhost:3002'}/payments`
      await emailTenantAchSetup({ to: t.email, tenantName: t.name || 'there', paymentsUrl, ctx: { landlordId: t.landlord_id ?? null, tenantId: targetId } })
      await logAdminAction({
        adminUserId: req.user!.userId, actionType: 'resend_ach_enrollment',
        targetId, targetType: 'tenant', notes: 'ACH-setup nudge resent', ipAddress: req.ip ?? null,
      })
      return res.json({ success: true, data: { message: `ACH-setup reminder sent to ${t.email}` } })
    }

    // landlord_setup is intentionally NOT wired: landlords self-register (no
    // admin "setup invite" concept). Honest failure rather than a fake success.
    throw new AppError(501, `Resend for "${type}" isn't available. Tenant invites, bank verification, and ACH enrollment can be resent; landlords self-register (no setup invite to resend).`)
  } catch (e) { next(e) }
}
adminRouter.post('/onboarding/resend', onboardingResendHandler)

// ── TENANTS LIST (with flex status) ──────────────────────────
// S592: exported for the scoped /api/portfolio router (caller-scoped by userId).
export const tenantsListHandler = async (req: any, res: any, next: any) => {
  try {
    // Portfolio scoping (S567): a regular admin only sees tenants whose active
    // lease sits under a landlord in their portfolio; super_admin sees all.
    const scopeId = req.user?.role === 'super_admin' ? null : req.user?.userId
    const tenants = await query<any>(`
      SELECT t.id, t.ach_verified, t.bank_last4, t.on_time_pay_enrolled,
             t.credit_reporting_enrolled, t.flex_deposit_enrolled, t.float_fee_active,
             t.ssi_ssdi, t.late_payment_count, t.created_at,
             u.first_name, u.last_name, u.email, u.phone,
             un.unit_number, p.name AS property_name,
             lu.first_name AS landlord_first, lu.last_name AS landlord_last
       FROM tenants t
       JOIN users u ON u.id = t.user_id
       LEFT JOIN LATERAL (
         SELECT un2.id, un2.unit_number, un2.property_id, un2.landlord_id
         FROM v_lease_active_tenants vlat
         JOIN leases le ON le.id = vlat.lease_id AND le.status = 'active'
         JOIN units un2 ON un2.id = le.unit_id
         WHERE vlat.tenant_id = t.id
         ORDER BY (vlat.role = 'primary') DESC
         LIMIT 1
       ) un ON TRUE
       LEFT JOIN properties p ON p.id = un.property_id
       LEFT JOIN landlords ld ON ld.id = un.landlord_id
       LEFT JOIN users lu ON lu.id = ld.user_id
       WHERE $1::uuid IS NULL
          OR ld.portfolio_manager_id = $1::uuid
          OR ld.service_manager_id = $1::uuid
       ORDER BY u.last_name, u.first_name
    `, [scopeId])
    res.json({ success: true, data: tenants })
  } catch (e) { next(e) }
}
adminRouter.get('/tenants', tenantsListHandler)

// ── PROJECTED PLATFORM INCOME ─────────────────────────────────
adminRouter.get('/income/projection', requireSuperAdmin, async (_req, res, next) => {
  try {
    // Unit counts
    const [units] = await query<any>(`
      SELECT
        COUNT(*) FILTER (WHERE u.status='active' AND t.on_time_pay_enrolled=TRUE)::int  AS otp_units,
        COUNT(*) FILTER (WHERE u.status='active' AND (t.on_time_pay_enrolled=FALSE OR t.id IS NULL))::int AS direct_units,
        COUNT(*) FILTER (WHERE u.status='active')::int AS active_units,
        COUNT(*) FILTER (WHERE u.status='vacant')::int AS vacant_units,
        COALESCE(SUM(u.rent_amount) FILTER (WHERE u.status='active'),0) AS total_rent
      FROM units u
      LEFT JOIN v_unit_occupancy vuo ON vuo.unit_id = u.id
      LEFT JOIN tenants t ON t.id = vuo.primary_tenant_id
    `)

    // Flex product counts
    const [flex] = await query<any>(`
      SELECT
        COUNT(*) FILTER (WHERE float_fee_active=TRUE)::int   AS flex_pay,
        COUNT(*) FILTER (WHERE ssi_ssdi=TRUE)::int           AS ssi_ssdi,
        COUNT(*) FILTER (WHERE flex_deposit_enrolled=TRUE)::int AS flex_deposit,
        COUNT(*) FILTER (WHERE credit_reporting_enrolled=TRUE)::int AS flex_credit
      FROM tenants
    `)

    // Platform fee — RECURRING subscription revenue under the live model:
    // $2 × occupied units, floored at the $10/PROPERTY minimum. The minimum is
    // a FLOOR (max of the two), NEVER added on top of the per-unit fee.
    // Computed PER PROPERTY via the canonical shared helper so this projection
    // matches real billing (platformFeeAccrual.ts). "Based on current
    // enrollment" → only properties with an occupied unit contribute; a fully
    // vacant property has no enrollment to project here. Excludes GAM system
    // properties (the renter-pool shell landlord).
    const propRows = await query<{ occ: string }>(`
      SELECT COUNT(*) FILTER (WHERE u.status='active')::int AS occ
        FROM properties p
        JOIN landlords l ON l.id = p.landlord_id
        LEFT JOIN units u ON u.property_id = p.id
       WHERE l.is_system IS NOT TRUE
       GROUP BY p.id
      HAVING COUNT(*) FILTER (WHERE u.status='active') > 0
    `)
    const platformUnitFees = propRows.reduce((sum, r) => sum + launchPlatformFeeForProperty(+r.occ), 0)

    // FlexPay is also recurring subscription revenue. Background checks are
    // ONE-TIME / transactional — intentionally EXCLUDED from this recurring,
    // ×12-annualized projection (they are not "current enrollment" revenue).
    const flexPayFees    = +flex.flex_pay * PLATFORM_FEES.FLOAT_FEE_MO

    // RECURRING total = the ARR basis. One-time revenue is NEVER in here.
    const totalMonthly   = +(platformUnitFees + flexPayFees).toFixed(2)
    const totalAnnual    = +(totalMonthly * 12).toFixed(2)

    // One-time / transactional revenue THIS MONTH — shown in the income-
    // composition pie so the full picture is visible, but EXCLUDED from the
    // recurring ARR above (per Nic: ARR must be cleanly recurring for valuation).
    const [bgChecks] = await query<any>(`
      SELECT COUNT(*)::int AS count FROM background_checks
      WHERE created_at >= date_trunc('month', CURRENT_DATE)
    `).catch(() => [{ count: 0 }])
    const bgCheckRevenue = +(+bgChecks.count * PLATFORM_FEES.BG_CHECK_NET).toFixed(2)

    // Full income composition for the pie (recurring + one-time). Each carries
    // a `recurring` flag so the UI can label/segment them.
    const incomeSources = [
      { key: 'platform_unit',     label: 'Platform Unit Fees', amount: +platformUnitFees.toFixed(2), recurring: true },
      { key: 'flexpay',           label: 'FlexPay',            amount: +flexPayFees.toFixed(2),      recurring: true },
      { key: 'background_checks', label: 'Background Checks',  amount: bgCheckRevenue,               recurring: false },
    ]
    const grossMonthly = +incomeSources.reduce((s, x) => s + x.amount, 0).toFixed(2)

    res.json({
      success: true,
      data: {
        monthly: {
          platform_unit_fees: +platformUnitFees.toFixed(2),
          flex_pay_fees:      +flexPayFees.toFixed(2),
          total:              totalMonthly,          // recurring only (ARR basis)
        },
        annual: totalAnnual,                          // recurring × 12
        gross_monthly: grossMonthly,                  // all sources incl. one-time
        income_sources: incomeSources,
        counts: {
          active_units:        +units.active_units,
          billable_properties: propRows.length,
          flex_pay:            +flex.flex_pay,
          bg_checks:           +bgChecks.count,
        }
      }
    })
  } catch (e) { next(e) }
})

// Income composition = ACTUAL realized revenue by source within a time window
// (the pie-chart data). Unlike the ARR snapshot above (forward recurring
// run-rate), this varies by period. One exception: the current in-progress
// month's platform fee accrues on the 1st, so mid-month there's no accrual row
// yet — we fill it with the current run-rate so the current month isn't
// understated. Past complete months use real accruals.
const INCOME_WINDOWS: Record<string, { start: string; label: string }> = {
  month:     { start: `date_trunc('month', CURRENT_DATE)`,     label: 'This month' },
  quarter:   { start: `date_trunc('quarter', CURRENT_DATE)`,   label: 'This quarter' },
  ytd:       { start: `date_trunc('year', CURRENT_DATE)`,      label: 'Year to date' },
  rolling12: { start: `(CURRENT_DATE - INTERVAL '12 months')`, label: 'Rolling 12 months' },
  all:       { start: `'1970-01-01'::timestamptz`,             label: 'All time' },
}

async function currentPlatformRunRate(): Promise<number> {
  const propRows = await query<{ occ: string }>(`
    SELECT COUNT(*) FILTER (WHERE u.status='active')::int AS occ
      FROM properties p
      JOIN landlords l ON l.id = p.landlord_id
      LEFT JOIN units u ON u.property_id = p.id
     WHERE l.is_system IS NOT TRUE
     GROUP BY p.id
    HAVING COUNT(*) FILTER (WHERE u.status='active') > 0
  `)
  return propRows.reduce((s, r) => s + launchPlatformFeeForProperty(+r.occ), 0)
}

async function computeComposition(key: string, startSql: string, label: string, platformRunRate: number) {
  const [pfa] = await query<any>(`
    SELECT COALESCE(SUM(pfa.total_amount), 0)::float AS amt
      FROM platform_fee_accruals pfa JOIN landlords l ON l.id = pfa.landlord_id
     WHERE l.is_system IS NOT TRUE
       AND pfa.accrual_month >= ${startSql}
       AND pfa.accrual_month <  date_trunc('month', CURRENT_DATE)
  `).catch(() => [{ amt: 0 }])
  const platform = +((pfa?.amt || 0) + platformRunRate).toFixed(2)
  const [fp] = await query<any>(`
    SELECT COALESCE(SUM(tenant_fee_amount), 0)::float AS amt
      FROM flexpay_advances WHERE created_at >= ${startSql}
  `).catch(() => [{ amt: 0 }])
  const flexpay = +(fp?.amt || 0).toFixed(2)
  const [bg] = await query<any>(`
    SELECT COUNT(*)::int AS n FROM background_checks WHERE created_at >= ${startSql}
  `).catch(() => [{ n: 0 }])
  const bgRevenue = +((bg?.n || 0) * PLATFORM_FEES.BG_CHECK_NET).toFixed(2)
  // Processing spread + instant-withdrawal + placement income — all live on the
  // platform_revenue_ledger, keyed by type. (platform_fee_subscription is NOT
  // pulled here — the platform fee is already counted above via run-rate +
  // accruals; pulling it again would double-count.)
  const [led] = await query<any>(`
    SELECT
      COALESCE(SUM(amount) FILTER (WHERE type='banking_spread'),       0)::float AS processing,
      COALESCE(SUM(amount) FILTER (WHERE type='manual_withdrawal_fee'),0)::float AS withdrawals,
      COALESCE(SUM(amount) FILTER (WHERE type='placement_fee_share'),  0)::float AS placement
    FROM platform_revenue_ledger WHERE created_at >= ${startSql}
  `).catch(() => [{ processing: 0, withdrawals: 0, placement: 0 }])
  // Business/POS platform fees (month is 'YYYY-MM' text — lexicographic compare).
  const [bpos] = await query<any>(`
    SELECT COALESCE(SUM(amount),0)::float AS amt FROM business_platform_fee_accruals
     WHERE month >= to_char((${startSql})::timestamptz, 'YYYY-MM')
  `).catch(() => [{ amt: 0 }])
  // FlexDeposit custody fee ($3/mo per FLEX_DEPOSIT_CUSTODY_FEE) while GAM holds
  // a tenant's deposit in custody. Recurring GAM revenue.
  const [fd] = await query<any>(`
    SELECT COALESCE(SUM(amount),0)::float AS amt FROM flex_deposit_custody_charges
     WHERE created_at >= ${startSql}
  `).catch(() => [{ amt: 0 }])
  // FlexCredit ($5/mo rent-reporting subscription). Wired but invisible until
  // launch — $0 until the first enrollment. GROSS $5 shown here (the ~$1.50
  // Esusu provider cost is COGS, tracked separately, not yet wired).
  const [fc] = await query<any>(`
    SELECT COALESCE(SUM(amount),0)::float AS amt FROM flexcredit_charges
     WHERE created_at >= ${startSql}
  `).catch(() => [{ amt: 0 }])

  const sources = [
    { key: 'platform_unit',       label: 'Platform Fees',        amount: platform,                        recurring: true },
    { key: 'processing',          label: 'Processing / ACH',     amount: +(led?.processing || 0).toFixed(2), recurring: true },
    { key: 'flexpay',             label: 'FlexPay',              amount: flexpay,                         recurring: true },
    { key: 'flex_deposit',        label: 'FlexDeposit Custody',  amount: +(fd?.amt || 0).toFixed(2),      recurring: true },
    { key: 'flex_credit',         label: 'FlexCredit',           amount: +(fc?.amt || 0).toFixed(2),      recurring: true },
    { key: 'business_pos',        label: 'Business Fees' ,         amount: +(bpos?.amt || 0).toFixed(2),    recurring: true },
    { key: 'placement',           label: 'Placement Fees',       amount: +(led?.placement || 0).toFixed(2),   recurring: false },
    { key: 'instant_withdrawal',  label: 'Instant Withdrawals',  amount: +(led?.withdrawals || 0).toFixed(2), recurring: false },
    { key: 'background_checks',   label: 'Background Checks',    amount: bgRevenue,                       recurring: false },
  ]
  const gross = +sources.reduce((s, x) => s + x.amount, 0).toFixed(2)
  return { window: key, label, gross, sources }
}

// GET /api/admin/income/composition?window=month|quarter|ytd|rolling12|all
adminRouter.get('/income/composition', requireSuperAdmin, async (req, res, next) => {
  try {
    const key = String(req.query.window || 'month')
    const win = INCOME_WINDOWS[key] || INCOME_WINDOWS.month
    const rr = await currentPlatformRunRate()
    res.json({ success: true, data: await computeComposition(key, win.start, win.label, rr) })
  } catch (e) { next(e) }
})

// GET /api/admin/income/composition/all — every window at once (the "wall of
// clocks": one pie per period, all on the page together).
adminRouter.get('/income/composition/all', requireSuperAdmin, async (_req, res, next) => {
  try {
    const rr = await currentPlatformRunRate()
    const keys = ['month', 'quarter', 'ytd', 'rolling12', 'all']
    const periods = await Promise.all(
      keys.map(k => computeComposition(k, INCOME_WINDOWS[k].start, INCOME_WINDOWS[k].label, rr))
    )
    res.json({ success: true, data: { periods } })
  } catch (e) { next(e) }
})

// GET /api/admin/income/breakdown?window=X — drill-down for one window: every
// income stream with its actual line items (the transactions that made up the
// pie). Feeds the click-through detail modal. Each stream's items are capped;
// totals are computed from the items so the modal's gross matches the pie.
adminRouter.get('/income/breakdown', requireSuperAdmin, async (req, res, next) => {
  try {
    const key = String(req.query.window || 'month')
    const win = INCOME_WINDOWS[key] || INCOME_WINDOWS.month
    const S = win.start
    const runRate = await currentPlatformRunRate()
    const q = (sql: string) => query<any>(sql).catch(() => [] as any[])

    const [platform, processing, flexpay, bpos, placement, withdrawals, bgc, fdc, fcc] = await Promise.all([
      q(`SELECT to_char(pfa.accrual_month,'Mon YYYY') AS date, p.name AS label, pfa.total_amount::float AS amount
           FROM platform_fee_accruals pfa JOIN landlords l ON l.id=pfa.landlord_id JOIN properties p ON p.id=pfa.property_id
          WHERE l.is_system IS NOT TRUE AND pfa.accrual_month >= ${S} AND pfa.accrual_month < date_trunc('month',CURRENT_DATE)
          ORDER BY pfa.accrual_month DESC LIMIT 100`),
      q(`SELECT to_char(created_at,'Mon DD') AS date, COALESCE(NULLIF(notes,''),'Processing spread') AS label, amount::float AS amount
           FROM platform_revenue_ledger WHERE type='banking_spread' AND created_at >= ${S} ORDER BY created_at DESC LIMIT 100`),
      q(`SELECT to_char(created_at,'Mon DD') AS date, 'FlexPay fee' AS label, tenant_fee_amount::float AS amount
           FROM flexpay_advances WHERE created_at >= ${S} ORDER BY created_at DESC LIMIT 100`),
      q(`SELECT bpfa.month AS date, 'Business POS fee' AS label, bpfa.amount::float AS amount
           FROM business_platform_fee_accruals bpfa WHERE bpfa.month >= to_char((${S})::timestamptz,'YYYY-MM') ORDER BY bpfa.month DESC LIMIT 100`),
      q(`SELECT to_char(created_at,'Mon DD') AS date, COALESCE(NULLIF(notes,''),'Placement fee') AS label, amount::float AS amount
           FROM platform_revenue_ledger WHERE type='placement_fee_share' AND created_at >= ${S} ORDER BY created_at DESC LIMIT 100`),
      q(`SELECT to_char(created_at,'Mon DD') AS date, COALESCE(NULLIF(notes,''),'Instant withdrawal') AS label, amount::float AS amount
           FROM platform_revenue_ledger WHERE type='manual_withdrawal_fee' AND created_at >= ${S} ORDER BY created_at DESC LIMIT 100`),
      q(`SELECT to_char(created_at,'Mon DD') AS date, TRIM(COALESCE(first_name,'')||' '||COALESCE(last_name,'')) AS label
           FROM background_checks WHERE created_at >= ${S} ORDER BY created_at DESC LIMIT 100`),
      q(`SELECT to_char(created_at,'Mon DD') AS date, 'FlexDeposit custody' AS label, amount::float AS amount
           FROM flex_deposit_custody_charges WHERE created_at >= ${S} ORDER BY created_at DESC LIMIT 100`),
      q(`SELECT to_char(created_at,'Mon DD') AS date, 'FlexCredit reporting' AS label, amount::float AS amount
           FROM flexcredit_charges WHERE created_at >= ${S} ORDER BY created_at DESC LIMIT 100`),
    ])

    // Current-month platform fee accrues on the 1st — surface the in-progress
    // run-rate as a synthetic "accruing" line so the total matches the pie.
    const platItems = [
      ...(runRate > 0 ? [{ date: 'This month', label: 'Current run-rate (accruing)', amount: runRate }] : []),
      ...platform,
    ]
    const bgItems = bgc.map((r: any) => ({ date: r.date, label: r.label || 'Screening', amount: PLATFORM_FEES.BG_CHECK_NET }))

    const sources = [
      { key: 'platform_unit',      label: 'Platform Fees',       items: platItems },
      { key: 'processing',         label: 'Processing / ACH',    items: processing },
      { key: 'flexpay',            label: 'FlexPay',             items: flexpay },
      { key: 'flex_deposit',       label: 'FlexDeposit Custody', items: fdc },
      { key: 'flex_credit',        label: 'FlexCredit',          items: fcc },
      { key: 'business_pos',       label: 'Business Fees' ,        items: bpos },
      { key: 'placement',          label: 'Placement Fees',      items: placement },
      { key: 'instant_withdrawal', label: 'Instant Withdrawals', items: withdrawals },
      { key: 'background_checks',  label: 'Background Checks',    items: bgItems },
    ].map(s => ({
      ...s,
      count: s.items.length,
      amount: +s.items.reduce((a: number, x: any) => a + (x.amount || 0), 0).toFixed(2),
    }))
    const gross = +sources.reduce((a, s) => a + s.amount, 0).toFixed(2)

    res.json({ success: true, data: { window: key, label: win.label, gross, sources } })
  } catch (e) { next(e) }
})


// ─── PROPERTY DUPLICATE FLAGS ─────────────────────────────────
adminRouter.get('/property-flags', requireSuperAdmin, async (req, res, next) => {
  try {
    const status = (req.query.status as string) || 'pending'
    let where = ''
    if (status === 'pending')  where = 'WHERE f.resolved_at IS NULL'
    if (status === 'resolved') where = 'WHERE f.resolved_at IS NOT NULL'
    const rows = await query<any>(`
      SELECT
        f.id, f.reason, f.detected_at, f.resolved_at, f.resolution, f.notes,
        f.property_id, f.conflicting_property_id,
        p1.name AS new_name, p1.street1 AS new_street1, p1.street2 AS new_street2,
          p1.city AS new_city, p1.state AS new_state, p1.zip AS new_zip,
          p1.review_status AS new_status, p1.created_at AS new_created_at,
        u1.first_name AS new_landlord_first, u1.last_name AS new_landlord_last,
          u1.email AS new_landlord_email, l1.business_name AS new_landlord_business,
        p2.name AS orig_name, p2.street1 AS orig_street1, p2.street2 AS orig_street2,
          p2.city AS orig_city, p2.state AS orig_state, p2.zip AS orig_zip,
          p2.created_at AS orig_created_at,
        u2.first_name AS orig_landlord_first, u2.last_name AS orig_landlord_last,
          u2.email AS orig_landlord_email, l2.business_name AS orig_landlord_business
      FROM property_duplicate_flags f
      JOIN properties p1 ON p1.id = f.property_id
      JOIN landlords  l1 ON l1.id = p1.landlord_id
      JOIN users      u1 ON u1.id = l1.user_id
      JOIN properties p2 ON p2.id = f.conflicting_property_id
      JOIN landlords  l2 ON l2.id = p2.landlord_id
      JOIN users      u2 ON u2.id = l2.user_id
      ${where}
      ORDER BY f.detected_at DESC
      LIMIT 500`)
    res.json({ success: true, data: rows })
  } catch (e) { next(e) }
})

adminRouter.post('/property-flags/:id/resolve', requireSuperAdmin, async (req: any, res, next) => {
  try {
    const { resolution, notes } = req.body as { resolution: 'approved_separate'|'merged'|'rejected'; notes?: string }
    if (!['approved_separate','merged','rejected'].includes(resolution)) {
      return res.status(400).json({ success: false, error: 'Invalid resolution' })
    }
    const flag = await queryOne<any>('SELECT * FROM property_duplicate_flags WHERE id=$1 AND resolved_at IS NULL', [req.params.id])
    if (!flag) return res.status(404).json({ success: false, error: 'Flag not found or already resolved' })

    await query(`
      UPDATE property_duplicate_flags
      SET resolved_at=now(), resolved_by=$1, resolution=$2, notes=$3
      WHERE id=$4`,
      [req.user.userId, resolution, notes || null, flag.id])

    // Update the flagged property's status based on resolution.
    // S73: typed via PropertyReviewStatus from @gam/shared.
    const newStatus: PropertyReviewStatus =
      resolution === 'approved_separate' ? 'active' :
      resolution === 'merged'            ? 'active' :
      /* rejected */                       'rejected'
    await query(`UPDATE properties SET review_status=$1 WHERE id=$2`, [newStatus, flag.property_id])

    await logAdminAction({
      adminUserId: req.user.userId,
      actionType: `property_flag_${resolution}`,
      targetId: flag.property_id,
      targetType: 'property',
      notes: notes || null,
      metadata: { flag_id: flag.id, resolution },
      ipAddress: req.ip ?? null,
    })

    res.json({ success: true })
  } catch (e) { next(e) }
})

// ── AUDIT LOG VIEWER (super_admin) ────────────────────────────
// S77: read-side for admin_action_log. Writers landed S67; this is the UI
// surface so super_admin can actually see the audit trail.

adminRouter.get('/audit-log', requireSuperAdmin, async (req, res, next) => {
  try {
    const limit = Math.min(Math.max(parseInt(String(req.query.limit ?? '100'), 10) || 100, 1), 200)
    const offset = Math.max(parseInt(String(req.query.offset ?? '0'), 10) || 0, 0)
    const actionType = typeof req.query.action_type === 'string' && req.query.action_type ? req.query.action_type : null
    const adminUserId = typeof req.query.admin_user_id === 'string' && req.query.admin_user_id ? req.query.admin_user_id : null
    const targetId = typeof req.query.target_id === 'string' && req.query.target_id ? req.query.target_id : null
    const from = typeof req.query.from === 'string' && req.query.from ? req.query.from : null
    const to = typeof req.query.to === 'string' && req.query.to ? req.query.to : null

    const where: string[] = []
    const params: any[] = []
    if (actionType)   { params.push(actionType);   where.push(`l.action_type = $${params.length}`) }
    if (adminUserId)  { params.push(adminUserId);  where.push(`l.admin_user_id = $${params.length}`) }
    if (targetId)     { params.push(targetId);     where.push(`l.target_id = $${params.length}`) }
    if (from)         { params.push(from);         where.push(`l.created_at >= $${params.length}`) }
    if (to)           { params.push(to);           where.push(`l.created_at < ($${params.length}::date + INTERVAL '1 day')`) }
    const whereSql = where.length ? `WHERE ${where.join(' AND ')}` : ''

    const rowsParams = [...params, limit, offset]
    const rows = await query<any>(`
      SELECT l.id, l.admin_user_id, l.action_type, l.target_id, l.target_type,
             l.notes, l.metadata, l.ip_address, l.created_at,
             u.email AS admin_email, u.first_name AS admin_first_name,
             u.last_name AS admin_last_name, u.role AS admin_role
      FROM admin_action_log l
      LEFT JOIN users u ON u.id = l.admin_user_id
      ${whereSql}
      ORDER BY l.created_at DESC
      LIMIT $${rowsParams.length - 1} OFFSET $${rowsParams.length}
    `, rowsParams)

    const totalRow = await queryOne<any>(`SELECT COUNT(*)::int AS total FROM admin_action_log l ${whereSql}`, params)

    const actionTypes = await query<any>(`SELECT DISTINCT action_type FROM admin_action_log ORDER BY action_type ASC`)
    const admins = await query<any>(`
      SELECT DISTINCT u.id, u.email, u.first_name, u.last_name, u.role
      FROM admin_action_log l
      JOIN users u ON u.id = l.admin_user_id
      ORDER BY u.email ASC
    `)

    res.json({
      success: true,
      data: {
        rows,
        total: totalRow?.total ?? 0,
        limit,
        offset,
        actionTypes: actionTypes.map(r => r.action_type),
        admins,
      },
    })
  } catch (e) { next(e) }
})

// ── INVOICE BACKFILL (super_admin) ────────────────────────────
// S100: explicit-window catch-up for invoice generation. The daily cron
// already runs a 30-day rolling catch-up; this endpoint exists for ops
// scenarios where a longer window is needed (cron outage, lease imported
// mid-cycle, etc.). dry_run=true returns the would-insert counts without
// writing — always run that first to confirm the blast radius before
// committing.

adminRouter.post('/invoices/backfill', requireSuperAdmin, async (req: any, res, next) => {
  try {
    const body = (req.body ?? {}) as {
      from?: unknown
      to?: unknown
      landlord_id?: unknown
      lease_id?: unknown
      dry_run?: unknown
    }

    const isISODate = (v: unknown): v is string =>
      typeof v === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(v)
    const isUuid = (v: unknown): v is string =>
      typeof v === 'string' && /^[0-9a-f-]{36}$/i.test(v)

    if (!isISODate(body.from)) throw new AppError(400, 'from is required as YYYY-MM-DD')
    if (!isISODate(body.to))   throw new AppError(400, 'to is required as YYYY-MM-DD')
    if (body.landlord_id != null && !isUuid(body.landlord_id)) throw new AppError(400, 'landlord_id must be a uuid')
    if (body.lease_id    != null && !isUuid(body.lease_id))    throw new AppError(400, 'lease_id must be a uuid')

    const dryRun = body.dry_run === true
    const result = await backfillInvoices({
      from: body.from,
      to: body.to,
      landlordId: isUuid(body.landlord_id) ? body.landlord_id : undefined,
      leaseId:    isUuid(body.lease_id)    ? body.lease_id    : undefined,
      dryRun,
    })

    await logAdminAction({
      adminUserId: req.user!.userId,
      actionType: dryRun ? 'invoices_backfill_dry_run' : 'invoices_backfill',
      targetId: null,
      targetType: 'invoice',
      notes: `from=${body.from} to=${body.to} invoices=${result.invoicesInserted} leases=${result.leasesProcessed}`,
      metadata: {
        from: body.from,
        to: body.to,
        landlord_id: isUuid(body.landlord_id) ? body.landlord_id : null,
        lease_id:    isUuid(body.lease_id)    ? body.lease_id    : null,
        dry_run: dryRun,
        ...result,
      },
      ipAddress: req.ip ?? null,
    })

    res.json({ success: true, data: { dryRun, ...result } })
  } catch (e) { next(e) }
})

// ── EMAIL FAILURES (super_admin) ──────────────────────────────────────────
// S101: global ops view of recent failed email sends. Per-landlord lookup
// lives at GET /api/landlords/me/email-failures. status filter defaults to
// 'failed' (the operational use case); pass status=sent for delivery audit.

adminRouter.get('/email-failures', requireSuperAdmin, async (req, res, next) => {
  try {
    const limit = Math.min(Math.max(parseInt(String(req.query.limit ?? '100'), 10) || 100, 1), 500)
    const sinceDays = Math.min(Math.max(parseInt(String(req.query.since_days ?? '7'), 10) || 7, 1), 365)
    const statusFilter = req.query.status === 'sent' ? 'sent' : 'failed'
    const category = typeof req.query.category === 'string' && req.query.category ? req.query.category : null

    const where: string[] = [
      `status = $1`,
      `created_at >= NOW() - ($2::int * INTERVAL '1 day')`,
    ]
    const params: any[] = [statusFilter, sinceDays]
    if (category) { params.push(category); where.push(`category = $${params.length}`) }

    params.push(limit)
    const rows = await query<any>(`
      SELECT id, to_email, subject, category, status, error_message,
             landlord_id, related_entity_type, related_entity_id, metadata, created_at
        FROM email_send_log
       WHERE ${where.join(' AND ')}
       ORDER BY created_at DESC
       LIMIT $${params.length}
    `, params)

    res.json({ success: true, data: { rows, status: statusFilter, sinceDays, limit } })
  } catch (e) { next(e) }
})

// ── ADMIN NOTIFICATIONS (S132) ────────────────────────────────────────────
// In-app + email surface for admin-relevant alerts (ACH retry confirm
// failures, allocation engine breaks, post-commit pm_transfer failures,
// e-sign lease build failures). Replaces console.error sites that were
// previously invisible.

adminRouter.get('/notifications', async (req, res, next) => {
  try {
    const limit = Math.min(Math.max(parseInt(String(req.query.limit ?? '100'), 10) || 100, 1), 500)
    const severity = typeof req.query.severity === 'string' ? req.query.severity : null
    const category = typeof req.query.category === 'string' ? req.query.category : null
    const includeAcked = req.query.include_acknowledged === 'true'

    const where: string[] = []
    const params: any[] = []
    if (!includeAcked) where.push('acknowledged_at IS NULL')
    if (severity) { params.push(severity); where.push(`severity = $${params.length}`) }
    if (category) { params.push(category); where.push(`category = $${params.length}`) }
    params.push(limit)

    const rows = await query<any>(`
      SELECT n.id, n.severity, n.category, n.title, n.body, n.context,
             n.acknowledged_at, n.acknowledged_by,
             u.email AS acknowledged_by_email,
             n.created_at
        FROM admin_notifications n
        LEFT JOIN users u ON u.id = n.acknowledged_by
        ${where.length ? 'WHERE ' + where.join(' AND ') : ''}
       ORDER BY n.created_at DESC
       LIMIT $${params.length}
    `, params)

    const counts = await queryOne<any>(`
      SELECT
        COUNT(*) FILTER (WHERE acknowledged_at IS NULL)                          AS unacked,
        COUNT(*) FILTER (WHERE acknowledged_at IS NULL AND severity = 'critical') AS unacked_critical,
        COUNT(*) FILTER (WHERE acknowledged_at IS NULL AND severity = 'warn')     AS unacked_warn,
        COUNT(*) FILTER (WHERE acknowledged_at IS NULL AND severity = 'info')     AS unacked_info
        FROM admin_notifications
    `)

    res.json({ success: true, data: { rows, counts, limit, includeAcked } })
  } catch (e) { next(e) }
})

adminRouter.post('/notifications/:id/acknowledge', async (req: any, res, next) => {
  try {
    const updated = await queryOne<any>(`
      UPDATE admin_notifications
         SET acknowledged_at = NOW(),
             acknowledged_by = $1
       WHERE id = $2
         AND acknowledged_at IS NULL
       RETURNING id, acknowledged_at, acknowledged_by
    `, [req.user!.userId, req.params.id])
    if (!updated) throw new AppError(404, 'Notification not found or already acknowledged')
    res.json({ success: true, data: updated })
  } catch (e) { next(e) }
})

// ─────────────────────────────────────────────────────────────
// SYSTEM FEATURES (S155)
// Platform-level feature flags. List is admin-readable; toggle
// is super_admin-only.
// ─────────────────────────────────────────────────────────────
adminRouter.get('/system-features', requireOwner, async (_req, res, next) => {
  try {
    const { listFeatures } = await import('../services/systemFeatures')
    const rows = await listFeatures()
    res.json({ success: true, data: rows })
  } catch (e) { next(e) }
})

adminRouter.patch('/system-features/:key', requireOwner, async (req, res, next) => {
  try {
    const enabled = !!req.body.enabled
    const { setFeatureEnabled } = await import('../services/systemFeatures')
    await setFeatureEnabled(req.params.key, enabled, req.user!.userId)
    res.json({ success: true })
  } catch (e) { next(e) }
})

// PATCH /api/admin/landlords/:id/otp-rollout — toggle per-landlord beta.
// OTP is hidden/shelved (S567); owner-only so nobody else can touch it.
adminRouter.patch('/landlords/:id/otp-rollout', requireOwner, async (req, res, next) => {
  try {
    const enabled = !!req.body.enabled
    await query('UPDATE landlords SET otp_rollout_enabled = $1 WHERE id = $2', [enabled, req.params.id])
    res.json({ success: true })
  } catch (e) { next(e) }
})

// S244: Retry a failed OTP advance Transfer. An advance row whose
// stripe.transfers.create errored on the original cron pass sits with
// status='pending' + transfer_error set. The admin alert points here.
// Idempotent — fireOtpAdvanceTransfer uses the same Idempotency-Key
// as the cron pass (otp_advance_<id>), so re-firing returns the
// original Transfer if it actually succeeded behind a reported error
// (e.g. network blip mid-response). Allowed for both admin and
// super_admin since this is recovery / loss-mitigation work.
adminRouter.post('/otp/advances/:id/retry-transfer', requireOwner, async (req, res, next) => {
  try {
    const adv = await queryOne<{
      id: string
      landlord_id: string
      tenant_id: string
      cycle_month: string
      advance_amount: string
      status: string
      stripe_transfer_id: string | null
      connect_account_id: string | null
    }>(
      `SELECT a.id, a.landlord_id, a.tenant_id, a.cycle_month, a.advance_amount,
              a.status, a.stripe_transfer_id,
              u.stripe_connect_account_id AS connect_account_id
         FROM otp_advances a
         JOIN landlords l ON l.id = a.landlord_id
         JOIN users u     ON u.id = l.user_id
        WHERE a.id = $1`,
      [req.params.id],
    )
    if (!adv) throw new AppError(404, 'OTP advance not found')
    if (adv.stripe_transfer_id) {
      throw new AppError(409, `Already funded — transfer ${adv.stripe_transfer_id}`)
    }
    if (!adv.connect_account_id) {
      throw new AppError(409, 'Landlord has no Stripe Connect account — onboarding must complete before retry')
    }

    const { fireOtpAdvanceTransfer } = await import('../services/otp')
    const out = await fireOtpAdvanceTransfer({
      advanceId:       adv.id,
      landlordConnect: adv.connect_account_id,
      amount:          Number(adv.advance_amount),
      cycle:           adv.cycle_month,
      tenantId:        adv.tenant_id,
      landlordId:      adv.landlord_id,
    })
    res.json({ success: true, data: out })
  } catch (e) { next(e) }
})

// S253: FlexCharge statement billing retry. A statement billing
// attempt that failed (e.g., customer payment method temporarily
// unavailable) lands in status='failed' with failed_reason set.
// Admin reviews + re-fires via this route. Resets status to 'open'
// and runs the standard processFlexChargeStatementBilling cron pass
// inline so the operator sees the result immediately.
adminRouter.post('/flexcharge/statements/:id/retry-billing', requireAdmin, async (req, res, next) => {
  try {
    const { retryFlexChargeStatement } = await import('../services/flexCharge')
    const out = await retryFlexChargeStatement(req.params.id)
    res.json({ success: true, data: out })
  } catch (e) { next(e) }
})

// S257: FlexDeposit portability — admin reverse-Transfer ops surface.
// When a tenant carries forward a landlord-held deposit (S255), the
// security_deposits row re-points to the new lease and flips
// held_by='gam_escrow' immediately, but the physical funds still sit
// in the previous landlord's Connect balance. Status goes to
// 'pending_transfer' and an admin alert fires. Admin moves the funds
// out-of-band (Stripe Dashboard reverse-Transfer, ACH, or another
// channel) and confirms via the mark-transferred route here.

adminRouter.get('/deposit-portability/pending', requireSuperAdmin, async (_req, res, next) => {
  try {
    const rows = await query<any>(
      `SELECT sd.id, sd.tenant_id, sd.unit_id, sd.lease_id,
              sd.total_amount::text AS total_amount,
              sd.portability_authorized_at::text AS portability_authorized_at,
              sd.portability_target_lease_id,
              sd.carried_from_deposit_id,
              sd.notes,
              -- Tenant
              tu.first_name || ' ' || tu.last_name AS tenant_name,
              tu.email AS tenant_email,
              -- New lease + landlord (after re-point)
              new_p.name AS new_property_name,
              new_u.unit_number AS new_unit_number,
              new_lu.first_name || ' ' || new_lu.last_name AS new_landlord_name,
              new_lu.email AS new_landlord_email,
              -- Old landlord — derive from the source security_deposits row
              -- via carried_from_deposit_id if set, else fall back to a
              -- best-effort lookup via the previous landlord's units.
              prev_lu.first_name || ' ' || prev_lu.last_name AS prev_landlord_name,
              prev_lu.email AS prev_landlord_email,
              prev_lu.stripe_connect_account_id AS prev_landlord_connect_id
         FROM security_deposits sd
         JOIN tenants t       ON t.id = sd.tenant_id
         JOIN users   tu      ON tu.id = t.user_id
         JOIN units   new_u   ON new_u.id = sd.unit_id
         JOIN properties new_p ON new_p.id = new_u.property_id
         JOIN landlords new_l  ON new_l.id = new_p.landlord_id
         JOIN users   new_lu   ON new_lu.id = new_l.user_id
         LEFT JOIN security_deposits prev_sd ON prev_sd.id = sd.carried_from_deposit_id
         LEFT JOIN leases    prev_l  ON prev_l.id = prev_sd.lease_id
         LEFT JOIN landlords prev_la ON prev_la.id = prev_l.landlord_id
         LEFT JOIN users     prev_lu ON prev_lu.id = prev_la.user_id
        WHERE sd.portability_status = 'pending_transfer'
        ORDER BY sd.portability_authorized_at DESC NULLS LAST`,
    )
    res.json({ success: true, data: rows })
  } catch (e) { next(e) }
})

adminRouter.post('/deposit-portability/:depositId/mark-transferred', requireSuperAdmin, async (req: any, res, next) => {
  try {
    const { notes } = req.body || {}
    const dep = await queryOne<{ id: string; portability_status: string }>(
      `SELECT id, portability_status FROM security_deposits WHERE id = $1`,
      [req.params.depositId],
    )
    if (!dep) throw new AppError(404, 'Deposit not found')
    if (dep.portability_status !== 'pending_transfer') {
      throw new AppError(409, `Deposit is in '${dep.portability_status}' state; can only mark-transferred from 'pending_transfer'`)
    }

    const stamp = '[Admin transfer confirmed by user ' + req.user!.userId + ' at ' + new Date().toISOString() + ']'
    const noteAppend = notes ? stamp + ' ' + String(notes).slice(0, 500) : stamp

    await query(
      `UPDATE security_deposits
          SET portability_status = 'carried_forward',
              notes              = LEFT(COALESCE(notes || E'\\n', '') || $1, 2000),
              updated_at         = NOW()
        WHERE id = $2`,
      [noteAppend, req.params.depositId],
    )

    res.json({ success: true, data: { id: req.params.depositId, status: 'carried_forward' } })
  } catch (e) { next(e) }
})

// ── S541: FlexPay demand-test review queue ────────────────────────────────
//
// FlexPay fronts rent every cycle, so enrollment volume = GAM float.
// Initial rollout is approval-gated (Nic): tenant inquires from the
// tenant portal; an admin reviews the lease + verifies SSI/SSDI income
// here; only an approved inquiry unlocks enrollFlexPay (enforced in
// services/flexpay.ts). Inquiry volume doubles as the demand signal
// for whether outside capital is worth raising.

adminRouter.get('/flexpay/inquiries', requireSuperAdmin, async (req: any, res, next) => {
  try {
    const status = ['pending', 'approved', 'declined'].includes(req.query.status)
      ? req.query.status : null
    // S545: tier-2 (non-SSI/SSDI) rows carry an income hold until the
    // expansion flag opens; they always sort behind tier 1.
    const { isFeatureEnabled } = await import('../services/systemFeatures')
    const otherIncomeOpen = await isFeatureEnabled('flexpay_other_income_open')
    // S542c (Nic): queue ordered by FLOAT NEED — shortest float first,
    // FIFO created_at as tiebreak. Float = days between GAM's front
    // (lease grace-period end, default 5) and the tenant's benefit-
    // arrival day; a benefit day at/before grace-end is ~zero float.
    // Shorter float recycles bankroll faster (3 tenants × 1 week beats
    // 1 tenant × 3 weeks) and longer floats earn less per dollar-day.
    // Unknown day (questionnaire-funneled) sorts LAST until captured.
    // Position numbers are ADMIN-SIDE ONLY — tenants never see one.
    // state_hold rows keep their place but cannot be approved (422).
    const rows = await query<any>(
      `SELECT fi.id, fi.status, fi.claimed_income_source, fi.tenant_note,
              fi.admin_notes, fi.created_at, fi.reviewed_at,
              fi.desired_pull_day, fi.benefit_schedule,
              -- NB: CASE guard required — GREATEST(0, NULL) is 0 in
              -- Postgres, which would sort unknown-day rows FIRST.
              CASE WHEN fi.desired_pull_day IS NULL THEN NULL
                   ELSE GREATEST(0, fi.desired_pull_day - COALESCE(l.late_fee_grace_days, 5))
              END AS est_float_days,
              -- S545: lease context the reviewer needs — the terms the
              -- float rides on: due day, remaining term.
              l.rent_due_day, l.status AS lease_status,
              CASE WHEN l.end_date IS NULL THEN NULL
                   ELSE GREATEST(0, ROUND(EXTRACT(EPOCH FROM (l.end_date::timestamp - NOW())) / 2592000))::int
              END AS lease_months_left,
              t.id AS tenant_id, t.ssi_ssdi, t.ach_verified,
              t.flexpay_enrolled,
              u.first_name, u.last_name, u.email, u.phone,
              l.id AS lease_id, l.rent_amount AS lease_rent, l.start_date, l.end_date,
              un.unit_number, pr.name AS property_name, pr.state AS property_state,
              (bs.state IS NOT NULL) AS state_hold,
              (fi.claimed_income_source NOT IN ('ssi', 'ssdi') AND NOT $2::boolean) AS income_hold,
              fi.held_at, fi.hold_reason,
              fi.proof_original_name, fi.proof_uploaded_at,
              fi.auto_verification,
              t.flexpay_prequal->>'status' AS prequal_status,
              -- S578: prior FlexPay default → "returner". A defaulted advance
              -- means the tenant already consumed float and broke the pull;
              -- the 90-day lockout is only the FLOOR — on re-entry they go to
              -- the BACK of the queue, behind every first-time inquiry (in high
              -- demand that can be a year+, which is the intended deterrent).
              -- Permanent for now (any lifetime default marks them a returner).
              (EXISTS (SELECT 1 FROM flexpay_advances fa
                        WHERE fa.tenant_id = fi.tenant_id
                          AND fa.status = 'defaulted')
               AND NOT COALESCE(t.flexpay_returner_cleared, false)) AS is_flexpay_returner,
              -- S545c: lease-holder names for the document-name check.
              (SELECT string_agg(u2.first_name || ' ' || u2.last_name, ', ' ORDER BY u2.last_name)
                 FROM lease_tenants lt2
                 JOIN tenants t2 ON t2.id = lt2.tenant_id
                 JOIN users u2 ON u2.id = t2.user_id
                WHERE lt2.lease_id = l.id AND lt2.status = 'active') AS lease_holder_names,
              -- S545c: held rows carry NO number — they're out of the
              -- working queue until released (created_at preserved, so
              -- release restores their spot automatically).
              CASE WHEN fi.status = 'pending' AND fi.held_at IS NULL THEN
                (ROW_NUMBER() OVER (PARTITION BY (fi.status = 'pending' AND fi.held_at IS NULL) ORDER BY
                  -- S578: first-timers ahead of returners (false<true → ASC);
                  -- a returner who completed 12 clean pulls (cleared) drops back
                  -- to first-timer standing and is no longer demoted.
                  (EXISTS (SELECT 1 FROM flexpay_advances fa
                            WHERE fa.tenant_id = fi.tenant_id
                              AND fa.status = 'defaulted')
                   AND NOT COALESCE(t.flexpay_returner_cleared, false)) ASC,
                  (fi.claimed_income_source IN ('ssi', 'ssdi')) DESC,
                  CASE WHEN fi.desired_pull_day IS NULL THEN NULL
                       ELSE GREATEST(0, fi.desired_pull_day - COALESCE(l.late_fee_grace_days, 5))
                  END ASC NULLS LAST,
                  fi.created_at ASC))::int
              END AS queue_position,
              ru.email AS reviewed_by_email
         FROM flexpay_inquiries fi
         JOIN tenants t ON t.id = fi.tenant_id
         JOIN users u ON u.id = t.user_id
    LEFT JOIN LATERAL (
           SELECT l2.* FROM lease_tenants lt
             JOIN leases l2 ON l2.id = lt.lease_id
            WHERE lt.tenant_id = t.id AND lt.status = 'active'
              AND l2.status IN ('active', 'pending')
            ORDER BY l2.created_at DESC LIMIT 1
         ) l ON TRUE
    LEFT JOIN units un ON un.id = l.unit_id
    LEFT JOIN properties pr ON pr.id = un.property_id
    LEFT JOIN flexpay_blocked_states bs ON bs.state = pr.state
    LEFT JOIN users ru ON ru.id = fi.reviewed_by_user_id
        WHERE ($1::text IS NULL OR fi.status = $1)
        ORDER BY (fi.status = 'pending') DESC,
                 -- S578: returners demoted behind all first-timers (see column above).
                 is_flexpay_returner ASC,
                 (fi.claimed_income_source IN ('ssi', 'ssdi')) DESC,
                 CASE WHEN fi.desired_pull_day IS NULL THEN NULL
                      ELSE GREATEST(0, fi.desired_pull_day - COALESCE(l.late_fee_grace_days, 5))
                 END ASC NULLS LAST,
                 fi.created_at ASC`,
      [status, otherIncomeOpen],
    )
    res.json({ success: true, data: rows })
  } catch (e) { next(e) }
})

// Approve or decline. Approving with incomeVerified=true marks
// tenants.ssi_ssdi (the eligibility gate enrollFlexPay checks) — the
// admin is attesting they verified the SSI/SSDI award letter / bank
// deposit history. Approving WITHOUT it is blocked: an approved tenant
// who fails the ssi_ssdi eligibility check would be stuck in a
// contradictory state.
adminRouter.post('/flexpay/inquiries/:id/review', requireSuperAdmin, async (req: any, res, next) => {
  try {
    const body = z.object({
      action:         z.enum(['approve', 'decline']),
      // S546: legacy attestation fields accepted but IGNORED — the
      // checks are automated now (checkbox ritual removed per Nic).
      incomeVerified: z.boolean().optional(),
      nameMatchConfirmed: z.boolean().optional(),
      notes:          z.string().max(2000).optional(),
    }).parse(req.body)

    const inq = await queryOne<{ id: string; tenant_id: string; status: string; proof_uploaded_at: string | null; claimed_income_source: string; held_at: string | null; auto_verification: any }>(
      `SELECT id, tenant_id, status, proof_uploaded_at, claimed_income_source, held_at, auto_verification FROM flexpay_inquiries WHERE id = $1`,
      [req.params.id],
    )
    if (!inq) throw new AppError(404, 'Inquiry not found')

    // S545c: a held request can't be decided either way until the
    // discrepancy is resolved and the hold released.
    if (inq.held_at) {
      throw new AppError(422, 'This request is on a verification hold — resolve the discrepancy and release the hold first')
    }

    // S545: tier-2 income hold — non-SSI/SSDI requests wait in the
    // queue (place preserved) until the expansion flag opens.
    const isTier1 = inq.claimed_income_source === 'ssi' || inq.claimed_income_source === 'ssdi'
    if (body.action === 'approve' && !isTier1) {
      const { isFeatureEnabled } = await import('../services/systemFeatures')
      if (!(await isFeatureEnabled('flexpay_other_income_open'))) {
        throw new AppError(422,
          'Income-type hold: FlexPay currently serves SSI/SSDI only. This tier-2 request keeps its place; approve once the expansion flag (flexpay_other_income_open) is on.')
      }
    }

    // S545/S546: proof document required, and its AUTOMATED check must
    // have passed — the platform read the document and found a lease
    // holder's name ('matched'), or a human resolved a hold
    // ('manual_ok' — set by release-hold, the one exception path).
    // No checkboxes: the machine did the verification.
    if (body.action === 'approve' && !inq.proof_uploaded_at) {
      throw new AppError(422,
        'No proof of benefits on file — the tenant must upload their award letter (or benefit verification letter) before this request can be approved')
    }
    if (body.action === 'approve') {
      const nameMatch = inq.auto_verification?.nameMatch
      if (nameMatch !== 'matched' && nameMatch !== 'manual_ok') {
        throw new AppError(422,
          'Automated document check has not passed — the proof must contain a lease holder\'s name (or resolve via the hold/release path)')
      }
    }

    // S542b: state hold — a tenant whose property is in a blocked
    // state stays WAITLISTED (keeps their queue place); approval is
    // refused until the state clears (flexpay_blocked_states row
    // removed by superadmin).
    if (body.action === 'approve') {
      const hold = await queryOne<{ state: string; reason: string }>(
        `SELECT bs.state, bs.reason
           FROM lease_tenants lt
           JOIN leases l ON l.id = lt.lease_id
           JOIN units u ON u.id = l.unit_id
           JOIN properties pr ON pr.id = u.property_id
           JOIN flexpay_blocked_states bs ON bs.state = pr.state
          WHERE lt.tenant_id = $1 AND lt.status = 'active'
            AND l.status IN ('active', 'pending')
          LIMIT 1`,
        [inq.tenant_id])
      if (hold) {
        throw new AppError(422,
          `State hold: FlexPay is blocked in ${hold.state} (${hold.reason}). ` +
          `The tenant keeps their queue place; approve once the state clears.`)
      }
    }

    const newStatus = body.action === 'approve' ? 'approved' : 'declined'
    await query(
      `UPDATE flexpay_inquiries
          SET status = $1, admin_notes = $2,
              reviewed_by_user_id = $3, reviewed_at = NOW(), updated_at = NOW()
        WHERE id = $4`,
      [newStatus, body.notes ?? null, req.user!.userId, inq.id],
    )
    // ssi_ssdi is the SSI/SSDI service-tier flag — only a tier-1
    // approval may set it (a tier-2 approval verifying a pension is
    // NOT an SSI/SSDI attestation).
    if (body.action === 'approve' && isTier1) {
      await query(`UPDATE tenants SET ssi_ssdi = TRUE WHERE id = $1`, [inq.tenant_id])
    }

    await logAdminAction({
      adminUserId: req.user!.userId,
      actionType: `flexpay_inquiry_${newStatus}`,
      targetType: 'flexpay_inquiry',
      targetId: inq.id,
      notes: body.notes ?? null,
      metadata: { tenant_id: inq.tenant_id, income_verified: body.incomeVerified === true },
    })

    res.json({ success: true, data: { id: inq.id, status: newStatus } })
  } catch (e) { next(e) }
})

// S543: demand-funnel numbers for the FlexPay Requests page — the
// data Nic's capital-raise decision reads from: how many were asked,
// how many raised a hand, how many are approved/enrolled, and the
// monthly front commitment (sum of enrolled tenants' active-lease
// rent = bankroll out the door each cycle).
adminRouter.get('/flexpay/funnel', requireSuperAdmin, async (_req, res, next) => {
  try {
    const [q, i, other, enr] = await Promise.all([
      query<any>(`SELECT status, COUNT(*)::int AS n FROM tenant_questionnaires GROUP BY status`),
      query<any>(`SELECT status, COUNT(*)::int AS n FROM flexpay_inquiries GROUP BY status`),
      // S545: tier-2 backlog — non-SSI/SSDI requests waiting on the
      // expansion flag. The expand-to-other-income-types signal.
      // (Held rows excluded — they're out of the working queue.)
      queryOne<any>(
        `SELECT COUNT(*)::int AS n FROM flexpay_inquiries
          WHERE status = 'pending' AND held_at IS NULL
            AND claimed_income_source NOT IN ('ssi', 'ssdi')`),
      queryOne<any>(
        `SELECT COUNT(*)::int AS enrolled,
                COALESCE(SUM(l.rent_amount), 0)::float AS monthly_float
           FROM tenants t
      LEFT JOIN LATERAL (
             SELECT l2.rent_amount FROM lease_tenants lt
               JOIN leases l2 ON l2.id = lt.lease_id
              WHERE lt.tenant_id = t.id AND lt.status = 'active'
                AND l2.status IN ('active', 'pending')
              ORDER BY l2.created_at DESC LIMIT 1
           ) l ON TRUE
          WHERE t.flexpay_enrolled = TRUE`),
    ])
    const by = (rows: any[]) => Object.fromEntries(rows.map(r => [r.status, r.n]))
    res.json({ success: true, data: {
      questionnaires: by(q),
      inquiries: by(i),
      otherIncomeInterest: other?.n ?? 0,
      enrolled: enr?.enrolled ?? 0,
      monthlyFloat: enr?.monthly_float ?? 0,
    } })
  } catch (e) { next(e) }
})

// (S545: the short-lived /flexpay/interest-only roster endpoint was
// removed same-session — non-SSI/SSDI interest now files TIER-2
// inquiries directly into the main queue with an income hold.)

// S565: FlexCredit demand funnel. Interest count + the units-to-breakeven read
// (provider $500/mo min ÷ $1.50 rev-share = ~333 enrollments to fully absorb
// the minimum; $500 ÷ $5 sell = 100 enrollments to cover the min on revenue).
// interestRate = interested ÷ eligible active tenants → the real adoption signal
// that sets the launch gate. No billing/Esusu wired yet.
adminRouter.get('/flexcredit/funnel', requireAdmin, async (_req, res, next) => {
  try {
    const [byStatus, interested, eligible] = await Promise.all([
      query<any>(`SELECT status, COUNT(*)::int AS n FROM flexcredit_inquiries GROUP BY status`),
      queryOne<any>(`SELECT COUNT(*)::int AS n FROM flexcredit_inquiries WHERE status='interested'`),
      // Denominator for the adoption rate: tenants on an active lease.
      queryOne<any>(`SELECT COUNT(DISTINCT vuo.primary_tenant_id)::int AS n
                       FROM v_unit_occupancy vuo
                       JOIN units u ON u.id = vuo.unit_id AND u.status='active'
                      WHERE vuo.primary_tenant_id IS NOT NULL`),
    ])
    const interestedN = interested?.n ?? 0
    const eligibleN = eligible?.n ?? 0
    res.json({ success: true, data: {
      byStatus: Object.fromEntries(byStatus.map(r => [r.status, r.n])),
      interested: interestedN,
      eligibleTenants: eligibleN,
      interestRatePct: eligibleN > 0 ? +((interestedN / eligibleN) * 100).toFixed(1) : 0,
      breakevenEnrollments: 100,          // $500 min ÷ $5 sell (revenue covers the floor)
      minFullyAbsorbedEnrollments: 333,   // $500 min ÷ $1.50 rev-share
      wired: false,                        // billing/Esusu not built yet — demand capture only
    } })
  } catch (e) { next(e) }
})

// S545c: manual verification hold + release. Hold = silently out of
// the working queue (no tenant-facing signal — their portal keeps the
// normal pending copy). Release restores their original spot in line
// automatically (created_at is the tiebreak and never changes).
adminRouter.post('/flexpay/inquiries/:id/hold', requireSuperAdmin, async (req: any, res, next) => {
  try {
    const body = z.object({ reason: z.string().min(3).max(500) }).parse(req.body)
    const rows = await query<any>(
      `UPDATE flexpay_inquiries
          SET held_at = NOW(), hold_reason = $2, updated_at = NOW()
        WHERE id = $1 AND status = 'pending' AND held_at IS NULL
        RETURNING id`,
      [req.params.id, body.reason])
    if (rows.length === 0) throw new AppError(404, 'Inquiry not found, already held, or already reviewed')
    await logAdminAction({
      adminUserId: req.user!.userId, actionType: 'flexpay_inquiry_held',
      targetType: 'flexpay_inquiry', targetId: req.params.id, notes: body.reason,
    })
    res.json({ success: true, data: { id: req.params.id, held: true } })
  } catch (e) { next(e) }
})

adminRouter.post('/flexpay/inquiries/:id/release-hold', requireSuperAdmin, async (req: any, res, next) => {
  try {
    const body = z.object({ notes: z.string().max(500).optional() }).parse(req.body ?? {})
    // S546: releasing a hold IS the manual verification — record
    // manual_ok so the automated approve gate accepts the file
    // (unless the machine already matched it).
    const rows = await query<any>(
      `UPDATE flexpay_inquiries
          SET held_at = NULL, hold_reason = NULL,
              auto_verification = CASE
                WHEN auto_verification->>'nameMatch' = 'matched' THEN auto_verification
                ELSE COALESCE(auto_verification, '{}'::jsonb) ||
                     jsonb_build_object('nameMatch', 'manual_ok', 'checkedAt', NOW()::text)
              END,
              updated_at = NOW()
        WHERE id = $1 AND held_at IS NOT NULL
        RETURNING id`,
      [req.params.id])
    if (rows.length === 0) throw new AppError(404, 'Inquiry not found or not held')
    await logAdminAction({
      adminUserId: req.user!.userId, actionType: 'flexpay_inquiry_hold_released',
      targetType: 'flexpay_inquiry', targetId: req.params.id, notes: body.notes ?? null,
    })
    res.json({ success: true, data: { id: req.params.id, held: false } })
  } catch (e) { next(e) }
})

// S543: capture/correct the benefit-arrival day during reach-out.
// Pending inquiries only — the day drives float-need queue ordering,
// and once reviewed the real pull day is chosen at enrollment.
adminRouter.post('/flexpay/inquiries/:id/benefit-day', requireSuperAdmin, async (req: any, res, next) => {
  try {
    const body = z.object({ benefitDay: z.number().int().min(1).max(28) }).parse(req.body)
    const rows = await query<any>(
      `UPDATE flexpay_inquiries
          SET desired_pull_day = $2, updated_at = NOW()
        WHERE id = $1 AND status = 'pending'
        RETURNING id, desired_pull_day`,
      [req.params.id, body.benefitDay])
    if (rows.length === 0) throw new AppError(404, 'Inquiry not found or already reviewed')
    await logAdminAction({
      adminUserId: req.user!.userId, actionType: 'flexpay_inquiry_benefit_day_set',
      targetType: 'flexpay_inquiry', targetId: req.params.id,
      metadata: { benefit_day: body.benefitDay },
    })
    res.json({ success: true, data: rows[0] })
  } catch (e) { next(e) }
})

// S542b: admin view of a tenant's proof-of-income document. The
// tenant uploaded it to the PLATFORM (never landlord-visible); the
// reviewer opens it here before attesting income verification.
adminRouter.get('/flexpay/inquiries/:id/proof-file', requireSuperAdmin, async (req: any, res, next) => {
  try {
    const inq = await queryOne<{ proof_file_path: string | null }>(
      `SELECT proof_file_path FROM flexpay_inquiries WHERE id = $1`,
      [req.params.id])
    if (!inq) throw new AppError(404, 'Inquiry not found')
    if (!inq.proof_file_path) throw new AppError(404, 'No proof uploaded')
    const { flexpayProofContentType } = await import('./tenants')
    const fp = path.join(process.cwd(), 'uploads', 'flexpay-proofs', path.basename(inq.proof_file_path))
    if (!fs.existsSync(fp)) throw new AppError(404, 'File missing')
    res.setHeader('Content-Type', flexpayProofContentType(fp))
    fs.createReadStream(fp).pipe(res)
  } catch (e) { next(e) }
})

// S542b: state blocks — superadmin-managed list of states where a
// legal requirement prevents offering FlexPay. Starts EMPTY (no state
// identified); this is the mechanism per the S177 posture. Tenants in
// a blocked state stay waitlisted with their queue place preserved.
adminRouter.get('/flexpay/blocked-states', requireSuperAdmin, async (_req, res, next) => {
  try {
    const rows = await query<any>(
      `SELECT state, reason, created_at FROM flexpay_blocked_states ORDER BY state`)
    res.json({ success: true, data: rows })
  } catch (e) { next(e) }
})

adminRouter.put('/flexpay/blocked-states/:state', requireSuperAdmin, async (req: any, res, next) => {
  try {
    const state = String(req.params.state || '').toUpperCase()
    if (!/^[A-Z]{2}$/.test(state)) throw new AppError(400, 'state must be a 2-letter code')
    const body = z.object({ reason: z.string().min(3).max(500) }).parse(req.body)
    await query(
      `INSERT INTO flexpay_blocked_states (state, reason) VALUES ($1, $2)
       ON CONFLICT (state) DO UPDATE SET reason = $2`,
      [state, body.reason])
    // targetId is a uuid column — state codes ride in metadata.
    await logAdminAction({
      adminUserId: req.user!.userId, actionType: 'flexpay_state_blocked',
      targetType: 'flexpay_blocked_state', notes: body.reason,
      metadata: { state },
    })
    res.json({ success: true, data: { state, reason: body.reason } })
  } catch (e) { next(e) }
})

adminRouter.delete('/flexpay/blocked-states/:state', requireSuperAdmin, async (req: any, res, next) => {
  try {
    const state = String(req.params.state || '').toUpperCase()
    const rows = await query<any>(
      `DELETE FROM flexpay_blocked_states WHERE state = $1 RETURNING state`, [state])
    if (rows.length === 0) throw new AppError(404, 'State not blocked')
    await logAdminAction({
      adminUserId: req.user!.userId, actionType: 'flexpay_state_unblocked',
      targetType: 'flexpay_blocked_state',
      metadata: { state },
    })
    res.json({ success: true, data: { state, unblocked: true } })
  } catch (e) { next(e) }
})

// ── S163: Connect readiness backfill ──────────────────────────────────────
//
// Pre-S160 landlord Connect accounts (and pre-S159 PM Connect accounts)
// have connect_payouts_enabled=false even though they may have completed
// KYC at Stripe long ago. Stripe re-fires account.updated periodically
// but not on a known schedule, so the booleans can stay stale indefinitely.
//
// This endpoint walks every users / pm_companies row that has a
// stripe_connect_account_id but isn't yet flagged ready, calls
// fetchAccountStatus live for each, and writes the cached flags. Synchronous
// so the admin sees the result counts inline; rate-limited Stripe API calls
// happen in series (Stripe's default rate limit is ~100/sec for accounts.retrieve
// in test mode, well above expected backfill volume).
adminRouter.post('/connect-readiness/backfill', async (req: any, res, next) => {
  try {
    const result = {
      users: { scanned: 0, updated: 0, errors: 0 },
      pm_companies: { scanned: 0, updated: 0, errors: 0 },
      errors: [] as Array<{ entity: 'user' | 'pm_company'; id: string; message: string }>,
    }

    const userRows = await query<{ id: string; stripe_connect_account_id: string }>(
      `SELECT id, stripe_connect_account_id
         FROM users
        WHERE stripe_connect_account_id IS NOT NULL
          AND (connect_payouts_enabled = false OR connect_details_submitted = false)`
    )
    for (const row of userRows) {
      result.users.scanned++
      try {
        const status = await fetchAccountStatus(row.stripe_connect_account_id)
        await query(
          `UPDATE users
              SET stripe_connect_status_synced_at = NOW(),
                  connect_charges_enabled    = $2,
                  connect_payouts_enabled    = $3,
                  connect_details_submitted  = $4
            WHERE id = $1`,
          [row.id, status.charges_enabled, status.payouts_enabled, status.details_submitted]
        )
        result.users.updated++
      } catch (e: any) {
        result.users.errors++
        result.errors.push({ entity: 'user', id: row.id, message: e?.message ?? String(e) })
      }
    }

    const pmRows = await query<{ id: string; stripe_connect_account_id: string }>(
      `SELECT id, stripe_connect_account_id
         FROM pm_companies
        WHERE stripe_connect_account_id IS NOT NULL
          AND (connect_payouts_enabled = false OR connect_details_submitted = false)`
    )
    for (const row of pmRows) {
      result.pm_companies.scanned++
      try {
        const status = await fetchAccountStatus(row.stripe_connect_account_id)
        await query(
          `UPDATE pm_companies
              SET stripe_connect_status_synced_at = NOW(),
                  connect_charges_enabled    = $2,
                  connect_payouts_enabled    = $3,
                  connect_details_submitted  = $4
            WHERE id = $1`,
          [row.id, status.charges_enabled, status.payouts_enabled, status.details_submitted]
        )
        result.pm_companies.updated++
      } catch (e: any) {
        result.pm_companies.errors++
        result.errors.push({ entity: 'pm_company', id: row.id, message: e?.message ?? String(e) })
      }
    }

    await logAdminAction({
      adminUserId: req.user!.userId,
      actionType: 'connect_readiness_backfill',
      metadata: {
        users_scanned: result.users.scanned,
        users_updated: result.users.updated,
        pm_companies_scanned: result.pm_companies.scanned,
        pm_companies_updated: result.pm_companies.updated,
      },
    })

    res.json({ success: true, data: result })
  } catch (e) { next(e) }
})

// GET /api/admin/connect-readiness/accounts — list every Connect-bearing
// account (user or pm_company), with cached readiness flags + last
// synced_at. Drives the admin ConnectAccountsPage.
adminRouter.get('/connect-readiness/accounts', async (req: any, res, next) => {
  try {
    // S567: super sees every Connect account; a regular admin (portfolio
    // manager) sees only the landlords they close or service (and no PM
    // companies — those are platform-level).
    const scopeId = req.user?.role === 'super_admin' ? null : req.user?.userId
    const userRows = await query<any>(`
      SELECT 'user' AS entity_type,
             u.id AS entity_id,
             COALESCE(u.first_name || ' ' || u.last_name, u.email) AS display_name,
             u.email,
             u.role,
             u.stripe_connect_account_id,
             u.connect_charges_enabled,
             u.connect_payouts_enabled,
             u.connect_details_submitted,
             u.stripe_connect_status_synced_at
        FROM users u
       WHERE u.stripe_connect_account_id IS NOT NULL
         AND ($1::uuid IS NULL OR u.id IN (
           SELECT user_id FROM landlords WHERE portfolio_manager_id = $1 OR service_manager_id = $1))
       ORDER BY u.connect_payouts_enabled ASC, u.email ASC
    `, [scopeId])
    const pmRows = scopeId ? [] : await query<any>(`
      SELECT 'pm_company' AS entity_type,
             c.id AS entity_id,
             c.name AS display_name,
             c.business_email AS email,
             c.status AS role,
             c.stripe_connect_account_id,
             c.connect_charges_enabled,
             c.connect_payouts_enabled,
             c.connect_details_submitted,
             c.stripe_connect_status_synced_at
        FROM pm_companies c
       WHERE c.stripe_connect_account_id IS NOT NULL
       ORDER BY c.connect_payouts_enabled ASC, c.name ASC
    `)
    res.json({ success: true, data: [...userRows, ...pmRows] })
  } catch (e) { next(e) }
})

// GET /api/admin/landlord-banking-nudges — list of tenant→landlord nudge
// emails sent (S163). Drives the admin Connect Accounts page sub-section
// for support visibility into who's been blocked on which landlord's
// onboarding completion. Pulls from email_send_log; no new table.
adminRouter.get('/landlord-banking-nudges', async (req: any, res, next) => {
  try {
    // S567: scope banking nudges to the regular admin's portfolio; super sees all.
    const scopeId = req.user?.role === 'super_admin' ? null : req.user?.userId
    const rows = await query<any>(`
      SELECT esl.id,
             esl.created_at,
             esl.to_email     AS landlord_email,
             esl.status,
             esl.error_message,
             esl.related_entity_id AS tenant_id,
             esl.metadata,
             esl.landlord_id,
             COALESCE(u_tenant.first_name || ' ' || u_tenant.last_name, u_tenant.email) AS tenant_name,
             COALESCE(u_landlord.first_name || ' ' || u_landlord.last_name, u_landlord.email) AS landlord_name,
             u_landlord.connect_payouts_enabled AS landlord_payouts_enabled,
             u_landlord.connect_details_submitted AS landlord_details_submitted
        FROM email_send_log esl
   LEFT JOIN tenants t          ON t.id = esl.related_entity_id
   LEFT JOIN users u_tenant     ON u_tenant.id = t.user_id
   LEFT JOIN landlords ll       ON ll.id = esl.landlord_id
   LEFT JOIN users u_landlord   ON u_landlord.id = ll.user_id
       WHERE esl.category = 'landlord_banking_nudge'
         AND ($1::uuid IS NULL OR ll.portfolio_manager_id = $1 OR ll.service_manager_id = $1)
       ORDER BY esl.created_at DESC
       LIMIT 200
    `, [scopeId])
    res.json({ success: true, data: rows })
  } catch (e) { next(e) }
})

// POST /api/admin/connect-readiness/refresh/:entity/:id — refresh one
// row's cached flags from Stripe live state. Single-row complement to
// the bulk backfill above; useful when a support call lands and admin
// wants a fresh read for one specific account.
adminRouter.post('/connect-readiness/refresh/:entity/:id', async (req: any, res, next) => {
  try {
    const entity = req.params.entity
    if (entity !== 'user' && entity !== 'pm_company') {
      throw new AppError(400, "entity must be 'user' or 'pm_company'")
    }
    const table = entity === 'user' ? 'users' : 'pm_companies'

    const row = await queryOne<{ stripe_connect_account_id: string | null }>(
      `SELECT stripe_connect_account_id FROM ${table} WHERE id = $1`,
      [req.params.id]
    )
    if (!row) throw new AppError(404, `${entity} not found`)
    if (!row.stripe_connect_account_id) {
      throw new AppError(400, 'No Connect account on this row')
    }

    const status = await fetchAccountStatus(row.stripe_connect_account_id)
    await query(
      `UPDATE ${table}
          SET stripe_connect_status_synced_at = NOW(),
              connect_charges_enabled    = $2,
              connect_payouts_enabled    = $3,
              connect_details_submitted  = $4
        WHERE id = $1`,
      [req.params.id, status.charges_enabled, status.payouts_enabled, status.details_submitted]
    )

    await logAdminAction({
      adminUserId: req.user!.userId,
      actionType: 'connect_readiness_refresh',
      targetId: req.params.id,
      targetType: entity,
      metadata: { stripe_account_id: row.stripe_connect_account_id, ...status },
    })

    res.json({ success: true, data: { ...status } })
  } catch (e) { next(e) }
})


// ── CSV-import review queue (S295 + S296) ─────────────────────────────
// Admin surface for reviewing landlord CSV migrations against real
// source-platform exports. Lists every validate + commit captured by
// the csvImportAttempts service (apps/api/src/services/
// csvImportAttempts.ts).
//
// Access tiers:
//   - List (this endpoint) — admin OR super_admin. Surfaces landlord
//     email + counts + status. No tenant PII at the list level.
//   - Detail (GET :id) — super_admin only. Sample rows carry tenant
//     PII (names, emails) so this is gated tighter.
//   - Mark-reviewed (POST :id/mark-reviewed) — super_admin only.
//   - Verification flip (POST platform-review-statuses) — super_admin
//     only. Reshapes the verification lifecycle.

// GET /api/admin/csv-import-attempts
// Query params:
//   ?status=pending  — only validated|committed (not yet reviewed)
//   ?status=all      — every attempt
//   ?platform=<key>  — filter by platform key
//   ?import_type=tenant|property|payment
//   ?limit=N         — default 50, max 200
adminRouter.get('/csv-import-attempts', requireSuperAdmin, async (req, res, next) => {
  try {
    const statusFilter   = String(req.query.status || 'pending').toLowerCase()
    const platformFilter = req.query.platform ? String(req.query.platform).toLowerCase() : null
    const typeFilter     = req.query.import_type ? String(req.query.import_type).toLowerCase() : null
    const limit = Math.min(Math.max(parseInt(String(req.query.limit ?? '50'), 10) || 50, 1), 200)

    const where: string[] = []
    const params: any[] = []
    if (statusFilter === 'pending') {
      where.push(`status IN ('validated', 'committed')`)
    } else if (statusFilter === 'reviewed') {
      where.push(`status = 'reviewed'`)
    }
    if (platformFilter) {
      params.push(platformFilter)
      where.push(`platform_key = $${params.length}`)
    }
    if (typeFilter) {
      params.push(typeFilter)
      where.push(`import_type = $${params.length}`)
    }
    const whereSql = where.length > 0 ? `WHERE ${where.join(' AND ')}` : ''
    params.push(limit)

    const rows = await query<any>(`
      SELECT
        a.id,
        a.landlord_id,
        u.first_name AS landlord_first_name,
        u.last_name  AS landlord_last_name,
        u.email      AS landlord_email,
        a.import_type,
        a.platform_key,
        a.claimed_platform_name,
        a.row_count,
        a.blockers,
        a.warnings,
        a.status,
        a.reviewed_by,
        a.reviewed_at,
        a.created_at,
        jsonb_array_length(a.column_headers) AS column_count
        FROM csv_import_attempts a
        JOIN landlords l ON l.id = a.landlord_id
        JOIN users u     ON u.id = l.user_id
        ${whereSql}
       ORDER BY a.created_at DESC
       LIMIT $${params.length}
    `, params)

    res.json({ success: true, data: { rows, limit, filters: { status: statusFilter, platform: platformFilter, import_type: typeFilter } } })
  } catch (e) { next(e) }
})

// GET /api/admin/csv-import-attempts/:id
// Returns one attempt with full column_headers + sample_rows.
// S298: also returns related_validate_attempt_id — the most-recent
// validate row from the same (landlord, platform, type) that
// preceded this attempt. Lets the admin UI cross-link from a
// commit row (which has empty column_headers / sample_rows) to
// the validate row that captured the actual upload shape.
adminRouter.get('/csv-import-attempts/:id', requireSuperAdmin, async (req, res, next) => {
  try {
    const row = await queryOne<any>(`
      SELECT
        a.*,
        u.first_name AS landlord_first_name,
        u.last_name  AS landlord_last_name,
        u.email      AS landlord_email,
        ru.first_name AS reviewer_first_name,
        ru.last_name  AS reviewer_last_name
        FROM csv_import_attempts a
        JOIN landlords l ON l.id = a.landlord_id
        JOIN users u     ON u.id = l.user_id
        LEFT JOIN users ru ON ru.id = a.reviewed_by
       WHERE a.id = $1
    `, [req.params.id])
    if (!row) throw new AppError(404, 'Attempt not found')

    // For commit-status rows, find the most recent preceding validate
    // attempt from the same landlord+platform+type. That row carries
    // the column_headers + sample_rows shape (commit rows store empty
    // arrays — see services/csvImportAttempts.ts).
    let related_validate_attempt_id: string | null = null
    if (row.status === 'committed' || row.status === 'reviewed') {
      const related = await queryOne<{ id: string }>(`
        SELECT id FROM csv_import_attempts
         WHERE landlord_id  = $1
           AND platform_key = $2
           AND import_type  = $3
           AND status = 'validated'
           AND created_at <= $4
         ORDER BY created_at DESC
         LIMIT 1
      `, [row.landlord_id, row.platform_key, row.import_type, row.created_at])
      related_validate_attempt_id = related?.id ?? null
    }

    res.json({ success: true, data: { ...row, related_validate_attempt_id } })
  } catch (e) { next(e) }
})

// POST /api/admin/csv-import-attempts/:id/mark-reviewed
// Marks the attempt as reviewed. Idempotent — re-marking by the same
// admin is a no-op; re-marking by a different admin updates the
// reviewed_by + reviewed_at to the latest.
adminRouter.post('/csv-import-attempts/:id/mark-reviewed', requireSuperAdmin, async (req: any, res, next) => {
  try {
    const reviewerId = req.user!.userId
    const row = await queryOne<any>(`
      UPDATE csv_import_attempts
         SET status      = 'reviewed',
             reviewed_by = $2,
             reviewed_at = NOW()
       WHERE id = $1
       RETURNING id, status, reviewed_by, reviewed_at
    `, [req.params.id, reviewerId])
    if (!row) throw new AppError(404, 'Attempt not found')
    await logAdminAction({
      adminUserId: reviewerId,
      actionType:  'csv_import_attempt.mark_reviewed',
      targetId:    req.params.id,
      targetType:  'csv_import_attempt',
      metadata:    {},
    })
    res.json({ success: true, data: row })
  } catch (e) { next(e) }
})

// GET /api/admin/csv-import-attempts/_stats/platforms
// Per-platform commit counts — powers the S295 dashboard tile + S296
// verification lifecycle gate. One row per (platform_key, import_type)
// with committed_count; platforms with ≤ 5 commits are still in
// "first 5 review" territory.
adminRouter.get('/csv-import-attempts/_stats/platforms', requireSuperAdmin, async (_req, res, next) => {
  try {
    const rows = await query<any>(`
      SELECT platform_key,
             import_type,
             COUNT(*)::int AS committed_count,
             COUNT(*) FILTER (WHERE status = 'reviewed')::int AS reviewed_count,
             MAX(created_at) AS most_recent
        FROM csv_import_attempts
       WHERE status IN ('committed', 'reviewed')
       GROUP BY platform_key, import_type
       ORDER BY platform_key, import_type
    `)
    res.json({ success: true, data: { rows } })
  } catch (e) { next(e) }
})

// ── S296: Platform verification lifecycle ─────────────────────────────
// Per-(platform_key, import_type) slot. Default 'unverified'. Super
// admin marks 'verified' once they've reviewed enough imports to
// trust the mapping. Verified slots stop generating banner + queue
// noise for landlord uploads.

// GET /api/admin/platform-review-statuses
// Returns every slot — verified rows from platform_review_status,
// merged with commit-count stats from csv_import_attempts. Slots
// with no row in platform_review_status default to 'unverified'.
adminRouter.get('/platform-review-statuses', requireSuperAdmin, async (_req, res, next) => {
  try {
    const rows = await query<any>(`
      WITH stats AS (
        SELECT platform_key, import_type,
               COUNT(*)::int AS committed_count,
               COUNT(DISTINCT landlord_id)::int AS distinct_landlords,
               MAX(created_at) AS most_recent_commit
          FROM csv_import_attempts
         WHERE status IN ('committed', 'reviewed')
         GROUP BY platform_key, import_type
      ),
      slots AS (
        -- All slots that have either a verification row OR a commit
        SELECT platform_key, import_type FROM platform_review_status
        UNION
        SELECT platform_key, import_type FROM stats
      )
      SELECT s.platform_key,
             s.import_type,
             COALESCE(p.mapping_status, 'unverified') AS mapping_status,
             p.verified_at,
             p.verified_by,
             p.notes,
             vu.first_name AS verifier_first_name,
             vu.last_name  AS verifier_last_name,
             COALESCE(st.committed_count, 0)     AS committed_count,
             COALESCE(st.distinct_landlords, 0)  AS distinct_landlords,
             st.most_recent_commit
        FROM slots s
        LEFT JOIN platform_review_status p
          ON p.platform_key = s.platform_key
         AND p.import_type  = s.import_type
        LEFT JOIN users vu ON vu.id = p.verified_by
        LEFT JOIN stats st
          ON st.platform_key = s.platform_key
         AND st.import_type  = s.import_type
       ORDER BY s.platform_key, s.import_type
    `)
    res.json({ success: true, data: { rows } })
  } catch (e) { next(e) }
})

// POST /api/admin/platform-review-statuses/:platform_key/:import_type/verify
// Upserts a row to mapping_status='verified', stamping verifier + timestamp.
// Super_admin only — flipping a slot to verified means we've vouched for
// the mapping accuracy, which suppresses the review banner for all future
// landlord uploads from that slot.
adminRouter.post('/platform-review-statuses/:platform_key/:import_type/verify', requireSuperAdmin, async (req: any, res, next) => {
  try {
    const verifierId = req.user!.userId
    const { platform_key, import_type } = req.params
    if (!['tenant','property','payment'].includes(import_type)) {
      throw new AppError(400, `import_type must be tenant/property/payment, got ${import_type}`)
    }
    const notes = typeof req.body?.notes === 'string' ? req.body.notes : null
    const row = await queryOne<any>(`
      INSERT INTO platform_review_status (
        platform_key, import_type, mapping_status,
        verified_at, verified_by, notes
      ) VALUES ($1, $2, 'verified', NOW(), $3, $4)
      ON CONFLICT (platform_key, import_type) DO UPDATE
        SET mapping_status = 'verified',
            verified_at    = NOW(),
            verified_by    = EXCLUDED.verified_by,
            notes          = COALESCE(EXCLUDED.notes, platform_review_status.notes),
            updated_at     = NOW()
      RETURNING *
    `, [platform_key, import_type, verifierId, notes])
    // S368 fix: targetId omitted — admin_action_log.target_id is uuid
    // typed and the composite slot key "platform:type" isn't a uuid.
    // Pre-S368 every call here silently failed the audit log INSERT
    // (logAdminAction swallows errors via try/catch). Composite key
    // now travels in metadata where it can be queried via jsonb.
    await logAdminAction({
      adminUserId: verifierId,
      actionType:  'platform_review_status.verify',
      targetType:  'platform_review_status',
      metadata:    { platform_key, import_type, notes },
    })
    res.json({ success: true, data: row })
  } catch (e) { next(e) }
})

// POST /api/admin/platform-review-statuses/:platform_key/:import_type/notes
// S316: dedicated notes upsert — independent of verify/unverify so
// editing operational context doesn't restamp verified_at. Upserts a
// row at the slot (creating an 'unverified' row if none exists) and
// overwrites the notes column with whatever the super_admin submitted
// (including empty string to clear). Returns the resulting row.
adminRouter.post('/platform-review-statuses/:platform_key/:import_type/notes', requireSuperAdmin, async (req: any, res, next) => {
  try {
    const adminId = req.user!.userId
    const { platform_key, import_type } = req.params
    if (!['tenant','property','payment'].includes(import_type)) {
      throw new AppError(400, `import_type must be tenant/property/payment, got ${import_type}`)
    }
    const notes = typeof req.body?.notes === 'string' ? req.body.notes : ''
    const row = await queryOne<any>(`
      INSERT INTO platform_review_status (
        platform_key, import_type, mapping_status, notes
      ) VALUES ($1, $2, 'unverified', $3)
      ON CONFLICT (platform_key, import_type) DO UPDATE
        SET notes      = EXCLUDED.notes,
            updated_at = NOW()
      RETURNING *
    `, [platform_key, import_type, notes])
    // S368 fix: targetId omitted — see verify route for full rationale.
    await logAdminAction({
      adminUserId: adminId,
      actionType:  'platform_review_status.notes',
      targetType:  'platform_review_status',
      metadata:    { platform_key, import_type, notesLength: notes.length },
    })
    res.json({ success: true, data: row })
  } catch (e) { next(e) }
})

// POST /api/admin/platform-review-statuses/:platform_key/:import_type/unverify
// Reverts a previously-verified slot back to 'unverified'. Used when we
// ship a mapping change that materially alters column handling and want
// to force re-review of the next imports.
adminRouter.post('/platform-review-statuses/:platform_key/:import_type/unverify', requireSuperAdmin, async (req: any, res, next) => {
  try {
    const adminId = req.user!.userId
    const { platform_key, import_type } = req.params
    if (!['tenant','property','payment'].includes(import_type)) {
      throw new AppError(400, `import_type must be tenant/property/payment, got ${import_type}`)
    }
    const notes = typeof req.body?.notes === 'string' ? req.body.notes : null
    const row = await queryOne<any>(`
      INSERT INTO platform_review_status (
        platform_key, import_type, mapping_status, notes
      ) VALUES ($1, $2, 'unverified', $3)
      ON CONFLICT (platform_key, import_type) DO UPDATE
        SET mapping_status = 'unverified',
            verified_at    = NULL,
            verified_by    = NULL,
            notes          = COALESCE(EXCLUDED.notes, platform_review_status.notes),
            updated_at     = NOW()
      RETURNING *
    `, [platform_key, import_type, notes])
    // S368 fix: targetId omitted — see verify route for full rationale.
    await logAdminAction({
      adminUserId: adminId,
      actionType:  'platform_review_status.unverify',
      targetType:  'platform_review_status',
      metadata:    { platform_key, import_type, notes },
    })
    res.json({ success: true, data: row })
  } catch (e) { next(e) }
})


// ── S297: Generic-upload platform claims + promotion candidates ───────
// Generic uploads carry a free-text claimed_platform_name. The
// candidates endpoint groups raw claims by normalized name; once
// ≥ 5 distinct landlords share a normalized name, the group becomes
// a promotion candidate. Promotion logs intent — the actual mapping
// work (adding the platform to PLATFORMS, building the alias arrays)
// happens in a follow-on code-change session.

// GET /api/admin/platform-claims/candidates
// Admin OK. Returns normalized-name groups with claim counts +
// per-import-type breakdown + sample raw spellings. Excludes
// already-promoted names.
adminRouter.get('/platform-claims/candidates', requireSuperAdmin, async (_req, res, next) => {
  try {
    const rows = await query<any>(`
      WITH normalized AS (
        SELECT a.landlord_id,
               a.import_type,
               a.claimed_platform_name AS raw_name,
               lower(regexp_replace(a.claimed_platform_name, '[^a-zA-Z0-9]+', '', 'g')) AS normalized_name,
               a.created_at
          FROM csv_import_attempts a
         WHERE a.claimed_platform_name IS NOT NULL
           AND a.claimed_platform_name <> ''
      )
      SELECT n.normalized_name,
             COUNT(DISTINCT n.landlord_id)::int AS distinct_landlords,
             COUNT(*)::int AS total_mentions,
             MAX(n.created_at) AS most_recent_mention,
             jsonb_agg(DISTINCT n.raw_name) AS raw_name_variants,
             jsonb_agg(DISTINCT n.import_type) AS import_types
        FROM normalized n
        LEFT JOIN platform_claim_promotions p
          ON p.normalized_name = n.normalized_name
       WHERE p.normalized_name IS NULL
         AND n.normalized_name <> ''
       GROUP BY n.normalized_name
       ORDER BY distinct_landlords DESC, total_mentions DESC, n.normalized_name
    `)
    res.json({ success: true, data: { rows } })
  } catch (e) { next(e) }
})

// GET /api/admin/platform-claims/promoted
// Admin OK. Audit-trail view of previously-promoted claim names.
adminRouter.get('/platform-claims/promoted', requireSuperAdmin, async (_req, res, next) => {
  try {
    const rows = await query<any>(`
      SELECT p.normalized_name,
             p.example_raw_name,
             p.promoted_at,
             p.promoted_by,
             u.first_name AS promoter_first_name,
             u.last_name  AS promoter_last_name,
             p.notes
        FROM platform_claim_promotions p
        LEFT JOIN users u ON u.id = p.promoted_by
       ORDER BY p.promoted_at DESC
    `)
    res.json({ success: true, data: { rows } })
  } catch (e) { next(e) }
})

// POST /api/admin/platform-claims/:normalized/promote
// Super_admin only. Marks a normalized claim name as promoted —
// drops it from the candidates list. The actual mapping work
// happens in a follow-on code change.
adminRouter.post('/platform-claims/:normalized/promote', requireSuperAdmin, async (req: any, res, next) => {
  try {
    const promoterId = req.user!.userId
    const normalized = String(req.params.normalized || '').toLowerCase().replace(/[^a-z0-9]+/g, '')
    if (!normalized) throw new AppError(400, 'normalized name required')

    const notes = typeof req.body?.notes === 'string' ? req.body.notes : null

    // Pick the most-common raw spelling as the example, for the
    // audit-trail view to display something human-friendly.
    const exampleRow = await queryOne<{ raw: string }>(`
      SELECT claimed_platform_name AS raw
        FROM csv_import_attempts
       WHERE claimed_platform_name IS NOT NULL
         AND lower(regexp_replace(claimed_platform_name, '[^a-zA-Z0-9]+', '', 'g')) = $1
       GROUP BY claimed_platform_name
       ORDER BY COUNT(*) DESC
       LIMIT 1
    `, [normalized])

    const row = await queryOne<any>(`
      INSERT INTO platform_claim_promotions (
        normalized_name, promoted_by, notes, example_raw_name
      ) VALUES ($1, $2, $3, $4)
      ON CONFLICT (normalized_name) DO UPDATE
        SET promoted_at      = NOW(),
            promoted_by      = EXCLUDED.promoted_by,
            notes            = COALESCE(EXCLUDED.notes, platform_claim_promotions.notes),
            example_raw_name = COALESCE(EXCLUDED.example_raw_name, platform_claim_promotions.example_raw_name)
      RETURNING *
    `, [normalized, promoterId, notes, exampleRow?.raw ?? null])

    // S368 fix: targetId omitted — `normalized` is a slug like
    // "rentmanager", not a uuid; admin_action_log.target_id is uuid
    // typed. Pre-S368 every promotion's audit log INSERT was
    // silently rejected. Normalized name lives in metadata.
    await logAdminAction({
      adminUserId: promoterId,
      actionType:  'platform_claim.promote',
      targetType:  'platform_claim',
      metadata:    { normalized_name: normalized, example_raw_name: exampleRow?.raw, notes },
    })

    res.json({ success: true, data: row })
  } catch (e) { next(e) }
})


// ── S553: Agent Analytics ─────────────────────────────────────────────
// Usage / quality / capacity dashboard over agent_interaction_logs.
// One call returns everything the admin page renders. `days` window is
// clamped 1–90. Shed volume is the "buy bigger hardware" alarm: the turn
// gate logs outcome='shed' when it rejects a turn under overload.
adminRouter.get('/agent-analytics', requireSuperAdmin, async (req, res, next) => {
  try {
    const days = Math.min(90, Math.max(1, Number(req.query.days) || 30))
    const since = `now() - interval '1 day' * $1`

    const [summary] = await query<any>(`
      SELECT COUNT(*)::int AS turns,
             COUNT(DISTINCT conversation_id)::int AS conversations,
             COUNT(DISTINCT actor_subject_id)::int AS unique_users,
             ROUND(AVG(latency_ms))::int AS avg_latency_ms,
             ROUND(percentile_cont(0.95) WITHIN GROUP (ORDER BY latency_ms))::int AS p95_latency_ms,
             COALESCE(SUM(prompt_tokens), 0)::bigint AS prompt_tokens,
             COALESCE(SUM(completion_tokens), 0)::bigint AS completion_tokens,
             COUNT(*) FILTER (WHERE escalated_to_human)::int AS human_escalations,
             COUNT(*) FILTER (WHERE tool_invocation_count > 0)::int AS tool_turns,
             COUNT(*) FILTER (WHERE outcome = 'error')::int AS errors,
             COUNT(*) FILTER (WHERE outcome = 'shed')::int AS shed
        FROM agent_interaction_logs
       WHERE created_at >= ${since}`, [days])

    const daily = await query<any>(`
      SELECT to_char(created_at::date, 'YYYY-MM-DD') AS day,
             COUNT(*)::int AS turns,
             COUNT(*) FILTER (WHERE escalated_to_human)::int AS escalations,
             COUNT(*) FILTER (WHERE outcome = 'shed')::int AS shed,
             COUNT(*) FILTER (WHERE outcome = 'error')::int AS errors,
             ROUND(AVG(latency_ms))::int AS avg_latency_ms,
             COALESCE(SUM(prompt_tokens + completion_tokens), 0)::bigint AS tokens
        FROM agent_interaction_logs
       WHERE created_at >= ${since}
       GROUP BY 1 ORDER BY 1`, [days])

    const hourly = await query<any>(`
      SELECT EXTRACT(HOUR FROM created_at)::int AS hour, COUNT(*)::int AS turns
        FROM agent_interaction_logs
       WHERE created_at >= ${since}
       GROUP BY 1 ORDER BY 1`, [days])

    const byAudience = await query<any>(`
      SELECT audience, COUNT(*)::int AS turns,
             COUNT(*) FILTER (WHERE escalated_to_human)::int AS escalations,
             ROUND(AVG(latency_ms))::int AS avg_latency_ms
        FROM agent_interaction_logs
       WHERE created_at >= ${since}
       GROUP BY 1 ORDER BY 2 DESC`, [days])

    const byAgent = await query<any>(`
      SELECT agent_name, profile_id, COUNT(*)::int AS turns,
             COUNT(*) FILTER (WHERE escalated_to_human)::int AS escalations,
             COUNT(*) FILTER (WHERE tool_invocation_count > 0)::int AS tool_turns
        FROM agent_interaction_logs
       WHERE created_at >= ${since}
       GROUP BY 1, 2 ORDER BY 3 DESC`, [days])

    const topTools = await query<any>(`
      SELECT tool AS name, COUNT(*)::int AS calls
        FROM agent_interaction_logs, unnest(tool_names) AS tool
       WHERE created_at >= ${since}
       GROUP BY 1 ORDER BY 2 DESC LIMIT 15`, [days])

    // S553 abuse visibility: who leans on the assistant hardest, and how
    // much of it was unproductive (same definition the turn budget uses).
    const heaviestUsers = await query<any>(`
      SELECT l.actor_user_id, u.email, l.actor_role AS role,
             COUNT(*)::int AS turns,
             COUNT(*) FILTER (WHERE ${unproductiveTurnSql('l')})::int AS unproductive,
             COUNT(*) FILTER (WHERE l.outcome = 'rate_limited')::int AS capped_turns,
             MAX(l.created_at) AS last_seen
        FROM agent_interaction_logs l
        JOIN users u ON u.id = l.actor_user_id
       WHERE l.created_at >= ${since}
       GROUP BY 1, 2, 3 ORDER BY 4 DESC LIMIT 15`, [days])

    res.json({ success: true, data: { days, summary, daily, hourly, byAudience, byAgent, topTools, heaviestUsers } })
  } catch (e) { next(e) }
})

// ── S553: Sales leads (Lucy → Portfolio Specialists) ─────────────────
// The lead queue the Specialists work from: list, status transitions, and
// the chat transcript that produced the lead (conversation_id →
// agent_interaction_logs), so the Specialist reads the conversation before
// the follow-up call.
adminRouter.get('/leads', requireSuperAdmin, async (req, res, next) => {
  try {
    const status = typeof req.query.status === 'string' && (SALES_LEAD_STATUSES as readonly string[]).includes(req.query.status)
      ? req.query.status : null
    const params: any[] = []
    let filter = ''
    if (status) { params.push(status); filter = `WHERE status = $${params.length}` }
    const rows = await query(
      `SELECT id, conversation_id, name, email, phone, states, portfolio_size, property_type,
              notes, status, source, created_at, updated_at
         FROM sales_leads ${filter}
        ORDER BY created_at DESC LIMIT 200`, params)
    res.json({ success: true, data: rows })
  } catch (e) { next(e) }
})

adminRouter.patch('/leads/:id/status', requireSuperAdmin, async (req, res, next) => {
  try {
    const b = z.object({ status: z.enum(SALES_LEAD_STATUSES as unknown as [string, ...string[]]) }).parse(req.body)
    const row = await queryOne<any>(
      `UPDATE sales_leads SET status = $2, updated_at = now() WHERE id = $1 RETURNING *`,
      [req.params.id, b.status])
    if (!row) throw new AppError(404, 'Lead not found')
    await logAdminAction({
      adminUserId: req.user!.userId,
      actionType: 'sales_lead_status',
      targetType: 'sales_lead',
      targetId: row.id,
      metadata: { status: b.status },
    })
    res.json({ success: true, data: row })
  } catch (e) { next(e) }
})

adminRouter.get('/leads/:id/transcript', requireSuperAdmin, async (req, res, next) => {
  try {
    const lead = await queryOne<any>(`SELECT id, conversation_id FROM sales_leads WHERE id = $1`, [req.params.id])
    if (!lead) throw new AppError(404, 'Lead not found')
    if (!lead.conversation_id) return res.json({ success: true, data: [] })
    const rows = await query(
      `SELECT turn_index, user_message, agent_reply, agent_name, created_at
         FROM agent_interaction_logs
        WHERE conversation_id = $1
        ORDER BY turn_index ASC LIMIT 100`, [lead.conversation_id])
    res.json({ success: true, data: rows })
  } catch (e) { next(e) }
})

// ── S553/S596: demo + specialist call calendar + availability ────────
adminRouter.get('/call-slots', async (_req, res, next) => {
  try {
    const rows = await query(
      `SELECT s.id, s.lead_id, s.starts_at, s.duration_minutes, s.kind, s.mode, s.status,
              s.prospect_name, s.prospect_email, s.prospect_phone, s.notes, s.meeting_url, s.reminded_at,
              l.states, l.portfolio_size, l.property_type, l.metadata
         FROM sales_call_slots s
         LEFT JOIN sales_leads l ON l.id = s.lead_id
        WHERE s.starts_at >= now() - interval '1 day'
        ORDER BY s.starts_at ASC LIMIT 100`)
    res.json({ success: true, data: rows })
  } catch (e) { next(e) }
})

adminRouter.patch('/call-slots/:id/status', async (req, res, next) => {
  try {
    const b = z.object({ status: z.enum(['booked', 'completed', 'cancelled', 'no_show']) }).parse(req.body)
    const row = await queryOne<any>(
      `UPDATE sales_call_slots SET status = $2, updated_at = now() WHERE id = $1 RETURNING *`,
      [req.params.id, b.status])
    if (!row) throw new AppError(404, 'Call not found')
    res.json({ success: true, data: row })
  } catch (e) { next(e) }
})

const availKindSchema = z.enum(SALES_BOOKING_KIND_VALUES)

adminRouter.get('/call-availability', async (req, res, next) => {
  try {
    const kind = availKindSchema.catch('demo').parse(req.query.kind)
    const rows = await query(
      `SELECT id, weekday, start_time, end_time, active, kind FROM sales_call_availability
        WHERE kind = $1 ORDER BY weekday, start_time`, [kind])
    res.json({ success: true, data: rows })
  } catch (e) { next(e) }
})

// Replace-all editor — SCOPED BY KIND so editing the demo window can never wipe
// the onboarding window (and vice-versa). Only the given kind's rows are
// deleted + re-inserted.
adminRouter.put('/call-availability', async (req, res, next) => {
  try {
    const b = z.object({
      kind: availKindSchema.default('demo'),
      windows: z.array(z.object({
        weekday: z.number().int().min(0).max(6),
        startTime: z.string().regex(/^\d{2}:\d{2}$/),
        endTime: z.string().regex(/^\d{2}:\d{2}$/),
      })).max(50),
    }).parse(req.body)
    for (const w of b.windows) {
      if (w.endTime <= w.startTime) throw new AppError(400, 'Each window must end after it starts')
    }
    await query(`DELETE FROM sales_call_availability WHERE kind = $1`, [b.kind])
    for (const w of b.windows) {
      await query(
        `INSERT INTO sales_call_availability (weekday, start_time, end_time, kind) VALUES ($1, $2, $3, $4)`,
        [w.weekday, w.startTime, w.endTime, b.kind])
    }
    const rows = await query(
      `SELECT id, weekday, start_time, end_time, active, kind FROM sales_call_availability
        WHERE kind = $1 ORDER BY weekday, start_time`, [b.kind])
    res.json({ success: true, data: rows })
  } catch (e) { next(e) }
})

// ── S596: the subscribe calendar feed URL (owner adds it once) + rotate ──
// Prefer an explicit API_PUBLIC_URL; otherwise derive the public origin from
// the request (behind the Cloudflare tunnel the Host is api.goldassetmanagement
// .com), so the subscribe URL is correct with zero env config.
function salesFeedUrls(req: Request, token: string): { url: string; webcalUrl: string } {
  const first = (v?: string) => (v || '').split(',')[0].trim()
  const derived = `${first(req.get('x-forwarded-proto')) || req.protocol || 'https'}://` +
                  `${first(req.get('x-forwarded-host')) || req.get('host') || 'localhost:4000'}`
  const base = (process.env.API_PUBLIC_URL || derived).replace(/\/$/, '')
  const url = `${base}/api/public/sales-calendar/${token}.ics`
  const webcalUrl = url.replace(/^https?:\/\//, 'webcal://')
  return { url, webcalUrl }
}

adminRouter.get('/demo-feed', async (req, res, next) => {
  try {
    const row = await queryOne<{ feed_token: string; busy_feed_token: string }>(
      `UPDATE sales_calendar_feed
          SET feed_token = COALESCE(feed_token, gen_random_uuid()),
              busy_feed_token = COALESCE(busy_feed_token, gen_random_uuid())
        WHERE id = true
      RETURNING feed_token, busy_feed_token`)
    const token = row!.feed_token
    const busyToken = row!.busy_feed_token
    res.json({
      success: true,
      data: {
        token, ...salesFeedUrls(req, token),
        // Shareable family/assistant link: same calendar, prospect data stripped.
        busyToken, busy: salesFeedUrls(req, busyToken),
      },
    })
  } catch (e) { next(e) }
})

adminRouter.post('/demo-feed/rotate', async (req, res, next) => {
  try {
    const row = await queryOne<{ feed_token: string }>(
      `UPDATE sales_calendar_feed SET feed_token = gen_random_uuid(), updated_at = now()
        WHERE id = true RETURNING feed_token`)
    const token = row!.feed_token
    res.json({ success: true, data: { token, ...salesFeedUrls(req, token) } })
  } catch (e) { next(e) }
})

// ── ADMIN INVITATIONS (S631) ─────────────────────────────────────────
//
// Nic: "Let's make a way to invite other admins to admin portal."
//
// Before this, a new admin was a hand-written INSERT against production. That is
// how the most privileged role on the platform ended up as the only one with no
// invitation record — and this same session showed what an untracked hand-edit
// costs when a co-owner vanished and nothing could say who removed them.
//
// Every route here is requireSuperAdmin. An `admin` cannot mint admins and
// cannot mint a super_admin; otherwise the two roles differ only in cosmetics,
// since any admin could promote themselves through a second account.
const ADMIN_INVITE_TTL_HOURS = 72
const ROLE_LABEL: Record<string, string> = { admin: 'an admin', super_admin: 'a super admin' }

// GET /api/admin/invitations — the standing list, live ones first.
adminRouter.get('/invitations', requireSuperAdmin, async (_req, res, next) => {
  try {
    const rows = await query<any>(`
      SELECT i.id, i.email, i.role, i.status, i.note,
             i.created_at, i.expires_at, i.accepted_at, i.revoked_at,
             (i.status = 'pending' AND i.expires_at <= now()) AS expired,
             inv.email AS invited_by_email,
             NULLIF(BTRIM(COALESCE(inv.first_name,'') || ' ' || COALESCE(inv.last_name,'')), '') AS invited_by_name,
             acc.email AS accepted_email
        FROM admin_invitations i
        JOIN users inv ON inv.id = i.invited_by_user_id
        LEFT JOIN users acc ON acc.id = i.accepted_user_id
       ORDER BY (i.status = 'pending' AND i.expires_at > now()) DESC, i.created_at DESC
       LIMIT 200`)
    res.json({ success: true, data: rows })
  } catch (e) { next(e) }
})

// GET /api/admin/staff — who already has console access. Invitations only tell
// half the story; the other half is the accounts that exist right now.
adminRouter.get('/staff', requireSuperAdmin, async (_req, res, next) => {
  try {
    const rows = await query<any>(`
      SELECT id, email, role, first_name, last_name, created_at,
             (totp_enabled OR email_2fa_enabled) AS two_factor_on, last_login_at
        FROM users WHERE role IN ('admin', 'super_admin')
       ORDER BY role DESC, created_at`)
    res.json({ success: true, data: rows })
  } catch (e) { next(e) }
})

// GET /api/admin/team-capabilities — what THIS viewer may do here. Only ever
// answers about the caller, so it tells a super admin what they can do without
// telling them which other account outranks them.
adminRouter.get('/team-capabilities', requireSuperAdmin, async (req, res, next) => {
  try {
    res.json({ success: true, data: {
      canInviteSuperAdmin: await isPlatformOwner(req.user!.userId, req.user!.email),
    } })
  } catch (e) { next(e) }
})

// POST /api/admin/invitations — invite somebody to the console.
adminRouter.post('/invitations', requireSuperAdmin, async (req, res, next) => {
  try {
    const body = z.object({
      email: z.string().trim().email(),
      role: z.enum(['admin', 'super_admin']),
      note: z.string().max(500).optional(),
    }).parse(req.body)
    const email = body.email.toLowerCase()

    // S631 (Nic, DIRECTIVE): "I want super admins to only be able to be added by
    // me. Other super admins can only add regular level admins. I don't need
    // people adding people willy nilly left and right."
    //
    // A super admin is an OWNER of the software; a regular admin is staff —
    // sales, portfolio strategists. Letting any super admin mint another makes
    // ownership self-propagating, and one compromised or departing account could
    // seed a second before anyone noticed.
    if (body.role === 'super_admin' && !(await isPlatformOwner(req.user!.userId, req.user!.email))) {
      throw new AppError(403,
        'Only the platform owner can add a super admin. You can invite an admin.')
    }

    // ONE ACCOUNT, ONE AUDIENCE. An address already on the platform is refused
    // rather than promoted — a landlord login that is also an admin login sits
    // on both sides of every isolation rule GAM has. Nic runs this way himself:
    // his super_admin and his landlord account are different addresses.
    const existing = await queryOne<{ role: string }>(
      `SELECT role FROM users WHERE lower(email) = $1`, [email])
    if (existing) {
      throw new AppError(409, existing.role === 'admin' || existing.role === 'super_admin'
        ? 'That address already has console access.'
        : `That address is already a ${String(existing.role).replace(/_/g, ' ')} account on GAM. ` +
          'Admin access needs its own separate login — invite a different address.')
    }

    const token = randomUUID().replace(/-/g, '') + randomUUID().replace(/-/g, '')
    const expiresAt = new Date(Date.now() + ADMIN_INVITE_TTL_HOURS * 3600_000).toISOString()
    const row = await queryOne<{ id: string }>(
      `INSERT INTO admin_invitations (email, role, invited_by_user_id, token, expires_at, note)
       VALUES ($1, $2, $3, $4, $5, $6)
       ON CONFLICT (lower(email)) WHERE status = 'pending'
       DO UPDATE SET token = EXCLUDED.token, expires_at = EXCLUDED.expires_at,
                     role = EXCLUDED.role, note = EXCLUDED.note,
                     invited_by_user_id = EXCLUDED.invited_by_user_id, updated_at = now()
       RETURNING id`,
      [email, body.role, req.user!.userId, token, expiresAt, body.note ?? null])

    const inviter = await queryOne<{ first_name: string | null; last_name: string | null; email: string }>(
      `SELECT first_name, last_name, email FROM users WHERE id = $1`, [req.user!.userId])
    const inviterName = [inviter?.first_name, inviter?.last_name].filter(Boolean).join(' ').trim()
      || inviter?.email || 'A GAM super admin'
    const base = (process.env.ADMIN_APP_URL || 'https://admin.goldassetmanagement.com').replace(/\/$/, '')
    await emailAdminInvitation(
      email, inviterName, ROLE_LABEL[body.role] ?? body.role,
      `${base}/accept-invite/${token}`, ADMIN_INVITE_TTL_HOURS, { invitationId: row!.id },
    ).catch(() => { /* the row stands; it can be resent */ })

    await logAdminAction({
      adminUserId: req.user!.userId, actionType: 'admin_invitation_sent',
      targetId: row!.id, targetType: 'admin_invitation',
      notes: `Invited ${email} as ${body.role}`,
      metadata: { email, role: body.role },
    })
    res.status(201).json({ success: true, data: { id: row!.id, email, role: body.role, expiresAt } })
  } catch (e) { next(e) }
})

// DELETE /api/admin/invitations/:id — revoke a live invitation.
adminRouter.delete('/invitations/:id', requireSuperAdmin, async (req, res, next) => {
  try {
    const row = await queryOne<any>(
      `UPDATE admin_invitations
          SET status = 'revoked', revoked_at = now(), revoked_by_user_id = $2, updated_at = now()
        WHERE id = $1 AND status = 'pending'
        RETURNING id, email`,
      [req.params.id, req.user!.userId])
    if (!row) throw new AppError(404, 'That invitation is no longer pending.')
    await logAdminAction({
      adminUserId: req.user!.userId, actionType: 'admin_invitation_revoked',
      targetId: row.id, targetType: 'admin_invitation', notes: `Revoked invite for ${row.email}`,
    })
    res.json({ success: true, data: { id: row.id } })
  } catch (e) { next(e) }
})

// ── ACCEPTING AN ADMIN INVITATION (S631) ─────────────────────────────
//
// A SEPARATE, UNAUTHENTICATED router. The invitee has no account yet — that is
// the whole point — so these two routes cannot live on adminRouter, which is
// behind requireAuth and an admin-role gate. Mounted at /api/admin-invite.
//
// What keeps it safe without a session: the 64-hex token is the only way in, it
// is single-use, it dies in 72 hours, and it can only ever create the ONE email
// address the super_admin typed. A stolen link cannot be pointed at a different
// address, cannot choose its own role, and cannot reach anything before the
// mandatory 2FA enrolment gate.
export const adminInviteRouter = Router()

const liveInvite = (token: string) => queryOne<any>(
  `SELECT id, email, role, expires_at FROM admin_invitations
    WHERE token = $1 AND status = 'pending' AND expires_at > now()`, [token])

// GET /api/admin-invite/:token — what the accept page shows before anyone types.
// Returns the invited address and role and nothing else; a probed token that is
// dead answers exactly as a token that never existed.
adminInviteRouter.get('/:token', async (req, res, next) => {
  try {
    const inv = await liveInvite(req.params.token)
    if (!inv) throw new AppError(404, 'This invitation has expired or already been used.')
    res.json({ success: true, data: { email: inv.email, role: inv.role, expiresAt: inv.expires_at } })
  } catch (e) { next(e) }
})

// POST /api/admin-invite/:token/accept — create the account.
adminInviteRouter.post('/:token/accept', async (req, res, next) => {
  try {
    const body = z.object({
      firstName: z.string().trim().min(1).max(80),
      lastName: z.string().trim().min(1).max(80),
      password: z.string().min(PASSWORD_MIN_LEN),
    }).parse(req.body)

    const client = await getClient()
    try {
      await client.query('BEGIN')
      // Re-read INSIDE the transaction and lock it: two people opening the same
      // link at once must not both get an account.
      const inv = (await client.query(
        `SELECT id, email, role FROM admin_invitations
          WHERE token = $1 AND status = 'pending' AND expires_at > now()
          FOR UPDATE`, [req.params.token])).rows[0]
      if (!inv) throw new AppError(404, 'This invitation has expired or already been used.')

      // Re-check the address here too. It was free when the invite was sent;
      // somebody may have registered it in the days since, and silently handing
      // that account admin is exactly what the send-time check exists to stop.
      const taken = (await client.query(
        `SELECT 1 FROM users WHERE lower(email) = lower($1)`, [inv.email])).rows[0]
      if (taken) {
        throw new AppError(409,
          'An account already exists for this address, so this invitation can no longer be used. ' +
          'Ask for a new invitation to a different address.')
      }

      const hash = await bcrypt.hash(body.password, 12)
      const user = (await client.query(
        `INSERT INTO users (email, password_hash, role, first_name, last_name)
         VALUES (lower($1), $2, $3, $4, $5) RETURNING id, email, role`,
        [inv.email, hash, inv.role, body.firstName, body.lastName])).rows[0]

      await client.query(
        `UPDATE admin_invitations
            SET status = 'accepted', accepted_at = now(), accepted_user_id = $2, updated_at = now()
          WHERE id = $1`, [inv.id, user.id])
      await client.query('COMMIT')

      // No session is issued here on purpose. They sign in normally, which runs
      // them straight into the mandatory 2FA enrolment every admin must pass —
      // handing back a token would route around the one gate that matters.
      res.status(201).json({ success: true, data: { email: user.email, role: user.role } })
    } catch (e) {
      await client.query('ROLLBACK').catch(() => {})
      throw e
    } finally { client.release() }
  } catch (e) { next(e) }
})
