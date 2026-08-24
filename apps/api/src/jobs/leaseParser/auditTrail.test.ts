/**
 * Audit-trail page detection.
 *
 * S620: this file had NO tests, and it sits on the lease-IMPORT path — how a
 * landlord brings leases with them from another platform. Detection decides
 * which pages of an uploaded PDF are the signing certificate: those pages get
 * mined for the tenant's email and signing timestamps (which the lease body
 * usually does not carry) AND skipped during body extraction. Both directions
 * cost something when it is wrong.
 *
 * The vendor names in AUDIT_TRAIL_SIGNALS are deliberate and load-bearing
 * (Nic): they are how a competitor-signed lease is recognised during
 * onboarding, which is a migration asset. They are nominative — matching text
 * another tool printed — not branding. Do not "clean them up".
 *
 * These tests assert the CURRENT behaviour exactly. They were written after an
 * attempt to replace those vendor strings with structural markers was reverted;
 * their job is to make the next such attempt fail loudly instead of silently
 * degrading imports.
 */
import { describe, it, expect } from 'vitest'
import { isAuditTrailPage } from './auditTrail'
import type { Page } from '../../lib/pdfText'

/** Build a Page from lines of text; positions are irrelevant to detection. */
function page(...lines: string[]): Page {
  return {
    pageNumber: 1,
    items: lines.map((text, i) => ({ text, x: 50, y: 700 - i * 14, width: 200, height: 12 })),
  } as unknown as Page
}

describe('isAuditTrailPage — pages that MUST be detected', () => {
  it('detects each vendor signature block a landlord may arrive with', () => {
    // One case per vendor string. If someone removes one of these signals,
    // exactly one of these fails and names the vendor whose imports broke.
    const vendorPages: [string, Page][] = [
      ['dropbox-sign', page('powered by Dropbox Sign', 'Jane Tenant  jane@example.com')],
      ['docusign',     page('DocuSign Envelope Id: 9F2C41A8B7D34E15A0C6', 'Status: Completed')],
      ['adobe-sign',   page('Adobe Sign', 'Agreement completed 2026-08-24')],
    ]
    for (const [name, p] of vendorPages) {
      expect(isAuditTrailPage(p), name).toBe(true)
    }
  })

  it('detects the generic certificate wording', () => {
    for (const marker of ['Audit trail', 'Document History', 'Sent for signature', 'Signed by']) {
      expect(isAuditTrailPage(page(marker, 'jane@example.com')), marker).toBe(true)
    }
  })

  it('detects a realistic full certificate page', () => {
    expect(isAuditTrailPage(page(
      'Audit trail',
      'Sent for signature to Jane Tenant (jane@example.com)',
      'Signed by Jane Tenant (jane@example.com)',
      'IP: 203.0.113.44   2026-08-24 14:02:11 UTC',
    ))).toBe(true)
  })
})

describe('isAuditTrailPage — lease BODY text must NOT be detected', () => {
  // A false positive makes the parser skip a real page of the lease.
  it('does not fire on an ordinary lease body page', () => {
    expect(isAuditTrailPage(page(
      'RESIDENTIAL LEASE AGREEMENT',
      'This Agreement is made between the Landlord and the Tenant.',
      '1. RENT. Tenant shall pay $750.00 per month, due on the 1st.',
      '2. SECURITY DEPOSIT. Tenant has deposited $750.00.',
      '3. TERM. The term begins January 4, 2026 and ends January 4, 2027.',
    ))).toBe(false)
  })

  it('does not fire on the unsigned signature block inside the lease', () => {
    expect(isAuditTrailPage(page(
      'IN WITNESS WHEREOF, the parties have executed this Agreement.',
      'Landlord Signature: ______________________  Date: __________',
      'Tenant Signature: ______________________  Date: __________',
    ))).toBe(false)
  })

  it('does not fire on a clause that merely discusses electronic signing', () => {
    expect(isAuditTrailPage(page(
      '18. ELECTRONIC SIGNATURES. The parties agree this Agreement may be',
      'executed electronically and that an electronic signature has the same',
      'force and effect as an original.',
    ))).toBe(false)
  })

  it('does not fire on lowercase lease prose — the signals are case-sensitive', () => {
    // Documents the CURRENT contract. 'Signed by' is capitalised on a
    // certificate; a lease body says "signed by both parties" in prose, and
    // matching that would skip a real page. Loosening case here is a
    // behaviour change, not a cleanup.
    expect(isAuditTrailPage(page(
      'This Agreement is not binding until it has been signed by both parties.',
      'Any amendment must be sent for signature to each occupant of record.',
    ))).toBe(false)
  })

  it('does not fire on an empty page', () => {
    expect(isAuditTrailPage(page())).toBe(false)
  })
})
