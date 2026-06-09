// S243: Stripe Terminal helpers. Two parallel paths for collecting a
// card-present payment, both built on the S242 backend lifecycle:
//
//   Bluetooth (client-driven) — JS SDK discovers nearby readers,
//     collects the payment method in-browser, and confirms the PI
//     directly with Stripe. The cashier's browser handles the
//     terminal UX; the backend just creates and captures the PI.
//
//   Smart reader (server-driven) — pre-registered readers (S700,
//     WisePOS E etc.) listed via /pos/terminal/readers. Backend
//     pushes the PI to the reader via processPaymentIntent; the
//     reader prompts the customer; the frontend polls the PI
//     status until auth completes; backend captures.
//
// All four lifecycle routes (create / process / capture / cancel)
// fire under the landlord's Stripe Connect account. POS sales are
// landlord revenue; GAM's POS revenue is the monthly per-unit
// platform fee, not a per-transaction cut.

import { loadStripeTerminal } from '@stripe/terminal-js'
import { api, apiGet, apiPost, apiDel } from './api'

let terminal: any = null

// ── Stripe Terminal JS SDK (Bluetooth path) ─────────────────────────

export async function getTerminal() {
  if (terminal) return terminal
  const StripeTerminal = await loadStripeTerminal()
  if (!StripeTerminal) throw new Error('Stripe Terminal failed to load')
  terminal = StripeTerminal.create({
    onFetchConnectionToken: async () => {
      // S243: endpoint moved to /pos/terminal/connection-token (S241).
      // Pre-S243 this called /terminal/connection-token which 404'd.
      const res = await api.post('/pos/terminal/connection-token')
      return res.data.data.secret
    },
    onUnexpectedReaderDisconnect: () => {
      console.warn('[Terminal] Reader disconnected unexpectedly')
      terminal = null
    },
  })
  return terminal
}

export async function discoverReaders() {
  const t = await getTerminal()
  // Vite exposes DEV via import.meta.env; process.env.NODE_ENV is
  // not defined in the browser bundle.
  const simulated = (import.meta as any).env?.DEV ?? false
  const result = await t.discoverReaders({ simulated })
  if (result.error) throw new Error(result.error.message)
  return result.discoveredReaders
}

export async function connectReader(reader: any) {
  const t = await getTerminal()
  const result = await t.connectReader(reader)
  if (result.error) throw new Error(result.error.message)
  return result.reader
}

export async function collectCardPayment(clientSecret: string) {
  const t = await getTerminal()
  const result = await t.collectPaymentMethod(clientSecret)
  if (result.error) throw new Error(result.error.message)
  const processResult = await t.processPayment(result.paymentIntent)
  if (processResult.error) throw new Error(processResult.error.message)
  return processResult.paymentIntent
}

export async function cancelCurrentPayment() {
  const t = await getTerminal()
  await t.cancelCollectPaymentMethod()
}

// ── Backend PI lifecycle (both paths share this) ────────────────────

export interface TerminalIntent {
  id:           string
  status:       string
  clientSecret: string
}

export async function createTerminalIntent(args: {
  amountCents: number
  propertyId:  string
  description?: string
  posDraftRef?: string
}): Promise<TerminalIntent> {
  const res = await apiPost('/pos/terminal/payment-intents', args)
  return res.data as TerminalIntent
}

export async function processIntentOnReader(args: {
  paymentIntentId: string
  stripeReaderId:  string
}): Promise<{ readerId: string; action: any }> {
  const res = await apiPost(
    `/pos/terminal/payment-intents/${args.paymentIntentId}/process`,
    { stripeReaderId: args.stripeReaderId },
  )
  return res.data
}

export async function captureTerminalIntent(
  paymentIntentId: string,
): Promise<{ id: string; status: string; amount: number }> {
  const res = await apiPost(`/pos/terminal/payment-intents/${paymentIntentId}/capture`)
  return res.data
}

export async function cancelTerminalIntent(
  paymentIntentId: string,
): Promise<{ id: string; status: string }> {
  const res = await apiPost(`/pos/terminal/payment-intents/${paymentIntentId}/cancel`)
  return res.data
}

export interface PiStatus {
  id:               string
  status:           string
  amount:           number
  lastPaymentError: string | null
}

export async function retrieveTerminalIntent(paymentIntentId: string): Promise<PiStatus> {
  return apiGet(`/pos/terminal/payment-intents/${paymentIntentId}`)
}

/**
 * Poll PI status until terminal state (succeeded, requires_capture, or
 * canceled). Used by the server-driven smart-reader flow after the
 * backend pushes the PI to the reader — the reader prompts the
 * customer async and we wait for the PI to flip out of
 * `requires_payment_method`. Returns the final PiStatus or throws on
 * timeout / last_payment_error.
 */
export async function pollPiUntilTerminal(
  paymentIntentId: string,
  opts: { timeoutMs?: number; intervalMs?: number } = {},
): Promise<PiStatus> {
  const timeoutMs  = opts.timeoutMs  ?? 60_000  // 60s default — customer-walk-up time
  const intervalMs = opts.intervalMs ?? 2_000
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    const s = await retrieveTerminalIntent(paymentIntentId)
    if (s.lastPaymentError) throw new Error(s.lastPaymentError)
    if (s.status === 'requires_capture' || s.status === 'succeeded') return s
    if (s.status === 'canceled') throw new Error('Payment canceled')
    await new Promise(r => setTimeout(r, intervalMs))
  }
  throw new Error('Reader timed out waiting for customer')
}

// ── Reader management (S241 backend, S243 UI) ───────────────────────

export interface RegisteredReader {
  id:                string
  landlordId:        string
  propertyId:        string
  stripeReaderId:    string
  nickname:          string
  status:            'active' | 'archived'
  registeredAt:      string
  createdAt:         string
  updatedAt:         string
}

export async function listRegisteredReaders(propertyId?: string): Promise<RegisteredReader[]> {
  const qs = propertyId ? `?propertyId=${encodeURIComponent(propertyId)}` : ''
  return apiGet(`/pos/terminal/readers${qs}`)
}

export async function registerNewReader(args: {
  propertyId:       string
  registrationCode: string
  nickname:         string
  label?:           string
}): Promise<RegisteredReader> {
  const res = await apiPost('/pos/terminal/readers', args)
  return res.data
}

export async function archiveRegisteredReader(id: string): Promise<void> {
  await apiDel(`/pos/terminal/readers/${id}`)
}
