import { query, queryOne } from '../db'
import { sendNotificationEmail } from './email'
import { logger } from '../lib/logger'

// SMS is still stubbed — no Twilio account wired. When Twilio (or another
// SMS provider) is selected, replace this stub with a real send + add log
// rows to email_send_log (or a sibling sms_send_log) so failures surface
// in the same dashboard.
async function sendSMS(to: string, body: string) {
  logger.info(`[SMS-STUB] To: ${to} | ${body}`)
}

function emailTemplate(title: string, body: string, cta?: { label: string; url: string }) {
  return `<!DOCTYPE html><html><head><meta charset="utf-8"><style>
    body{font-family:system-ui,sans-serif;background:#060809;color:#b8c4d8;margin:0;padding:20px}
    .c{max-width:560px;margin:0 auto;background:#0a0d10;border:1px solid #1e2530;border-radius:12px;overflow:hidden}
    .h{background:#090c0f;border-bottom:1px solid #1e2530;padding:20px 28px}
    .logo{font-size:18px;font-weight:800;color:#c9a227}
    .body{padding:28px}
    .title{font-size:20px;font-weight:700;color:#eef1f8;margin-bottom:12px}
    .text{font-size:14px;line-height:1.7;color:#b8c4d8}
    .btn{display:inline-block;margin-top:20px;padding:12px 24px;background:#c9a227;color:#060809;font-weight:700;border-radius:8px;text-decoration:none}
    .foot{padding:16px 28px;border-top:1px solid #1e2530;font-size:11px;color:#4a5568}
  </style></head><body>
  <div class="c">
    <div class="h"><div class="logo">⚡ GAM</div></div>
    <div class="body">
      <div class="title">${title}</div>
      <div class="text">${body}</div>
      ${cta ? `<a href="${cta.url}" class="btn">${cta.label}</a>` : ''}
    </div>
    <div class="foot">Gold Asset Management LLC</div>
  </div></body></html>`
}

export async function createNotification(p: {
  userId: string; landlordId?: string; type: string; title: string; body: string; data?: any
  sendEmail?: boolean; emailTo?: string; emailSubject?: string; emailHtml?: string
  sendSMS?: boolean; smsTo?: string; smsBody?: string
}) {
  try {
    const prefs = await queryOne<any>('SELECT * FROM notification_preferences WHERE user_id=$1 AND type=$2', [p.userId, p.type])
    const emailOk = prefs ? prefs.email_enabled : true
    const smsOk   = prefs ? prefs.sms_enabled : false
    const inAppOk = prefs ? prefs.in_app_enabled : true

    // Capture the inserted notification id so the post-send flag updates can
    // target this exact row instead of the previously-broken
    // `UPDATE ... ORDER BY created_at LIMIT 1` shape (MySQL syntax; not
    // valid on PostgreSQL UPDATE — would throw and leave the email_sent
    // and sms_sent flags forever FALSE).
    let notificationId: string | null = null
    if (inAppOk) {
      const ins = await queryOne<{ id: string }>(
        'INSERT INTO notifications (user_id,landlord_id,type,title,body,data) VALUES ($1,$2,$3,$4,$5,$6) RETURNING id',
        [p.userId, p.landlordId||null, p.type, p.title, p.body, JSON.stringify(p.data||{})]
      )
      notificationId = ins?.id ?? null
    }
    if (emailOk && p.sendEmail && p.emailTo) {
      // S106: routed through the central send() in services/email.ts so
      // every notification email writes to email_send_log and surfaces
      // in the failure dashboard. Pre-S106 the local stub just
      // console.log'd — no real delivery and no log coverage.
      // Flag is only set TRUE on actual delivery (non-null message id);
      // attempted-but-rejected sends leave the flag FALSE and the
      // email_send_log row carries the failure for landlord visibility.
      const messageId = await sendNotificationEmail({
        to: p.emailTo,
        subject: p.emailSubject || p.title,
        html: p.emailHtml || emailTemplate(p.title, p.body),
        notificationType: p.type,
        userId: p.userId,
        landlordId: p.landlordId ?? null,
        notificationId,
      })
      if (notificationId && messageId) {
        await query("UPDATE notifications SET email_sent=TRUE, email_sent_at=NOW() WHERE id=$1", [notificationId])
      }
    }
    if (smsOk && p.sendSMS && p.smsTo) {
      await sendSMS(p.smsTo, p.smsBody||p.body)
      if (notificationId) {
        await query("UPDATE notifications SET sms_sent=TRUE, sms_sent_at=NOW() WHERE id=$1", [notificationId])
      }
    }
  } catch (e) { logger.error({ err: e }, '[NOTIFY]') }
}

export async function notifyRentCollected(o: { landlordUserId:string; landlordId:string; landlordEmail:string; landlordPhone?:string; tenantName:string; unitNumber:string; propertyName:string; amount:number }) {
  await createNotification({ userId:o.landlordUserId, landlordId:o.landlordId, type:'rent_collected', title:`Rent Collected — Unit ${o.unitNumber}`, body:`${o.tenantName} paid $${o.amount.toFixed(2)} for Unit ${o.unitNumber} at ${o.propertyName}.`, data:o, sendEmail:true, emailTo:o.landlordEmail, emailSubject:`✅ Rent Collected — Unit ${o.unitNumber}`, emailHtml:emailTemplate(`Rent Collected — Unit ${o.unitNumber}`, `<b>${o.tenantName}</b> paid <b>$${o.amount.toFixed(2)}</b> for Unit ${o.unitNumber} at ${o.propertyName}.`), sendSMS:true, smsTo:o.landlordPhone, smsBody:`GAM: Rent $${o.amount.toFixed(2)} collected from ${o.tenantName}, Unit ${o.unitNumber}.` })
}

