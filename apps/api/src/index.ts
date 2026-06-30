// Sentry instrumentation MUST be the first import — it patches
// modules at load time via OpenTelemetry, so any module imported
// before it won't get auto-instrumented.
import './instrument'
import * as Sentry from '@sentry/node'

import express from 'express'
import path from 'path'
import fs from 'fs'
// S86: scheduleOtpCron import removed. The cron's INSERT references the
// pre-S64 disbursements shape (landlord_id + scheduled_date + unit_count
// columns that no longer exist) AND its tenant query JOINs against
// units.tenant_id (column was dropped when lease_tenants/v_unit_occupancy
// landed). Re-enable once Item 16 batch 3+ wires real OTP infra against
// the current schema. See services/otpScheduler.ts header comment.
import cors from 'cors'
import helmet from 'helmet'
import rateLimit from 'express-rate-limit'
import { logger, httpLogger } from './lib/logger'
import { validateEnv } from './lib/validateEnv'
import dotenv from 'dotenv'
import { errorHandler } from './middleware/errorHandler'
import { camelCaseKeys } from './lib/caseConversion'
import { recordLatency } from './lib/apiMetrics'
import { authRouter }         from './routes/auth'
import { totpRouter }         from './routes/totp'
import { landlordsRouter }    from './routes/landlords'
import { landlordAgentActivityRouter } from './routes/landlordAgentActivity'
import { pmAgentActivityRouter } from './routes/pmAgentActivity'
import { businessesRouter }   from './routes/businesses'
import { businessUsersRouter } from './routes/businessUsers'
import { businessCustomersRouter } from './routes/businessCustomers'
import { businessInvoicesRouter } from './routes/businessInvoices'
import { businessInventoryRouter } from './routes/businessInventory'
import { businessPosRouter } from './routes/businessPos'
import { businessDiscountsRouter } from './routes/businessDiscounts'
import { businessVehiclesRouter } from './routes/businessVehicles'
import { businessWorkOrdersRouter } from './routes/businessWorkOrders'
import { businessDashboardRouter } from './routes/businessDashboard'
import { businessQuotesRouter } from './routes/businessQuotes'
import { businessReportsRouter } from './routes/businessReports'
import { businessRecurringInvoicesRouter } from './routes/businessRecurringInvoices'
import { businessBookableServicesRouter } from './routes/businessBookableServices'
import { publicBookingRouter } from './routes/publicBooking'
import { publicPropertyBookingRouter } from './routes/publicPropertyBooking'
import { businessAttachmentsRouter } from './routes/businessAttachments'
import { publicCardUpdateRouter } from './routes/publicCardUpdate'
import { publicCustomerPortalRouter } from './routes/publicCustomerPortal'
import { publicBusinessCalendarRouter } from './routes/publicBusinessCalendar'
import { businessSearchRouter } from './routes/businessSearch'
import { appointmentsRouter } from './routes/appointments'
import { recurringSchedulesRouter } from './routes/recurringSchedules'
import { routesRouter } from './routes/routes'
import { depotsRouter } from './routes/depots'
import { vehiclesRouter } from './routes/vehicles'
import { dumpLocationsRouter } from './routes/dumpLocations'
import { tenantsRouter }      from './routes/tenants'
import { propertiesRouter, publicPropertiesRouter } from './routes/properties'
import { unitsRouter }        from './routes/units'
import { propertyBookingAdminRouter } from './routes/propertyBookingAdmin'
import { leasesRouter }       from './routes/leases'
import { subleasesRouter }    from './routes/subleases'
import { subleaseInvitationsRouter } from './routes/subleaseInvitations'
import { posCustomerOnboardingRouter } from './routes/posCustomerOnboarding'
import { paymentsRouter }     from './routes/payments'
import { disbursementsRouter } from './routes/disbursements'
import { maintenanceRouter }  from './routes/maintenance'
import { documentsRouter }    from './routes/documents'
import { utilityRouter }      from './routes/utility'
import { adminRouter }        from './routes/admin'
import { webhooksRouter }     from './routes/webhooks'
import { stripeRouter }       from './routes/stripe'
import { workTradeRouter }    from './routes/workTrade'
import { posRouter }          from './routes/pos'
import { reportsRouter }      from './routes/reports'
import { maintenancePortalRouter } from './routes/maintenance-portal'
import { esignRouter }        from './routes/esign'
import { backgroundRouter }   from './routes/background'
import { announcementsRouter }  from './routes/announcements'
import { propertyTaxRouter } from './routes/propertyTax'
import { realEstateLawRouter } from './routes/realEstateLaw'
import { booksRouter } from './routes/books'
import { scopesRouter, invitationsRouter } from './routes/scopes'
import { pmRouter } from './routes/pm'
import { creditRouter }       from './routes/credit'
import { bookingsRouter }     from './routes/bookings'
import { inspectionsRouter }  from './routes/inspections'
import { commonAreasRouter }  from './routes/commonAreas'
import { serviceInterruptionsRouter } from './routes/serviceInterruptions'
import { agentRouter, salesAgentRouter, guestAgentRouter } from './routes/agent'
import { entryRequestsRouter } from './routes/entryRequests'
import { bulletinRouter }      from './routes/bulletin'
import { notificationsRouter } from './routes/notifications'
import { bankAccountsRouter } from './routes/bankAccounts'
import { adminBankAccountsRouter } from './routes/admin/bankAccounts'
import { financesRouter }      from './routes/finances'
import { withdrawalsRouter }   from './routes/withdrawals'
import { fitnessRouter }      from './routes/fitness'
import { schedulerInit }      from './jobs/scheduler'

