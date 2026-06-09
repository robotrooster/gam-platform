import { Resend } from 'resend'
import { LandlordAssignableRole, LANDLORD_ASSIGNABLE_ROLE_LABEL } from '@gam/shared'
import { query } from '../db'
import { logger } from '../lib/logger'

const resend = new Resend(process.env.RESEND_API_KEY)
// S288: two senders, picked per email kind. NOREPLY is the default
// (system messages — password reset, verification, automated
// reminders, signing flows, generic notifications). SUPPORT is the
// reply-welcome address used for invitations + adverse-action
// notices where a recipient legitimately needs a path to ask
// questions. Old EMAIL_FROM is honored as a fallback for envs that
// haven't been split yet.
const FALLBACK_FROM = process.env.EMAIL_FROM || 'GAM Platform <onboarding@resend.dev>'
const FROM_NOREPLY = process.env.EMAIL_FROM_NOREPLY || FALLBACK_FROM
const FROM_SUPPORT = process.env.EMAIL_FROM_SUPPORT || FALLBACK_FROM
const APP_NAME = 'GAM Platform'

type SenderKind = 'noreply' | 'support'

function senderFor(kind: SenderKind): string {
  return kind === 'support' ? FROM_SUPPORT : FROM_NOREPLY
}

// S101: optional context that callers can thread through send() so failures
// can be attributed to a specific landlord and entity. Existing callers
// that don't pass ctx still log a row (with NULL metadata) — global ops
// failure list works regardless; per-landlord filterability arrives as
// individual senders get ctx threaded through.
export interface EmailSendContext {
  category?: string
  landlordId?: string | null
  relatedEntityType?: string | null
  relatedEntityId?: string | null
  metadata?: Record<string, unknown>
}

/**
 * Returns the Resend message id on success, or null on failure. Callers
 * that need the id (e.g. adverse-action notices stamping it onto an audit
 * row) read the return; everyone else ignores it. Every attempt also
 * writes one row to email_send_log for the failure-surface UIs.
 */
export interface EmailAttachment {
  filename: string
  // Resend SDK accepts Buffer / string / Uint8Array. Pass Buffer in our
  // call sites (services/flexsuitePdf returns Buffer; existing callers
  // pass nothing).
  content:  Buffer | string | Uint8Array
}

