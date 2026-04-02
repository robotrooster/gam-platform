/// <reference types="vite/client" />
import axios from 'axios'

const API_URL = import.meta.env.VITE_API_URL || 'http://localhost:4000'

export const api = axios.create({
  baseURL: `${API_URL}/api`,
  headers: { 'Content-Type': 'application/json' },
})

// Attach JWT on every request
api.interceptors.request.use((config) => {
  const token = localStorage.getItem('gam_token')
  if (token) config.headers.Authorization = `Bearer ${token}`
  return config
})

// Auto-logout on 401
api.interceptors.response.use(
  (res) => res,
  (err) => {
    if (err.response?.status === 401) {
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
