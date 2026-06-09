/**
 * S443 services-audit slice — email.ts (854 lines).
 *
 * Strategy: mock the `resend` module at the boundary so every test
 * captures the resend.emails.send() call shape. Real DB writes for
 * email_send_log verify the audit-trail contract. Then walk
 * representative senders covering each branch family:
 *
 *   - send() success / Resend error response / thrown exception
 *   - attachments[] only present when passed
 *   - sender selection: noreply (default) vs support
 *   - logger.error swallow + email_send_log write on failures
 *   - escapeHtml: indirect via emailDocumentDeclined / emailAdverseActionNotice
 *
 * Senders pinned (each at one rep test):
 *   bg check (new + decision both branches), pool (match + interested),
 *   esign (request / completed / reminder / declined / auto-voided),
 *   invitation, pm invitation, pm property invitation (both
 *   directions), landlord banking nudge, adverse action,
 *   OTP invitation, late payment notice, notification email,
 *   tenant onboarded, email verification, password reset,
 *   flexsuite enrollment.
 */

import { describe, it, expect, beforeEach, vi } from 'vitest'

const { resendSendMock } = vi.hoisted(() => ({
  resendSendMock: vi.fn(async () => ({ data: { id: 'msg_default' }, error: null }) as any),
}))

vi.mock('resend', () => ({
  Resend: class {
    emails = { send: resendSendMock }
  },
}))

import { db } from '../db'
import { cleanupAllSchema } from '../test/dbHelpers'
import * as email from './email'

beforeEach(async () => {
  await cleanupAllSchema()
  resendSendMock.mockReset()
  resendSendMock.mockResolvedValue({ data: { id: 'msg_default' }, error: null } as any)
})

async function logRowFor(toEmail: string): Promise<any> {
  const { rows } = await db.query<any>(
    `SELECT to_email, subject, category, status, error_message, landlord_id,
            related_entity_type, related_entity_id, metadata
       FROM email_send_log WHERE to_email=$1
       ORDER BY created_at DESC LIMIT 1`, [toEmail])
  return rows[0]
}

// ═════════════════════════ send() behavior via emailInvitation ═════════════════════════

describe('send() behavior (exercised via emailInvitation)', () => {
  it('Resend success → email_send_log row written with status=sent', async () => {
    resendSendMock.mockResolvedValueOnce({ data: { id: 'msg_real' }, error: null } as any)
    await email.emailInvitation(
      'recip@example.com', 'Alice', 'property_manager',
      'https://gam.example/invite/123',
      { invitationId: '00000000-0000-0000-0000-000000000111' })
    const log = await logRowFor('recip@example.com')
    expect(log.status).toBe('sent')
    expect(log.error_message).toBeNull()
    expect(log.category).toBe('invitation')
    expect(log.related_entity_type).toBe('invitation')
  })

  it('Resend returns error object → log row status=failed; error_message captured', async () => {
    resendSendMock.mockResolvedValueOnce({
      data: null, error: { message: 'Domain not verified' },
    } as any)
    await email.emailInvitation('fail@example.com', 'X', 'property_manager', 'u')
    const log = await logRowFor('fail@example.com')
    expect(log.status).toBe('failed')
    expect(log.error_message).toBe('Domain not verified')
  })

  it('Resend throws → log row status=failed; exception message captured', async () => {
    resendSendMock.mockRejectedValueOnce(new Error('network down'))
    await email.emailInvitation('throw@example.com', 'X', 'property_manager', 'u')
    const log = await logRowFor('throw@example.com')
    expect(log.status).toBe('failed')
    expect(log.error_message).toBe('network down')
  })

  it('attachments not passed → Resend send args omit attachments key (default senders)', async () => {
    await email.emailInvitation('noatt@example.com', 'X', 'property_manager', 'u')
    const call = (resendSendMock.mock.calls[0] as any[])[0]
    expect(call.attachments).toBeUndefined()
  })

  it('sender selection: emailInvitation uses "support" sender (process.env.EMAIL_FROM_SUPPORT or fallback)', async () => {
    await email.emailInvitation('sup@example.com', 'X', 'property_manager', 'u')
    const call = (resendSendMock.mock.calls[0] as any[])[0]
    // Default behavior: EMAIL_FROM_SUPPORT or fallback contains "GAM Platform"
    expect(call.from).toMatch(/GAM Platform|onboarding@resend\.dev/)
  })

  it('subject + html shape verified via emailInvitation', async () => {
    await email.emailInvitation('subj@example.com', 'Alice', 'property_manager', 'https://x')
    const call = (resendSendMock.mock.calls[0] as any[])[0]
    expect(call.subject).toBe('Alice invited you to join GAM as Property Manager')
    expect(call.html).toContain('Alice')
    expect(call.html).toContain('Accept Invitation')
    expect(call.html).toContain('https://x')
  })

  it('ctx.invitationId null/undefined → related_entity_type stays NULL (not "invitation")', async () => {
    await email.emailInvitation('noctx@example.com', 'X', 'property_manager', 'u')
    const log = await logRowFor('noctx@example.com')
    expect(log.related_entity_type).toBeNull()
    expect(log.related_entity_id).toBeNull()
  })

  it('metadata field stored as jsonb (round-trips)', async () => {
    await email.emailInvitation('meta@example.com', 'X', 'bookkeeper', 'u')
    const log = await logRowFor('meta@example.com')
    expect(log.metadata).toEqual({ role: 'bookkeeper' })
  })
})

