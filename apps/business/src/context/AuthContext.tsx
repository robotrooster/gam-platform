import { isAuthRejection, fetchAuthMeWithRetry } from '@gam/shared'
import React, { createContext, useContext, useState, useEffect, useCallback } from 'react'
import { apiPost, apiGet } from '../lib/api'

// S458: business-portal AuthContext. Differs from landlord-portal's
// AuthContext in two ways:
//   1. Adds businessId + staffRole to the AuthUser shape (S454 JWT)
//   2. Accepts both business_owner AND business_staff roles
//
// S492: also exposes the active business's enabled_features so the
// Layout nav + page-level gates can hide features the business hasn't
// turned on.
interface AuthUser {
  id: string; email: string; role: string
  firstName: string; lastName: string; profileId: string
  // S453/S454 — business-side scope
  businessId?: string | null
  staffRole?: string | null
  permissions?: Record<string, boolean | string> | null
}

interface BusinessSummary {
  id: string
  name: string
  businessType: string
  enabledFeatures: string[]
  tipsEnabled?: boolean
}

// S578: business_owner has mandatory email-2FA (S574) — login can require an
// emailed code before the full session, exactly like the landlord/tenant
// portals. business_staff (passcode-scoped) still logs in with a token.
export type LoginResult =
  | { kind: 'success' }
  | { kind: 'email_otp_required'; emailOtpSession: string }

interface AuthCtx {
  user: AuthUser | null
  token: string | null
  loading: boolean
  business: BusinessSummary | null
  login: (email: string, password: string) => Promise<LoginResult>
  loginWithEmailOtp: (emailOtpSession: string, code: string) => Promise<void>
  resendEmailOtp: (emailOtpSession: string) => Promise<void>
  logout: () => void
  refresh: () => Promise<void>
  refreshBusiness: () => Promise<void>
}

const Ctx = createContext<AuthCtx>(null!)
export const useAuth = () => useContext(Ctx)

export function AuthProvider({ children }: { children: React.ReactNode }) {
  const [user, setUser] = useState<AuthUser | null>(null)
  const [token, setToken] = useState<string | null>(() => localStorage.getItem('gam_business_token'))
  const [loading, setLoading] = useState(true)
  const [business, setBusiness] = useState<BusinessSummary | null>(null)

  const logout = useCallback(() => {
    localStorage.removeItem('gam_business_token')
    setToken(null); setUser(null); setBusiness(null)
  }, [])

  const fetchBusiness = useCallback(async (role: string) => {
    // Staff fetch the business via a different shape later. Owner-side
    // /businesses/me works today and carries enabled_features.
    if (role !== 'business_owner') {
      setBusiness(null)
      return
    }
    try {
      const biz = await apiGet<any>('/businesses/me')
      setBusiness({
        id:              biz.id,
        name:            biz.name,
        businessType:    biz.businessType,
        enabledFeatures: biz.enabledFeatures ?? [],
        tipsEnabled:     biz.tipsEnabled ?? true,
      })
    } catch {
      setBusiness(null)
    }
  }, [])

  const refresh = useCallback(async () => {
    try {
      const me = await fetchAuthMeWithRetry(() => apiGet<AuthUser>('/auth/me'))
      // Reject any /me response that isn't a business role — the
      // portal is business-only. Token may belong to a landlord who
      // clicked the wrong portal URL; bounce them to login.
      if (me.role !== 'business_owner' && me.role !== 'business_staff') {
        logout()
        return
      }
      setUser(me)
      await fetchBusiness(me.role)
    } catch (e) {
      // S540: only a real auth rejection ends the session. API
      // restarts / network blips keep the token; next load recovers.
      if (isAuthRejection(e)) logout()
    }
    finally { setLoading(false) }
  }, [logout, fetchBusiness])

  const refreshBusiness = useCallback(async () => {
    if (!user) return
    await fetchBusiness(user.role)
  }, [user, fetchBusiness])

  useEffect(() => { token ? refresh() : setLoading(false) }, [token, refresh])

  const login = async (email: string, password: string): Promise<LoginResult> => {
    const res = await apiPost<any>('/auth/login', { email, password })
    const data = res.data!
    // S578: mandatory email-2FA (business_owner) — a pending session, no token yet.
    // Previously this path read data.user.role and CRASHED on the OTP response.
    if (data.requiresEmailOtp) {
      return { kind: 'email_otp_required', emailOtpSession: data.emailOtpSession as string }
    }
    // Token path (business_staff — register passcode, no second factor).
    if (data.user.role !== 'business_owner' && data.user.role !== 'business_staff') {
      throw new Error('This portal is for service-business operators. Please use the appropriate portal for your account.')
    }
    localStorage.setItem('gam_business_token', data.token)
    setToken(data.token)
    setUser(data.user)
    await fetchBusiness(data.user.role)
    return { kind: 'success' }
  }

  // S578: email-code second step — trades the pending session + emailed code for
  // the full session, then confirms the account belongs in this portal.
  const loginWithEmailOtp = async (emailOtpSession: string, code: string): Promise<void> => {
    const res = await apiPost<{ token: string; user: AuthUser }>(
      '/auth/email-otp/verify', { emailOtpSession, code })
    const role = res.data!.user.role
    if (role !== 'business_owner' && role !== 'business_staff') {
      throw new Error('This portal is for service-business operators. Please use the appropriate portal for your account.')
    }
    localStorage.setItem('gam_business_token', res.data!.token)
    setToken(res.data!.token)
    await refresh()
  }

  const resendEmailOtp = async (emailOtpSession: string): Promise<void> => {
    await apiPost('/auth/email-otp/resend', { emailOtpSession })
  }

  return (
    <Ctx.Provider value={{
      user, token, loading, business,
      login, loginWithEmailOtp, resendEmailOtp, logout, refresh, refreshBusiness,
    }}>
      {children}
    </Ctx.Provider>
  )
}
