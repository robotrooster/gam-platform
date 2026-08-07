import { Router, Request, Response, NextFunction } from 'express'
import { requireAuth } from '../middleware/auth'
import {
  onboardingOverviewHandler,
  onboardingLandlordDetailHandler,
  onboardingTenantDetailHandler,
  onboardingResendHandler,
  tenantsListHandler,
  myReferralHandler,
  commissionsSummaryHandler,
} from './admin'
import { adminLandlordsListHandler } from './landlords'

// ============================================================
// S592 — the PORTFOLIO-MANAGER scoped surface (the allow-list wall).
//
// A portfolio_manager reaches ONLY the endpoints registered here — their own
// book of landlord accounts + those accounts' data + their own commission — and
// is denied on /api/admin entirely (that router's gate 403s anyone who isn't
// admin/super_admin). This is deny-list → allow-list: platform features live on
// /api/admin and are unreachable by construction, so a new admin endpoint is
// never accidentally exposed to a PM.
//
// admin/super_admin are ALSO admitted here (oversight; and it lets the admin
// app share the exact same handlers). The handlers are IMPORTED from admin.ts,
// not copied — each is caller-scoped by req.user.userId (super_admin →
// platform-wide), so a portfolio_manager sees only their book, identical to how
// a regular admin is scoped. See PORTFOLIO_MANAGER_SPEC.md § 3.
// ============================================================

export const portfolioRouter = Router()

portfolioRouter.use(requireAuth)
portfolioRouter.use((req: Request, res: Response, next: NextFunction) => {
  const role = req.user?.role
  if (!req.user) return res.status(401).json({ success: false, error: 'Unauthenticated' })
  if (role !== 'admin' && role !== 'super_admin' && role !== 'portfolio_manager') {
    return res.status(403).json({ success: false, error: 'Portfolio manager access required' })
  }
  next()
})

// Their book
portfolioRouter.get('/landlords', adminLandlordsListHandler)
portfolioRouter.get('/onboarding/overview', onboardingOverviewHandler)
portfolioRouter.get('/onboarding/landlord/:id', onboardingLandlordDetailHandler)
portfolioRouter.get('/onboarding/tenant/:id', onboardingTenantDetailHandler)
portfolioRouter.get('/tenants', tenantsListHandler)
portfolioRouter.post('/onboarding/resend', onboardingResendHandler)

// Their own comp
portfolioRouter.get('/my-referral', myReferralHandler)
portfolioRouter.get('/commissions/summary', commissionsSummaryHandler)
