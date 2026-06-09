import React, { createContext, useContext, useState, useEffect, useCallback } from 'react'
import { apiPost, apiGet } from '../lib/api'

interface AuthUser {
  id: string
  email: string
  role: string
  firstName: string
  lastName: string
  profileId: string
}

/** A pm_staff membership: which pm_company the current user belongs to,
 *  and at what role. Populated lazily after auth (one /api/pm/companies
 *  call). The PM portal scopes ALL its work to a single active company —
 *  if a user is staff at multiple companies, the first is selected and
 *  the user can switch via a dropdown (TODO). */
interface ActivePmCompany {
  id: string
  name: string
  myRole: 'owner' | 'manager' | 'staff'
  myMembershipStatus: string
}

interface AuthCtx {
  user: AuthUser | null
  token: string | null
  loading: boolean
  pmCompanies: ActivePmCompany[]
  activePmCompany: ActivePmCompany | null
  setActivePmCompany: (c: ActivePmCompany) => void
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
  const [pmCompanies, setPmCompanies] = useState<ActivePmCompany[]>([])
  const [activePmCompany, setActivePmCompanyState] = useState<ActivePmCompany | null>(null)

  const logout = useCallback(() => {
    localStorage.removeItem('gam_token')
    localStorage.removeItem('gam_active_pm_company')
    setToken(null); setUser(null)
    setPmCompanies([]); setActivePmCompanyState(null)
  }, [])

  const setActivePmCompany = useCallback((c: ActivePmCompany) => {
    localStorage.setItem('gam_active_pm_company', c.id)
    setActivePmCompanyState(c)
  }, [])

  const refresh = useCallback(async () => {
    try {
      const me = await apiGet<AuthUser>('/auth/me')
      setUser(me)
      // Load the user's pm_staff memberships
      try {
        const companies = await apiGet<ActivePmCompany[]>('/pm/companies')
        setPmCompanies(companies)
        if (companies.length > 0) {
          const stored = localStorage.getItem('gam_active_pm_company')
          const match = companies.find(c => c.id === stored) ?? companies[0]
          setActivePmCompanyState(match)
        } else {
          setActivePmCompanyState(null)
        }
      } catch {
        // user is logged in but has no pm_staff rows — they need to register a company
        setPmCompanies([])
        setActivePmCompanyState(null)
      }
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

  return (
    <Ctx.Provider value={{
      user, token, loading,
      pmCompanies, activePmCompany, setActivePmCompany,
      login, logout, refresh,
    }}>
      {children}
    </Ctx.Provider>
  )
}
