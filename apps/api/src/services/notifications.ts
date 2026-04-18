import { query, queryOne } from '../db'

async function sendEmail(to: string, subject: string, html: string) {
  console.log(`[EMAIL] To: ${to} | Subject: ${subject}`)
  console.log(`[EMAIL] ${html.replace(/<[^>]+>/g, '').slice(0,150)}…`)
}

async function sendSMS(to: string, body: string) {
  // Enable Twilio: npm install twilio, add TWILIO_SID/TOKEN/FROM to .env
  // const client = require('twilio')(process.env.TWILIO_SID, process.env.TWILIO_TOKEN)
  // await client.messages.create({ to, from: process.env.TWILIO_FROM, body })
  console.log(`[SMS] To: ${to} | ${body}`)
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
    <div class="foot">Gold Asset Management LLC · Arizona</div>
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

    if (inAppOk) {
      await query('INSERT INTO notifications (user_id,landlord_id,type,title,body,data) VALUES ($1,$2,$3,$4,$5,$6)',
        [p.userId, p.landlordId||null, p.type, p.title, p.body, JSON.stringify(p.data||{})])
    }
    if (emailOk && p.sendEmail && p.emailTo) {
      await sendEmail(p.emailTo, p.emailSubject||p.title, p.emailHtml||emailTemplate(p.title, p.body))
      await query("UPDATE notifications SET email_sent=TRUE,email_sent_at=NOW() WHERE user_id=$1 AND type=$2 ORDER BY created_at DESC LIMIT 1", [p.userId, p.type])
    }
    if (smsOk && p.sendSMS && p.smsTo) {
      await sendSMS(p.smsTo, p.smsBody||p.body)
      await query("UPDATE notifications SET sms_sent=TRUE,sms_sent_at=NOW() WHERE user_id=$1 AND type=$2 ORDER BY created_at DESC LIMIT 1", [p.userId, p.type])
    }
  } catch (e) { console.error('[NOTIFY]', e) }
}

export async function notifyRentCollected(o: { landlordUserId:string; landlordId:string; landlordEmail:string; landlordPhone?:string; tenantName:string; unitNumber:string; propertyName:string; amount:number }) {
  await createNotification({ userId:o.landlordUserId, landlordId:o.landlordId, type:'rent_collected', title:`Rent Collected — Unit ${o.unitNumber}`, body:`${o.tenantName} paid $${o.amount.toFixed(2)} for Unit ${o.unitNumber} at ${o.propertyName}.`, data:o, sendEmail:true, emailTo:o.landlordEmail, emailSubject:`✅ Rent Collected — Unit ${o.unitNumber}`, emailHtml:emailTemplate(`Rent Collected — Unit ${o.unitNumber}`, `<b>${o.tenantName}</b> paid <b>$${o.amount.toFixed(2)}</b> for Unit ${o.unitNumber} at ${o.propertyName}.`), sendSMS:true, smsTo:o.landlordPhone, smsBody:`GAM: Rent $${o.amount.toFixed(2)} collected from ${o.tenantName}, Unit ${o.unitNumber}.` })
}