dotenv.config()

// S280: validate required env BEFORE building the app. Throws and
// kills the process if a critical var (e.g. JWT_SECRET) is unset —
// safer than booting against a misconfigured runtime that would
// silently fail-closed on every request OR (with a hardcoded
// fallback that S277/S278 removed) issue forgeable tokens.
validateEnv()

const app  = express()
const uploadsDir = path.join(process.cwd(), 'uploads')
if (!fs.existsSync(uploadsDir)) fs.mkdirSync(uploadsDir, { recursive: true })
app.use('/uploads', express.static(uploadsDir))
const PORT = process.env.PORT || 4000

// ── MIDDLEWARE ──────────────────────────────────────────────
app.use(helmet())
app.use(cors({
  origin: [
    process.env.LANDLORD_APP_URL       || 'http://localhost:3001',
    process.env.TENANT_APP_URL         || 'http://localhost:3002',
    process.env.ADMIN_APP_URL          || 'http://localhost:3003',
    process.env.MARKETING_URL          || 'http://localhost:3004',
    process.env.POS_APP_URL            || 'http://localhost:3005',
    process.env.BOOKS_APP_URL          || 'http://localhost:3006',
    process.env.PROPERTY_INTEL_APP_URL || 'http://localhost:3007',
    process.env.LISTINGS_APP_URL       || 'http://localhost:3008',
    process.env.ADMIN_OPS_APP_URL      || 'http://localhost:3009',
    process.env.PM_COMPANY_APP_URL     || 'http://localhost:3011',
    process.env.BUSINESS_APP_URL       || 'http://localhost:3012',
    process.env.FITNESS_APP_URL        || 'http://localhost:3013',
    process.env.CUSTOMER_PORTAL_URL    || 'http://localhost:3014',
    'https://experience.arcgis.com',
  ],
  credentials: true,
}))

// Stripe webhooks need raw body — must be before express.json()
app.use('/webhooks/stripe', express.raw({ type: 'application/json' }))

// S422: background-check provider webhooks (Checkr, etc.) also need
// raw body for HMAC verification. The provider's HMAC is computed
// against the exact bytes they sent — re-stringifying parsed JSON
// drifts (key order, whitespace), so verify would fail in production.
// Must be before express.json() so the route handler receives a
// Buffer rather than a parsed object.
app.use('/api/background/webhook', express.raw({ type: 'application/json' }))

