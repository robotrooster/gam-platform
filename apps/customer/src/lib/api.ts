/// <reference types="vite/client" />

// The customer portal is public — no JWT. Every call is scoped by the
// token / business slug in the URL path. The API globally camelCases
// responses, so keys arrive camelCase.
const API_URL = import.meta.env.VITE_API_URL || 'http://localhost:4000'

async function unwrap<T>(res: Response): Promise<T> {
  const body = await res.json().catch(() => ({} as any))
  if (!res.ok || !body?.success) {
    const msg = body?.error || `Request failed (${res.status})`
    const err = new Error(msg) as Error & { status?: number }
    err.status = res.status
    throw err
  }
  return body.data as T
}

export function apiGet<T = any>(path: string): Promise<T> {
  return fetch(`${API_URL}/api${path}`).then((r) => unwrap<T>(r))
}

export function apiPost<T = any>(path: string, payload?: unknown): Promise<T> {
  return fetch(`${API_URL}/api${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload ?? {}),
  }).then((r) => unwrap<T>(r))
}