export async function notifyRentFailed(o: { landlordUserId:string; landlordId:string; landlordEmail:string; landlordPhone?:string; tenantUserId:string; tenantEmail:string; tenantPhone?:string; tenantName:string; unitNumber:string; propertyName:string; amount:number; reason?:string }) {
  await createNotification({ userId:o.landlordUserId, landlordId:o.landlordId, type:'rent_failed', title:`⚠️ Rent Failed — Unit ${o.unitNumber}`, body:`ACH payment of $${o.amount.toFixed(2)} from ${o.tenantName} failed. ${o.reason||''}`, data:o, sendEmail:true, emailTo:o.landlordEmail, emailSubject:`⚠️ Rent Payment Failed — Unit ${o.unitNumber}`, emailHtml:emailTemplate(`Rent Payment Failed`, `Payment of <b>$${o.amount.toFixed(2)}</b> from <b>${o.tenantName}</b> Unit ${o.unitNumber} failed.${o.reason?`<br>Reason: ${o.reason}`:''}`), sendSMS:true, smsTo:o.landlordPhone, smsBody:`GAM ALERT: Rent failed $${o.amount.toFixed(2)} ${o.tenantName} Unit ${o.unitNumber}.` })
  await createNotification({ userId:o.tenantUserId, type:'payment_failed', title:'Your Rent Payment Failed', body:`Your payment of $${o.amount.toFixed(2)} failed. Contact your landlord immediately.`, sendEmail:true, emailTo:o.tenantEmail, emailSubject:'Rent Payment Failed', emailHtml:emailTemplate('Payment Failed', `Your rent payment of <b>$${o.amount.toFixed(2)}</b> for Unit ${o.unitNumber} failed. Please contact your landlord immediately.`), sendSMS:true, smsTo:o.tenantPhone, smsBody:`GAM: Your rent payment of $${o.amount.toFixed(2)} failed. Contact your landlord.` })
}

export async function notifyDisbursementSent(o: { landlordUserId:string; landlordId:string; landlordEmail:string; landlordPhone?:string; amount:number; period:string; unitCount:number }) {
  await createNotification({ userId:o.landlordUserId, landlordId:o.landlordId, type:'disbursement_sent', title:`Disbursement Sent — ${o.period}`, body:`$${o.amount.toFixed(2)} disbursed for ${o.unitCount} units.`, data:o, sendEmail:true, emailTo:o.landlordEmail, emailSubject:`💸 Disbursement Sent — ${o.period}`, emailHtml:emailTemplate(`Disbursement — ${o.period}`, `Your disbursement of <b>$${o.amount.toFixed(2)}</b> for ${o.unitCount} units has been sent. Arrives in 1-2 business days.`), sendSMS:true, smsTo:o.landlordPhone, smsBody:`GAM: Disbursement $${o.amount.toFixed(2)} sent for ${o.period}. Arrives 1-2 days.` })
}

export async function notifyMaintenanceSubmitted(o: { landlordUserId:string; landlordId:string; landlordEmail:string; tenantName:string; unitNumber:string; propertyName:string; title:string; priority:string; requestId:string }) {
  await createNotification({ userId:o.landlordUserId, landlordId:o.landlordId, type:'maintenance_submitted', title:`New Maintenance — Unit ${o.unitNumber}`, body:`${o.tenantName}: "${o.title}" (${o.priority})`, data:o, sendEmail:true, emailTo:o.landlordEmail, emailSubject:`🔧 ${o.priority.toUpperCase()} Maintenance — Unit ${o.unitNumber}`, emailHtml:emailTemplate(`New Maintenance Request`, `<b>${o.tenantName}</b> submitted: <b>${o.title}</b><br>Unit ${o.unitNumber} · ${o.propertyName}<br>Priority: <b>${o.priority.toUpperCase()}</b>${o.priority==='emergency'?'<br><br><b style="color:red">EMERGENCY — Requires immediate attention.</b>':''}`), sendSMS:o.priority==='emergency', smsTo:undefined, smsBody:`GAM EMERGENCY: ${o.tenantName} Unit ${o.unitNumber} "${o.title}". Login now.` })
}

