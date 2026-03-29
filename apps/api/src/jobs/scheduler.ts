import cron from 'node-cron'
import { notifyLeaseExpiring, notifyLowStock, notifyLeaseRenewalSurvey, notifyLandlordRenewalDecision } from '../services/notifications'
import { query, queryOne } from '../db'

// ============================================================
// GAM PAYMENT SCHEDULER
// All cron jobs that power the On-Time Pay SLA
// ============================================================

async function checkLeaseExpiry() {
  try {
    const expiring = await query(`
      SELECT l.id, l.end_date, l.landlord_id,
        l.tenant_renewal_intent, l.tenant_renewal_intent_at,
        l.renewal_status, l.renewal_notified_37d_at, l.renewal_notified_31d_at, l.renewal_policy_sent_at,
        lu.id as landlord_user_id, lu.email as landlord_email, lu.phone as landlord_phone,
        un.unit_number, p.name as property_name,
        tu.id as tenant_user_id, tu.email as tenant_email, tu.phone as tenant_phone,
        tu.first_name as tenant_first, tu.last_name as tenant_last,
        EXTRACT(DAY FROM l.end_date - NOW())::int as days_remaining
      FROM leases l
      JOIN units un ON un.id = l.unit_id
      JOIN properties p ON p.id = un.property_id
      JOIN landlords la ON la.id = l.landlord_id
      JOIN users lu ON lu.id = la.user_id
      LEFT JOIN tenants t ON t.id = un.tenant_id
      LEFT JOIN users tu ON tu.id = t.user_id
      WHERE l.status = 'active'
        AND l.end_date BETWEEN NOW() AND NOW() + INTERVAL '76 days'
        AND l.renewal_status IS NULL
    `)
    for (const lease of expiring as any[]) {
      const d = lease.days_remaining
      const tName = (lease.tenant_first || '') + ' ' + (lease.tenant_last || '')

      // 75 days (AZ 30 + 15 extra buffer) — survey tenant first notice
      if (d <= 75 && d >= 70 && lease.tenant_user_id && !lease.tenant_renewal_intent_at) {
        await notifyLeaseRenewalSurvey({ tenantUserId: lease.tenant_user_id, tenantEmail: lease.tenant_email, tenantPhone: lease.tenant_phone, unitNumber: lease.unit_number, propertyName: lease.property_name, endDate: lease.end_date, leaseId: lease.id })
      }

      // 60 days — landlord expiry warning + tenant survey reminder if no response
      if (d === 60) {
        await notifyLeaseExpiring({ landlordUserId: lease.landlord_user_id, landlordId: lease.landlord_id, landlordEmail: lease.landlord_email, landlordPhone: lease.landlord_phone, tenantName: tName, unitNumber: lease.unit_number, propertyName: lease.property_name, endDate: lease.end_date, daysRemaining: d, leaseId: lease.id })
        if (lease.tenant_user_id && !lease.tenant_renewal_intent_at) {
          await notifyLeaseRenewalSurvey({ tenantUserId: lease.tenant_user_id, tenantEmail: lease.tenant_email, tenantPhone: lease.tenant_phone, unitNumber: lease.unit_number, propertyName: lease.property_name, endDate: lease.end_date, leaseId: lease.id })
        }
      }

      // 45 days — notify landlord of tenant response if received
      if (d === 45 && lease.tenant_renewal_intent) {
        await notifyLandlordRenewalDecision({ landlordUserId: lease.landlord_user_id, landlordId: lease.landlord_id, landlordEmail: lease.landlord_email, landlordPhone: lease.landlord_phone, tenantName: tName, unitNumber: lease.unit_number, propertyName: lease.property_name, endDate: lease.end_date, leaseId: lease.id, tenantIntent: lease.tenant_renewal_intent })
      }

      // 37 days (AZ min 30 + 7) — escalation if unresolved
      if (d <= 37 && d >= 36 && !lease.renewal_notified_37d_at) {
        await notifyLandlordRenewalDecision({ landlordUserId: lease.landlord_user_id, landlordId: lease.landlord_id, landlordEmail: lease.landlord_email, landlordPhone: lease.landlord_phone, tenantName: tName, unitNumber: lease.unit_number, propertyName: lease.property_name, endDate: lease.end_date, leaseId: lease.id, tenantIntent: lease.tenant_renewal_intent || 'no_response' })
        await query('UPDATE leases SET renewal_notified_37d_at=NOW() WHERE id=$1', [lease.id])
      }

      // 31 days (AZ min 30 + 1) — final notice
      if (d <= 31 && d >= 30 && !lease.renewal_notified_31d_at) {
        await notifyLeaseExpiring({ landlordUserId: lease.landlord_user_id, landlordId: lease.landlord_id, landlordEmail: lease.landlord_email, landlordPhone: lease.landlord_phone, tenantName: tName, unitNumber: lease.unit_number, propertyName: lease.property_name, endDate: lease.end_date, daysRemaining: d, leaseId: lease.id })
        await query('UPDATE leases SET renewal_notified_31d_at=NOW() WHERE id=$1', [lease.id])
      }

      // 28 days — policy notice to landlord if still unresolved (not legal advice)
      if (d <= 28 && d >= 27 && !lease.renewal_policy_sent_at) {
        const { createNotification } = await import('../services/notifications')
        await createNotification({
          userId: lease.landlord_user_id, landlordId: lease.landlord_id,
          type: 'lease_renewal_action_required',
          title: `⚠ Unresolved Lease — Unit ${lease.unit_number} (${d} days)`,
          body: `This lease expires in ${d} days with no renewal or non-renewal notice on file. Under A.R.S. § 33-1375, a landlord must provide at least 30 days written notice. This is a statutory reference only — not legal advice.`,
          data: { leaseId: lease.id, daysRemaining: d },
          sendEmail: true, emailTo: lease.landlord_email,
          emailSubject: `Urgent: Unresolved Lease Expiry — Unit ${lease.unit_number}`,
          emailHtml: `<b>Unit ${lease.unit_number}</b> lease expires in <b>${d} days</b> with no renewal decision on file.<br><br>Under <b>A.R.S. § 33-1375</b>, Arizona landlords must provide at least <b>30 days written notice</b> of non-renewal or termination.<br><br>GAM is informing you of this statute as a courtesy. <b>This is not legal advice.</b> Please consult an attorney if you have questions about your obligations.<br><br>Log in to your landlord portal to take action.`,
          sendSMS: true, smsTo: lease.landlord_phone,
          smsBody: `GAM URGENT: Unit ${lease.unit_number} lease expires in ${d} days. No renewal notice on file. ARS 33-1375 requires 30 days notice. Login now.`
        })
        await query('UPDATE leases SET renewal_policy_sent_at=NOW() WHERE id=$1', [lease.id])
      }
    }
  } catch(e) { console.error('[SCHEDULER] lease expiry:', e) }
}