app.use(express.json())
app.use(express.urlencoded({ extended: true }))

// Record per-request latency for the super-admin Scaling Readiness panel (p95).
app.use((_req, res, next) => {
  const start = process.hrtime.bigint()
  res.on('finish', () => {
    recordLatency(Number(process.hrtime.bigint() - start) / 1e6)
  })
  next()
})

// Outgoing camelCase middleware — converts snake_case DB keys to camelCase
// wire format on the way out. DB stays snake_case; frontend sees camelCase.
app.use((_req, res, next) => {
  const originalJson = res.json.bind(res)
  res.json = (body: any) => originalJson(camelCaseKeys(body))
  next()
})

// Structured request logging. pino-http attaches `req.log` (a child
// logger tagged with the request id) to every request and emits a
// one-line summary when the response finishes. Replaces morgan.
app.use(httpLogger)

// Rate limiting
const limiter = rateLimit({ windowMs: 15 * 60 * 1000, max: 200 })
app.use('/api/', limiter)

const authLimiter = rateLimit({ windowMs: 15 * 60 * 1000, max: 100 })
app.use('/api/auth/', authLimiter)

// S282: tighter limit on /login specifically. The per-account
// lockout (S280) covers a single account being attacked — this
// covers a single IP being attacked across many accounts (credential
// stuffing with a stolen email list). 10 attempts per 15min per IP;
// successful logins don't count toward the limit
// (skipSuccessfulRequests=true) so a user who occasionally typos
// their password isn't rate-limited.
const loginLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 10,
  skipSuccessfulRequests: true,
  message: { success: false, error: 'Too many login attempts from this IP. Try again later.' },
})
app.use('/api/auth/login', loginLimiter)

// ── ROUTES ──────────────────────────────────────────────────
app.get('/health', (_req, res) => res.json({ status: 'ok', ts: new Date() }))

app.use('/api/auth',          authRouter)
app.use('/api/auth/totp',     totpRouter)
app.use('/api/landlords',     landlordsRouter)
app.use('/api/landlord/agent-activity', landlordAgentActivityRouter)
app.use('/api/businesses',    businessesRouter)
app.use('/api/business-users', businessUsersRouter)
app.use('/api/business-customers', businessCustomersRouter)
app.use('/api/business-invoices',  businessInvoicesRouter)
app.use('/api/business-inventory', businessInventoryRouter)
app.use('/api/business-pos', businessPosRouter)
app.use('/api/business-discounts', businessDiscountsRouter)
app.use('/api/business-vehicles', businessVehiclesRouter)
app.use('/api/business-work-orders', businessWorkOrdersRouter)
app.use('/api/business-dashboard', businessDashboardRouter)
app.use('/api/business-quotes', businessQuotesRouter)
app.use('/api/business-reports', businessReportsRouter)
app.use('/api/business-recurring-invoices', businessRecurringInvoicesRouter)
app.use('/api/business-bookable-services', businessBookableServicesRouter)
app.use('/api/public', publicBookingRouter)
app.use('/api/public', publicPropertyBookingRouter)
app.use('/api/business-attachments', businessAttachmentsRouter)
app.use('/api/business-search', businessSearchRouter)
app.use('/api/public', publicCardUpdateRouter)
app.use('/api/public', publicCustomerPortalRouter)
app.use('/api/public', publicBusinessCalendarRouter)
app.use('/api/appointments',  appointmentsRouter)
app.use('/api/recurring-schedules', recurringSchedulesRouter)
app.use('/api/routes',        routesRouter)
app.use('/api/depots',         depotsRouter)
app.use('/api/vehicles',       vehiclesRouter)
app.use('/api/dump-locations', dumpLocationsRouter)
app.use('/api/tenants',       tenantsRouter)
app.use('/api/properties',    propertiesRouter)
app.use('/api/public/properties', publicPropertiesRouter)
app.use('/api/units',         unitsRouter)
app.use('/api',               propertyBookingAdminRouter)
app.use('/api/leases',        leasesRouter)
app.use('/api/subleases',     subleasesRouter)
app.use('/api/sublease-invitations', subleaseInvitationsRouter)
app.use('/api/pos-customer-onboarding', posCustomerOnboardingRouter)
app.use('/api/payments',      paymentsRouter)
app.use('/api/disbursements', disbursementsRouter)
app.use('/api/maintenance',   maintenanceRouter)
app.use('/api/documents',     documentsRouter)
app.use('/api/utility',       utilityRouter)
app.use('/api/admin',         adminRouter)
app.use('/api/work-trade',    workTradeRouter)
app.use('/api/stripe',        stripeRouter)
app.use('/api/pos',           posRouter)
app.use('/api/reports',       reportsRouter)
// Allow PDF embedding for file routes
app.use('/api/esign/files', (req, res, next) => {
  res.setHeader('Content-Type', 'application/pdf')
  res.setHeader('X-Frame-Options', 'ALLOWALL')
  res.setHeader('Content-Security-Policy', "frame-ancestors *")
  res.setHeader('Cross-Origin-Resource-Policy', 'cross-origin')
  next()
})
app.use('/api/background/id-files', (req, res, next) => {
  res.setHeader('Cross-Origin-Resource-Policy', 'cross-origin')
  next()
})
app.use('/api/maint-portal', maintenancePortalRouter)
app.use('/api/esign',         esignRouter)
app.use('/api/announcements',  announcementsRouter)
app.use('/api/property-tax',   propertyTaxRouter)
app.use('/api/real-estate-law', realEstateLawRouter)
app.use('/api/bulletin',       bulletinRouter)
  app.use('/api/background',    backgroundRouter)
