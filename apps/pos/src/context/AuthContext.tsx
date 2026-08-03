import { isAuthRejection, fetchAuthMeWithRetry } from '@gam/shared'
import React, { createContext, useContext, useState, useEffect, useCallback } from 'react'
import { apiPost, apiGet } from '../lib/api'

const API_URL = import.meta.env.VITE_API_URL || 'http://localhost:4000'

// S574: read the posLimited claim straight off the JWT so it survives a reload
// (a cashier session is register-only; the UI gates on this).
function readPosLimited(tok: string | null): boolean {
  if (!tok) return false
  try { return !!JSON.parse(atob(tok.split('.')[1])).posLimited } catch { return false }
}

interface AuthUser {
  id: string; email: string; role: string
  firstName: string; lastName: string; profileId: string
  onboardingComplete?: boolean
  bankAccountReady?: boolean
  // S570: the shared POSPage reads these for cashier property-lock scoping +
  // per-tab staff permissions. Undefined here (in the standalone POS this
  // screen only renders for landlord-role users, who are owners → see all);
  // populated in the landlord app where scoped workers exist.
  propertyIds?: string[] | null
  allProperties?: boolean
  permissions?: Record<string, boolean | string> | null
}

// S574: login() returns a discriminated result so LoginPage can branch into the
// second factor. business_owner always hits email_otp_required (mandatory email
// 2FA); totp_required only fires for a legacy authenticator account.
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
  // S574 — terminal lock screen.
  // terminalToken present = this device is bound to a business register.
  terminalToken: string | null
  // posLimited = the current session is a passcode cashier session (register-only).
  posLimited: boolean
  // Owner/manager (full session) binds this device to their business register.
  activateTerminal: () => Promise<void>
  // Drop the full session but KEEP the terminal binding → show the lock screen.
  // If not yet activated, activates first. This is "hand the register to cashiers".
  lockRegister: () => Promise<void>
  // Trade a passcode for a cashier session (uses the terminal token).
  unlockWithPasscode: (passcode: string) => Promise<void>
  // Forget the terminal binding entirely (owner un-binds this device).
  deactivateTerminal: () => void
}

const Ctx = createContext<AuthCtx>(null!)
export const useAuth = () => useContext(Ctx)

export function AuthProvider({ children }: { children: React.ReactNode }) {
  const [user,    setUser]    = useState<AuthUser | null>(null)
  const [token,   setToken]   = useState<string | null>(() => localStorage.getItem('gam_token'))
  const [terminalToken, setTerminalToken] = useState<string | null>(() => localStorage.getItem('gam_pos_terminal'))
  const [loading, setLoading] = useState(true)

  const posLimited = readPosLimited(token)

  // Full sign-out: leave this device entirely. Clears the session AND the
  // terminal binding → back to the login screen. (Handing the register to
  // cashiers uses lockRegister instead, which keeps the terminal bound.)
  const logout = useCallback(() => {
    localStorage.removeItem('gam_token')
    localStorage.removeItem('gam_pos_terminal')
    setToken(null); setUser(null); setTerminalToken(null)
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

  // Post-credentials login. Returns a discriminated result so LoginPage can
  // pivot into the second factor. Doesn't set token/user until the full JWT
  // lands — a pending 2FA session JWT is not a valid auth token.
  const login = async (email: string, password: string): Promise<LoginResult> => {
    const res = await apiPost<any>('/auth/login', { email, password })
    const data = res.data!
    if (data.requiresTotp) {
      return { kind: 'totp_required', totpSession: data.totpSession as string }
    }
    // S574: mandatory email-code 2FA — backend emailed a code + returned a
    // pending session instead of the full token.
    if (data.requiresEmailOtp) {
      return { kind: 'email_otp_required', emailOtpSession: data.emailOtpSession as string }
    }
    localStorage.setItem('gam_token', data.token)
    setToken(data.token)
    setUser(data.user)
    return { kind: 'success' }
  }

  // Legacy authenticator second-step exchange (no new POS account can enroll one).
  const loginWithTotp = async (totpSession: string, code: string): Promise<void> => {
    const res = await apiPost<{ token: string }>('/auth/totp/verify', { totpSession, code })
    localStorage.setItem('gam_token', res.data!.token)
    setToken(res.data!.token)
    await refresh()
  }

  // S574: email-code second-step exchange. Trades the pending session + emailed
  // 6-digit code for the full session JWT.
  const loginWithEmailOtp = async (emailOtpSession: string, code: string): Promise<void> => {
    const res = await apiPost<{ token: string }>('/auth/email-otp/verify', { emailOtpSession, code })
    localStorage.setItem('gam_token', res.data!.token)
    setToken(res.data!.token)
    await refresh()
  }

  // Resend a fresh email code (supersedes the prior one) for the same session.
  const resendEmailOtp = async (emailOtpSession: string): Promise<void> => {
    await apiPost('/auth/email-otp/resend', { emailOtpSession })
  }

  // ── S574: terminal lock screen ────────────────────────────────
  // Bind this device to the current (full) session's business register.
  const activateTerminal = async (): Promise<void> => {
    const res = await apiPost<any>('/pos-lock/activate', {})
    const tok = res.data!.terminalToken as string
    localStorage.setItem('gam_pos_terminal', tok)
    setTerminalToken(tok)
  }

  // Hand the register to cashiers: bind the terminal if needed, then drop the
  // full session (keeping the terminal) so the lock screen takes over. A stolen
  // device now holds only the low-privilege terminal token, not a full session.
  const lockRegister = async (): Promise<void> => {
    if (!localStorage.getItem('gam_pos_terminal')) await activateTerminal()
    localStorage.removeItem('gam_token')
    setToken(null); setUser(null)
  }

  // Trade a passcode for a cashier session. Uses the terminal token directly
  // (a raw fetch — NOT the shared api instance — so a wrong-passcode 401 doesn't
  // trip the global auto-logout-to-/login interceptor).
  const unlockWithPasscode = async (passcode: string): Promise<void> => {
    const tok = localStorage.getItem('gam_pos_terminal')
    if (!tok) throw new Error('This register is not activated.')
    const r = await fetch(`${API_URL}/api/pos-lock/unlock`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${tok}` },
      body: JSON.stringify({ passcode }),
    })
    const body = await r.json().catch(() => ({}))
    if (!r.ok || !body?.success) {
      const err: any = new Error(body?.error || 'Incorrect passcode.')
      err.response = { data: { error: body?.error } }
      throw err
    }
    localStorage.setItem('gam_token', body.data.token)
    setToken(body.data.token)
    await refresh()
  }

  const deactivateTerminal = (): void => {
    localStorage.removeItem('gam_pos_terminal')
    setTerminalToken(null)
  }

  return <Ctx.Provider value={{
    user, token, loading, login, loginWithTotp, loginWithEmailOtp, resendEmailOtp, logout, refresh,
    terminalToken, posLimited, activateTerminal, lockRegister, unlockWithPasscode, deactivateTerminal,
  }}>{children}</Ctx.Provider>
}
