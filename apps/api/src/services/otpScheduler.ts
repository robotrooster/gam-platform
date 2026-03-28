import { query, queryOne } from '../db'

// ── OTP Disbursement Scheduler ────────────────────────────────────────────
// Runs on the 28th of each month.
// Finds all tenants who qualified for OTP by the 23rd cutoff,
// calculates per-landlord charges and queues disbursements for the 1st.

export async function runOtpDisbursementCycle() {
  const now = new Date()
  const month = now.getMonth() + 1
  const year  = now.getFullYear()

  // Cutoff: 23rd of current month at EOD
  const cutoff = new Date(year, now.getMonth(), 23, 23, 59, 59)

  console.log(`[OTP] Running disbursement cycle for ${year}-${String(month).padStart(2,'0')}, cutoff: ${cutoff.toISOString()}`)

  // Find all OTP-qualified tenants where qualification is before cutoff
  const qualifiedTenants = await query<any>(`
    SELECT
      t.id AS tenant_id,
      t.otp_qualified_at,
      t.income_arrival_day,
      u.unit_number,
      u.rent_amount,
      u.landlord_id,
      l.id AS landlord_id,
      lu.email AS landlord_email
    FROM tenants t
    JOIN units u ON u.tenant_id = t.id
    JOIN landlords l ON l.id = u.landlord_id
    JOIN users lu ON lu.id = l.user_id
    WHERE t.otp_qualified_at IS NOT NULL
      AND t.otp_qualified_at <= $1
      AND t.on_time_pay_enrolled = TRUE
      AND t.ach_verified = TRUE
  `, [cutoff])

  if (!qualifiedTenants.length) {
    console.log('[OTP] No qualifying tenants found for this cycle')
    return { processed: 0, landlords: 0 }
  }

  // Group by landlord
  const byLandlord = qualifiedTenants.reduce((acc: any, t: any) => {
    if (!acc[t.landlord_id]) acc[t.landlord_id] = { landlordId: t.landlord_id, landlordEmail: t.landlord_email, tenants: [] }
    acc[t.landlord_id].tenants.push(t)
    return acc
  }, {} as Record<string, any>)

  const disbursementDate = new Date(year, now.getMonth() + 1, 1) // 1st of next month

  let totalProcessed = 0

  for (const landlordGroup of Object.values(byLandlord) as any[]) {
    const { landlordId, tenants } = landlordGroup
    const unitCount = tenants.length
    const totalRent = tenants.reduce((sum: number, t: any) => sum + parseFloat(t.rent_amount || 0), 0)
    const platformFee = unitCount * 15 // $15 per OTP unit

    console.log(`[OTP] Landlord ${landlordId}: ${unitCount} units, rent $${totalRent.toFixed(2)}, fee $${platformFee}`)

    // Record the scheduled disbursement
    await query(`
      INSERT INTO disbursements (
        landlord_id, amount, platform_fee, unit_count,
        scheduled_date, status, type, notes, created_at
      ) VALUES ($1, $2, $3, $4, $5, 'scheduled', 'otp_rent', $6, NOW())
      ON CONFLICT DO NOTHING
    `, [
      landlordId,
      totalRent,
      platformFee,
      unitCount,
      disbursementDate,
      `OTP cycle ${year}-${String(month).padStart(2,'0')}: ${unitCount} units`
    ])

    totalProcessed += unitCount
  }

  console.log(`[OTP] Cycle complete: ${totalProcessed} tenants across ${Object.keys(byLandlord).length} landlords`)
  return { processed: totalProcessed, landlords: Object.keys(byLandlord).length }
}

// ── Check if today is the 28th and run ────────────────────────────────────
export function scheduleOtpCron() {
  // Check every hour if it's the 28th and hasn't run this month
  let lastRunMonth = -1

  setInterval(async () => {
    const now = new Date()
    if (now.getDate() === 28 && now.getMonth() !== lastRunMonth) {
      lastRunMonth = now.getMonth()
      console.log('[OTP] 28th detected — running disbursement cycle')
      try {
        await runOtpDisbursementCycle()
      } catch (e) {
        console.error('[OTP] Scheduler error:', e)
      }
    }
  }, 60 * 60 * 1000) // every hour

  console.log('[OTP] Scheduler initialized — will run on the 28th of each month')
}