app.use('/api/fitness',        fitnessRouter)
app.use('/api/notifications',  notificationsRouter)
app.use('/api/bank-accounts',  bankAccountsRouter)
app.use('/api/admin',          adminBankAccountsRouter)
app.use('/api/users',          financesRouter)
app.use('/api/users',          withdrawalsRouter)
app.use('/api/books',          booksRouter)
app.use('/api/scopes',         scopesRouter)
app.use('/api/invitations',    invitationsRouter)
app.use('/api/pm',             pmRouter)
app.use('/api/pm/:pmCompanyId/agent-activity', pmAgentActivityRouter)
app.use('/api/credit',         creditRouter)
app.use('/api/bookings',       bookingsRouter)
app.use('/api/inspections',    inspectionsRouter)
app.use('/api/common-areas',   commonAreasRouter)
app.use('/api/service-interruptions', serviceInterruptionsRouter)
app.use('/api/agent',          agentRouter)
app.use('/api/sales',          salesAgentRouter)
app.use('/api/guest',          guestAgentRouter)
app.use('/api/entry-requests', entryRequestsRouter)
app.use('/webhooks',          webhooksRouter)

// Sentry's express error handler must come AFTER all routes and
// BEFORE the custom errorHandler. It captures the exception (when a
// DSN is configured) then calls next(err) so the custom handler can
// shape the JSON response. No-op when SENTRY_DSN is unset.
Sentry.setupExpressErrorHandler(app)

app.use(errorHandler)

// ── START ────────────────────────────────────────────────────
app.listen(PORT, () => {
  logger.info({
    port: PORT,
    landlordApp:  process.env.LANDLORD_APP_URL || 'http://localhost:3001',
    tenantApp:    process.env.TENANT_APP_URL   || 'http://localhost:3002',
    adminApp:     process.env.ADMIN_APP_URL    || 'http://localhost:3003',
    marketing:    process.env.MARKETING_URL    || 'http://localhost:3004',
  }, 'GAM API listening')
  schedulerInit()
})

export default app