async function send(
  to: string,
  subject: string,
  html: string,
  ctx: EmailSendContext = {},
  from: SenderKind = 'noreply',
  attachments: EmailAttachment[] | undefined = undefined,
): Promise<string | null> {
  let status: 'sent' | 'failed' = 'sent'
  let errorMessage: string | null = null
  let messageId: string | null = null
  try {
    // S322: optional attachments via Resend's documented attachments[]
    // field. Unset for the existing callers — only the new
    // emailFlexsuiteEnrollment path passes a PDF.
    const sendArgs: any = { from: senderFor(from), to, subject, html }
    if (attachments && attachments.length > 0) sendArgs.attachments = attachments
    const result = await resend.emails.send(sendArgs)
    if (result.error) {
      status = 'failed'
      errorMessage = (result.error as { message?: string }).message ?? JSON.stringify(result.error)
      logger.error('[EMAIL ERROR]', result.error)
    } else {
      messageId = result.data?.id ?? null
      logger.info('[EMAIL SENT]', subject, '->', to)
    }
  } catch(e) {
    status = 'failed'
    errorMessage = e instanceof Error ? e.message : String(e)
    logger.error({ err: e }, '[EMAIL FAILED]')
  }
  // Best-effort log — never let logging failure break a user-facing flow.
  try {
    await query(
      `INSERT INTO email_send_log (
         to_email, subject, category, status, error_message,
         landlord_id, related_entity_type, related_entity_id, metadata
       ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
      [
        to, subject, ctx.category ?? null, status, errorMessage,
        ctx.landlordId ?? null, ctx.relatedEntityType ?? null, ctx.relatedEntityId ?? null,
        ctx.metadata ? JSON.stringify(ctx.metadata) : null,
      ]
    )
  } catch (logErr) {
    logger.error({ err: logErr }, '[EMAIL LOG FAILED]')
  }
  return messageId
}

function base(content: string) {
  return `<!DOCTYPE html><html><body style="margin:0;padding:0;background:#0a0f14;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif">
<div style="max-width:560px;margin:0 auto;padding:32px 16px">
  <div style="margin-bottom:24px">
    <span style="font-size:1.2rem;font-weight:700;color:#c9a227">${APP_NAME}</span>
  </div>
  <div style="background:#111820;border:1px solid #1e2530;border-radius:12px;padding:28px">
    ${content}
  </div>
  <div style="margin-top:20px;font-size:.72rem;color:#4a5568;text-align:center">
    Gold Asset Management · You are receiving this because you have an account with us.
  </div>
</div>
</body></html>`
}

function btn(text: string, url: string) {
  return `<a href="${url}" style="display:inline-block;margin-top:16px;padding:10px 22px;background:#c9a227;color:#060809;border-radius:8px;font-weight:700;font-size:.88rem;text-decoration:none">${text}</a>`
}

function p(text: string) {
  return `<p style="margin:0 0 12px;color:#b8c4d8;font-size:.9rem;line-height:1.6">${text}</p>`
}

function h(text: string) {
  return `<h2 style="margin:0 0 16px;color:#eef1f8;font-size:1.1rem;font-weight:700">${text}</h2>`
}

// ── BACKGROUND CHECK EMAILS ───────────────────────────────────

export async function emailNewBackgroundCheck(landlordEmail: string, landlordName: string, tenantName: string, propertyName: string, unitNumber: string, riskLevel: string, portalUrl = 'http://localhost:3001/background', ctx?: { landlordId?: string; backgroundCheckId?: string }) {
  const riskColor = riskLevel === 'low' ? '#22c55e' : riskLevel === 'medium' ? '#f59e0b' : '#ef4444'
  await send(landlordEmail, `New background check submitted — ${tenantName}`,
    base(h('New Application Received') +
      p(`<strong style="color:#eef1f8">${tenantName}</strong> has submitted a background check for <strong style="color:#eef1f8">${propertyName} Unit ${unitNumber}</strong>.`) +
      `<div style="margin:12px 0;padding:10px 14px;background:#0a0f14;border-radius:8px;border-left:3px solid ${riskColor}">
        <span style="font-size:.75rem;color:#4a5568;text-transform:uppercase;letter-spacing:.06em">Risk Level</span>
        <div style="font-weight:700;color:${riskColor};text-transform:capitalize;margin-top:2px">${riskLevel}</div>
      </div>` +
      p('Log in to your landlord portal to review the application and make a decision.') +
      btn('Review Application', portalUrl)
    ),
    {
      category: 'background_new',
      landlordId: ctx?.landlordId ?? null,
      relatedEntityType: ctx?.backgroundCheckId ? 'background_check' : null,
      relatedEntityId: ctx?.backgroundCheckId ?? null,
    }
  )
}

export async function emailBackgroundDecision(tenantEmail: string, tenantName: string, decision: 'approved' | 'denied', propertyName: string, unitNumber: string, notes?: string, portalUrl = 'http://localhost:3002', ctx?: { landlordId?: string; backgroundCheckId?: string }) {
  const approved = decision === 'approved'
  await send(tenantEmail,
    approved ? 'Your application has been approved! 🎉' : 'Update on your rental application',
    base(
      h(approved ? 'Application Approved' : 'Application Update') +
      p(`Hi ${tenantName},`) +
      p(approved
        ? `Great news! Your application for <strong style="color:#eef1f8">${propertyName} Unit ${unitNumber}</strong> has been <strong style="color:#22c55e">approved</strong>. You can now access your full tenant portal.`
        : `Thank you for your interest in <strong style="color:#eef1f8">${propertyName} Unit ${unitNumber}</strong>. After careful review, we are unable to approve your application at this time.`
      ) +
      (notes ? `<div style="margin:12px 0;padding:10px 14px;background:#0a0f14;border-radius:8px;font-size:.82rem;color:#b8c4d8">${notes}</div>` : '') +
      (approved ? btn('Access Your Portal', portalUrl) : '')
    ),
    {
      category: 'background_decision',
      landlordId: ctx?.landlordId ?? null,
      relatedEntityType: ctx?.backgroundCheckId ? 'background_check' : null,
      relatedEntityId: ctx?.backgroundCheckId ?? null,
      metadata: { decision },
    }
  )
}

// ── POOL EMAILS ───────────────────────────────────────────────

export async function emailPoolMatchInterest(tenantEmail: string, tenantName: string, landlordName: string, propertyName: string, unitNumber: string, message: string|null, portalUrl = 'http://localhost:3002/notifications', ctx?: { landlordId?: string; matchRequestId?: string }) {
  await send(tenantEmail, `A landlord is interested in you — ${propertyName}`,
    base(
      h('You Have a Match!') +
      p(`Hi ${tenantName},`) +
      p(`<strong style="color:#eef1f8">${landlordName}</strong> has a vacancy at <strong style="color:#eef1f8">${propertyName} Unit ${unitNumber}</strong> and is interested in your profile.`) +
      (message ? `<div style="margin:12px 0;padding:10px 14px;background:#0a0f14;border-radius:8px;border-left:3px solid #c9a227;font-size:.82rem;color:#b8c4d8;font-style:italic">"</strong>${message}"</div>` : '') +
      p('Log in to your portal to let them know if you are interested.') +
      btn('Respond Now', portalUrl)
    ),
    {
      category: 'pool_match_interest',
      landlordId: ctx?.landlordId ?? null,
      relatedEntityType: ctx?.matchRequestId ? 'pool_match_request' : null,
      relatedEntityId: ctx?.matchRequestId ?? null,
    }
  )
}

export async function emailPoolTenantInterested(landlordEmail: string, landlordName: string, portalUrl = 'http://localhost:3001/pool', ctx?: { landlordId?: string; matchRequestId?: string }) {
  await send(landlordEmail, 'A tenant confirmed interest — unlock their full report',
    base(
      h('Tenant Is Interested!') +
      p(`Hi ${landlordName},`) +
      p('A tenant from the applicant pool has confirmed they are interested in your property.') +
      p('You can now unlock their full background report for <strong style="color:#eef1f8">$1</strong>.') +
      btn('View Match', portalUrl)
    ),
    {
      category: 'pool_tenant_interested',
      landlordId: ctx?.landlordId ?? null,
      relatedEntityType: ctx?.matchRequestId ? 'pool_match_request' : null,
      relatedEntityId: ctx?.matchRequestId ?? null,
    }
  )
}

// ── E-SIGN EMAILS ─────────────────────────────────────────────

export async function emailSigningRequest(to: string, signerName: string, documentTitle: string, unitLabel: string, landlordName: string, signingUrl: string, ctx?: { landlordId?: string; documentId?: string }) {
  await send(to, `Please sign: ${documentTitle}`,
    base(
      h('Document Ready for Your Signature') +
      p(`Hi ${signerName},`) +
      p(`<strong style="color:#eef1f8">${landlordName}</strong> has sent you a document to review and sign:`) +
      `<div style="margin:12px 0;padding:12px 16px;background:#0a0f14;border-radius:8px;border-left:3px solid #c9a227">
        <div style="font-weight:700;color:#eef1f8;margin-bottom:2px">${documentTitle}</div>
        <div style="font-size:.82rem;color:#b8c4d8">${unitLabel}</div>
      </div>` +
      p('Please review the document carefully before signing. This is a legally binding agreement under UETA and the federal E-SIGN Act.') +
      btn('Review & Sign Document', signingUrl) +
      `<div style="margin-top:16px;font-size:.75rem;color:#4a5568">Sign in to your GAM account to access this document.</div>`
    ),
    {
      category: 'esign_signing_request',
      landlordId: ctx?.landlordId ?? null,
      relatedEntityType: ctx?.documentId ? 'document' : null,
      relatedEntityId: ctx?.documentId ?? null,
    }
  )
}

export async function emailSigningCompleted(to: string, signerName: string, documentTitle: string, unitLabel: string, pdfUrl?: string, portalUrl = 'http://localhost:3002', ctx?: { landlordId?: string; documentId?: string }) {
  await send(to, `✅ Document fully signed: ${documentTitle}`,
    base(
      h('Document Fully Executed') +
      p(`Hi ${signerName},`) +
      p(`All parties have signed <strong style="color:#eef1f8">${documentTitle}</strong> for ${unitLabel}.`) +
      `<div style="margin:12px 0;padding:12px 16px;background:#0a0f14;border-radius:8px">
        <div style="font-size:.75rem;color:#4a5568;text-transform:uppercase;letter-spacing:.06em">Status</div>
        <div style="font-weight:700;color:#22c55e;margin-top:2px">Fully Executed</div>
        <div style="font-size:.75rem;color:#4a5568;text-transform:uppercase;letter-spacing:.06em;margin-top:10px">Signed On</div>
        <div style="color:#eef1f8;margin-top:2px">${new Date().toLocaleDateString()}</div>
      </div>` +
      (pdfUrl ? btn('Download Signed Document', pdfUrl) : btn('View in Portal', portalUrl))
    ),
    {
      category: 'esign_signing_completed',
      landlordId: ctx?.landlordId ?? null,
      relatedEntityType: ctx?.documentId ? 'document' : null,
      relatedEntityId: ctx?.documentId ?? null,
    }
  )
}

// ── ESIGN REMINDER + AUTO-VOID EMAILS (S29) ───────────────

export async function emailSigningReminder(to: string, signerName: string, documentTitle: string, unitLabel: string, landlordName: string, signingUrl: string, ctx?: { landlordId?: string; documentId?: string }) {
  await send(to, `Reminder: please sign ${documentTitle}`,
    base(
      h('Reminder: Document Awaiting Your Signature') +
      p(`Hi ${signerName},`) +
      p(`This is a reminder that <strong style="color:#eef1f8">${landlordName}</strong> sent you a document to review and sign, and it has not yet been signed:`) +
      `<div style="margin:12px 0;padding:12px 16px;background:#0a0f14;border-radius:8px;border-left:3px solid #c9a227">
        <div style="font-weight:700;color:#eef1f8;margin-bottom:2px">${documentTitle}</div>
        <div style="font-size:.82rem;color:#b8c4d8">${unitLabel}</div>
      </div>` +
      p('If the document is not signed within 24 hours of being sent, it will be automatically voided.') +
      btn('Review & Sign Document', signingUrl) +
      `<div style="margin-top:16px;font-size:.75rem;color:#4a5568">Sign in to your GAM account to access this document.</div>`
    ),
    {
      category: 'esign_signing_reminder',
      landlordId: ctx?.landlordId ?? null,
      relatedEntityType: ctx?.documentId ? 'document' : null,
      relatedEntityId: ctx?.documentId ?? null,
    }
  )
}

// S234: tenant decline-with-reason. Fires to the landlord (and any
// other landlord-side recipients passed in `to`) when a signer hits
// the Decline button on the sign page. The doc is voided as a side
// effect of decline; the landlord can optionally re-send a new doc.
export async function emailDocumentDeclined(to: string, recipientName: string, signerName: string, signerRole: string, documentTitle: string, unitLabel: string, reason: string | null, ctx?: { landlordId?: string; documentId?: string }) {
  const reasonBlock = reason && reason.trim()
    ? `<div style="margin:12px 0;padding:12px 16px;background:#0a0f14;border-radius:8px;border-left:3px solid #dc4c4c">
         <div style="font-size:.72rem;font-weight:700;color:#dc4c4c;text-transform:uppercase;letter-spacing:.05em;margin-bottom:6px">Reason given</div>
         <div style="color:#eef1f8;line-height:1.45">${escapeHtml(reason.trim())}</div>
       </div>`
    : p('<em style="color:#b8c4d8">No reason provided.</em>')
  await send(to, `Document declined: ${documentTitle}`,
    base(
      h('A Signer Declined Your Document') +
      p(`Hi ${recipientName},`) +
      p(`<strong>${escapeHtml(signerName)}</strong> (${escapeHtml(signerRole)}) declined to sign the following document:`) +
      `<div style="margin:12px 0;padding:12px 16px;background:#0a0f14;border-radius:8px;border-left:3px solid #c9a227">
        <div style="font-weight:700;color:#eef1f8;margin-bottom:2px">${escapeHtml(documentTitle)}</div>
        <div style="font-size:.82rem;color:#b8c4d8">${escapeHtml(unitLabel)}</div>
      </div>` +
      reasonBlock +
      p('The document has been voided. If the issue is resolvable, prepare a new document and re-send it for signing.')
    ),
    {
      category: 'esign_document_declined',
      landlordId: ctx?.landlordId ?? null,
      relatedEntityType: ctx?.documentId ? 'document' : null,
      relatedEntityId: ctx?.documentId ?? null,
    }
  )
}

export async function emailDocumentAutoVoided(to: string, recipientName: string, documentTitle: string, unitLabel: string, ctx?: { landlordId?: string; documentId?: string }) {
  await send(to, `Document auto-voided: ${documentTitle}`,
    base(
      h('Document Has Been Auto-Voided') +
      p(`Hi ${recipientName},`) +
      p('The following document was automatically voided because it was not signed by all parties within 24 hours of being sent:') +
      `<div style="margin:12px 0;padding:12px 16px;background:#0a0f14;border-radius:8px;border-left:3px solid #c9a227">
        <div style="font-weight:700;color:#eef1f8;margin-bottom:2px">${documentTitle}</div>
        <div style="font-size:.82rem;color:#b8c4d8">${unitLabel}</div>
      </div>` +
      p('No action is required. If you still need to complete this signing, please contact the landlord to send a new document.')
    ),
    {
      category: 'esign_document_auto_voided',
      landlordId: ctx?.landlordId ?? null,
      relatedEntityType: ctx?.documentId ? 'document' : null,
      relatedEntityId: ctx?.documentId ?? null,
    }
  )
}

// ── INVITATION EMAILS ─────────────────────────────────────────

export async function emailInvitation(to: string, inviterName: string, role: LandlordAssignableRole, acceptUrl: string, ctx?: { landlordId?: string; invitationId?: string }) {
  const roleLabel = LANDLORD_ASSIGNABLE_ROLE_LABEL[role]
  await send(to, `${inviterName} invited you to join GAM as ${roleLabel}`,
    base(
      h("You've been invited") +
      p(`<strong style="color:#eef1f8">${inviterName}</strong> has invited you to join Gold Asset Management as a <strong style="color:#eef1f8">${roleLabel}</strong>.`) +
      p('Click below to accept and set up your account. This invitation expires in 24 hours.') +
      btn('Accept Invitation', acceptUrl) +
      `<div style="margin-top:16px;font-size:.75rem;color:#4a5568">If you were not expecting this invitation, you can safely ignore this email.</div>`
    ),
    {
      category: 'invitation',
      landlordId: ctx?.landlordId ?? null,
      relatedEntityType: ctx?.invitationId ? 'invitation' : null,
      relatedEntityId: ctx?.invitationId ?? null,
      metadata: { role },
    },
    'support',
  )
}

// ── PM COMPANY STAFF INVITATION (S112) ────────────────────────
// Distinct from emailInvitation (in-house worker) — PM staff invitations
// land them as employees of a third-party PM company, not as a landlord's
// in-house worker. Different copy, different role enum, different accept
// endpoint (POST /api/pm/invitations/accept).
export async function emailPmInvitation(
  to: string,
  inviterName: string,
  companyName: string,
  role: 'owner' | 'manager' | 'staff',
  acceptUrl: string,
  ctx?: { pmCompanyId?: string; invitationId?: string }
) {
  const roleLabel = role === 'owner' ? 'Owner' : role === 'manager' ? 'Manager' : 'Staff'
  await send(to, `${inviterName} invited you to join ${companyName} on GAM`,
    base(
      h(`You've been invited to ${companyName}`) +
      p(`<strong style="color:#eef1f8">${inviterName}</strong> has invited you to join <strong style="color:#eef1f8">${companyName}</strong> as a <strong style="color:#eef1f8">${roleLabel}</strong>.`) +
      p(`${companyName} uses GAM (Gold Asset Management) to manage rental properties on behalf of property owners. As ${roleLabel.toLowerCase()}, you'll have access to the company's portfolio inside the GAM platform.`) +
      p('Click below to accept and set up your account. This invitation expires in 24 hours.') +
      btn('Accept Invitation', acceptUrl) +
      `<div style="margin-top:16px;font-size:.75rem;color:#4a5568">If you were not expecting this invitation, you can safely ignore this email.</div>`
    ),
    {
      category: 'pm_invitation',
      // landlordId intentionally null — pm_invitations are scoped to a
      // pm_company, not a landlord. The relatedEntity captures the company
      // and the invitation row id for failure-dashboard attribution.
      landlordId: null,
      relatedEntityType: ctx?.invitationId ? 'pm_invitation' : null,
      relatedEntityId: ctx?.invitationId ?? null,
      metadata: { role, pm_company_id: ctx?.pmCompanyId, company_name: companyName },
    },
    'support',
  )
}

