import express from 'express'
import { scheduleOtpCron } from './services/otpScheduler'
import cors from 'cors'
import helmet from 'helmet'
import morgan from 'morgan'
import rateLimit from 'express-rate-limit'
import dotenv from 'dotenv'
import { errorHandler } from './middleware/errorHandler'
import { authRouter }         from './routes/auth'
import { landlordsRouter }    from './routes/landlords'
import { tenantsRouter }      from './routes/tenants'
import { propertiesRouter }   from './routes/properties'
import { unitsRouter }        from './routes/units'
import { leasesRouter }       from './routes/leases'
import { paymentsRouter }     from './routes/payments'
import { disbursementsRouter } from './routes/disbursements'
import { maintenanceRouter }  from './routes/maintenance'
import { documentsRouter }    from './routes/documents'
import { utilityRouter }      from './routes/utility'
import { adminRouter }        from './routes/admin'
import { webhooksRouter }     from './routes/webhooks'
import { stripeRouter }       from './routes/stripe'
import { teamRouter }         from './routes/team'
import { workTradeRouter }    from './routes/workTrade'
import { posRouter }          from './routes/pos'
import { pmRouter }           from './routes/pm'
import { reportsRouter }      from './routes/reports'
import { maintenancePortalRouter } from './routes/maintenance-portal'
import { esignRouter }        from './routes/esign'
import { backgroundRouter }   from './routes/background'
import { announcementsRouter }  from './routes/announcements'
import { booksRouter } from './routes/books'
import { bulletinRouter }      from './routes/bulletin'
import { notificationsRouter } from './routes/notifications'
import { schedulerInit }      from './jobs/scheduler'

dotenv.config()

const app  = express()
const PORT = process.env.PORT || 4000

// ── MIDDLEWARE ──────────────────────────────────────────────
app.use(helmet())
app.use(cors({
  origin: [
    process.env.LANDLORD_APP_URL || 'http://localhost:3001',
    process.env.TENANT_APP_URL   || 'http://localhost:3002',
    process.env.ADMIN_APP_URL    || 'http://localhost:3003',
    process.env.MARKETING_URL    || 'http://localhost:3004',
    process.env.POS_APP_URL      || 'http://localhost:3005',
    'http://localhost:3006',
    'http://localhost:3007',
  ],
  credentials: true,
}))

// Stripe webhooks need raw body — must be before express.json()
app.use('/webhooks/stripe', express.raw({ type: 'application/json' }))

app.use(express.json())
app.use(express.urlencoded({ extended: true }))
app.use(morgan('dev'))

// Rate limiting
const limiter = rateLimit({ windowMs: 15 * 60 * 1000, max: 200 })
app.use('/api/', limiter)

const authLimiter = rateLimit({ windowMs: 15 * 60 * 1000, max: 100 })
app.use('/api/auth/', authLimiter)

// ── ROUTES ──────────────────────────────────────────────────
app.get('/health', (_req, res) => res.json({ status: 'ok', ts: new Date() }))

app.use('/api/auth',          authRouter)
app.use('/api/landlords',     landlordsRouter)
app.use('/api/tenants',       tenantsRouter)
app.use('/api/properties',    propertiesRouter)
app.use('/api/units',         unitsRouter)
app.use('/api/leases',        leasesRouter)
app.use('/api/payments',      paymentsRouter)
app.use('/api/disbursements', disbursementsRouter)
app.use('/api/maintenance',   maintenanceRouter)
app.use('/api/documents',     documentsRouter)
app.use('/api/utility',       utilityRouter)
app.use('/api/admin',         adminRouter)
app.use('/api/team',          teamRouter)
app.use('/api/work-trade',    workTradeRouter)
app.use('/api/stripe',        stripeRouter)
app.use('/api/pos',           posRouter)
app.use('/api/pm',            pmRouter)
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
app.use('/api/bulletin',       bulletinRouter)
  app.use('/api/background',    backgroundRouter)
app.use('/api/notifications',  notificationsRouter)
app.use('/api/books',          booksRouter)
app.use('/webhooks',          webhooksRouter)

app.use(errorHandler)

// ── START ────────────────────────────────────────────────────
scheduleOtpCron()
app.listen(PORT, () => {
  console.log(`\n🏢 GAM API running on http://localhost:${PORT}`)
  console.log(`   Landlord app:  ${process.env.LANDLORD_APP_URL || 'http://localhost:3001'}`)
  console.log(`   Tenant app:    ${process.env.TENANT_APP_URL   || 'http://localhost:3002'}`)
  console.log(`   Admin app:     ${process.env.ADMIN_APP_URL    || 'http://localhost:3003'}`)
  console.log(`   Marketing:     ${process.env.MARKETING_URL    || 'http://localhost:3004'}`)
  schedulerInit()
})

export default app