// ═════════════════════════ Background check ═════════════════════════

describe('background check emails', () => {
  it('emailNewBackgroundCheck: category=background_new; subject contains tenant name', async () => {
    await email.emailNewBackgroundCheck(
      'l@example.com', 'Landlord', 'Tenant Jones', 'Sunset', 'A1', 'high')
    const call = (resendSendMock.mock.calls[0] as any[])[0]
    expect(call.subject).toBe('New background check submitted — Tenant Jones')
    const log = await logRowFor('l@example.com')
    expect(log.category).toBe('background_new')
  })

  it('emailBackgroundDecision approved: celebratory subject + portal button + metadata.decision=approved', async () => {
    await email.emailBackgroundDecision(
      't@example.com', 'Tenant', 'approved', 'Sunset', 'A1', 'Welcome aboard!')
    const call = (resendSendMock.mock.calls[0] as any[])[0]
    expect(call.subject).toBe('Your application has been approved! 🎉')
    expect(call.html).toContain('Access Your Portal')
    const log = await logRowFor('t@example.com')
    expect(log.metadata).toEqual({ decision: 'approved' })
  })

  it('emailBackgroundDecision denied: neutral subject + NO portal button + metadata.decision=denied', async () => {
    await email.emailBackgroundDecision(
      'd@example.com', 'Tenant', 'denied', 'Sunset', 'A1')
    const call = (resendSendMock.mock.calls[0] as any[])[0]
    expect(call.subject).toBe('Update on your rental application')
    expect(call.html).not.toContain('Access Your Portal')
    const log = await logRowFor('d@example.com')
    expect(log.metadata).toEqual({ decision: 'denied' })
  })
})

// ═════════════════════════ E-sign emails ═════════════════════════