// S125: ACH retry-scheduled notification. Fires when a payment fails on a
// retry-eligible NACHA code (R01 insufficient funds, R09 uncollected) and
// retry_count < 2. Tenant gets the heads-up + retry date; landlord gets a
// shorter info copy. Terminal-failure path is notifyAchRetriesExhausted.
export async function notifyAchRetryScheduled(o: {
  tenantUserId: string; tenantEmail: string; tenantPhone?: string; tenantName: string;
  landlordUserId: string; landlordId: string; landlordEmail: string;
  unitNumber: string; propertyName: string;
  amount: number; reason: string;          // human-readable description from ACH_RETURN_CONFIG
  retryDate: string;                       // ISO date string (YYYY-MM-DD)
  retryAttempt: 1 | 2;                     // which retry this is
}) {
  // Tenant: actionable — tells them what failed, why, and when we'll try again
  await createNotification({
    userId: o.tenantUserId,
    type: 'ach_retry_scheduled',
    title: `Payment retry scheduled — ${o.retryDate}`,
    body: `Your $${o.amount.toFixed(2)} payment for Unit ${o.unitNumber} failed (${o.reason}). We'll automatically retry on ${o.retryDate}. Make sure your bank account has sufficient funds.`,
    data: o,
    sendEmail: true, emailTo: o.tenantEmail,
    emailSubject: `Payment retry scheduled — ${o.retryDate}`,
    emailHtml: emailTemplate(
      `Your Payment Will Retry on ${o.retryDate}`,
      `<p>Your <b>$${o.amount.toFixed(2)}</b> payment for ${o.propertyName} Unit ${o.unitNumber} failed:</p>` +
      `<div style="margin:12px 0;padding:10px;background:#0a0f14;border-left:3px solid #f59e0b;border-radius:6px;color:#b8c4d8">${o.reason}</div>` +
      `<p>We'll automatically retry the charge on <b>${o.retryDate}</b>. Please make sure your bank account has sufficient funds before then.</p>` +
      `<p style="font-size:.85rem;color:#4a5568">This is retry attempt ${o.retryAttempt} of 2 permitted by NACHA. If this retry also fails you'll need to update your payment method.</p>`
    ),
    sendSMS: true, smsTo: o.tenantPhone,
    smsBody: `GAM: Payment of $${o.amount.toFixed(2)} failed. Retry on ${o.retryDate}. Ensure funds available.`,
  })

  // Landlord: shorter info-only copy
  await createNotification({
    userId: o.landlordUserId, landlordId: o.landlordId,
    type: 'ach_retry_scheduled_info',
    title: `${o.tenantName} payment retry — ${o.retryDate}`,
    body: `${o.tenantName} (Unit ${o.unitNumber}) payment of $${o.amount.toFixed(2)} failed (${o.reason}). Auto-retry scheduled ${o.retryDate}.`,
    data: o,
    sendEmail: true, emailTo: o.landlordEmail,
    emailSubject: `Tenant payment retry scheduled — Unit ${o.unitNumber}`,
    emailHtml: emailTemplate(
      `Tenant Payment Retry Scheduled`,
      `<b>${o.tenantName}</b> payment of <b>$${o.amount.toFixed(2)}</b> for Unit ${o.unitNumber} failed (${o.reason}). GAM will automatically retry on <b>${o.retryDate}</b>. No action required.`
    ),
  })
}

// S125: ACH retry-cap-reached alert. Fires when the second retry also
// fails (or any failure on a non-retry-eligible code on retry_count = 2).
// Landlord + tenant both get notified the payment is permanently failed
// and needs manual intervention; admin in-app notification flags the
// payment for review.
export async function notifyAchRetriesExhausted(o: {
  paymentId: string;
  tenantUserId: string; tenantEmail: string; tenantPhone?: string; tenantName: string;
  landlordUserId: string; landlordId: string; landlordEmail: string; landlordPhone?: string;
  unitNumber: string; propertyName: string;
  amount: number; reason: string;
}) {
  // Tenant: action-required
  await createNotification({
    userId: o.tenantUserId,
    type: 'ach_retries_exhausted',
    title: `Payment cannot be retried — manual action required`,
    body: `Your $${o.amount.toFixed(2)} payment for Unit ${o.unitNumber} failed after multiple retry attempts (${o.reason}). Please update your payment method or contact your landlord directly.`,
    data: o,
    sendEmail: true, emailTo: o.tenantEmail,
    emailSubject: `Payment cannot be retried — Unit ${o.unitNumber}`,
    emailHtml: emailTemplate(
      `Payment Cannot Be Retried`,
      `<p>Your <b>$${o.amount.toFixed(2)}</b> payment for ${o.propertyName} Unit ${o.unitNumber} failed multiple times:</p>` +
      `<div style="margin:12px 0;padding:10px;background:#0a0f14;border-left:3px solid #ef4444;border-radius:6px;color:#b8c4d8">${o.reason}</div>` +
      `<p>NACHA limits us to 2 retries per failed transaction. Both have now been exhausted.</p>` +
      `<p><b>What to do next:</b></p>` +
      `<ul style="color:#b8c4d8;line-height:1.7">` +
      `<li>Update your payment method or bank account in the tenant portal</li>` +
      `<li>Contact your landlord directly to arrange payment</li>` +
      `</ul>`
    ),
    sendSMS: true, smsTo: o.tenantPhone,
    smsBody: `GAM URGENT: Payment $${o.amount.toFixed(2)} cannot be auto-retried. Update payment method or contact landlord.`,
  })

  // Landlord: action-required, urgent
  await createNotification({
    userId: o.landlordUserId, landlordId: o.landlordId,
    type: 'ach_retries_exhausted_landlord',
    title: `🚨 ${o.tenantName} payment failed permanently — Unit ${o.unitNumber}`,
    body: `${o.tenantName} payment of $${o.amount.toFixed(2)} failed all retry attempts (${o.reason}). Manual intervention needed.`,
    data: o,
    sendEmail: true, emailTo: o.landlordEmail,
    emailSubject: `🚨 Tenant payment failed permanently — Unit ${o.unitNumber}`,
    emailHtml: emailTemplate(
      `Tenant Payment Failed Permanently`,
      `<div style="margin-bottom:14px;padding:10px 14px;background:rgba(239,68,68,.08);border:1px solid rgba(239,68,68,.3);border-radius:8px;color:#ef4444;font-size:.85rem">⚠️ Manual intervention required</div>` +
      `<p><b>${o.tenantName}</b> payment of <b>$${o.amount.toFixed(2)}</b> for Unit ${o.unitNumber} has failed all NACHA-permitted retry attempts.</p>` +
      `<div style="margin:12px 0;padding:10px;background:#0a0f14;border-radius:6px;color:#b8c4d8">${o.reason}</div>` +
      `<p>The tenant has been notified to update their payment method. You may also want to contact them directly.</p>`
    ),
    sendSMS: true, smsTo: o.landlordPhone,
    smsBody: `GAM ALERT: ${o.tenantName} Unit ${o.unitNumber} - payment $${o.amount.toFixed(2)} failed permanently. Manual review.`,
  })
}

// S175: Stripe Connect payout notifications. Replaces the pre-S113
// notifyDisbursementSent helper, which assumed batched GAM-rail
// disbursements (period + unitCount) — a model that doesn't exist
// under destination charges. Each Stripe Connect payout fires
// individually against a connected account; the recipient is the
// user (landlord or opt-in manager) who owns that Connect account.
// PM company payouts are notified via a separate path (TBD — needs
// pm_staff routing logic). Fired from services/stripeConnect.ts
// recordPayoutEvent on payout.paid / payout.failed.
export async function notifyConnectPayoutPaid(o: {
  userId:          string
  userEmail:       string
  userPhone?:      string
  amount:          number
  arrivalDate:     string | null  // ISO date or null when Stripe didn't supply one
  stripePayoutId:  string
}) {
  const dateLine = o.arrivalDate ? ` Expected arrival ${o.arrivalDate}.` : ''
  await createNotification({
    userId:        o.userId,
    type:          'connect_payout_paid',
    title:         `Payout sent — $${o.amount.toFixed(2)}`,
    body:          `Your Stripe payout of $${o.amount.toFixed(2)} is on its way to your bank.${dateLine}`,
    data:          o,
    sendEmail:     true,
    emailTo:       o.userEmail,
    emailSubject:  `💸 Payout Sent — $${o.amount.toFixed(2)}`,
    emailHtml:     emailTemplate(
      'Payout Sent',
      `Your Stripe Connect payout of <b>$${o.amount.toFixed(2)}</b> has been initiated.${
        o.arrivalDate ? `<br>Expected arrival: <b>${o.arrivalDate}</b>.` : ''
      }<br><br>You can review the transfer in your Banking page.`,
    ),
    sendSMS:       false,
    smsTo:         o.userPhone,
    smsBody:       `GAM: Payout $${o.amount.toFixed(2)} sent.${dateLine}`,
  })
}

