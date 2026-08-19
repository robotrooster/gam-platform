/// <reference types="vite/client" />
import axios from 'axios'
import { applyCamelizeInterceptor } from '@gam/shared'

const API_URL = import.meta.env.VITE_API_URL || 'http://localhost:4000'

export const api = axios.create({
  baseURL: `${API_URL}/api`,
  headers: { 'Content-Type': 'application/json' },
})

// S312: snake_case → camelCase response transform (see packages/shared/src/camelize.ts).
applyCamelizeInterceptor(api)

api.interceptors.request.use((config) => {
  const token = localStorage.getItem('gam_token')
  if (token) config.headers.Authorization = `Bearer ${token}`
  return config
})

api.interceptors.response.use(
  (res) => res,
  (err) => {
    // S605 (Nic, live bug): a wrong password on the SIGN-IN page returns 401,
    // and this used to hard-navigate to /login for it. Already being on /login,
    // that is a RELOAD — the form clears and the React state holding the error
    // is destroyed, so the user sees a blank refresh with no message and cannot
    // tell a wrong password from a broken app. Auth pages render the server's
    // error inline; only a 401 on a normal authed request means a dead session.
    if (err.response?.status === 401 && !String(err.config?.url || '').includes('/auth/')) {
      localStorage.removeItem('gam_token')
      window.location.href = '/login'
    }
    return Promise.reject(err)
  }
)

export const apiGet    = <T = any>(url: string)             => api.get<{ success: boolean; data: T }>(url).then(r => r.data.data)
export const apiPost   = <T = any>(url: string, body?: any) => api.post<{ success: boolean; data: T; message?: string }>(url, body).then(r => r.data)
export const apiPatch  = <T = any>(url: string, body?: any) => api.patch<{ success: boolean; data: T }>(url, body).then(r => r.data.data)
export const apiDelete = <T = any>(url: string)             => api.delete<{ success: boolean; data: T }>(url).then(r => r.data)
