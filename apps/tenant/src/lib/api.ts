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

// S537: auto-logout on 401 — an expired session must land the tenant on
// the login screen, never leave a dead-feeling portal (same as landlord).
api.interceptors.response.use(
  r => r,
  err => {
    if (err.response?.status === 401 && !String(err.config?.url || '').includes('/auth/')) {
      localStorage.removeItem('gam_tenant_token')
      window.location.href = '/login'
    }
    return Promise.reject(err)
  }
)

export const apiGet = <T = any>(url: string): Promise<T> =>
  api.get<{ success: boolean; data: T }>(url).then(r => r.data.data)

export const apiPost = <T = any>(url: string, body?: any): Promise<T> =>
  api.post<{ success: boolean; data: T }>(url, body).then(r => r.data as any)

export const apiPatch = <T = any>(url: string, body?: any): Promise<T> =>
  api.patch<{ success: boolean; data: T }>(url, body).then(r => r.data.data)

export const apiPut = <T = any>(url: string, body?: any): Promise<T> =>
  api.put<{ success: boolean; data: T }>(url, body).then(r => r.data.data)

// Multipart upload (photos/video). axios sets the multipart boundary itself.
export const apiUpload = <T = any>(url: string, form: FormData): Promise<T> =>
  api.post<{ success: boolean; data: T }>(url, form).then(r => r.data.data)
