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
  // 2FA state. The landlord role is NOT in the backend's
  // MANDATORY_TOTP_ROLES, so mustEnrollTotp is always false here —
  // 2FA is optional-with-prompts. totpEnabled drives the Settings
  // surface + the dismissible nudge.
  totpEnabled?: boolean
  mustEnrollTotp?: boolean
}

// login() returns a discriminated result so LoginPage can branch into
// the TOTP second step when the backend gates on 2FA.
type LoginResult = { kind: 'success' } | { kind: 'totp_required'; totpSession: string }

interface AuthCtx {
  user: AuthUser | null
  token: string | null
  loading: boolean
  login:  (email: string, password: string) => Promise<LoginResult>
  loginWithTotp: (totpSession: string, code: string) => Promise<void>
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
      const me = await apiGet<AuthUser>('/auth/me')
      setUser(me)
    } catch { logout() }
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

  return <Ctx.Provider value={{ user, token, loading, login, loginWithTotp, logout, refresh }}>{children}</Ctx.Provider>
}
