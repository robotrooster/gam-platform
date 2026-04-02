import React, { createContext, useContext, useState, useEffect, useCallback } from 'react'
import { apiPost, apiGet } from '../lib/api'

interface AuthUser {
  id: string; email: string; role: string
  firstName: string; lastName: string; profileId: string
  onboardingComplete?: boolean
  stripeBankVerified?: boolean
}

interface AuthCtx {
  user: AuthUser | null
  token: string | null
  loading: boolean
  login:  (email: string, password: string) => Promise<void>
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

  const login = async (email: string, password: string) => {
    const res = await apiPost<{ token: string; user: AuthUser }>('/auth/login', { email, password })
    localStorage.setItem('gam_token', res.data!.token)
    setToken(res.data!.token)
    setUser(res.data!.user)
  }

  return <Ctx.Provider value={{ user, token, loading, login, logout, refresh }}>{children}</Ctx.Provider>
}