// S176: PM company payout fan-out. PM companies have no inherent
// email/phone — notifications fan out to active pm_staff rows with
// financial-authority roles (owner / manager). Generic 'staff' role
// is excluded by design: operational role, not financial. The
// fan-out shape (loop + per-recipient createNotification) mirrors
// routeMaintenanceNotification's pm_staff path.
export async function notifyPmCompanyPayoutPaid(o: {
  pmCompanyId:     string
  pmCompanyName:   string
  amount:          number
  arrivalDate:     string | null
  stripePayoutId:  string
}) {
  const recipients = await query<{ user_id: string; email: string; phone: string | null }>(
    `SELECT u.id AS user_id, u.email, u.phone
       FROM pm_staff ps
       JOIN users u ON u.id = ps.user_id
      WHERE ps.pm_company_id = $1
        AND ps.status = 'active'
        AND ps.role IN ('owner', 'manager')`,
    [o.pmCompanyId]
  )
  const dateLine = o.arrivalDate ? ` Expected arrival ${o.arrivalDate}.` : ''
  for (const r of recipients) {
    await createNotification({
      userId:        r.user_id,
      type:          'connect_payout_paid',
      title:         `Payout sent — $${o.amount.toFixed(2)}`,
      body:          `${o.pmCompanyName}'s Stripe payout of $${o.amount.toFixed(2)} is on its way to your bank.${dateLine}`,
      data:          o,
      sendEmail:     true,
      emailTo:       r.email,
      emailSubject:  `💸 Payout Sent — $${o.amount.toFixed(2)}`,
      emailHtml:     emailTemplate(
        'Payout Sent',
        `<b>${o.pmCompanyName}</b>'s Stripe Connect payout of <b>$${o.amount.toFixed(2)}</b> has been initiated.${
          o.arrivalDate ? `<br>Expected arrival: <b>${o.arrivalDate}</b>.` : ''
        }<br><br>Review the transfer in the Banking page.`,
      ),
      sendSMS:       false,
      smsTo:         r.phone ?? undefined,
      smsBody:       `GAM: ${o.pmCompanyName} payout $${o.amount.toFixed(2)} sent.${dateLine}`,
    })
  }
}

export async function notifyPmCompanyPayoutFailed(o: {
  pmCompanyId:     string
  pmCompanyName:   string
  amount:          number
  reason:          string
  failureCode?:    string
  stripePayoutId:  string
}) {
  const recipients = await query<{ user_id: string; email: string; phone: string | null }>(
    `SELECT u.id AS user_id, u.email, u.phone
       FROM pm_staff ps
       JOIN users u ON u.id = ps.user_id
      WHERE ps.pm_company_id = $1
        AND ps.status = 'active'
        AND ps.role IN ('owner', 'manager')`,
    [o.pmCompanyId]
  )
  for (const r of recipients) {
    await createNotification({
      userId:        r.user_id,
      type:          'connect_payout_failed',
      title:         `⚠️ Payout failed — $${o.amount.toFixed(2)}`,
      body:          `Stripe could not deliver ${o.pmCompanyName}'s $${o.amount.toFixed(2)} payout. ${o.reason}`,
      data:          o,
      sendEmail:     true,
      emailTo:       r.email,
      emailSubject:  `⚠️ Payout Failed — $${o.amount.toFixed(2)}`,
      emailHtml:     emailTemplate(
        'Payout Failed',
        `Stripe could not deliver <b>${o.pmCompanyName}</b>'s <b>$${o.amount.toFixed(2)}</b> payout.<br><br>` +
          `<b>Reason:</b> ${o.reason}${o.failureCode ? ` (code: ${o.failureCode})` : ''}<br><br>` +
          `Verify the company's bank account details on the Banking page and re-initiate the payout, ` +
          `or contact support if the bank info looks correct.`,
      ),
      sendSMS:       true,
      smsTo:         r.phone ?? undefined,
      smsBody:       `GAM ALERT: ${o.pmCompanyName} payout $${o.amount.toFixed(2)} failed — ${o.reason}.`,
    })
  }
}

export async function notifyConnectPayoutFailed(o: {
  userId:          string
  userEmail:       string
  userPhone?:      string
  amount:          number
  reason:          string
  failureCode?:    string
  stripePayoutId:  string
}) {
  await createNotification({
    userId:        o.userId,
    type:          'connect_payout_failed',
    title:         `⚠️ Payout failed — $${o.amount.toFixed(2)}`,
    body:          `Stripe could not deliver your $${o.amount.toFixed(2)} payout. ${o.reason}`,
    data:          o,
    sendEmail:     true,
    emailTo:       o.userEmail,
    emailSubject:  `⚠️ Payout Failed — $${o.amount.toFixed(2)}`,
    emailHtml:     emailTemplate(
      'Payout Failed',
      `Stripe could not deliver your <b>$${o.amount.toFixed(2)}</b> payout.<br><br>` +
        `<b>Reason:</b> ${o.reason}${o.failureCode ? ` (code: ${o.failureCode})` : ''}<br><br>` +
        `Verify your bank account details on the Banking page and re-initiate the payout, ` +
        `or contact support if the bank info looks correct.`,
    ),
    sendSMS:       true,
    smsTo:         o.userPhone,
    smsBody:       `GAM ALERT: Payout $${o.amount.toFixed(2)} failed — ${o.reason}. Check Banking.`,
  })
}

export async function notifyMaintenanceUpdated(o: { tenantUserId:string; tenantEmail:string; tenantPhone?:string; unitNumber:string; requestTitle:string; newStatus:string; scheduledAt?:string; notes?:string }) {
  const labels: Record<string,string> = { assigned:'assigned', in_progress:'in progress', completed:'completed ✅', cancelled:'cancelled' }
  const label = labels[o.newStatus]||o.newStatus
  await createNotification({ userId:o.tenantUserId, type:'maintenance_updated', title:`Maintenance ${o.newStatus==='completed'?'Completed':'Updated'} — ${o.requestTitle}`, body:`Your request "${o.requestTitle}" is now ${label}.${o.scheduledAt?` Scheduled: ${new Date(o.scheduledAt).toLocaleDateString()}.`:''}`, data:o, sendEmail:true, emailTo:o.tenantEmail, emailSubject:`🔧 Maintenance ${o.newStatus==='completed'?'Complete':'Update'}`, emailHtml:emailTemplate(`Maintenance ${o.newStatus==='completed'?'Completed':'Update'}`, `Your request <b>"${o.requestTitle}"</b> is now <b>${label}</b>.${o.scheduledAt?`<br>Scheduled: ${new Date(o.scheduledAt).toLocaleString()}`:''}${o.notes?`<br>Notes: ${o.notes}`:''}`), sendSMS:o.newStatus==='completed'||!!o.scheduledAt, smsTo:o.tenantPhone, smsBody:`GAM: Your maintenance "${o.requestTitle}" is ${label}.` })
}