// ── S157: pm_property_invitations email (mutual property-link handshake) ──
//
// Two directions:
//   owner_to_pm — owner offers property X to PM Co; PM staff click accept
//   pm_to_owner — PM Co offers visibility/management to owner; owner clicks
//
// Same email shape, different framing. ctx.invitationId is the
// pm_property_invitations row id; ctx.pmCompanyId is the company side.
export async function emailPmPropertyInvitation(args: {
  to: string
  direction: 'owner_to_pm' | 'pm_to_owner'
  inviterName: string
  pmCompanyName: string
  propertyName: string
  proposedScope: 'manage' | 'view'
  acceptUrl: string
  ctx?: { pmCompanyId?: string; invitationId?: string; landlordId?: string | null }
}) {
  const scopeLabel = args.proposedScope === 'manage' ? 'manage' : 'connect to'
  const subject = args.direction === 'owner_to_pm'
    ? `${args.inviterName} invited ${args.pmCompanyName} to manage ${args.propertyName}`
    : `${args.pmCompanyName} invited you to ${scopeLabel} ${args.propertyName} on GAM`
  const headline = args.direction === 'owner_to_pm'
    ? `Manage ${args.propertyName} on GAM?`
    : `${args.pmCompanyName} wants to ${scopeLabel} ${args.propertyName}`
  const body = args.direction === 'owner_to_pm'
    ? p(`<strong style="color:#eef1f8">${args.inviterName}</strong>, the owner of <strong style="color:#eef1f8">${args.propertyName}</strong>, has invited <strong style="color:#eef1f8">${args.pmCompanyName}</strong> to take over property management.`)
      + p('Accepting will route rent collection through GAM with the proposed fee plan, give your staff dispatch access for maintenance, and surface the property on your PM dashboard.')
    : p(`<strong style="color:#eef1f8">${args.pmCompanyName}</strong> has invited you to ${scopeLabel} <strong style="color:#eef1f8">${args.propertyName}</strong> on GAM.`)
      + p(args.proposedScope === 'manage'
          ? 'Accepting will route rent collection through GAM with the PM company\'s fee plan applied; you\'ll see the gross / PM cut / your net on every disbursement.'
          : 'Accepting will give you read-only visibility into the property\'s financials and operations through your GAM dashboard. The PM company continues to manage off-platform; no money flow changes.')
  await send(args.to, subject,
    base(
      h(headline) +
      body +
      p('This invitation expires in 72 hours.') +
      btn('Review Invitation', args.acceptUrl) +
      `<div style="margin-top:16px;font-size:.75rem;color:#4a5568">If you weren't expecting this invitation, you can safely ignore this email.</div>`
    ),
    {
      category: 'pm_property_invitation',
      landlordId: args.ctx?.landlordId ?? null,
      relatedEntityType: args.ctx?.invitationId ? 'pm_property_invitation' : null,
      relatedEntityId: args.ctx?.invitationId ?? null,
      metadata: {
        direction: args.direction,
        proposed_scope: args.proposedScope,
        pm_company_id: args.ctx?.pmCompanyId,
        pm_company_name: args.pmCompanyName,
        property_name: args.propertyName,
      },
    },
    'support',
  )
}

