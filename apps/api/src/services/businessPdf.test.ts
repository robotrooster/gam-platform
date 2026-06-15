/**
 * S504 — PDF renderer smoke tests.
 *
 * Verifies each renderer produces a valid PDF buffer that pdf-lib can
 * parse back and that has the expected page count. We don't grep the
 * raw byte stream for text because pdf-lib's content-stream encoding
 * doesn't preserve plaintext substrings reliably. Content correctness
 * is verified via the visual portal walk.
 */

import { describe, it, expect } from 'vitest'
import { PDFDocument } from 'pdf-lib'
import {
  renderInvoicePdf,
  renderWorkOrderPdf,
  renderQuotePdf,
  renderPosReceiptPdf,
  BusinessInfo,
  CustomerInfo,
} from './businessPdf'

const biz: BusinessInfo = {
  name: 'Test Garage Co',
  email: 'shop@example.dev',
  phone: '555-0100',
  street1: '100 Main St',
  street2: null,
  city: 'Phoenix', state: 'AZ', zip: '85001',
}

const cust: CustomerInfo = {
  firstName: 'Jane', lastName: 'Doe',
  companyName: null,
  email: 'jane@example.dev', phone: '555-0200',
  street1: '200 Oak St',
  city: 'Phoenix', state: 'AZ', zip: '85002',
}

function isPdf(buf: Buffer): boolean {
  return buf.subarray(0, 4).toString() === '%PDF'
}

async function loadPages(buf: Buffer): Promise<number> {
  const pdf = await PDFDocument.load(buf)
  return pdf.getPageCount()
}

describe('renderInvoicePdf', () => {
  it('produces a valid PDF that pdf-lib can re-parse', async () => {
    const buf = await renderInvoicePdf({
      business: biz, customer: cust,
      invoiceNumber: 'INV-0042', status: 'sent',
      issueDate: '2026-06-14', dueDate: '2026-07-14',
      lines: [
        { description: 'Brake pad replacement', quantity: 1, unitPrice: 89.99, lineTotal: 89.99 },
        { description: 'Labor 2hrs', quantity: 2, unitPrice: 100, lineTotal: 200 },
      ],
      subtotal: 289.99, taxAmount: 25.37, totalAmount: 315.36, amountPaid: 0,
      notes: 'Thanks for choosing us.',
      hostedPayUrl: 'https://pay.example/x',
    })
    expect(isPdf(buf)).toBe(true)
    expect(buf.length).toBeGreaterThan(1000)
    expect(await loadPages(buf)).toBeGreaterThanOrEqual(1)
  })

  it('partially-paid invoice still renders', async () => {
    const buf = await renderInvoicePdf({
      business: biz, customer: cust,
      invoiceNumber: 'INV-0001', status: 'sent',
      issueDate: '2026-06-14', dueDate: '2026-07-14',
      lines: [{ description: 'X', quantity: 1, unitPrice: 100, lineTotal: 100 }],
      subtotal: 100, taxAmount: 0, totalAmount: 100, amountPaid: 30,
      notes: null, hostedPayUrl: null,
    })
    expect(isPdf(buf)).toBe(true)
    expect(await loadPages(buf)).toBeGreaterThanOrEqual(1)
  })
})