export async function notifyMaintenanceUpdated(o: { tenantUserId:string; tenantEmail:string; tenantPhone?:string; unitNumber:string; requestTitle:string; newStatus:string; scheduledAt?:string; notes?:string }) {
  const labels: Record<string,string> = { assigned:'assigned', in_progress:'in progress', completed:'completed ✅', cancelled:'cancelled' }
  const label = labels[o.newStatus]||o.newStatus
  await createNotification({ userId:o.tenantUserId, type:'maintenance_updated', title:`Maintenance ${o.newStatus==='completed'?'Completed':'Updated'} — ${o.requestTitle}`, body:`Your request "${o.requestTitle}" is now ${label}.${o.scheduledAt?` Scheduled: ${new Date(o.scheduledAt).toLocaleDateString()}.`:''}`, data:o, sendEmail:true, emailTo:o.tenantEmail, emailSubject:`🔧 Maintenance ${o.newStatus==='completed'?'Complete':'Update'}`, emailHtml:emailTemplate(`Maintenance ${o.newStatus==='completed'?'Completed':'Update'}`, `Your request <b>"${o.requestTitle}"</b> is now <b>${label}</b>.${o.scheduledAt?`<br>Scheduled: ${new Date(o.scheduledAt).toLocaleString()}`:''}${o.notes?`<br>Notes: ${o.notes}`:''}`), sendSMS:o.newStatus==='completed'||!!o.scheduledAt, smsTo:o.tenantPhone, smsBody:`GAM: Your maintenance "${o.requestTitle}" is ${label}.` })
}

export async function notifyLeaseExpiring(o: { landlordUserId:string; landlordId:string; landlordEmail:string; landlordPhone?:string; tenantName:string; unitNumber:string; propertyName:string; endDate:string; daysRemaining:number; leaseId:string }) {
  const urgent = o.daysRemaining <= 30
  await createNotification({ userId:o.landlordUserId, landlordId:o.landlordId, type:urgent?'lease_expiring_30':'lease_expiring_60', title:`${urgent?'⚠️ ':''}Lease Expiring in ${o.daysRemaining} Days — Unit ${o.unitNumber}`, body:`${o.tenantName}'s lease expires ${new Date(o.endDate).toLocaleDateString()}. ${urgent?'Take action soon — check your local notice requirements.':'Take action to renew or send non-renewal.'}`, data:o, sendEmail:true, emailTo:o.landlordEmail, emailSubject:`${urgent?'⚠️ URGENT: ':''}Lease Expiring ${o.daysRemaining} Days — Unit ${o.unitNumber}`, emailHtml:emailTemplate(`Lease Expiring in ${o.daysRemaining} Days`, `<b>${o.tenantName}'s</b> lease for Unit ${o.unitNumber} expires <b>${new Date(o.endDate).toLocaleDateString()}</b>.${urgent?'<br><br><b style="color:red">Act soon — check your local notice requirements for non-renewal.</b>':''}`), sendSMS:urgent, smsTo:o.landlordPhone, smsBody:`GAM: Lease expires ${o.daysRemaining} days — ${o.tenantName} Unit ${o.unitNumber}. Login to manage.` })
}

export async function notifyLowStock(o: { landlordUserId:string; landlordId:string; landlordEmail:string; items:Array<{name:string;stock_qty:number;stock_min:number;vendor_name?:string}> }) {
  const itemList = o.items.map(i=>`${i.name} (${i.stock_qty} left)`).join(', ')
  await createNotification({ userId:o.landlordUserId, landlordId:o.landlordId, type:'pos_low_stock', title:`Low Stock — ${o.items.length} item${o.items.length>1?'s':''}`, body:`Below minimum: ${itemList}`, data:o, sendEmail:true, emailTo:o.landlordEmail, emailSubject:`📦 POS Low Stock Alert`, emailHtml:emailTemplate('Low Stock Alert', `Items below minimum:<br><br>${o.items.map(i=>`• <b>${i.name}</b> — ${i.stock_qty} left (min ${i.stock_min})${i.vendor_name?` · Vendor: ${i.vendor_name}`:''}`).join('<br>')}`) })
}

export async function notifyTenantInviteAccepted(o: { landlordUserId:string; landlordId:string; landlordEmail:string; tenantName:string; tenantEmail:string; unitNumber:string; propertyName:string }) {
  await createNotification({ userId:o.landlordUserId, landlordId:o.landlordId, type:'tenant_invite_accepted', title:`Tenant Activated — Unit ${o.unitNumber}`, body:`${o.tenantName} accepted their invite for Unit ${o.unitNumber}.`, data:o, sendEmail:true, emailTo:o.landlordEmail, emailSubject:`✅ Tenant Activated — Unit ${o.unitNumber}`, emailHtml:emailTemplate('Tenant Joined', `<b>${o.tenantName}</b> activated their account for Unit ${o.unitNumber} at ${o.propertyName}.`) })
}