// ── S163: tenant nudges landlord to finish Connect onboarding ─────────────
//
// The tenant clicked the "Notify my landlord" CTA on the LandlordBankingBanner
// after seeing online rent payment was unavailable. Soft, polite copy — the
// tenant is the customer here too and we don't want them to feel awkward.
export async function emailLandlordBankingNudge(args: {
  to: string
  landlordName: string
  tenantName: string
  propertyName: string
  unitNumber: string
  bankingUrl: string
  ctx?: { landlordId?: string | null; tenantId?: string | null }
}) {
  await send(args.to,
    `${args.tenantName} is waiting on your GAM banking setup`,
    base(
      h(`${args.tenantName} wants to pay rent through GAM`) +
      p(`Hi ${args.landlordName},`) +
      p(`<strong style="color:#eef1f8">${args.tenantName}</strong> at <strong style="color:#eef1f8">${args.propertyName}, Unit ${args.unitNumber}</strong> tried to pay rent online but couldn't — your Stripe Connect onboarding isn't finished yet, so GAM can't route their payment to your bank.`) +
      p('Finish onboarding (a few minutes via the embedded Stripe form) and your tenant can start paying rent online immediately.') +
      btn('Complete Banking Setup', args.bankingUrl) +
      `<div style="margin-top:16px;font-size:.75rem;color:#4a5568">This is an automated nudge from your tenant. They'll only see the option to send it once every 24 hours.</div>`
    ),
    {
      category: 'landlord_banking_nudge',
      landlordId: args.ctx?.landlordId ?? null,
      relatedEntityType: 'tenant_landlord_nudge',
      relatedEntityId: args.ctx?.tenantId ?? null,
      metadata: { property_name: args.propertyName, unit_number: args.unitNumber },
    }
  )
}

