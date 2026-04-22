import { Resend } from 'resend'
import { LandlordAssignableRole, LANDLORD_ASSIGNABLE_ROLE_LABEL } from '@gam/shared'

const resend = new Resend(process.env.RESEND_API_KEY)
const FROM = process.env.EMAIL_FROM || 'GAM Platform <onboarding@resend.dev>'
const APP_NAME = 'GAM Platform'

async function send(to: string, subject: string, html: string) {
  try {
    const { error } = await resend.emails.send({ from: FROM, to, subject, html })
    if (error) console.error('[EMAIL ERROR]', error)
    else console.log('[EMAIL SENT]', subject, '->', to)
  } catch(e) {
    console.error('[EMAIL FAILED]', e)
  }
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

export async function emailNewBackgroundCheck(landlordEmail: string, landlordName: string, tenantName: string, propertyName: string, unitNumber: string, riskLevel: string, portalUrl = 'http://localhost:3001/background') {
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
    )
  )
}

export async function emailBackgroundDecision(tenantEmail: string, tenantName: string, decision: 'approved' | 'denied', propertyName: string, unitNumber: string, notes?: string, portalUrl = 'http://localhost:3002') {
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
    )
  )
}

// ── POOL EMAILS ───────────────────────────────────────────────

export async function emailPoolMatchInterest(tenantEmail: string, tenantName: string, landlordName: string, propertyName: string, unitNumber: string, message: string|null, portalUrl = 'http://localhost:3002/notifications') {
  await send(tenantEmail, `A landlord is interested in you — ${propertyName}`,
    base(
      h('You Have a Match!') +
      p(`Hi ${tenantName},`) +
      p(`<strong style="color:#eef1f8">${landlordName}</strong> has a vacancy at <strong style="color:#eef1f8">${propertyName} Unit ${unitNumber}</strong> and is interested in your profile.`) +
      (message ? `<div style="margin:12px 0;padding:10px 14px;background:#0a0f14;border-radius:8px;border-left:3px solid #c9a227;font-size:.82rem;color:#b8c4d8;font-style:italic">"</strong>${message}"</div>` : '') +
      p('Log in to your portal to let them know if you are interested.') +
      btn('Respond Now', portalUrl)
    )
  )
}

export async function emailPoolTenantInterested(landlordEmail: string, landlordName: string, portalUrl = 'http://localhost:3001/pool') {
  await send(landlordEmail, 'A tenant confirmed interest — unlock their full report',
    base(
      h('Tenant Is Interested!') +
      p(`Hi ${landlordName},`) +
      p('A tenant from the applicant pool has confirmed they are interested in your property.') +
      p('You can now unlock their full background report for <strong style="color:#eef1f8">$5</strong>.') +
      btn('View Match', portalUrl)
    )
  )
}

// ── MAINTENANCE EMAILS ────────────────────────────────────────

export async function emailMaintenanceCreated(landlordEmail: string, tenantName: string, unit: string, issue: string, portalUrl = 'http://localhost:3001/maintenance') {
  await send(landlordEmail, `New maintenance request — Unit ${unit}`,
    base(
      h('New Maintenance Request') +
      p(`<strong style="color:#eef1f8">${tenantName}</strong> (Unit ${unit}) has submitted a maintenance request:`) +
      `<div style="margin:12px 0;padding:10px 14px;background:#0a0f14;border-radius:8px;font-size:.82rem;color:#b8c4d8">${issue}</div>` +
      btn('View Request', portalUrl)
    )
  )
}

// ── E-SIGN EMAILS ─────────────────────────────────────────────

export async function emailSigningRequest(to: string, signerName: string, documentTitle: string, unitLabel: string, landlordName: string, signingUrl: string) {
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
    )
  )
}

export async function emailSigningCompleted(to: string, signerName: string, documentTitle: string, unitLabel: string, pdfUrl?: string, portalUrl = 'http://localhost:3002') {
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
    )
  )
}

// ── INVITATION EMAILS ─────────────────────────────────────────

export async function emailInvitation(to: string, inviterName: string, role: LandlordAssignableRole, acceptUrl: string) {
  const roleLabel = LANDLORD_ASSIGNABLE_ROLE_LABEL[role]
  await send(to, `${inviterName} invited you to join GAM as ${roleLabel}`,
    base(
      h("You've been invited") +
      p(`<strong style="color:#eef1f8">${inviterName}</strong> has invited you to join Gold Asset Management as a <strong style="color:#eef1f8">${roleLabel}</strong>.`) +
      p('Click below to accept and set up your account. This invitation expires in 24 hours.') +
      btn('Accept Invitation', acceptUrl) +
      `<div style="margin-top:16px;font-size:.75rem;color:#4a5568">If you were not expecting this invitation, you can safely ignore this email.</div>`
    )
  )
}