export async function notifyWorkTradeHours(o: { tenantUserId:string; tenantEmail:string; tenantPhone?:string; unitNumber:string; hoursCommitted:number; hoursWorked:number; daysLeft:number }) {
  const short = o.hoursCommitted - o.hoursWorked
  await createNotification({ userId:o.tenantUserId, type:'work_trade_reminder', title:`Work Trade: ${short}hrs remaining`, body:`${o.hoursWorked}/${o.hoursCommitted} hours logged. ${short} hours left with ${o.daysLeft} days remaining.`, data:o, sendEmail:true, emailTo:o.tenantEmail, emailSubject:`⚡ Work Trade Reminder — ${short} hours remaining`, emailHtml:emailTemplate('Work Trade Reminder', `<b>${short} hours remaining</b> this month.<br>Logged: ${o.hoursWorked} / ${o.hoursCommitted}<br>Days left: ${o.daysLeft}`), sendSMS:short>0&&o.daysLeft<=7, smsTo:o.tenantPhone, smsBody:`GAM: Work trade ${short} hours remaining, ${o.daysLeft} days left. Log hours in tenant portal.` })
}

export async function sendBulkNotification(o: { landlordId:string; propertyId?:string; title:string; body:string; sendEmail?:boolean; sendSMS?:boolean }) {
  const tenants = await query<any>(`SELECT DISTINCT t.id,u.id as user_id,u.email,u.phone,u.first_name,u.last_name,un.unit_number,p.name as property_name FROM tenants t JOIN users u ON u.id=t.user_id JOIN units un ON un.tenant_id=t.id JOIN properties p ON p.id=un.property_id WHERE un.landlord_id=$1 ${o.propertyId?`AND p.id='${o.propertyId}'`:''}`, [o.landlordId])
  let sent = 0
  for (const t of tenants) {
    await createNotification({ userId:t.user_id, type:'bulk_message', title:o.title, body:`Unit ${t.unit_number}: ${o.body}`, data:{unitNumber:t.unit_number}, sendEmail:o.sendEmail, emailTo:t.email, emailSubject:o.title, emailHtml:emailTemplate(o.title, o.body), sendSMS:o.sendSMS, smsTo:t.phone, smsBody:`${o.title}: ${o.body}` })
    sent++
  }
  return { sent }
}