// ── ADVERSE ACTION NOTICE (S87, FCRA §615(a)) ─────────────────
// Sent to an applicant when a landlord denies them based on a CRA
// report. The notice_text is built by lib/adverseAction.ts and stored
// verbatim in adverse_action_notices for the legal record. This email
// renders the same text into the body — text and stored copy must
// agree exactly.
//
// Returns the Resend message id so the caller can stamp it onto the
// adverse_action_notices row for delivery audit.
export async function emailAdverseActionNotice({
  to, applicantFirstName, noticeText, ctx,
}: { to: string; applicantFirstName: string; noticeText: string; ctx?: { landlordId?: string; backgroundCheckId?: string } }): Promise<string | null> {
  const html = base(
    h('Notice of Adverse Action') +
    p(`Hi ${applicantFirstName},`) +
    p(
      'The required Fair Credit Reporting Act notice regarding your ' +
      'recent rental application is included below. Please retain a ' +
      'copy for your records.'
    ) +
    `<pre style="margin:16px 0;padding:14px;background:#0a0f14;border:1px solid #1e2530;border-radius:8px;color:#b8c4d8;font-family:ui-monospace,Menlo,Consolas,monospace;font-size:.78rem;line-height:1.55;white-space:pre-wrap;word-wrap:break-word">${escapeHtml(noticeText)}</pre>`
  )
  return send(to, 'Notice of Adverse Action — Fair Credit Reporting Act', html, {
    category: 'adverse_action',
    landlordId: ctx?.landlordId ?? null,
    relatedEntityType: ctx?.backgroundCheckId ? 'background_check' : null,
    relatedEntityId: ctx?.backgroundCheckId ?? null,
  }, 'support')
}

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;')
}