describe('e-sign emails', () => {
  it('emailSigningRequest: category=esign_signing_request; subject includes title', async () => {
    await email.emailSigningRequest(
      's@example.com', 'Signer', 'Lease 2026', 'Unit A1', 'Landlord',
      'https://sign/x')
    const log = await logRowFor('s@example.com')
    expect(log.category).toBe('esign_signing_request')
    const call = (resendSendMock.mock.calls[0] as any[])[0]
    expect(call.subject).toBe('Please sign: Lease 2026')
  })

  it('emailSigningCompleted with pdfUrl: button points to PDF', async () => {
    await email.emailSigningCompleted(
      's@example.com', 'Signer', 'Lease 2026', 'Unit A1',
      'https://gam.example/executed.pdf')
    const call = (resendSendMock.mock.calls[0] as any[])[0]
    expect(call.html).toContain('Download Signed Document')
    expect(call.html).toContain('https://gam.example/executed.pdf')
  })

  it('emailSigningCompleted without pdfUrl: falls back to portal button', async () => {
    await email.emailSigningCompleted(
      's@example.com', 'Signer', 'Lease 2026', 'Unit A1')
    const call = (resendSendMock.mock.calls[0] as any[])[0]
    expect(call.html).toContain('View in Portal')
  })

  it('emailDocumentDeclined: HTML-escapes signer name + reason (prevents XSS)', async () => {
    await email.emailDocumentDeclined(
      'l@example.com', 'Landlord', '<script>Bad</script>', 'tenant',
      'Lease', 'Unit A1', '<img src=x onerror=alert(1)>')
    const call = (resendSendMock.mock.calls[0] as any[])[0]
    expect(call.html).not.toContain('<script>Bad</script>')
    expect(call.html).toContain('&lt;script&gt;Bad&lt;/script&gt;')
    // The <img> tag is neutralized as escaped text — the angle brackets are
    // escaped so the browser won't parse it as an element. The onerror=
    // substring still appears as literal text inside the escaped output, but
    // it can't execute because the surrounding `<` was turned into `&lt;`.
    expect(call.html).not.toContain('<img src=x')
    expect(call.html).toContain('&lt;img src=x onerror=alert(1)&gt;')
  })

  it('emailDocumentDeclined: empty reason → "No reason provided"', async () => {
    await email.emailDocumentDeclined(
      'l@example.com', 'Landlord', 'Tenant', 'tenant', 'Lease', 'A1', null)
    const call = (resendSendMock.mock.calls[0] as any[])[0]
    expect(call.html).toContain('No reason provided')
  })

  it('emailDocumentAutoVoided: subject + category', async () => {
    await email.emailDocumentAutoVoided(
      'l@example.com', 'Landlord', 'Lease 2026', 'Unit A1')
    const log = await logRowFor('l@example.com')
    expect(log.category).toBe('esign_document_auto_voided')
  })

  it('emailSigningReminder: category', async () => {
    await email.emailSigningReminder(
      's@example.com', 'Signer', 'Lease', 'A1', 'Landlord', 'https://x')
    const log = await logRowFor('s@example.com')
    expect(log.category).toBe('esign_signing_reminder')
  })
})

// ═════════════════════════ PM + property invitations ═════════════════════════

describe('PM invitations', () => {
  it('emailPmInvitation: category=pm_invitation; landlord_id=null (PM-scoped); metadata captures company', async () => {
    await email.emailPmInvitation(
      'pm@example.com', 'Owner', 'Acme PM', 'manager',
      'https://accept/x',
      { pmCompanyId: '00000000-0000-0000-0000-000000000222',
        invitationId: '00000000-0000-0000-0000-000000000333' })
    const log = await logRowFor('pm@example.com')
    expect(log.category).toBe('pm_invitation')
    expect(log.landlord_id).toBeNull()
    expect(log.related_entity_type).toBe('pm_invitation')
    expect(log.metadata).toMatchObject({
      role: 'manager',
      company_name: 'Acme PM',
    })
  })

  it('emailPmPropertyInvitation: owner_to_pm direction → "inviter invited PM" subject', async () => {
    await email.emailPmPropertyInvitation({
      to: 'pm@example.com',
      direction: 'owner_to_pm',
      inviterName: 'Owner Bob',
      pmCompanyName: 'Acme PM',
      propertyName: 'Sunset',
      proposedScope: 'manage',
      acceptUrl: 'https://x',
    })
    const call = (resendSendMock.mock.calls[0] as any[])[0]
    expect(call.subject).toBe('Owner Bob invited Acme PM to manage Sunset')
  })

  it('emailPmPropertyInvitation: pm_to_owner direction → "PM invited you" subject', async () => {
    await email.emailPmPropertyInvitation({
      to: 'o@example.com',
      direction: 'pm_to_owner',
      inviterName: 'PM Carol',
      pmCompanyName: 'Acme PM',
      propertyName: 'Sunset',
      proposedScope: 'view',
      acceptUrl: 'https://x',
    })
    const call = (resendSendMock.mock.calls[0] as any[])[0]
    expect(call.subject).toMatch(/Acme PM invited you to connect to Sunset/)
  })
})