// S68: collapsed pre-S18 split (lease_expiring_60 / lease_expiring_30) into
// a single 'lease_expiring' type. Urgency is in `data.urgent` for consumers
// that want to differentiate; under S18 the trigger date is per-property
// expiration_notice_days, not a fixed 60/30-day cron.
export async function notifyLeaseExpiring(o: { landlordUserId:string; landlordId:string; landlordEmail:string; landlordPhone?:string; tenantName:string; unitNumber:string; propertyName:string; endDate:string; daysRemaining:number; leaseId:string }) {
  const urgent = o.daysRemaining <= 30
  await createNotification({ userId:o.landlordUserId, landlordId:o.landlordId, type:'lease_expiring', title:`${urgent?'⚠️ ':''}Lease Expiring in ${o.daysRemaining} Days — Unit ${o.unitNumber}`, body:`${o.tenantName}'s lease expires ${new Date(o.endDate).toLocaleDateString()}. ${urgent?'Take action soon — check your local notice requirements.':'Take action to renew or send non-renewal.'}`, data:{ ...o, urgent }, sendEmail:true, emailTo:o.landlordEmail, emailSubject:`${urgent?'⚠️ URGENT: ':''}Lease Expiring ${o.daysRemaining} Days — Unit ${o.unitNumber}`, emailHtml:emailTemplate(`Lease Expiring in ${o.daysRemaining} Days`, `<b>${o.tenantName}'s</b> lease for Unit ${o.unitNumber} expires <b>${new Date(o.endDate).toLocaleDateString()}</b>.${urgent?'<br><br><b style="color:red">Act soon — check your local notice requirements for non-renewal.</b>':''}`), sendSMS:urgent, smsTo:o.landlordPhone, smsBody:`GAM: Lease expires ${o.daysRemaining} days — ${o.tenantName} Unit ${o.unitNumber}. Login to manage.` })
}

export async function notifyLowStock(o: { landlordUserId:string; landlordId:string; landlordEmail:string; items:Array<{name:string;stock_qty:number;stock_min:number;vendor_name?:string}> }) {
  const itemList = o.items.map(i=>`${i.name} (${i.stock_qty} left)`).join(', ')
  await createNotification({ userId:o.landlordUserId, landlordId:o.landlordId, type:'pos_low_stock', title:`Low Stock — ${o.items.length} item${o.items.length>1?'s':''}`, body:`Below minimum: ${itemList}`, data:o, sendEmail:true, emailTo:o.landlordEmail, emailSubject:`📦 POS Low Stock Alert`, emailHtml:emailTemplate('Low Stock Alert', `Items below minimum:<br><br>${o.items.map(i=>`• <b>${i.name}</b> — ${i.stock_qty} left (min ${i.stock_min})${i.vendor_name?` · Vendor: ${i.vendor_name}`:''}`).join('<br>')}`) })
}

// ── Inspection workflow ──────────────────────────────────────
export async function notifyInspectionReadyForTenant(o: {
  tenantUserId: string; tenantEmail: string; tenantPhone?: string
  inspectionId: string; inspectionType: 'move_in'|'move_out'|'periodic'
  propertyName?: string; unitNumber?: string
}) {
  const typeLabel = o.inspectionType === 'move_in' ? 'Move-in' : o.inspectionType === 'move_out' ? 'Move-out' : 'Periodic'
  await createNotification({
    userId: o.tenantUserId,
    type: 'inspection_ready',
    title: `${typeLabel} Inspection Ready to Sign`,
    body: `Your landlord has completed the ${typeLabel.toLowerCase()} checklist${o.unitNumber ? ` for Unit ${o.unitNumber}` : ''}. Review and sign it in the tenant portal.`,
    data: { inspection_id: o.inspectionId, inspection_type: o.inspectionType },
    sendEmail: true,
    emailTo: o.tenantEmail,
    emailSubject: `📋 ${typeLabel} Inspection Ready — Sign Now`,
    emailHtml: emailTemplate(`${typeLabel} Inspection Ready`, `Your landlord has completed the ${typeLabel.toLowerCase()} checklist${o.unitNumber ? ` for <b>Unit ${o.unitNumber}</b>` : ''}. Review and sign it in your tenant portal so it can be finalized.`),
    sendSMS: !!o.tenantPhone,
    smsTo: o.tenantPhone,
    smsBody: `GAM: ${typeLabel} inspection ready to sign${o.unitNumber ? ` for Unit ${o.unitNumber}` : ''}. Open tenant portal.`,
  })
}