// ── DISBURSEMENT / RENT-FLOW EMAILS (S85: ported from lib/email.ts) ──
// Pre-S85 these lived in apps/api/src/lib/email.ts and used nodemailer/SMTP.
// Consolidated to Resend so the platform has one mail sender. No consumers
// were wired before consolidation; signatures preserved so callers can be
// added later without re-shaping the call sites.

/**
 * S247: Sublease invite — sent to a prospective sublessee who is not
 * yet a GAM tenant. Carries a token-bearing accept link. Public flow:
 * recipient clicks, lands on accept page, signs up + verifies ACH +
 * completes BG check; on completion the sublease row's invitation
 * link resolves and the landlord can decide the request.
 */
export async function sendSubleaseInvite({
  sublesseeEmail, sublessorName, token, propertyName, unitNumber,
  subMonthlyAmount, startDate, endDate, ctx,
}: {
  sublesseeEmail: string; sublessorName: string; token: string
  propertyName: string; unitNumber: string
  subMonthlyAmount: number
  startDate: string; endDate: string | null
  ctx?: { masterLeaseId?: string; sublessorTenantId?: string }
}) {
  const appUrl = process.env.TENANT_APP_URL || 'http://localhost:3002'
  const acceptUrl = `${appUrl}/sublease-invite/${token}`
  const range = endDate
    ? `${new Date(startDate).toLocaleDateString()} – ${new Date(endDate).toLocaleDateString()}`
    : `Starting ${new Date(startDate).toLocaleDateString()} (open-ended)`
  await send(sublesseeEmail, `${sublessorName} invited you to sublease their unit`,
    base(
      h(`You've been invited to sublease`) +
      p(`${sublessorName} wants to sublease their place to you through GAM:`) +
      `<div style="background:#0a0f14;border-radius:8px;padding:16px;margin:12px 0">
        <div style="font-weight:700;color:#c9a227;margin-bottom:8px">${propertyName} · Unit ${unitNumber}</div>
        <ul style="color:#b8c4d8;font-size:.82rem;padding-left:18px;line-height:1.7;margin:0">
          <li>${range}</li>
          <li>$${subMonthlyAmount.toFixed(2)}/month</li>
        </ul>
      </div>` +
      p(`To accept, you'll create a GAM tenant account, verify your bank, and complete a background check. After that, the property owner reviews and approves the sublease.`) +
      `<div style="text-align:center;margin:18px 0">
        <a href="${acceptUrl}" style="background:#c9a227;color:#0a0f14;padding:12px 24px;border-radius:6px;font-weight:700;text-decoration:none;display:inline-block">Accept the invitation</a>
      </div>` +
      p(`This invitation expires in 14 days. If you don't recognize ${sublessorName} or this property, ignore this email.`)
    ),
    {
      category: 'sublease_invite',
      landlordId: null,
      relatedEntityType: ctx?.masterLeaseId ? 'lease' : null,
      relatedEntityId: ctx?.masterLeaseId ?? null,
      metadata: {
        sublessor_tenant_id: ctx?.sublessorTenantId ?? null,
        sub_monthly_amount: subMonthlyAmount,
      },
    },
    'support',
  )
}

/**
 * S258: pos_customer ACH onboarding invite. Sent to a non-tenant
 * customer that a merchant has added to their FlexCharge roster.
 * Carries a token-bearing link to a public-flow onboarding page
 * where the customer completes Stripe Financial Connections to
 * verify their bank account. Required before FlexCharge statements
 * can be ACH-pulled against them.
 */
export async function sendPosCustomerOnboarding({
  customerEmail, customerName, merchantName, token, ctx,
}: {
  customerEmail: string
  customerName:  string
  merchantName:  string
  token:         string
  ctx?: { landlordId?: string; posCustomerId?: string }
}) {
  const appUrl = process.env.TENANT_APP_URL || 'http://localhost:3002'
  const acceptUrl = `${appUrl}/pos-customer-onboard/${token}`
  await send(customerEmail, `${merchantName} invited you to open a FlexCharge tab`,
    base(
      h('Open a FlexCharge tab') +
      p(`Hi ${customerName},`) +
      p(`<b>${merchantName}</b> wants to open a FlexCharge tab for you on the GAM platform. With a tab, you can charge purchases through the month and pay the balance via auto-ACH on a single monthly statement.`) +
      `<div style="background:#0a0f14;border-radius:8px;padding:16px;margin:12px 0">
        <div style="font-weight:700;color:#c9a227;margin-bottom:8px">How this works</div>
        <ul style="color:#b8c4d8;font-size:.82rem;padding-left:18px;line-height:1.7;margin:0">
          <li>Verify your bank account with Stripe (we never see the full number)</li>
          <li>${merchantName} sets your credit limit at their point-of-sale</li>
          <li>End-of-month statement auto-pulls from your bank — 1.5% service fee</li>
        </ul>
      </div>` +
      `<div style="text-align:center;margin:18px 0">
        <a href="${acceptUrl}" style="background:#c9a227;color:#0a0f14;padding:12px 24px;border-radius:6px;font-weight:700;text-decoration:none;display:inline-block">Verify your bank</a>
      </div>` +
      p(`This link expires in 14 days. If you don't recognize ${merchantName}, ignore this email.`)
    ),
    {
      category: 'pos_customer_onboarding',
      landlordId: ctx?.landlordId ?? null,
      relatedEntityType: ctx?.posCustomerId ? 'pos_customer' : null,
      relatedEntityId: ctx?.posCustomerId ?? null,
      metadata: {},
    },
    'support',
  )
}