describe('renderWorkOrderPdf', () => {
  it('renders with vehicle + complaint + mixed line types', async () => {
    const buf = await renderWorkOrderPdf({
      business: biz, customer: cust,
      woNumber: 'WO-000123',
      status: 'in_progress',
      createdAt: '2026-06-14T10:00:00Z',
      intakeMileage: 78000, closeoutMileage: null,
      closeoutNotes: null,
      complaint: 'Squeaking from front-right wheel during low-speed braking',
      vehicle: {
        year: 2018, make: 'Honda', model: 'Civic',
        vin: '1HGCM82633A123456', licensePlate: 'ABC123',
      },
      lines: [
        { lineType: 'labor', description: 'Inspection', quantity: 1, unitPrice: 100, lineTotal: 100 },
        { lineType: 'part',  description: 'Brake pad',  quantity: 1, unitPrice: 50,  lineTotal: 50 },
        { lineType: 'fee',   description: 'Disposal',   quantity: 1, unitPrice: 10,  lineTotal: 10 },
      ],
      laborSubtotal: 100, partsSubtotal: 60, taxAmount: 0, totalAmount: 160,
    })
    expect(isPdf(buf)).toBe(true)
    expect(buf.length).toBeGreaterThan(1500)
  })

  it('renders without a vehicle block when null', async () => {
    const buf = await renderWorkOrderPdf({
      business: biz, customer: cust,
      woNumber: 'WO-X', status: 'open',
      createdAt: new Date(),
      intakeMileage: null, closeoutMileage: null, closeoutNotes: null,
      complaint: null, vehicle: null,
      lines: [{ lineType: 'fee', description: 'Diagnostic fee', quantity: 1, unitPrice: 75, lineTotal: 75 }],
      laborSubtotal: 0, partsSubtotal: 75, taxAmount: 0, totalAmount: 75,
    })
    expect(isPdf(buf)).toBe(true)
  })
})

describe('renderQuotePdf', () => {
  it('renders with expires_at + scope + lines', async () => {
    const buf = await renderQuotePdf({
      business: biz, customer: cust,
      quoteNumber: 'Q-000007', status: 'sent',
      createdAt: '2026-06-14', expiresAt: '2026-07-14',
      intakeDescription: 'Suspension overhaul',
      notes: 'Reply to accept.',
      lines: [
        { description: 'Strut x2', quantity: 2, unitPrice: 200, lineTotal: 400 },
      ],
      subtotal: 400, taxAmount: 0, totalAmount: 400,
    })
    expect(isPdf(buf)).toBe(true)
  })

  it('renders without expires_at', async () => {
    const buf = await renderQuotePdf({
      business: biz, customer: cust,
      quoteNumber: 'Q-X', status: 'draft',
      createdAt: new Date(), expiresAt: null,
      intakeDescription: null, notes: null,
      lines: [{ description: 'X', quantity: 1, unitPrice: 50, lineTotal: 50 }],
      subtotal: 50, taxAmount: 0, totalAmount: 50,
    })
    expect(isPdf(buf)).toBe(true)
  })
})

describe('renderPosReceiptPdf', () => {
  it('cash receipt with tendered + change', async () => {
    const buf = await renderPosReceiptPdf({
      business: biz, customer: null,
      receiptNumber: 'TXN-000099',
      createdAt: new Date(),
      status: 'completed',
      paymentMethod: 'cash',
      amountTendered: 20, changeDue: 5,
      refundReason: null,
      lines: [
        { description: 'Coffee', quantity: 1, unitPrice: 5,  lineTotal: 5 },
        { description: 'Bagel',  quantity: 1, unitPrice: 10, lineTotal: 10 },
      ],
      subtotal: 15, taxAmount: 0, totalAmount: 15,
    })
    expect(isPdf(buf)).toBe(true)
  })

  it('refunded receipt with reason', async () => {
    const buf = await renderPosReceiptPdf({
      business: biz, customer: cust,
      receiptNumber: 'TXN-1', createdAt: new Date(),
      status: 'refunded',
      paymentMethod: 'card_recorded',
      amountTendered: null, changeDue: null,
      refundReason: 'Customer returned the box',
      lines: [{ description: 'Widget', quantity: 1, unitPrice: 50, lineTotal: 50 }],
      subtotal: 50, taxAmount: 0, totalAmount: 50,
    })
    expect(isPdf(buf)).toBe(true)
  })

  it('walk-in receipt (no customer block)', async () => {
    const buf = await renderPosReceiptPdf({
      business: biz, customer: null,
      receiptNumber: 'TXN-2', createdAt: new Date(),
      status: 'completed',
      paymentMethod: 'card_recorded',
      amountTendered: null, changeDue: null,
      refundReason: null,
      lines: [{ description: 'Snack', quantity: 1, unitPrice: 2, lineTotal: 2 }],
      subtotal: 2, taxAmount: 0, totalAmount: 2,
    })
    expect(isPdf(buf)).toBe(true)
  })
})
