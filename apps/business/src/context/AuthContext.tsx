import { isAuthRejection, fetchAuthMeWithRetry, sessionRenewalDue } from '@gam/shared'
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
  // 10/30 (Nic): "a passkey replaces the emailed code." The server has already
  // verified the device and minted a FULL session, so there is no second step
  // to pivot into — this checks the portal and stores what came back.
  loginWithPasskey: (session: { token: string; user?: any }) => Promise<void>
  logout: () => void
  refresh: () => Promise<void>
  refreshBusiness: () => Promise<void>
}

const Ctx = createContext<AuthCtx>(null!)
export const useAuth = () => useContext(Ctx)

// Said by three sign-in paths now (password, emailed code, passkey), so it is
// written once. Carried on a `response.data.error` as well as the message
// because the shared passkey card reads the server's sentence from there — a
// bare Error would show it the generic "that passkey did not work" instead.
const WRONG_PORTAL = 'This portal is for service-business operators. Please use the appropriate portal for your account.'
function wrongPortal(): Error {
  const e: any = new Error(WRONG_PORTAL)
  e.response = { data: { error: WRONG_PORTAL } }
  return e
}

export function AuthProvider({ children }: { children: React.ReactNode }) {
  const [user, setUser] = useState<AuthUser | null>(null)
  const [token, setToken] = useState<string | null>(() => localStorage.getItem('gam_business_token'))
  const [loading, setLoading] = useState(true)
  const [business, setBusiness] = useState<BusinessSummary | null>(null)

  const logout = useCallback(() => {
    localStorage.removeItem('gam_business_token')
    setToken(null); setUser(null); setBusiness(null)
  }, [])

  // S654: same renewal as the landlord portal. A session was a fixed 7-day pass
  // from the last sign-in; renew one older than a day so it ends only after
  // seven idle days. The new pass goes under this portal's own key.
  const renewSession = useCallback(async () => {
    const current = localStorage.getItem('gam_business_token')
    if (!sessionRenewalDue(current)) return
    try {
      const r = await apiPost<{ token: string }>('/auth/refresh')
      // S654 (review): a sign-out (or another sign-in) while this was in flight wins.
      if (localStorage.getItem('gam_business_token') !== current) return
      localStorage.setItem('gam_business_token', r.data.token)
      setToken(r.data.token)
    } catch (e) { if (isAuthRejection(e)) logout() }
  }, [logout])

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
      // S654: renew only once the pass is known to be a business account's.
      await renewSession()
    } catch (e) {
      // S540: only a real auth rejection ends the session. API
      // restarts / network blips keep the token; next load recovers.
      if (isAuthRejection(e)) logout()
    }
    finally { setLoading(false) }
  }, [logout, fetchBusiness, renewSession])

  const refreshBusiness = useCallback(async () => {
    if (!user) return
    await fetchBusiness(user.role)
  }, [user, fetchBusiness])

  useEffect(() => { token ? refresh() : setLoading(false) }, [token, refresh])
  // S654: renew when the portal comes back into view. `user` is set only after
  // the business role check, so a stray non-business pass is never renewed here.
  useEffect(() => {
    const onVisible = () => { if (document.visibilityState === 'visible' && user) renewSession() }
    document.addEventListener('visibilitychange', onVisible)
    return () => document.removeEventListener('visibilitychange', onVisible)
  }, [renewSession, user])

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
      throw wrongPortal()
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
      throw wrongPortal()
    }
    localStorage.setItem('gam_business_token', res.data!.token)
    setToken(res.data!.token)
    await refresh()
  }

  const resendEmailOtp = async (emailOtpSession: string): Promise<void> => {
    await apiPost('/auth/email-otp/resend', { emailOtpSession })
  }

  // 10/30 (Nic): a passkey sign-in. routes/passkeys.ts has already checked the
  // challenge, the origin, the relying party, the signature and the sign count
  // and minted a full session, so nothing follows this. The portal check is the
  // same one the other two paths run, BEFORE the pass is stored: the sign-in
  // endpoint is platform-wide, so a landlord's Face ID would otherwise mint a
  // token here that refresh() silently throws away, dropping them back on this
  // page with nothing said.
  const loginWithPasskey = async (session: { token: string; user?: any }): Promise<void> => {
    const role = session.user?.role
    if (role !== 'business_owner' && role !== 'business_staff') throw wrongPortal()
    localStorage.setItem('gam_business_token', session.token)
    setToken(session.token)
    await refresh()
  }

  return (
    <Ctx.Provider value={{
      user, token, loading, business,
      login, loginWithEmailOtp, resendEmailOtp, loginWithPasskey, logout, refresh, refreshBusiness,
    }}>
      {children}
    </Ctx.Provider>
  )
}
