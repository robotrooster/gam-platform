// S654 (review): one reader, two flows. Whose breakdown is up decides whether a
// new one may simply replace it, and who may take it down. A card tapped on one
// flow's breakdown is held by the reader through display updates, so another
// flow taking the screen clears the reader first.
import { describe, it, expect, vi, beforeEach } from 'vitest'

const { setReaderDisplay, cancelAction, retrieve, processPaymentIntent } = vi.hoisted(() => ({
  setReaderDisplay:     vi.fn(async (): Promise<any> => ({})),
  cancelAction:         vi.fn(async (): Promise<any> => ({})),
  retrieve:             vi.fn(async (): Promise<any> => ({ action: null })),
  processPaymentIntent: vi.fn(async (): Promise<any> => ({ id: 'tmr', action: { status: 'in_progress' } })),
}))
vi.mock('../lib/stripe', () => ({
  getStripe: () => ({ terminal: { readers: { setReaderDisplay, cancelAction, retrieve, processPaymentIntent } } }),
}))

import { showCartOnReader, clearCartOnReader, processPaymentIntentOnReader } from './posTerminal'

const cart = (owner: string, reader = 'tmr_shared') => showCartOnReader({
  stripeReaderId: reader, lines: [{ description: 'Ice', amountCents: 300, quantity: 1 }], taxCents: 0, totalCents: 300, owner,
})

beforeEach(() => { setReaderDisplay.mockClear(); cancelAction.mockClear(); retrieve.mockClear(); retrieve.mockResolvedValue({ action: null }) })

describe('S654 whose breakdown is on the reader', () => {
  it('the same flow updates its own breakdown without clearing (a tap on it survives)', async () => {
    expect(await cart('register:u1:p1', 'tmr_a')).toBe('kept')
    expect(await cart('register:u1:p1', 'tmr_a')).toBe('kept')
    expect(cancelAction).not.toHaveBeenCalled()
    expect(setReaderDisplay).toHaveBeenCalledTimes(2)
  })

  it('another flow taking the screen clears the reader first, and says so', async () => {
    await cart('register:u1:p1', 'tmr_b')
    expect(await cart('rent:pay1', 'tmr_b')).toBe('took_over')
    expect(cancelAction).toHaveBeenCalledWith('tmr_b')
  })

  it('a flow cannot take down another flow\'s breakdown', async () => {
    await cart('rent:pay2', 'tmr_c')
    retrieve.mockResolvedValue({ action: { type: 'set_reader_display', status: 'in_progress' } })
    expect(await clearCartOnReader('tmr_c', 'register:u1:p1')).toBe(false)
    expect(cancelAction).not.toHaveBeenCalled()
    expect(await clearCartOnReader('tmr_c', 'rent:pay2')).toBe(true)
    expect(cancelAction).toHaveBeenCalledWith('tmr_c')
  })

  it('a breakdown nobody recorded (after a restart) is cleared before a new one goes up', async () => {
    retrieve.mockResolvedValue({ action: { type: 'set_reader_display', status: 'in_progress' } })
    expect(await cart('register:u2:p1', 'tmr_d')).toBe('took_over')
    expect(cancelAction).toHaveBeenCalledWith('tmr_d')
  })

  it('a payment replaces the breakdown, so the next flow starts clean', async () => {
    await cart('register:u1:p1', 'tmr_e')
    await processPaymentIntentOnReader({ stripeReaderId: 'tmr_e', paymentIntentId: 'pi_1' })
    expect(await cart('rent:pay3', 'tmr_e')).toBe('kept')
    expect(cancelAction).not.toHaveBeenCalled()
  })
})
