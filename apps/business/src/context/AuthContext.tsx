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
}

interface AuthCtx {
  user: AuthUser | null
  token: string | null
  loading: boolean
  business: BusinessSummary | null
  login: (email: string, password: string) => Promise<void>
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
        businessType:    biz.businessType ?? biz.business_type,
        enabledFeatures: biz.enabledFeatures ?? biz.enabled_features ?? [],
      })
    } catch {
      setBusiness(null)
    }
  }, [])

  const refresh = useCallback(async () => {
    try {
      const me = await apiGet<AuthUser>('/auth/me')
      // Reject any /me response that isn't a business role — the
      // portal is business-only. Token may belong to a landlord who
      // clicked the wrong portal URL; bounce them to login.
      if (me.role !== 'business_owner' && me.role !== 'business_staff') {
        logout()
        return
      }
      setUser(me)
      await fetchBusiness(me.role)
    } catch { logout() }
    finally { setLoading(false) }
  }, [logout, fetchBusiness])

  const refreshBusiness = useCallback(async () => {
    if (!user) return
    await fetchBusiness(user.role)
  }, [user, fetchBusiness])

  useEffect(() => { token ? refresh() : setLoading(false) }, [token, refresh])

  const login = async (email: string, password: string) => {
    const res = await apiPost<{ token: string; user: AuthUser; business?: BusinessSummary }>(
      '/auth/login', { email, password })
    if (res.data!.user.role !== 'business_owner' && res.data!.user.role !== 'business_staff') {
      throw new Error('This portal is for service-business operators. Please use the appropriate portal for your account.')
    }
    localStorage.setItem('gam_business_token', res.data!.token)
    setToken(res.data!.token)
    setUser(res.data!.user)
    await fetchBusiness(res.data!.user.role)
  }

  return (
    <Ctx.Provider value={{
      user, token, loading, business,
      login, logout, refresh, refreshBusiness,
    }}>
      {children}
    </Ctx.Provider>
  )
}