export async function notifyInspectionTenantSigned(o: {
  landlordUserId: string; landlordId: string; landlordEmail: string
  inspectionId: string; inspectionType: 'move_in'|'move_out'|'periodic'
  unitNumber?: string; tenantName?: string
}) {
  const typeLabel = o.inspectionType === 'move_in' ? 'Move-in' : o.inspectionType === 'move_out' ? 'Move-out' : 'Periodic'
  await createNotification({
    userId: o.landlordUserId,
    landlordId: o.landlordId,
    type: 'inspection_tenant_signed',
    title: `Tenant Signed ${typeLabel} Inspection`,
    body: `${o.tenantName || 'The tenant'} has signed${o.unitNumber ? ` Unit ${o.unitNumber}'s` : ''} ${typeLabel.toLowerCase()} inspection. You can finalize it now.`,
    data: { inspection_id: o.inspectionId, inspection_type: o.inspectionType },
    sendEmail: true,
    emailTo: o.landlordEmail,
    emailSubject: `✓ Tenant signed ${typeLabel.toLowerCase()} inspection`,
    emailHtml: emailTemplate(`Tenant Signed`, `${o.tenantName || 'The tenant'} has signed${o.unitNumber ? ` Unit <b>${o.unitNumber}</b>'s` : ''} ${typeLabel.toLowerCase()} inspection. You can finalize it now.`),
  })
}

export async function notifyInspectionFinalized(o: {
  tenantUserId?: string; tenantEmail?: string
  landlordUserId: string; landlordId: string; landlordEmail: string
  inspectionId: string; inspectionType: 'move_in'|'move_out'|'periodic'
  unitNumber?: string
  matchesMoveIn?: boolean; damageDocumented?: boolean
}) {
  const typeLabel = o.inspectionType === 'move_in' ? 'Move-in' : o.inspectionType === 'move_out' ? 'Move-out' : 'Periodic'
  const outcomeBlurb =
    o.inspectionType === 'move_out'
      ? (o.matchesMoveIn ? ' Condition matches move-in.' : o.damageDocumented ? ' Damage was documented.' : '')
      : ''

  // Tenant ping (if applicable)
  if (o.tenantUserId && o.tenantEmail) {
    await createNotification({
      userId: o.tenantUserId,
      type: 'inspection_finalized',
      title: `${typeLabel} Inspection Finalized`,
      body: `Your ${typeLabel.toLowerCase()} inspection has been finalized.${outcomeBlurb}`,
      data: { inspection_id: o.inspectionId, inspection_type: o.inspectionType, matches_move_in: o.matchesMoveIn, damage_documented: o.damageDocumented },
      sendEmail: true,
      emailTo: o.tenantEmail,
      emailSubject: `${typeLabel} Inspection Finalized`,
      emailHtml: emailTemplate(`${typeLabel} Inspection Finalized`, `Your ${typeLabel.toLowerCase()} inspection has been finalized.${outcomeBlurb} The credit-ledger events have been recorded.`),
    })
  }

  // Landlord ping (always)
  await createNotification({
    userId: o.landlordUserId,
    landlordId: o.landlordId,
    type: 'inspection_finalized',
    title: `${typeLabel} Inspection Finalized`,
    body: `${typeLabel} inspection${o.unitNumber ? ` for Unit ${o.unitNumber}` : ''} finalized.${outcomeBlurb}`,
    data: { inspection_id: o.inspectionId, inspection_type: o.inspectionType, matches_move_in: o.matchesMoveIn, damage_documented: o.damageDocumented },
    sendEmail: true,
    emailTo: o.landlordEmail,
    emailSubject: `${typeLabel} Inspection Finalized`,
    emailHtml: emailTemplate(`${typeLabel} Inspection Finalized`, `${typeLabel} inspection${o.unitNumber ? ` for <b>Unit ${o.unitNumber}</b>` : ''} finalized.${outcomeBlurb}`),
  })
}

export async function notifyInspectionScheduledReminder(o: {
  tenantUserId?: string; tenantEmail?: string; tenantPhone?: string
  landlordUserId: string; landlordId: string; landlordEmail: string
  inspectionId: string; inspectionType: 'move_in'|'move_out'|'periodic'
  scheduledFor: string; unitNumber?: string
}) {
  const typeLabel = o.inspectionType === 'move_in' ? 'Move-in' : o.inspectionType === 'move_out' ? 'Move-out' : 'Periodic'
  const timestr = new Date(o.scheduledFor).toLocaleString()
  if (o.tenantUserId && o.tenantEmail) {
    await createNotification({
      userId: o.tenantUserId,
      type: 'inspection_scheduled_reminder',
      title: `Reminder: ${typeLabel} Inspection Tomorrow`,
      body: `Your ${typeLabel.toLowerCase()} inspection is scheduled for ${timestr}${o.unitNumber ? ` (Unit ${o.unitNumber})` : ''}.`,
      data: { inspection_id: o.inspectionId, scheduled_for: o.scheduledFor },
      sendEmail: true,
      emailTo: o.tenantEmail,
      emailSubject: `🔔 Inspection Tomorrow`,
      emailHtml: emailTemplate(`Inspection Tomorrow`, `Your ${typeLabel.toLowerCase()} inspection is scheduled for <b>${timestr}</b>${o.unitNumber ? ` (Unit ${o.unitNumber})` : ''}.`),
      sendSMS: !!o.tenantPhone,
      smsTo: o.tenantPhone,
      smsBody: `GAM: ${typeLabel} inspection tomorrow at ${timestr}.`,
    })
  }
  await createNotification({
    userId: o.landlordUserId,
    landlordId: o.landlordId,
    type: 'inspection_scheduled_reminder',
    title: `Reminder: ${typeLabel} Inspection Tomorrow`,
    body: `${typeLabel} inspection scheduled for ${timestr}${o.unitNumber ? ` (Unit ${o.unitNumber})` : ''}.`,
    data: { inspection_id: o.inspectionId, scheduled_for: o.scheduledFor },
    sendEmail: true,
    emailTo: o.landlordEmail,
    emailSubject: `🔔 Inspection Tomorrow`,
    emailHtml: emailTemplate(`Inspection Tomorrow`, `${typeLabel} inspection scheduled for <b>${timestr}</b>${o.unitNumber ? ` (Unit ${o.unitNumber})` : ''}.`),
  })
}

// ── Entry-request workflow ──────────────────────────────────
export async function notifyEntryRequestNew(o: {
  tenantUserId: string; tenantEmail: string; tenantPhone?: string
  requestId: string; reason: string; reasonCategory: string
  windowStart: string; windowEnd: string; noticeWindowHours: number
  unitNumber?: string
}) {
  const start = new Date(o.windowStart).toLocaleString()
  const subUrgent = o.noticeWindowHours < 24
  await createNotification({
    userId: o.tenantUserId,
    type: 'entry_request_new',
    title: `Entry Request${o.unitNumber ? ` — Unit ${o.unitNumber}` : ''}`,
    body: `Your landlord requests entry for ${o.reasonCategory}: "${o.reason}". Proposed window starts ${start} (${o.noticeWindowHours}h notice).`,
    data: { entry_request_id: o.requestId, window_start: o.windowStart, window_end: o.windowEnd },
    sendEmail: true,
    emailTo: o.tenantEmail,
    emailSubject: `${subUrgent ? '⚠️' : '🚪'} Entry Request — Respond Promptly`,
    emailHtml: emailTemplate(`Entry Request`, `Your landlord requests entry for <b>${o.reasonCategory}</b>: "${o.reason}".<br>Proposed window starts <b>${start}</b> (${o.noticeWindowHours}h notice).<br>Granting access promptly credits your record; denying does not penalize you.`),
    sendSMS: !!o.tenantPhone,
    smsTo: o.tenantPhone,
    smsBody: `GAM: Entry request for ${o.reasonCategory}, ${start} (${o.noticeWindowHours}h notice). Open tenant portal to respond.`,
  })
}

export async function notifyEntryRequestResponded(o: {
  landlordUserId: string; landlordId: string; landlordEmail: string
  requestId: string; decision: 'granted'|'denied'
  tenantName?: string; unitNumber?: string
}) {
  const decisionLabel = o.decision === 'granted' ? '✓ Granted' : '✗ Denied'
  await createNotification({
    userId: o.landlordUserId,
    landlordId: o.landlordId,
    type: 'entry_request_responded',
    title: `Entry ${decisionLabel}${o.unitNumber ? ` — Unit ${o.unitNumber}` : ''}`,
    body: `${o.tenantName || 'The tenant'} has ${o.decision} your entry request${o.unitNumber ? ` for Unit ${o.unitNumber}` : ''}.`,
    data: { entry_request_id: o.requestId, decision: o.decision },
    sendEmail: true,
    emailTo: o.landlordEmail,
    emailSubject: `Entry ${decisionLabel}`,
    emailHtml: emailTemplate(`Entry ${decisionLabel}`, `${o.tenantName || 'The tenant'} has <b>${o.decision}</b> your entry request${o.unitNumber ? ` for Unit <b>${o.unitNumber}</b>` : ''}.`),
  })
}

export async function notifyEntryRecorded(o: {
  tenantUserId?: string; tenantEmail?: string
  requestId: string; outcome: 'compliant'|'breach'
  enteredAt: string; unitNumber?: string
}) {
  if (!o.tenantUserId || !o.tenantEmail) return
  const t = new Date(o.enteredAt).toLocaleString()
  await createNotification({
    userId: o.tenantUserId,
    type: 'entry_recorded',
    title: `Entry Recorded${o.unitNumber ? ` — Unit ${o.unitNumber}` : ''}`,
    body: `Your landlord entered the unit at ${t}.${o.outcome === 'breach' ? ' This was outside the agreed window.' : ''}`,
    data: { entry_request_id: o.requestId, outcome: o.outcome, entered_at: o.enteredAt },
    sendEmail: true,
    emailTo: o.tenantEmail,
    emailSubject: `Entry Recorded`,
    emailHtml: emailTemplate(`Entry Recorded`, `Your landlord entered the unit at <b>${t}</b>.${o.outcome === 'breach' ? '<br><br>This was outside the agreed-upon window. Contact GAM if there is a concern.' : ''}`),
  })
}

// ── Dispute lifecycle ────────────────────────────────────────
export async function notifyDisputeResolved(o: {
  disputingUserId: string; disputingEmail: string
  disputeId: string; outcome: 'upheld'|'corrected'|'no_change'; resolverNotes?: string
}) {
  const outcomeLabel = o.outcome === 'corrected' ? 'Corrected' : o.outcome === 'upheld' ? 'Upheld' : 'No change'
  await createNotification({
    userId: o.disputingUserId,
    type: 'dispute_resolved',
    title: `Dispute Resolved — ${outcomeLabel}`,
    body: o.outcome === 'corrected'
      ? 'Your dispute was upheld and the original event was corrected on your record.'
      : o.outcome === 'upheld'
        ? 'Your dispute was acknowledged but the original event remains on your record.'
        : 'Your dispute has been closed without changes to the record.',
    data: { dispute_id: o.disputeId, outcome: o.outcome, resolver_notes: o.resolverNotes ?? null },
    sendEmail: true,
    emailTo: o.disputingEmail,
    emailSubject: `Dispute Resolved — ${outcomeLabel}`,
    emailHtml: emailTemplate(`Dispute Resolved — ${outcomeLabel}`, o.outcome === 'corrected'
      ? 'Your dispute was upheld. The original event was corrected on your record.'
      : o.outcome === 'upheld'
        ? 'Your dispute was acknowledged but the original event remains on your record.'
        : 'Your dispute has been closed without changes.'),
  })
}

// S198: sublease lifecycle notifications. Phase 2 — in-app + email
// (no SMS). Routes to a single recipient per call; route-side
// orchestration loops over the three parties (sublessor, sublessee,
// landlord) as appropriate to each lifecycle event.
export async function notifySubleaseRequested(o: {
  landlordUserId: string; landlordId: string; landlordEmail: string
  subleaseId: string; sublessorName: string; sublesseeName: string
  unitNumber: string; propertyName: string
  startDate: string; subMonthlyAmount: number
}) {
  await createNotification({
    userId: o.landlordUserId,
    landlordId: o.landlordId,
    type: 'sublease_requested',
    title: `Sublease request — Unit ${o.unitNumber}`,
    body: `${o.sublessorName} wants to sublease Unit ${o.unitNumber} to ${o.sublesseeName} starting ${new Date(o.startDate).toLocaleDateString()} at $${o.subMonthlyAmount.toFixed(2)}/mo. Approve or deny in the landlord portal.`,
    data: { sublease_id: o.subleaseId, unit_number: o.unitNumber },
    sendEmail: true,
    emailTo: o.landlordEmail,
    emailSubject: `Sublease request — Unit ${o.unitNumber}`,
    emailHtml: emailTemplate(
      `Sublease Request`,
      `<b>${o.sublessorName}</b> has requested permission to sublease Unit ${o.unitNumber} at ${o.propertyName} to <b>${o.sublesseeName}</b>.<br><br>Start: ${new Date(o.startDate).toLocaleDateString()}<br>Monthly: $${o.subMonthlyAmount.toFixed(2)}<br><br>Open the landlord portal to approve or deny.`
    ),
  })
}

export async function notifySubleaseDecision(o: {
  sublessorUserId: string; sublessorEmail: string
  subleaseId: string; decision: 'approved' | 'denied'
  unitNumber: string; propertyName: string; landlordNote?: string | null
}) {
  const verb = o.decision === 'approved' ? '✅ Approved' : '✗ Denied'
  await createNotification({
    userId: o.sublessorUserId,
    type: o.decision === 'approved' ? 'sublease_approved' : 'sublease_denied',
    title: `Sublease ${verb} — Unit ${o.unitNumber}`,
    body: `Your landlord has ${o.decision} your sublease request for Unit ${o.unitNumber}${o.landlordNote ? ` — note: ${o.landlordNote}` : ''}.`,
    data: { sublease_id: o.subleaseId, decision: o.decision },
    sendEmail: true,
    emailTo: o.sublessorEmail,
    emailSubject: `Sublease ${verb} — Unit ${o.unitNumber}`,
    emailHtml: emailTemplate(
      `Sublease ${verb}`,
      `Your landlord has <b>${o.decision}</b> your sublease request for Unit ${o.unitNumber} at ${o.propertyName}.${o.landlordNote ? `<br><br>Note from landlord: ${o.landlordNote}` : ''}`
    ),
  })
}

export async function notifySubleaseTerminated(o: {
  recipientUserId: string; recipientEmail: string
  subleaseId: string; unitNumber: string; propertyName: string
  triggeredBy: 'sublessor_terminated' | 'sublessee_terminated' | 'landlord_terminated'
  reason: string
}) {
  const triggerLabel =
    o.triggeredBy === 'sublessor_terminated' ? 'the sublessor' :
    o.triggeredBy === 'sublessee_terminated' ? 'the sublessee' :
    'the landlord'
  await createNotification({
    userId: o.recipientUserId,
    type: 'sublease_terminated',
    title: `Sublease terminated — Unit ${o.unitNumber}`,
    body: `The sublease for Unit ${o.unitNumber} was terminated by ${triggerLabel}. Reason: ${o.reason}`,
    data: { sublease_id: o.subleaseId, triggered_by: o.triggeredBy },
    sendEmail: true,
    emailTo: o.recipientEmail,
    emailSubject: `Sublease terminated — Unit ${o.unitNumber}`,
    emailHtml: emailTemplate(
      `Sublease Terminated`,
      `The sublease for Unit ${o.unitNumber} at ${o.propertyName} was terminated by <b>${triggerLabel}</b>.<br><br>Reason: ${o.reason}`
    ),
  })
}

export async function notifyTenantInviteAccepted(o: { landlordUserId:string; landlordId:string; landlordEmail:string; tenantName:string; tenantEmail:string; unitNumber:string; propertyName:string }) {
  await createNotification({ userId:o.landlordUserId, landlordId:o.landlordId, type:'tenant_invite_accepted', title:`Tenant Activated — Unit ${o.unitNumber}`, body:`${o.tenantName} accepted their invite for Unit ${o.unitNumber}.`, data:o, sendEmail:true, emailTo:o.landlordEmail, emailSubject:`✅ Tenant Activated — Unit ${o.unitNumber}`, emailHtml:emailTemplate('Tenant Joined', `<b>${o.tenantName}</b> activated their account for Unit ${o.unitNumber} at ${o.propertyName}.`) })
}

export async function notifyWorkTradeHours(o: { tenantUserId:string; tenantEmail:string; tenantPhone?:string; unitNumber:string; hoursCommitted:number; hoursWorked:number; daysLeft:number }) {
  const short = o.hoursCommitted - o.hoursWorked
  await createNotification({ userId:o.tenantUserId, type:'work_trade_reminder', title:`Work Trade: ${short}hrs remaining`, body:`${o.hoursWorked}/${o.hoursCommitted} hours logged. ${short} hours left with ${o.daysLeft} days remaining.`, data:o, sendEmail:true, emailTo:o.tenantEmail, emailSubject:`⚡ Work Trade Reminder — ${short} hours remaining`, emailHtml:emailTemplate('Work Trade Reminder', `<b>${short} hours remaining</b> this month.<br>Logged: ${o.hoursWorked} / ${o.hoursCommitted}<br>Days left: ${o.daysLeft}`), sendSMS:short>0&&o.daysLeft<=7, smsTo:o.tenantPhone, smsBody:`GAM: Work trade ${short} hours remaining, ${o.daysLeft} days left. Log hours in tenant portal.` })
}

export async function sendBulkNotification(o: { landlordId:string; propertyId?:string; title:string; body:string; sendEmail?:boolean; sendSMS?:boolean }) {
  // Pre-S107 this query was broken in two ways:
  //   1. JOIN units un ON un.tenant_id=t.id — units.tenant_id has not
  //      existed since the lease_tenants model. Query would throw on
  //      first invocation.
  //   2. propertyId was string-interpolated directly into the SQL — a
  //      SQL injection vector reachable from any authenticated landlord
  //      via POST /api/notifications/bulk.
  // Active-tenant lookup now goes through v_unit_occupancy (the same
  // view v_lease_active_tenants's sibling) which returns the primary
  // tenant per unit. propertyId is parameterized.
  const params: any[] = [o.landlordId]
  let propertyClause = ''
  if (o.propertyId) {
    params.push(o.propertyId)
    propertyClause = `AND p.id = $${params.length}`
  }
  const tenants = await query<any>(`
    SELECT
      vuo.primary_tenant_id AS tenant_id,
      t.user_id            AS user_id,
      vuo.primary_email    AS email,
      vuo.primary_phone    AS phone,
      un.unit_number,
      p.name               AS property_name
    FROM units un
    JOIN properties p ON p.id = un.property_id
    JOIN v_unit_occupancy vuo ON vuo.unit_id = un.id
    JOIN tenants t ON t.id = vuo.primary_tenant_id
    WHERE un.landlord_id = $1
      AND vuo.is_occupied = true
      ${propertyClause}
  `, params)
  let sent = 0
  for (const t of tenants) {
    await createNotification({ userId:t.user_id, landlordId: o.landlordId, type:'bulk_message', title:o.title, body:`Unit ${t.unit_number}: ${o.body}`, data:{unitNumber:t.unit_number}, sendEmail:o.sendEmail, emailTo:t.email, emailSubject:o.title, emailHtml:emailTemplate(o.title, o.body), sendSMS:o.sendSMS, smsTo:t.phone, smsBody:`${o.title}: ${o.body}` })
    sent++
  }
  return { sent }
}

// ── SMART MAINTENANCE ROUTING ─────────────────────────────────
export async function routeMaintenanceNotification(requestId: string) {
  try {
    // S107/S109: notification fan-out covers BOTH PM concepts.
    //   - pms (below)         = OWNER'S in-house property managers
    //                           (property_manager_scopes — owner's employees)
    //   - pmCoStaff (below)   = third-party PM company staff
    //                           (pm_staff, when properties.pm_company_id set)
    // Both queries run; both populations get notified per the same urgency
    // rules. Frontend distinguishes via data.source='pm_company' on the
    // contracted-staff variant.
    //
    // properties.pm_company_id was added in S108. The schema landed clean;
    // S109 wired the routes + this notification path.
    const req = await queryOne<any>(`
      SELECT mr.*,
        u.unit_number, p.name as property_name, p.id as property_id,
        p.pm_company_id as property_pm_company_id,
        l.id as landlord_id, l.maint_approval_threshold,
        lu.id as landlord_user_id, lu.email as landlord_email, lu.phone as landlord_phone,
        tu.id as tenant_user_id, tu.first_name as tenant_first, tu.last_name as tenant_last,
        tu.email as tenant_email
      FROM maintenance_requests mr
      JOIN units u ON u.id = mr.unit_id
      JOIN properties p ON p.id = u.property_id
      JOIN landlords l ON l.id = mr.landlord_id
      JOIN users lu ON lu.id = l.user_id
      LEFT JOIN tenants t ON t.id = mr.tenant_id
      LEFT JOIN users tu ON tu.id = t.user_id
      WHERE mr.id = $1`, [requestId])

    if (!req) return

    const threshold   = parseFloat(req.maint_approval_threshold || 500)
    const estimatedCost = parseFloat(req.estimated_cost || 0)
    const isEmergency = req.priority === 'emergency'
    const overThreshold = estimatedCost > threshold
    const tenantName  = `${req.tenant_first} ${req.tenant_last}`

    // S185: when a property is delegated to a PM company, the PM
    // company's staff are the responsible maintenance party. Owner's
    // in-house team (workers, onsite managers, property managers) is
    // suppressed for that property — they aren't on call for properties
    // the owner has handed off. Owner still gets escalation pings on
    // emergency / over-threshold per the existing rules.
    const isDelegatedToPmCompany = !!req.property_pm_company_id

    // Get maintenance team members for this property. S80: switched from
    // team_members (dropped) to UNION across the per-role scope tables.
    // S185: filter by property/unit coverage (was landlord-wide; workers
    // scoped to specific properties got paged for properties they
    // weren't assigned to). Suppressed entirely when delegated to a PM
    // company.
    const maintTeam = isDelegatedToPmCompany ? [] : await query<any>(`
      SELECT u.id, u.email, u.phone
      FROM users u
      WHERE u.id IN (
        SELECT user_id FROM maintenance_worker_scopes
         WHERE landlord_id = $1
           AND (all_properties = true
                OR $2::uuid = ANY(property_ids)
                OR $3::uuid = ANY(unit_ids))
        UNION
        SELECT user_id FROM onsite_manager_scopes
         WHERE landlord_id = $1
           AND (all_properties = true
                OR $2::uuid = ANY(property_ids)
                OR $3::uuid = ANY(unit_ids))
      )`,
      [req.landlord_id, req.property_id, req.unit_id])

    // Get all OWNER-IN-HOUSE property managers whose scope covers this
    // property/unit. Distinct from third-party pm_company staff (queried
    // separately below). S185: suppressed entirely when delegated to a
    // PM company — pm_staff fan-out is the responsible-party path.
    const pms = isDelegatedToPmCompany ? [] : await query<{ user_id: string; email: string; phone: string }>(`
      SELECT u.id AS user_id, u.email, u.phone
      FROM users u
      JOIN property_manager_scopes pms ON pms.user_id = u.id
      WHERE pms.landlord_id = $1
        AND (
          pms.all_properties = true
          OR $2::uuid = ANY(pms.property_ids)
          OR $3::uuid = ANY(pms.unit_ids)
        )`,
      [req.landlord_id, req.property_id, req.unit_id])

    // S109: parallel pm_staff path for THIRD-PARTY PM company staff. Fires
    // only when this property is assigned to a pm_company. Notifies all
    // active staff of that pm_company. Per-staff permission filtering (e.g.
    // only those with maintenance access) is a future refinement; for now
    // all active staff get the alert so the company can route internally.
    const pmCoStaff = await query<{ user_id: string; email: string; phone: string }>(`
      SELECT u.id AS user_id, u.email, u.phone
      FROM properties p
      JOIN pm_staff ps ON ps.pm_company_id = p.pm_company_id
      JOIN users u     ON u.id = ps.user_id
      WHERE p.id = $1
        AND p.pm_company_id IS NOT NULL
        AND ps.status = 'active'`,
      [req.property_id])

    // 1. Notify maintenance team
    for (const member of maintTeam) {
      await createNotification({
        userId: member.id, landlordId: req.landlord_id,
        type: 'maintenance_assigned',
        title: `New ${isEmergency ? '🚨 EMERGENCY ' : ''}Request — Unit ${req.unit_number}`,
        body: `${tenantName}: "${req.title}" (${req.priority})${overThreshold ? ` — Estimated: $${estimatedCost} — REQUIRES LANDLORD APPROVAL` : ''}`,
        data: { requestId, unitNumber: req.unit_number, priority: req.priority },
        sendEmail: true, emailTo: member.email,
        emailSubject: `${isEmergency ? '🚨 EMERGENCY: ' : ''}Maintenance Request — Unit ${req.unit_number}`,
        emailHtml: `New ${req.priority} request from ${tenantName}: "${req.title}"${overThreshold ? '<br><b>APPROVAL REQUIRED before proceeding.</b>' : ''}`,
        sendSMS: isEmergency, smsTo: member.phone,
        smsBody: `GAM EMERGENCY: ${tenantName} Unit ${req.unit_number} - "${req.title}". Respond immediately.`
      })
    }

    // 2. Notify landlord if emergency OR over threshold OR there's no
    // responsible party at all to pick up the request. S185: under PM
    // company delegation, maintTeam is empty by design (owner's in-house
    // team is suppressed), but pmCoStaff handles the request — owner
    // doesn't need a fallback page in that case. The "no responsible
    // party" condition checks BOTH fan-outs, so owner only escalates
    // when literally no one is on call.
    const hasResponsibleParty = maintTeam.length > 0 || pmCoStaff.length > 0
    if (isEmergency || overThreshold || !hasResponsibleParty) {
      await createNotification({
        userId: req.landlord_user_id, landlordId: req.landlord_id,
        type: isEmergency ? 'maintenance_emergency' : overThreshold ? 'maintenance_approval_required' : 'maintenance_submitted',
        title: `${isEmergency ? '🚨 EMERGENCY: ' : overThreshold ? '⚠️ Approval Required: ' : ''}Maintenance — Unit ${req.unit_number}`,
        body: `${tenantName}: "${req.title}"${overThreshold ? ` · Est. $${estimatedCost} — requires your approval` : ''}`,
        data: { requestId, unitNumber: req.unit_number, estimatedCost, priority: req.priority },
        sendEmail: true, emailTo: req.landlord_email,
        emailSubject: `${isEmergency ? '🚨 EMERGENCY ' : overThreshold ? '⚠️ APPROVAL REQUIRED: ' : ''}Maintenance Unit ${req.unit_number}`,
        emailHtml: `<b>${tenantName}</b> submitted: "${req.title}"<br>Priority: ${req.priority}${overThreshold ? `<br><b>Estimated cost: $${estimatedCost} — exceeds your $${threshold} threshold. Your approval is required before work begins.</b>` : ''}`,
        sendSMS: isEmergency || overThreshold, smsTo: req.landlord_phone,
        smsBody: `GAM ${isEmergency ? 'EMERGENCY' : 'APPROVAL NEEDED'}: ${tenantName} Unit ${req.unit_number} - "${req.title}"${overThreshold ? ` Est $${estimatedCost}` : ''}`
      })

      // Mark approval required in DB
      if (overThreshold && !isEmergency) {
        await query(`UPDATE maintenance_requests SET status='awaiting_approval' WHERE id=$1`, [requestId])
      }
    }

    // 3. Notify all property managers whose scope covers this unit/property
    // (silently for under-threshold, urgently for over/emergency).
    for (const pm of pms) {
      await createNotification({
        userId: pm.user_id, landlordId: req.landlord_id,
        type: 'maintenance_pm_alert',
        title: `${isEmergency ? '🚨 ' : ''}Maintenance — ${req.property_name} Unit ${req.unit_number}`,
        body: `${tenantName}: "${req.title}" (${req.priority})${overThreshold ? ` · Est $${estimatedCost}` : ''}`,
        data: { requestId, unitNumber: req.unit_number, priority: req.priority },
        sendEmail: isEmergency || overThreshold, emailTo: pm.email,
        emailSubject: `Maintenance Alert — ${req.property_name} Unit ${req.unit_number}`,
        emailHtml: `Maintenance request at ${req.property_name} Unit ${req.unit_number}: "${req.title}"`,
        sendSMS: isEmergency, smsTo: pm.phone,
        smsBody: `GAM PM ALERT: ${req.property_name} Unit ${req.unit_number} - "${req.title}" EMERGENCY`
      })
    }

    // 3b. S109: notify third-party PM company staff if property is contracted.
    // Same urgency rules as in-house PM notifications. data.source='pm_company'
    // so frontend can distinguish in-house vs contracted alerts.
    for (const staff of pmCoStaff) {
      await createNotification({
        userId: staff.user_id, landlordId: req.landlord_id,
        type: 'maintenance_pm_alert',
        title: `${isEmergency ? '🚨 ' : ''}Maintenance — ${req.property_name} Unit ${req.unit_number}`,
        body: `${tenantName}: "${req.title}" (${req.priority})${overThreshold ? ` · Est $${estimatedCost}` : ''}`,
        data: { requestId, unitNumber: req.unit_number, priority: req.priority, source: 'pm_company' },
        sendEmail: isEmergency || overThreshold, emailTo: staff.email,
        emailSubject: `Maintenance Alert — ${req.property_name} Unit ${req.unit_number}`,
        emailHtml: `Maintenance request at ${req.property_name} Unit ${req.unit_number}: "${req.title}"`,
        sendSMS: isEmergency, smsTo: staff.phone,
        smsBody: `GAM PM ALERT: ${req.property_name} Unit ${req.unit_number} - "${req.title}" EMERGENCY`,
      })
    }

    // 4. Multi-unit — notify all affected tenants
    if (req.affects_multiple_units && req.affected_unit_ids?.length > 0) {
      // S107: same units.tenant_id drift as sendBulkNotification.
      // Active-tenant lookup goes through v_unit_occupancy, which gives
      // the primary tenant per unit when one is occupying.
      const affectedTenants = await query<any>(`
        SELECT t.user_id        AS user_id,
               vuo.primary_email AS email,
               vuo.primary_phone AS phone,
               un.unit_number
        FROM units un
        JOIN v_unit_occupancy vuo ON vuo.unit_id = un.id
        JOIN tenants t ON t.id = vuo.primary_tenant_id
        WHERE un.id = ANY($1::uuid[])
          AND un.id != $2
          AND vuo.is_occupied = true`,
        [req.affected_unit_ids, req.unit_id])

      for (const tenant of affectedTenants) {
        await createNotification({
          userId: tenant.user_id,
          type: 'maintenance_building_notice',
          title: `Building Maintenance Notice — ${req.property_name}`,
          body: `Maintenance work affecting your unit: "${req.title}". We'll keep you updated on timing.`,
          data: { requestId, propertyName: req.property_name },
          sendEmail: true, emailTo: tenant.email,
          emailSubject: `Building Maintenance Notice — ${req.property_name}`,
          emailHtml: `Maintenance work is being performed that may affect Unit ${tenant.unit_number}: "${req.title}". You will be notified of scheduling.`,
          sendSMS: isEmergency, smsTo: tenant.phone,
          smsBody: `GAM: Building maintenance affecting your unit - "${req.title}". Check tenant portal for updates.`
        })
      }
    }
  } catch(e) { logger.error({ err: e }, '[NOTIFY] routeMaintenanceNotification:') }
}

// S68: notifyLeaseRenewalSurvey deleted. Pre-S18 flow with no callers
// remaining. The S18 lease processor handles renewal-vs-non-renewal via
// auto_renew_mode; explicit tenant intent surveys aren't part of the
// current model.
// S176: notifyLandlordRenewalDecision also deleted. It was the
// counterpart that fired when a tenant responded to the survey above.
// With the survey retired in S68, this helper had no live trigger and
// no callers — clean removal.
