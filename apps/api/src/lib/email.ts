import nodemailer from 'nodemailer'

function getTransport() {
  // In dev, use ethereal or log to console
  if (process.env.NODE_ENV !== 'production') {
    return nodemailer.createTransport({
      host: 'smtp.ethereal.email',
      port: 587,
      auth: {
        user: process.env.SMTP_USER || 'dev@ethereal.email',
        pass: process.env.SMTP_PASS || '',
      },
    })
  }
  return nodemailer.createTransport({
    host: process.env.SMTP_HOST,
    port: parseInt(process.env.SMTP_PORT || '587'),
    secure: process.env.SMTP_SECURE === 'true',
    auth: { user: process.env.SMTP_USER, pass: process.env.SMTP_PASS },
  })
}

const FROM = '"Gold Asset Management" <no-reply@goldassetmgmt.com>'

export async function sendDisbursementConfirmation({
  email, firstName, amount, targetDate, fromReserve,
}: { email:string; firstName:string; amount:number; targetDate:string; fromReserve:boolean }) {
  const t = getTransport()
  await t.sendMail({
    from: FROM,
    to: email,
    subject: `✓ Rent disbursed — $${amount.toLocaleString()} — ${targetDate}`,
    html: `
      <div style="font-family:sans-serif;max-width:520px;margin:0 auto;padding:32px;background:#f9f9f9">
        <div style="background:#0a0b0e;border-radius:12px;padding:28px;color:#f0f2f7">
          <div style="font-size:1.2rem;font-weight:800;color:#c9a227;margin-bottom:16px">⚡ Gold Asset Management</div>
          <h2 style="margin-bottom:8px">Rent Disbursed</h2>
          <p style="color:#8a96b0;margin-bottom:20px">Hi ${firstName},</p>
          <div style="background:#141720;border-radius:8px;padding:16px;margin-bottom:20px">
            <div style="font-size:2rem;font-weight:800;color:#22c55e">$${amount.toLocaleString()}</div>
            <div style="color:#8a96b0;font-size:.875rem;margin-top:4px">Initiated ${targetDate} per On-Time Pay SLA</div>
            ${fromReserve ? '<div style="color:#f59e0b;font-size:.8rem;margin-top:8px">⚡ Funded from operational reserve — tenant collection pending</div>' : ''}
          </div>
          <p style="color:#8a96b0;font-size:.875rem">Funds will settle in your bank account within 1–2 business days.</p>
        </div>
      </div>
    `,
  })
}

export async function sendOnTimePayInvitation({
  email, firstName, lateCount, rentAmount,
}: { email:string; firstName:string; lateCount:number; rentAmount:number }) {
  const t = getTransport()
  await t.sendMail({
    from: FROM,
    to: email,
    subject: 'Never pay a late fee again — On-Time Pay invitation',
    html: `
      <div style="font-family:sans-serif;max-width:520px;margin:0 auto;padding:32px;background:#f9f9f9">
        <div style="background:#0a0b0e;border-radius:12px;padding:28px;color:#f0f2f7">
          <div style="font-size:1.2rem;font-weight:800;color:#c9a227;margin-bottom:20px">⚡ Gold Asset Management</div>
          <h2 style="margin-bottom:12px">Never pay a late fee again</h2>
          <p style="color:#8a96b0;margin-bottom:16px">Hi ${firstName},</p>
          <p style="color:#c4ccde;margin-bottom:20px">We noticed your last ${lateCount} rent payments arrived after the 1st. If your income arrives mid-month — Social Security, disability, pension, or similar — we can help.</p>
          <div style="background:#141720;border-radius:8px;padding:16px;margin-bottom:20px">
            <div style="font-weight:700;color:#c9a227;margin-bottom:8px">On-Time Pay — $20/month</div>
            <ul style="color:#8a96b0;font-size:.875rem;padding-left:16px;line-height:1.8">
              <li>Your landlord gets paid on the 1st — automatically</li>
              <li>Your payment is collected on your income date</li>
              <li>No late fees. Ever.</li>
              <li>Not a loan — this is a payment timing service</li>
            </ul>
          </div>
          <p style="color:#555f7a;font-size:.8rem">Most tenants save $30–55/month in late fees. This invitation expires in 14 days.</p>
        </div>
      </div>
    `,
  })
}

