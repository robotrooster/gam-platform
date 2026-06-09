import axios from 'axios'
import { applyCamelizeInterceptor } from '@gam/shared'

const API_URL = (import.meta as any).env?.VITE_API_URL || 'http://localhost:4000'
const api = axios.create({ baseURL: `${API_URL}/api` })

api.interceptors.request.use(c => {
  const t = localStorage.getItem('gam_tenant_token')
  if (t) c.headers.Authorization = `Bearer ${t}`
  return c
})

// S312: snake_case → camelCase response transform. Applied via
// shared helper so every portal's response shape is consistent
// at the frontend boundary. JSONB blob columns (audit_log,
// notifications, permissions, etc.) are passed through to
// protect free-form / external-vendor data — see
// packages/shared/src/camelize.ts.
applyCamelizeInterceptor(api)

export const apiGet = <T = any>(url: string): Promise<T> =>
  api.get<{ success: boolean; data: T }>(url).then(r => r.data.data)

export const apiPost = <T = any>(url: string, body?: any): Promise<T> =>
  api.post<{ success: boolean; data: T }>(url, body).then(r => r.data as any)