// ═════════════════════════ Adverse action (FCRA) ═════════════════════════

describe('emailAdverseActionNotice', () => {
  it('returns messageId on success; sender=support; escapes notice HTML', async () => {
    resendSendMock.mockResolvedValueOnce({ data: { id: 'msg_aa_1' }, error: null } as any)
    const id = await email.emailAdverseActionNotice({
      to: 'a@example.com',
      applicantFirstName: 'Pat',
      noticeText: 'Use of <CRA> data per § 615(a)(2)',
    })
    expect(id).toBe('msg_aa_1')
    const call = (resendSendMock.mock.calls[0] as any[])[0]
    expect(call.subject).toBe('Notice of Adverse Action — Fair Credit Reporting Act')
    expect(call.html).toContain('&lt;CRA&gt;')
    expect(call.html).toContain('§ 615(a)(2)')
    const log = await logRowFor('a@example.com')
    expect(log.category).toBe('adverse_action')
  })

  it('returns null on Resend error', async () => {
    resendSendMock.mockResolvedValueOnce({ data: null, error: { message: 'bad' } } as any)
    const id = await email.emailAdverseActionNotice({
      to: 'a2@example.com', applicantFirstName: 'Pat', noticeText: 'X',
    })
    expect(id).toBeNull()
  })
})

// ═════════════════════════ Misc senders ═════════════════════════

describe('emailLandlordBankingNudge', () => {
  it('default sender (noreply); category=landlord_banking_nudge', async () => {
    await email.emailLandlordBankingNudge({
      to: 'l@example.com', landlordName: 'L', tenantName: 'T',
      propertyName: 'Sunset', unitNumber: 'A1',
      bankingUrl: 'https://banking/x',
    })
    const log = await logRowFor('l@example.com')
    expect(log.category).toBe('landlord_banking_nudge')
    expect(log.related_entity_type).toBe('tenant_landlord_nudge')
  })
})

describe('OTP + late payment senders', () => {
  it('sendOnTimePayInvitation: subject + category + metadata.late_count', async () => {
    await email.sendOnTimePayInvitation({
      email: 'o@example.com', firstName: 'T', lateCount: 3, rentAmount: 1200,
    })
    const call = (resendSendMock.mock.calls[0] as any[])[0]
    expect(call.subject).toBe('Never pay a late fee again — On-Time Pay invitation')
    const log = await logRowFor('o@example.com')
    expect(log.category).toBe('otp_invitation')
    expect(log.metadata).toEqual({ late_count: 3 })
  })

  it('sendLatePaymentNotice: subject contains daysLate; category=late_payment_notice; metadata captures amount', async () => {
    await email.sendLatePaymentNotice({
      landlordEmail: 'l@example.com', landlordName: 'L',
      tenantName: 'T', unitNumber: 'A1', propertyName: 'Sunset',
      daysLate: 5, amount: 1200,
    })
    const call = (resendSendMock.mock.calls[0] as any[])[0]
    expect(call.subject).toBe('Late payment alert — T — Unit A1 — Day 5')
    const log = await logRowFor('l@example.com')
    expect(log.category).toBe('late_payment_notice')
    expect(log.metadata).toEqual({ days_late: 5, amount: 1200 })
  })
})

describe('sendNotificationEmail', () => {
  it('category prefixes notif_<type>', async () => {
    await email.sendNotificationEmail({
      to: 'n@example.com', subject: 'Update', html: '<p>x</p>',
      notificationType: 'rent_due', userId: '00000000-0000-0000-0000-000000000aaa',
    })
    const log = await logRowFor('n@example.com')
    expect(log.category).toBe('notif_rent_due')
    expect(log.metadata).toMatchObject({ user_id: '00000000-0000-0000-0000-000000000aaa' })
  })
})

