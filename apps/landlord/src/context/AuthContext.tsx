import { isAuthRejection, fetchAuthMeWithRetry } from '@gam/shared'
import React, { createContext, useContext, useState, useEffect, useCallback } from 'react'
import { apiPost, apiGet } from '../lib/api'

interface AuthUser {
  id: string; email: string; role: string
  firstName: string; lastName: string; profileId: string
  onboardingComplete?: boolean
  bankAccountReady?: boolean
  // S82: worker-role users carry their scope's landlordId + the
  // sub-permission map. Owner roles (admin/super_admin/landlord) get
  // null for both — they're handled by role-based gates, not perms.
  landlordId?: string | null
  permissions?: Record<string, boolean | string> | null
  // Property scope for scoped workers (cashier/onsite/PM/maintenance). The POS
  // register locks its property dropdown to these. allProperties=true → every
  // property; else only propertyIds. Owners get allProperties implicitly.
  propertyIds?: string[] | null
  allProperties?: boolean
  // S168: per-manager Connect opt-in — gates the /banking nav for managers.
  directDepositEnabled?: boolean
  // S575: true when the landlord owns ≥1 mobile-home unit — gates the
  // "Lot Rent & Net" nav item (MH-only feature).
  hasMobileHomeUnits?: boolean
  // 2FA state. S574: email-code 2FA is MANDATORY for every landlord from
  // signup (auth.ts enforces + canonicalizes email_2fa_enabled on login).
  // The landlord portal exposes NO authenticator enrollment; totpEnabled is
  // read-only backward-compat for any legacy TOTP account.
  email2faEnabled?: boolean
  totpEnabled?: boolean
  mustEnrollTotp?: boolean
}

// login() returns a discriminated result so LoginPage can branch into the
// second factor. Landlords always hit email_otp_required; totp_required only
// fires for legacy authenticator accounts (no new landlord can enroll one).
type LoginResult =
  | { kind: 'success' }
  | { kind: 'totp_required'; totpSession: string }
  | { kind: 'email_otp_required'; emailOtpSession: string }

interface AuthCtx {
  user: AuthUser | null
  token: string | null
  loading: boolean
  login:  (email: string, password: string) => Promise<LoginResult>
  loginWithTotp: (totpSession: string, code: string) => Promise<void>
  loginWithEmailOtp: (emailOtpSession: string, code: string) => Promise<void>
  resendEmailOtp: (emailOtpSession: string) => Promise<void>
  logout: () => void
  refresh: () => Promise<void>
}

const Ctx = createContext<AuthCtx>(null!)
export const useAuth = () => useContext(Ctx)

export function AuthProvider({ children }: { children: React.ReactNode }) {
  const [user,    setUser]    = useState<AuthUser | null>(null)
  const [token,   setToken]   = useState<string | null>(() => localStorage.getItem('gam_token'))
  const [loading, setLoading] = useState(true)

  const logout = useCallback(() => {
    localStorage.removeItem('gam_token')
    setToken(null); setUser(null)
  }, [])

  const refresh = useCallback(async () => {
    try {
      const me = await fetchAuthMeWithRetry(() => apiGet<AuthUser>('/auth/me'))
      setUser(me)
    } catch (e) {
      // S540: only a real auth rejection ends the session. API
      // restarts / network blips keep the token; next load recovers.
      if (isAuthRejection(e)) logout()
    }
    finally { setLoading(false) }
  }, [logout])

  useEffect(() => { token ? refresh() : setLoading(false) }, [token, refresh])

  // Post-credentials login. Returns a discriminated result so LoginPage
  // can pivot into the TOTP second step when 2FA is enabled on the
  // account. Doesn't set token/user until the full JWT lands — a
  // totp_session JWT is not a valid auth token.
  const login = async (email: string, password: string): Promise<LoginResult> => {
    const res = await apiPost<any>('/auth/login', { email, password })
    const data = res.data!
    if (data.requiresTotp) {
      return { kind: 'totp_required', totpSession: data.totpSession as string }
    }
    // S574: mandatory email-code 2FA — the backend emailed a code and returned
    // a pending session instead of the full token.
    if (data.requiresEmailOtp) {
      return { kind: 'email_otp_required', emailOtpSession: data.emailOtpSession as string }
    }
    localStorage.setItem('gam_token', data.token)
    setToken(data.token)
    setUser(data.user ?? data)
    return { kind: 'success' }
  }

  // TOTP second-step exchange. Trades the short-lived totp_session JWT
  // (from /login) plus a 6-digit token or recovery code for the full
  // session JWT, then loads /auth/me for accurate user state.
  const loginWithTotp = async (totpSession: string, code: string): Promise<void> => {
    const res = await apiPost<{ token: string }>('/auth/totp/verify', { totpSession, code })
    localStorage.setItem('gam_token', res.data!.token)
    // Setting token triggers the refresh() effect, but set it eagerly
    // here too so /auth/me carries the new bearer immediately.
    setToken(res.data!.token)
    await refresh()
  }

  // S574: email-code second-step exchange. Trades the pending email_otp_session
  // JWT (from /login) plus the 6-digit emailed code for the full session JWT.
  const loginWithEmailOtp = async (emailOtpSession: string, code: string): Promise<void> => {
    const res = await apiPost<{ token: string }>('/auth/email-otp/verify', { emailOtpSession, code })
    localStorage.setItem('gam_token', res.data!.token)
    setToken(res.data!.token)
    await refresh()
  }

  // Resend a fresh email code (supersedes the prior one) for the same pending session.
  const resendEmailOtp = async (emailOtpSession: string): Promise<void> => {
    await apiPost('/auth/email-otp/resend', { emailOtpSession })
  }

  return <Ctx.Provider value={{ user, token, loading, login, loginWithTotp, loginWithEmailOtp, resendEmailOtp, logout, refresh }}>{children}</Ctx.Provider>
}