// ── SMART MAINTENANCE ROUTING ─────────────────────────────────
export async function routeMaintenanceNotification(requestId: string) {
  try {
    const req = await queryOne<any>(`
      SELECT mr.*,
        u.unit_number, p.name as property_name, p.id as property_id,
        l.id as landlord_id, l.maint_approval_threshold, l.pm_company_id,
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

    // Get maintenance team members
    const maintTeam = await query<any>(`
      SELECT u.id, u.email, u.phone FROM team_members tm
      JOIN users u ON u.id = tm.user_id
      WHERE tm.landlord_id = $1 AND tm.role IN ('maintenance','onsite_manager') AND tm.status='active'`,
      [req.landlord_id])

    // Get PM info if connected
    const pm = req.pm_company_id ? await queryOne<any>(`
      SELECT ps.*, u.id as user_id, u.email, u.phone
      FROM pm_staff ps JOIN users u ON u.id = ps.user_id
      WHERE ps.pm_company_id = $1 AND ps.status='active' LIMIT 1`,
      [req.pm_company_id]) : null

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

    // 2. Notify landlord if emergency OR over threshold OR no maintenance team
    if (isEmergency || overThreshold || maintTeam.length === 0) {
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
        await query('UPDATE maintenance_requests SET approval_required=TRUE WHERE id=$1', [requestId])
      }
    }

    // 3. Always notify PM (silently for under-threshold, urgently for over/emergency)
    if (pm) {
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

    // 4. Multi-unit — notify all affected tenants
    if (req.affects_multiple_units && req.affected_unit_ids?.length > 0) {
      const affectedTenants = await query<any>(`
        SELECT u.id as user_id, u.email, u.phone, un.unit_number
        FROM units un
        JOIN tenants t ON t.id = un.tenant_id
        JOIN users u ON u.id = t.user_id
        WHERE un.id = ANY($1::uuid[]) AND un.id != $2`,
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
  } catch(e) { console.error('[NOTIFY] routeMaintenanceNotification:', e) }
}

// ── LEASE RENEWAL FLOW ────────────────────────────────────────
export async function notifyLeaseRenewalSurvey(params: {
  tenantUserId: string; tenantEmail: string; tenantPhone?: string
  unitNumber: string; propertyName: string; endDate: string; leaseId: string
}) {
  const { tenantUserId, tenantEmail, tenantPhone, unitNumber, propertyName, endDate, leaseId } = params
  await createNotification({
    userId: tenantUserId,
    type: 'lease_renewal_survey',
    title: 'Do you plan to renew your lease?',
    body: `Your lease at Unit ${unitNumber} ends ${new Date(endDate).toLocaleDateString()}. Please let us know your plans.`,
    data: { leaseId, unitNumber, propertyName, endDate },
    sendEmail: true, emailTo: tenantEmail,
    emailSubject: 'Your Lease Renewal — Please Respond',
    emailHtml: `Your lease at Unit ${unitNumber}, ${propertyName} ends on <b>${new Date(endDate).toLocaleDateString()}</b>.<br><br>Please log in to your tenant portal to indicate whether you plan to renew.<br><br>This helps your landlord plan ahead.`,
    sendSMS: true, smsTo: tenantPhone,
    smsBody: `GAM: Your lease at Unit ${unitNumber} ends ${new Date(endDate).toLocaleDateString()}. Log in to your tenant portal to indicate renewal plans.`
  })
}

export async function notifyLandlordRenewalDecision(params: {
  landlordUserId: string; landlordId: string; landlordEmail: string; landlordPhone?: string
  tenantName: string; unitNumber: string; propertyName: string
  endDate: string; leaseId: string; tenantIntent: string
}) {
  const { landlordUserId, landlordId, landlordEmail, landlordPhone, tenantName, unitNumber, propertyName, endDate, leaseId, tenantIntent } = params
  const intentLabel = tenantIntent === 'yes' ? '✅ plans to renew' : tenantIntent === 'no' ? '❌ does NOT plan to renew' : '❓ is unsure'
  const daysLeft = Math.ceil((new Date(endDate).getTime() - Date.now()) / 86400000)

  await createNotification({
    userId: landlordUserId, landlordId,
    type: 'lease_renewal_action_required',
    title: `Lease Action Required — Unit ${unitNumber}`,
    body: `${tenantName} ${intentLabel}. Lease ends ${new Date(endDate).toLocaleDateString()} (${daysLeft} days). Send renewal offer or non-renewal notice.`,
    data: { leaseId, unitNumber, tenantIntent, daysLeft },
    sendEmail: true, emailTo: landlordEmail,
    emailSubject: `Lease Decision Needed — Unit ${unitNumber}`,
    emailHtml: `<b>${tenantName}</b> has responded to their lease renewal survey for Unit ${unitNumber} at ${propertyName}.<br><br>Intent: <b>${intentLabel}</b><br>Lease ends: <b>${new Date(endDate).toLocaleDateString()}</b> (${daysLeft} days remaining)<br><br>Please log in to send a renewal offer or non-renewal notice. Check your local laws for any notice period requirements.`,
    sendSMS: daysLeft <= 35, smsTo: landlordPhone,
    smsBody: `GAM: ${tenantName} Unit ${unitNumber} ${intentLabel}. ${daysLeft} days left. Login to act.`
  })
}