export async function sendLatePaymentNotice({
  landlordEmail, landlordName, tenantName, unitNumber, propertyName, daysLate, amount,
}: { landlordEmail:string; landlordName:string; tenantName:string; unitNumber:string; propertyName:string; daysLate:number; amount:number }) {
  const t = getTransport()
  await t.sendMail({
    from: FROM,
    to: landlordEmail,
    subject: `Late payment alert — ${tenantName} — Unit ${unitNumber} — Day ${daysLate}`,
    html: `
      <div style="font-family:sans-serif;max-width:520px;margin:0 auto;padding:32px;background:#f9f9f9">
        <div style="background:#0a0b0e;border-radius:12px;padding:28px;color:#f0f2f7">
          <div style="font-size:1.2rem;font-weight:800;color:#c9a227;margin-bottom:20px">⚡ Gold Asset Management</div>
          <div style="background:rgba(245,158,11,.1);border:1px solid rgba(245,158,11,.3);border-radius:8px;padding:12px;margin-bottom:16px;color:#f59e0b;font-size:.875rem">
            ⚠️ Late payment — Day ${daysLate}
          </div>
          <p style="color:#8a96b0;margin-bottom:16px">Hi ${landlordName},</p>
          <p style="color:#c4ccde;margin-bottom:16px">Tenant <strong style="color:#f0f2f7">${tenantName}</strong> at <strong style="color:#f0f2f7">${propertyName} Unit ${unitNumber}</strong> has not paid rent of $${amount.toLocaleString()} — now ${daysLate} days overdue.</p>
          <p style="color:#8a96b0;font-size:.875rem">Your On-Time Pay disbursement was funded from our reserve. We are continuing to attempt ACH collection. You will be notified when payment settles.</p>
          <p style="color:#555f7a;font-size:.8rem;margin-top:16px">If you wish to file for eviction, activate Eviction Mode in your dashboard first — this hard-blocks all ACH. Check your local laws before accepting any payment during an eviction process.</p>
        </div>
      </div>
    `,
  })
}

export async function sendAchReturnAlert({
  adminEmail, tenantName, unitNumber, returnCode, zeroTolerance, amount,
}: { adminEmail:string; tenantName:string; unitNumber:string; returnCode:string; zeroTolerance:boolean; amount:number }) {
  const t = getTransport()
  await t.sendMail({
    from: FROM,
    to: adminEmail,
    subject: `${zeroTolerance ? '🚨 ZERO-TOLERANCE' : '⚠️'} ACH Return ${returnCode} — ${tenantName} — Unit ${unitNumber}`,
    html: `
      <div style="font-family:sans-serif;max-width:520px;margin:0 auto;padding:32px">
        <div style="background:${zeroTolerance ? '#1a0505' : '#0d1014'};border-radius:12px;padding:28px;color:#f0f2f7;border:1px solid ${zeroTolerance ? '#7f1d1d' : '#1e2435'}">
          <h2 style="color:${zeroTolerance ? '#ef4444' : '#f59e0b'};margin-bottom:16px">${zeroTolerance ? '🚨 Zero-Tolerance ACH Return' : '⚠️ ACH Return Received'}</h2>
          <div style="background:rgba(0,0,0,.3);border-radius:8px;padding:14px;margin-bottom:16px">
            <div><span style="color:#555f7a">Tenant:</span> <strong>${tenantName}</strong></div>
            <div><span style="color:#555f7a">Unit:</span> ${unitNumber}</div>
            <div><span style="color:#555f7a">Return code:</span> <strong style="color:${zeroTolerance?'#ef4444':'#f59e0b'}">${returnCode}</strong></div>
            <div><span style="color:#555f7a">Amount:</span> $${amount.toLocaleString()}</div>
          </div>
          ${zeroTolerance ? '<p style="color:#fca5a5;font-size:.875rem">NACHA zero-tolerance policy: tenant ACH has been automatically suspended. Manual review required before re-enabling. Check NACHA Monitor in admin console.</p>' : '<p style="color:#8a96b0;font-size:.875rem">Non-critical return. Tenant retry may be attempted. Review in admin console.</p>'}
        </div>
      </div>
    `,
  })
}
