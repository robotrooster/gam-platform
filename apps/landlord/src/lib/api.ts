/// <reference types="vite/client" />
import axios from 'axios'
import { applyCamelizeInterceptor } from '@gam/shared'

const API_URL = import.meta.env.VITE_API_URL || 'http://localhost:4000'

export const api = axios.create({
  baseURL: `${API_URL}/api`,
  headers: { 'Content-Type': 'application/json' },
})

// S312: snake_case → camelCase response transform. Registered
// BEFORE the auth interceptor so the camelize step runs on the
// success path; the 401 redirect path doesn't touch r.data. See
// packages/shared/src/camelize.ts for the passthrough rules
// protecting JSONB blob columns.
applyCamelizeInterceptor(api)

// Attach JWT on every request
api.interceptors.request.use((config) => {
  const token = localStorage.getItem('gam_token')
  if (token) config.headers.Authorization = `Bearer ${token}`
  return config
})

// Auto-logout on 401 — but NEVER for /auth/ calls.
//
// S605 (Nic, live bug): a wrong password on the SIGN-IN page returns 401, and
// this interceptor was hard-navigating to /login for it. That reload destroyed
// the React state holding the error, so a landlord who mistyped saw the screen
// blank and the empty form come back with NO message — indistinguishable from
// the app being broken, and impossible to tell apart from "2FA never sent me a
// code" (the password check runs BEFORE any code is issued).
//
// Auth routes own their own error display: login, the 2FA verify/resend step,
// register, forgot-password and reset-password all render the server's message
// inline. Only a 401 on a NORMAL authed request means a dead session worth
// bouncing. The tenant portal already had this carve-out (S537).
api.interceptors.response.use(
  (res) => res,
  (err) => {
    const url = String(err.config?.url || '')
    if (err.response?.status === 401 && !url.includes('/auth/')) {
      localStorage.removeItem('gam_token')
      window.location.href = '/login'
    }
    return Promise.reject(err)
  }
)

export const apiGet  = <T = any>(url: string) => api.get<{ success: boolean; data: T }>(url).then(r => r.data.data)
export const apiPost = <T = any>(url: string, body?: any) => api.post<{ success: boolean; data: T; message?: string }>(url, body).then(r => r.data)
export const apiPatch = <T = any>(url: string, body?: any) => api.patch<{ success: boolean; data: T }>(url, body).then(r => r.data.data)
export const apiDel  = (url: string) => api.delete(url).then(r => r.data)

export const apiPut = <T = any>(url: string, body?: any) => api.put<{ success: boolean; data: T }>(url, body).then(r => r.data.data)
export const apiDelete = <T = any>(url: string) => api.delete<{ success: boolean; data: T }>(url).then(r => r.data)