export async function sendOnTimePayInvitation({
  email, firstName, lateCount, rentAmount, ctx,
}: { email: string; firstName: string; lateCount: number; rentAmount: number; ctx?: { landlordId?: string; tenantId?: string } }) {
  void rentAmount  // reserved for future per-tenant fee tier display
  await send(email, 'Never pay a late fee again — On-Time Pay invitation',
    base(
      h('Never pay a late fee again') +
      p(`Hi ${firstName},`) +
      p(`We noticed your last ${lateCount} rent payments arrived after the 1st. If your income arrives mid-month — Social Security, disability, pension, or similar — we can help.`) +
      `<div style="background:#0a0f14;border-radius:8px;padding:16px;margin:12px 0">
        <div style="font-weight:700;color:#c9a227;margin-bottom:8px">On-Time Pay — $20/month</div>
        <ul style="color:#b8c4d8;font-size:.82rem;padding-left:18px;line-height:1.7;margin:0">
          <li>Your landlord gets paid on the 1st — automatically</li>
          <li>Your payment is collected on your income date</li>
          <li>No late fees. Ever.</li>
          <li>Not a loan — this is a payment timing service</li>
        </ul>
      </div>` +
      p('Most tenants save $30–55/month in late fees. This invitation expires in 14 days.')
    ),
    {
      category: 'otp_invitation',
      landlordId: ctx?.landlordId ?? null,
      relatedEntityType: ctx?.tenantId ? 'tenant' : null,
      relatedEntityId: ctx?.tenantId ?? null,
      metadata: { late_count: lateCount },
    }
  )
}

export async function sendLatePaymentNotice({
  landlordEmail, landlordName, tenantName, unitNumber, propertyName, daysLate, amount, ctx,
}: { landlordEmail: string; landlordName: string; tenantName: string; unitNumber: string; propertyName: string; daysLate: number; amount: number; ctx?: { landlordId?: string; paymentId?: string } }) {
  await send(landlordEmail, `Late payment alert — ${tenantName} — Unit ${unitNumber} — Day ${daysLate}`,
    base(
      `<div style="margin-bottom:14px;padding:10px 14px;background:rgba(245,158,11,.08);border:1px solid rgba(245,158,11,.3);border-radius:8px;color:#f59e0b;font-size:.85rem">⚠️ Late payment — Day ${daysLate}</div>` +
      h('Late Payment Alert') +
      p(`Hi ${landlordName},`) +
      p(`Tenant <strong style="color:#eef1f8">${tenantName}</strong> at <strong style="color:#eef1f8">${propertyName} Unit ${unitNumber}</strong> has not paid rent of <strong style="color:#eef1f8">$${amount.toLocaleString()}</strong> — now ${daysLate} days overdue.`) +
      p('Your On-Time Pay disbursement was funded from the platform reserve. We are continuing to attempt ACH collection. You will be notified when payment settles.') +
      `<div style="margin-top:14px;font-size:.75rem;color:#4a5568">If you wish to file for eviction, activate Eviction Mode in your dashboard first — this hard-blocks all ACH. Check your local laws before accepting any payment during an eviction process.</div>`
    ),
    {
      category: 'late_payment_notice',
      landlordId: ctx?.landlordId ?? null,
      relatedEntityType: ctx?.paymentId ? 'payment' : null,
      relatedEntityId: ctx?.paymentId ?? null,
      metadata: { days_late: daysLate, amount },
    }
  )
}

// S106 — generic notification-channel email. Wraps send() so callers in
// services/notifications.ts (createNotification + sendBulkNotification)
// can route through the same Resend integration + email_send_log
// pipeline as the per-purpose senders above. Pre-S106 those callers used
// a local stub that only console.log'd. Category is 'notif_<type>' so
// notification-channel emails are distinguishable from sender-triggered
// ones in the failure dashboard.
export async function sendNotificationEmail(opts: {
  to: string
  subject: string
  html: string
  notificationType: string
  userId?: string | null
  landlordId?: string | null
  notificationId?: string | null
}): Promise<string | null> {
  return send(opts.to, opts.subject, opts.html, {
    category: `notif_${opts.notificationType}`,
    landlordId: opts.landlordId ?? null,
    relatedEntityType: opts.notificationId ? 'notification' : null,
    relatedEntityId: opts.notificationId ?? null,
    metadata: opts.userId ? { user_id: opts.userId } : undefined,
  })
}

