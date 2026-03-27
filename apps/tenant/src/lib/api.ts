import axios from 'axios'

const API_URL = (import.meta as any).env?.VITE_API_URL || 'http://localhost:4000'
const api = axios.create({ baseURL: `${API_URL}/api` })

api.interceptors.request.use(c => {
  const t = localStorage.getItem('gam_tenant_token')
  if (t) c.headers.Authorization = `Bearer ${t}`
  return c
})

export const apiGet = <T = any>(url: string): Promise<T> =>
  api.get<{ success: boolean; data: T }>(url).then(r => r.data.data)

export const apiPost = <T = any>(url: string, body?: any): Promise<T> =>
  api.post<{ success: boolean; data: T }>(url, body).then(r => r.data as any)