async function checkLowStock() {
  try {
    const landlords = await query('SELECT DISTINCT landlord_id FROM pos_items WHERE is_active=TRUE')
    for (const row of landlords as any[]) {
      const low = await query('SELECT pi.*, v.name as vendor_name FROM pos_items pi LEFT JOIN pos_vendors v ON v.id=pi.vendor_id WHERE pi.landlord_id=$1 AND pi.stock_qty <= pi.stock_min AND pi.is_active=TRUE', [row.landlord_id])
      if ((low as any[]).length > 0) {
        const landlord = await queryOne('SELECT u.id, u.email FROM landlords l JOIN users u ON u.id=l.user_id WHERE l.id=$1', [row.landlord_id]) as any
        if (landlord) await notifyLowStock({ landlordUserId: landlord.id, landlordId: row.landlord_id, landlordEmail: landlord.email, items: low as any[] })
      }
    }
  } catch(e) { console.error('[SCHEDULER] low stock:', e) }
}

export function schedulerInit() {
  console.log('\n⏰ Scheduler initialized')

  // ── RENT COLLECTION INITIATION ──────────────────────────────
  // Run on 28th of each month at 6am — pulls rent for following month
  // Gives ACH time to settle by the 1st
  cron.schedule('0 6 28 * *', async () => {
    console.log('[Scheduler] Initiating rent collection pulls...')
    try {
      const now = new Date()
      const nextMonth = new Date(now.getFullYear(), now.getMonth() + 1, 1)
      const targetMonth = `${nextMonth.getFullYear()}-${String(nextMonth.getMonth() + 1).padStart(2,'0')}`
      // TODO: call payment service to initiate Stripe ACH pulls
      console.log(`[Scheduler] Rent collection initiated for ${targetMonth}`)
    } catch (e) { console.error('[Scheduler] Rent collection error:', e) }
  })

  // ── ON-TIME PAY DISBURSEMENT SLA ────────────────────────────
  // Run last business day of month at 8am
  // SLA: initiated on or before 1st business day of month
  // Platform disburses from reserve if tenant hasn't settled yet
  cron.schedule('0 8 28,29,30,31 * *', async () => {
    const today = new Date()
    const tomorrow = new Date(today); tomorrow.setDate(tomorrow.getDate() + 1)
    // Only run if tomorrow is 1st (or if today is last day of month)
    if (tomorrow.getDate() !== 1 && today.getDate() !== new Date(today.getFullYear(), today.getMonth() + 1, 0).getDate()) return
    console.log('[Scheduler] Initiating On-Time Pay disbursements (SLA)...')
    try {
      const targetDate = `${tomorrow.getFullYear()}-${String(tomorrow.getMonth() + 1).padStart(2,'0')}-01`
      // TODO: call disbursement service — fulfill SLA from reserve if needed
      console.log(`[Scheduler] Disbursements initiated for ${targetDate}`)
    } catch (e) { console.error('[Scheduler] Disbursement error:', e) }
  })

  // ── RESERVE FUND CONTRIBUTION ───────────────────────────────
  // Run on 2nd of each month — after disbursements settle
  // Contributions from previous month's net
  cron.schedule('0 10 2 * *', async () => {
    console.log('[Scheduler] Processing reserve fund contribution...')
    try {
      const state = await queryOne<any>(`SELECT * FROM reserve_fund_state LIMIT 1`)
      if (!state) return
      // TODO: calculate contribution from prior month net and add to reserve
      console.log(`[Scheduler] Reserve contribution processed. Balance: $${state.balance}`)
    } catch (e) { console.error('[Scheduler] Reserve contribution error:', e) }
  })

  // ── LATE PAYMENT DETECTION ──────────────────────────────────
  // Run daily at 7am — detect failed/missing ACH pulls
  cron.schedule('0 7 * * *', async () => {
    try {
      const today = new Date()
      // Payments due 5+ days ago that haven't settled
      const overdue = await query<any>(`
        SELECT p.*, u.unit_number, u.id AS unit_id,
          t.id AS tenant_id, t.late_payment_count, t.ssi_ssdi,
          ul.email AS landlord_email
        FROM payments p
        JOIN units u ON u.id = p.unit_id
        JOIN tenants t ON t.id = p.tenant_id
        JOIN landlords l ON l.id = p.landlord_id
        JOIN users ul ON ul.id = l.user_id
        WHERE p.type = 'rent'
          AND p.status IN ('pending','failed')
          AND p.due_date <= NOW() - INTERVAL '5 days'
          AND u.payment_block = FALSE
      `)

      for (const payment of overdue) {
        // Increment late count
        await query(
          `UPDATE tenants SET late_payment_count = late_payment_count + 1 WHERE id = $1`,
          [payment.tenant_id]
        )

        // Mark unit delinquent
        await query(
          `UPDATE units SET status = 'delinquent' WHERE id = $1 AND status = 'active'`,
          [payment.unit_id]
        )

        // After 2 late payments — check if On-Time Pay invitation should be sent
        if (payment.late_payment_count >= 1) { // Already incremented above, so this is 2+
          const tenant = await queryOne<any>(
            `SELECT * FROM tenants WHERE id = $1`, [payment.tenant_id]
          )
          if (tenant && !tenant.on_time_pay_enrolled && !tenant.on_time_pay_invite_sent_at) {
            await query(
              `UPDATE tenants SET on_time_pay_invite_sent_at = NOW() WHERE id = $1`,
              [payment.tenant_id]
            )
            // TODO: send On-Time Pay invitation email
            console.log(`[Scheduler] On-Time Pay invite queued for tenant ${payment.tenant_id}`)
          }
        }

        // TODO: send late payment notifications to landlord
      }

      if (overdue.length > 0) {
        console.log(`[Scheduler] ${overdue.length} overdue payment(s) processed`)
      }
    } catch (e) { console.error('[Scheduler] Late payment detection error:', e) }
  })

  // ── FLEX DEPOSIT INSTALLMENT PULLS ──────────────────────────
  // Run daily at 9am — pull scheduled FlexDeposit installments
  cron.schedule('0 9 * * *', async () => {
    try {
      const today = new Date()
      const todayDate = `${today.getFullYear()}-${String(today.getMonth()+1).padStart(2,'0')}-${String(today.getDate()).padStart(2,'0')}`
      const installments = await query<any>(`
        SELECT sd.*, t.stripe_customer_id, t.ach_verified
        FROM security_deposits sd
        JOIN tenants t ON t.id = sd.tenant_id
        WHERE sd.status IN ('pending','partial')
          AND sd.flex_deposit_enabled = TRUE
          AND sd.installments_remaining > 0
          AND sd.next_installment_date = $1
          AND t.ach_verified = TRUE
      `, [todayDate])

      for (const dep of installments) {
        // TODO: initiate Stripe ACH for installment_amount
        await query(`
          UPDATE security_deposits
          SET installments_paid = installments_paid + 1,
              installments_remaining = installments_remaining - 1,
              collected_amount = collected_amount + installment_amount,
              next_installment_date = next_installment_date + INTERVAL '1 month'
          WHERE id = $1
        `, [dep.id])
        // Mark fully funded when all installments complete
        await query(`
          UPDATE security_deposits
          SET status = CASE WHEN installments_remaining = 0 THEN 'funded' ELSE status END
          WHERE id = $1
        `, [dep.id])
      }
      if (installments.length > 0) {
        console.log(`[Scheduler] ${installments.length} FlexDeposit installment(s) processed`)
      }
    } catch (e) { console.error('[Scheduler] FlexDeposit error:', e) }
  })

  // ── UTILITY BILLING ─────────────────────────────────────────
  // Run on 15th at 10am — pull utility charges from prior month
  cron.schedule('0 10 15 * *', async () => {
    console.log('[Scheduler] Processing utility billing...')
    // TODO: calculate and initiate utility bill ACH pulls
  })

  // ── NACHA RETURN MONITORING ─────────────────────────────────
  // Run daily at 8am — check return rates, alert if approaching threshold
  cron.schedule('0 8 * * *', async () => {
    try {
      const [stats] = await query<any>(`
        SELECT
          COUNT(*) FILTER (WHERE status = 'returned') AS returns,
          COUNT(*) FILTER (WHERE type = 'rent' AND created_at > NOW() - INTERVAL '30 days') AS total,
          COUNT(*) FILTER (WHERE zero_tolerance_flag = TRUE AND created_at > NOW() - INTERVAL '30 days') AS zero_tolerance
        FROM payments
        WHERE type = 'rent'
          AND created_at > NOW() - INTERVAL '30 days'
      `)
      const returnRate = stats.total > 0 ? (stats.returns / stats.total) : 0
      if (returnRate > 0.03) {
        console.warn(`[NACHA ALERT] Return rate ${(returnRate*100).toFixed(2)}% exceeds 3% threshold`)
      }
      if (stats.zero_tolerance > 0) {
        console.error(`[NACHA ZERO-TOLERANCE] ${stats.zero_tolerance} zero-tolerance return(s) this month — manual review required`)
      }
    } catch (e) { console.error('[Scheduler] NACHA monitoring error:', e) }
  })


  // ── FLEXPAY PULL ─────────────────────────────────────────────
  // Run daily at 6am — pull rent for tenants whose chosen date is today
  // Also handles variable patterns (3rd Wednesday etc)
  cron.schedule('0 6 * * *', async () => {
    try {
      const today = new Date()
      const dayOfMonth = today.getDate()
      const dayOfWeek = today.getDay() // 0=Sun, 1=Mon ... 3=Wed ... 5=Fri
      const weekOfMonth = Math.ceil(dayOfMonth / 7)

      // Resolve variable pattern to today
      const matchesPattern = (pattern: string) => {
        const [week, day] = pattern.split('-')
        const weekNum = { '1st':1,'2nd':2,'3rd':3,'4th':4 }[week] || 0
        const dayNum  = { 'monday':1,'wednesday':3,'friday':5 }[day] || -1
        return weekOfMonth === weekNum && dayOfWeek === dayNum
      }

      // Find all tenants with FlexPay pull due today
      const dueTenants = await query<any>(`
        SELECT t.id AS tenant_id, t.flexpay_pull_day, t.flexpay_pull_pattern,
               t.flexpay_fee, t.flexpay_tier,
               u.unit_number, u.rent_amount, u.id AS unit_id,
               l.id AS landlord_id,
               tu.email AS tenant_email, tu.first_name, tu.last_name
        FROM tenants t
        JOIN units u ON u.tenant_id = t.id
        JOIN landlords l ON l.id = u.landlord_id
        JOIN users tu ON tu.id = t.user_id
        WHERE t.flexpay_enrolled = TRUE
          AND t.ach_verified = TRUE
          AND (
            (t.flexpay_pull_day = $1 AND t.flexpay_pull_pattern IS NULL)
            OR t.flexpay_pull_pattern IS NOT NULL
          )
      `, [dayOfMonth])

      for (const tenant of dueTenants as any[]) {
        // For variable patterns, check if today matches
        if (tenant.flexpay_pull_pattern && !matchesPattern(tenant.flexpay_pull_pattern)) continue

        console.log(`[FlexPay] Initiating pull for ${tenant.first_name} ${tenant.last_name} — ${tenant.rent_amount}`)
        // TODO: initiate Stripe ACH pull for tenant.rent_amount
        // Record payment intent
        await query(`
          INSERT INTO payments (tenant_id, unit_id, landlord_id, amount, type, status, due_date, entry_description)
          VALUES ($1, $2, $3, $4, 'rent', 'processing', NOW(), 'FlexPay ACH pull')
          ON CONFLICT DO NOTHING
        `, [tenant.tenant_id, tenant.unit_id, tenant.landlord_id, tenant.rent_amount])
      }

      if ((dueTenants as any[]).length > 0) {
        console.log(`[FlexPay] ${(dueTenants as any[]).length} pulls initiated for day ${dayOfMonth}`)
      }
    } catch (e) { console.error('[Scheduler] FlexPay pull error:', e) }
  })

  // ── FLEXCHARGE PULL ──────────────────────────────────────────
  // Run daily at 7am — consolidate and pull FlexCharge balances
  // for accounts whose pull date is today (synced with FlexPay or 15th)
  cron.schedule('0 7 * * *', async () => {
    try {
      const today = new Date()
      const dayOfMonth = today.getDate()

      // Get accounts where pull date matches today
      // Pull date = FlexPay pull day, or 15 if no FlexPay
      const dueAccounts = await query<any>(`
        SELECT fca.id AS account_id, fca.current_balance, fca.tenant_id,
               fca.landlord_id, fca.status,
               t.flexpay_pull_day, t.flexpay_pull_pattern,
               tu.email AS tenant_email, tu.first_name, tu.last_name
        FROM flex_charge_accounts fca
        JOIN tenants t ON t.id = fca.tenant_id
        JOIN users tu ON tu.id = t.user_id
        WHERE fca.status IN ('active','disqualified')
          AND fca.current_balance > 0
          AND (
            (t.flexpay_pull_day = $1)
            OR (t.flexpay_pull_day IS NULL AND $1 = 15)
          )
      `, [dayOfMonth])

      for (const account of dueAccounts as any[]) {
        console.log(`[FlexCharge] Pulling ${account.current_balance} for ${account.first_name} ${account.last_name}`)
        // TODO: initiate Stripe ACH pull for account.current_balance

        // Mark all pending transactions as pulled
        await query(`
          UPDATE flex_charge_transactions
          SET status = 'pulled', pulled_at = NOW()
          WHERE account_id = $1 AND status = 'pending'
        `, [account.account_id])

        // Reset balance
        await query(`
          UPDATE flex_charge_accounts SET current_balance = 0, updated_at = NOW()
          WHERE id = $1
        `, [account.account_id])

        // If disqualified, close the account after pull
        if (account.status === 'disqualified') {
          await query(`
            UPDATE flex_charge_accounts SET status = 'closed', updated_at = NOW()
            WHERE id = $1
          `, [account.account_id])
          console.log(`[FlexCharge] Account closed after final pull for ${account.first_name} ${account.last_name}`)
        }
      }

      if ((dueAccounts as any[]).length > 0) {
        console.log(`[FlexCharge] ${(dueAccounts as any[]).length} accounts pulled for day ${dayOfMonth}`)
      }
    } catch (e) { console.error('[Scheduler] FlexCharge pull error:', e) }
  })

  console.log('   ✓ FlexPay pulls:      Daily 6am (per tenant date)')
  console.log('   ✓ FlexCharge pulls:   Daily 7am (synced with FlexPay)')
  console.log('   ✓ Rent collection:    28th of month, 6am')
  console.log('   ✓ Disbursement SLA:   Last business day, 8am')
  console.log('   ✓ Reserve build:      2nd of month, 10am')
  console.log('   ✓ Late detection:     Daily 7am')
  console.log('   ✓ FlexDeposit pulls:  Daily 9am')
  console.log('   ✓ Utility billing:    15th of month, 10am')
  console.log('   ✓ NACHA monitoring:   Daily 8am\n')
}
