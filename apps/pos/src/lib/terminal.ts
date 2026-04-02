import { loadStripeTerminal } from '@stripe/terminal-js'
import { api } from './api'

let terminal: any = null

export async function getTerminal() {
  if (terminal) return terminal
  const StripeTerminal = await loadStripeTerminal()
  if (!StripeTerminal) throw new Error("Stripe Terminal failed to load")
  terminal = StripeTerminal.create({
    onFetchConnectionToken: async () => {
      const res = await api.post('/terminal/connection-token')
      return res.data.data.secret
    },
    onUnexpectedReaderDisconnect: () => {
      console.warn('[Terminal] Reader disconnected unexpectedly')
      terminal = null
    }
  })
  return terminal
}

export async function discoverReaders() {
  const t = await getTerminal()
  const result = await t.discoverReaders({ simulated: process.env.NODE_ENV !== 'production' })
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
