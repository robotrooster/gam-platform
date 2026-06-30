import axios from 'axios'

// Platform convention: request bodies are snake_case, responses are camelCase
// (the API camelizes outgoing JSON server-side — see apps/api/src/index.ts).
// So we send snake_case and read camelCase here.
const API_URL = (import.meta as any).env?.VITE_API_URL || 'http://localhost:4000'

export const TOKEN_KEY = 'gam_fitness_token'

export const api = axios.create({ baseURL: `${API_URL}/api` })

api.interceptors.request.use(c => {
  const t = localStorage.getItem(TOKEN_KEY)
  if (t) c.headers.Authorization = `Bearer ${t}`
  return c
})

api.interceptors.response.use(
  r => r,
  e => {
    if (e.response?.status === 401) {
      localStorage.removeItem(TOKEN_KEY)
      if (location.pathname !== '/auth') location.href = '/auth'
    }
    return Promise.reject(e)
  }
)

// Reads: unwrap { success, data } → data
export const apiGet = <T = any>(url: string): Promise<T> =>
  api.get<{ success: boolean; data: T }>(url).then(r => r.data.data)

// Writes: return the full { success, data, error } envelope so callers can
// branch on success (the fitness routes return success:false with a message
// rather than HTTP error codes for validation failures).
export const apiPost = <T = any>(url: string, body?: any): Promise<{ success: boolean; data?: T; error?: string }> =>
  api.post(url, body).then(r => r.data)

export const apiPatch = <T = any>(url: string, body?: any): Promise<{ success: boolean; data?: T; error?: string }> =>
  api.patch(url, body).then(r => r.data)

export const apiDelete = (url: string): Promise<{ success: boolean; error?: string }> =>
  api.delete(url).then(r => r.data)

export const getToken = () => localStorage.getItem(TOKEN_KEY)
export const setToken = (t: string) => localStorage.setItem(TOKEN_KEY, t)
export const clearToken = () => localStorage.removeItem(TOKEN_KEY)

export const fmt = (n: number) => (n ?? 0).toLocaleString('en-US')