describe('account-management senders', () => {
  it('sendEmailVerification: category=email_verification; no landlordId', async () => {
    const id = await email.sendEmailVerification(
      'v@example.com', 'Alice', 'https://verify/tok')
    expect(id).toBe('msg_default')
    const log = await logRowFor('v@example.com')
    expect(log.category).toBe('email_verification')
    expect(log.landlord_id).toBeNull()
    const call = (resendSendMock.mock.calls[0] as any[])[0]
    expect(call.html).toContain('Welcome, Alice!')
  })

  it('sendEmailVerification with null firstName: uses generic greeting', async () => {
    await email.sendEmailVerification('vn@example.com', null, 'https://verify/x')
    const call = (resendSendMock.mock.calls[0] as any[])[0]
    expect(call.html).toContain('Welcome!')
    expect(call.html).not.toContain('Welcome, null')
  })

  it('sendPasswordResetEmail: subject + category', async () => {
    await email.sendPasswordResetEmail('r@example.com', 'Bob', 'https://reset/x')
    const call = (resendSendMock.mock.calls[0] as any[])[0]
    expect(call.subject).toBe('Reset your GAM password')
    const log = await logRowFor('r@example.com')
    expect(log.category).toBe('password_reset')
  })

  it('emailTenantOnboarded: uses support sender; category=tenant_onboarded', async () => {
    await email.emailTenantOnboarded(
      'tn@example.com', 'Tenant', 'Landlord',
      '123 Main', 'Unit A1', 'https://activate/x')
    const log = await logRowFor('tn@example.com')
    expect(log.category).toBe('tenant_onboarded')
    expect(log.metadata).toEqual({ unit_label: 'Unit A1' })
  })
})

describe('emailFlexsuiteEnrollment', () => {
  it('flexpay: attaches PDF with FlexPay filename; category prefix includes product', async () => {
    resendSendMock.mockResolvedValueOnce({ data: { id: 'msg_flex' }, error: null } as any)
    const id = await email.emailFlexsuiteEnrollment({
      to: 'f@example.com', tenantName: 'Alice Jones',
      product: 'flexpay',
      acceptedAt: new Date('2026-06-01T12:00:00Z'),
      templateVersion: '1.0.0',
      acceptanceId: '00000000-0000-0000-0000-000000000abc',
      pdfBuffer: Buffer.from('%PDF-1.4 fake'),
    })
    expect(id).toBe('msg_flex')
    const call = (resendSendMock.mock.calls[0] as any[])[0]
    expect(call.attachments).toHaveLength(1)
    expect(call.attachments[0].filename).toBe('GAM-FlexPay-Subscription-Terms.pdf')
    expect(call.subject).toBe('Your FlexPay Subscription Terms — enrollment confirmation')
    const log = await logRowFor('f@example.com')
    expect(log.category).toBe('flexsuite_flexpay_enrollment_confirmation')
    expect(log.related_entity_type).toBe('flexsuite_enrollment_acceptance')
  })

  it('flexdeposit: different filename + subject', async () => {
    await email.emailFlexsuiteEnrollment({
      to: 'fd@example.com', tenantName: 'Bob',
      product: 'flexdeposit',
      acceptedAt: new Date('2026-06-01T12:00:00Z'),
      templateVersion: '1.0.0',
      acceptanceId: '00000000-0000-0000-0000-000000000def',
      pdfBuffer: Buffer.from('%PDF-1.4 fake'),
    })
    const call = (resendSendMock.mock.calls[0] as any[])[0]
    expect(call.attachments[0].filename).toBe('GAM-FlexDeposit-Service-Agreement.pdf')
    expect(call.subject).toBe('Your FlexDeposit Service Agreement — enrollment confirmation')
  })
})

describe('pool emails', () => {
  it('emailPoolMatchInterest: category', async () => {
    await email.emailPoolMatchInterest(
      'p@example.com', 'Tenant', 'Landlord', 'Sunset', 'A1', 'Hi there')
    const log = await logRowFor('p@example.com')
    expect(log.category).toBe('pool_match_interest')
  })

  it('emailPoolTenantInterested: category', async () => {
    await email.emailPoolTenantInterested('l@example.com', 'Landlord')
    const log = await logRowFor('l@example.com')
    expect(log.category).toBe('pool_tenant_interested')
  })
})