// S29c — onboarding activation email (existing-tenant migration flow)
export async function emailTenantOnboarded(
  to: string,
  tenantName: string,
  landlordName: string,
  propertyAddress: string,
  unitLabel: string,
  activationUrl: string,
  ctx?: { landlordId?: string; tenantId?: string }
) {
  await send(to, `${landlordName} added you to GAM for ${unitLabel}`,
    base(
      h('Welcome to GAM') +
      p(`Hi ${tenantName},`) +
      p(`Your landlord <strong style="color:#eef1f8">${landlordName}</strong> has added you to GAM, the platform they use to manage your tenancy.`) +
      `<div style="margin:12px 0;padding:12px 16px;background:#0a0f14;border-radius:8px;border-left:3px solid #c9a227">
        <div style="font-weight:700;color:#eef1f8;margin-bottom:2px">${propertyAddress}</div>
        <div style="font-size:.82rem;color:#b8c4d8">${unitLabel}</div>
      </div>` +
      p('Click below to activate your account and set a password. There is no application or background check required — your landlord has already onboarded you.') +
      btn('Activate Your Account', activationUrl) +
      p('Once activated, you can view your lease, set up rent payments, and submit maintenance requests through the GAM tenant portal.') +
      `<div style="margin-top:16px;font-size:.75rem;color:#4a5568">If you have questions, reach out to your landlord directly.</div>`
    ),
    {
      category: 'tenant_onboarded',
      landlordId: ctx?.landlordId ?? null,
      relatedEntityType: ctx?.tenantId ? 'tenant' : null,
      relatedEntityId: ctx?.tenantId ?? null,
      metadata: { unit_label: unitLabel },
    },
    'support',
  )
}

// S281 — email verification at registration. Sent after a successful
// signup; the link consumes the token via POST /api/auth/verify-email.
export async function sendEmailVerification(
  to: string,
  firstName: string | null,
  verifyUrl: string,
  ctx?: { userId?: string },
): Promise<string | null> {
  const greeting = firstName ? `Welcome, ${firstName}!` : 'Welcome!'
  return send(
    to,
    'Verify your GAM email',
    base(
      h('Confirm your email') +
      p(greeting) +
      p(`Click the button below to verify the email on your GAM account. This link doesn't expire and is good for one use — you'll only need to do this once.`) +
      btn('Verify email', verifyUrl) +
      p(`If you didn't create a GAM account, you can safely ignore this email.`)
    ),
    {
      category: 'email_verification',
      metadata: ctx?.userId ? { user_id: ctx.userId } : undefined,
    },
  )
}

// S279 — password reset request. Single-use token-bearing URL.
// Caller has already minted + persisted the token; this just
// sends the email with the URL embedded.
export async function sendPasswordResetEmail(
  to: string,
  firstName: string | null,
  resetUrl: string,
  ctx?: { userId?: string },
): Promise<string | null> {
  const greeting = firstName ? `Hi ${firstName},` : 'Hi,'
  return send(
    to,
    'Reset your GAM password',
    base(
      h('Password reset request') +
      p(greeting) +
      p(`We got a request to reset the password on your GAM account. Click the button below to set a new one — the link expires in <strong style="color:#eef1f8">1 hour</strong>.`) +
      btn('Reset password', resetUrl) +
      p(`If you didn't request this, you can ignore this email. Your current password stays active until someone uses the link.`) +
      `<div style="margin-top:16px;font-size:.75rem;color:#4a5568">For security, this link only works once.</div>`
    ),
    {
      category: 'password_reset',
      metadata: ctx?.userId ? { user_id: ctx.userId } : undefined,
    },
  )
}


// S322: FlexSuite enrollment confirmation with attached populated
// terms PDF. The PDF is the load-bearing tenant-inbox-durability copy
// of the click-accepted SLA / Subscription Terms; the canonical legal
// artifact remains flexsuite_enrollment_acceptances.rendered_text in
// the DB. Best-effort send — failures log but never throw (caller's
// enrollment commit already succeeded).
export async function emailFlexsuiteEnrollment(args: {
  to:                 string
  tenantName:         string
  product:            'flexpay' | 'flexdeposit'
  acceptedAt:         Date
  templateVersion:    string
  acceptanceId:       string
  pdfBuffer:          Buffer
}): Promise<string | null> {
  const productLabel = args.product === 'flexpay'
    ? 'FlexPay Subscription Terms'
    : 'FlexDeposit Service Agreement'
  const greeting = args.tenantName ? `Hi ${args.tenantName.split(' ')[0]},` : 'Hi,'
  const subject  = `Your ${productLabel} — enrollment confirmation`
  const filename = args.product === 'flexpay'
    ? 'GAM-FlexPay-Subscription-Terms.pdf'
    : 'GAM-FlexDeposit-Service-Agreement.pdf'
  const html = base(
    h(`Enrollment confirmed — ${productLabel}`) +
    p(greeting) +
    p(`Thank you for enrolling. Your accepted copy of the ${productLabel} is attached as a PDF for your records.`) +
    p(`<strong style="color:#eef1f8">What's attached:</strong> the exact populated agreement you click-accepted on the platform on <strong style="color:#eef1f8">${args.acceptedAt.toLocaleString()}</strong>. Keep it with your other GAM records.`) +
    `<div style="margin-top:20px;padding:12px 14px;background:#1a1f24;border-radius:7px;font-size:.74rem;color:#a0aec0;line-height:1.5">
      <div><strong style="color:#c9a227">Acceptance ID</strong> ${args.acceptanceId}</div>
      <div style="margin-top:4px"><strong style="color:#c9a227">Template version</strong> v${args.templateVersion}</div>
      <div style="margin-top:4px"><strong style="color:#c9a227">Accepted at</strong> ${args.acceptedAt.toISOString()}</div>
    </div>` +
    `<div style="margin-top:20px;font-size:.72rem;color:#4a5568">If you have questions, reply to this email or contact GAM support from the tenant portal.</div>`
  )
  return send(
    args.to,
    subject,
    html,
    {
      category: `flexsuite_${args.product}_enrollment_confirmation`,
      relatedEntityType: 'flexsuite_enrollment_acceptance',
      relatedEntityId:   args.acceptanceId,
      metadata:          { product: args.product, template_version: args.templateVersion },
    },
    'noreply',
    [{ filename, content: args.pdfBuffer }],
  )
}
