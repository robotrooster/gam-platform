import { query, queryOne } from '../db'
import {
  SERVICE_INTERRUPTION_TYPE_LABELS,
  type ServiceInterruptionType,
} from '@gam/shared'
import { AppError } from '../middleware/errorHandler'
import {
  createNotification, notifyServiceInterruption, notifyServiceRestored,
} from './notifications'
import { findStaffWithPermission } from './staffNotify'

// ============================================================
// S517 — service-interruption status auto-activation.
//
// A landlord can post an outage scheduled for the future (status='scheduled').
// The resident notice is sent at post time; this cron flips the notice to
// 'active' once starts_at arrives so the tenant feed + landlord console show
// the true current state.
//
// NOTE: we intentionally do NOT auto-resolve at expected_restore_at — that's
// only an estimate, and 'resolved' fires the all-clear notification. Telling
// residents "service restored" before it actually is would be a false signal,
// so resolution stays a manual landlord action.
// ============================================================

const utilityLabel = (t: string) =>
  SERVICE_INTERRUPTION_TYPE_LABELS[t as ServiceInterruptionType] ?? t

// ============================================================
// S553 — create/resolve extracted to a shared service so the portal route
// and the landlord agent tool run the exact same path (S552 pattern, ref
// entryRequestRespond). Callers verify ownership BEFORE calling; this layer
// validates the window, writes, and fans out notifications.
//
// Fan-out (S552 front-desk principle — the owner never relays): residents
// get the outage notice as before, and staff holding the Outages tab for
// the property + the owner are notified too, minus whoever posted it.
// ============================================================

export interface CreateServiceInterruptionInput {
  propertyId: string
  landlordId: string
  unitIds: string[]
  utilityType: string
  title: string | null
  message: string | null
  isEmergency: boolean
  /** ISO; defaults to now (emergency posture) */
  startsAt?: string | null
  expectedRestoreAt?: string | null
  createdByUserId: string
}

export async function createServiceInterruption(input: CreateServiceInterruptionInput) {
  const startsAt = input.startsAt ?? new Date().toISOString()
  if (input.expectedRestoreAt && new Date(input.expectedRestoreAt) < new Date(startsAt))
    throw new AppError(400, 'Expected-restore time cannot be before the start')
  const status = new Date(startsAt) <= new Date() ? 'active' : 'scheduled'

  const row = await queryOne<any>(
    `INSERT INTO service_interruptions
       (property_id, landlord_id, unit_ids, utility_type, title, message,
        is_emergency, starts_at, expected_restore_at, status, created_by_user_id, residents_notified_at)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11, now()) RETURNING *`,
    [input.propertyId, input.landlordId, input.unitIds, input.utilityType,
     input.title, input.message, input.isEmergency, startsAt,
     input.expectedRestoreAt ?? null, status, input.createdByUserId])

  const residentsNotified = await notifyServiceInterruption({
    propertyId: input.propertyId, landlordId: input.landlordId, unitIds: input.unitIds,
    utilityLabel: utilityLabel(input.utilityType), title: input.title, message: input.message,
    isEmergency: input.isEmergency, startsAt, expectedRestoreAt: input.expectedRestoreAt ?? null,
  })

  let staffNotified = 0
  try {
    const recipients = new Map<string, true>()
    const staff = await findStaffWithPermission(
      input.landlordId, input.propertyId, ['maintenance.tab.outages'])
    for (const s of staff) recipients.set(s.user_id, true)
    const owner = await queryOne<{ user_id: string }>(
      `SELECT user_id FROM landlords WHERE id = $1`, [input.landlordId])
    if (owner) recipients.set(owner.user_id, true)
    recipients.delete(input.createdByUserId)

    const prop = await queryOne<{ name: string }>(
      `SELECT name FROM properties WHERE id = $1`, [input.propertyId])
    const label = utilityLabel(input.utilityType)
    for (const userId of recipients.keys()) {
      await createNotification({
        userId, landlordId: input.landlordId,
        type: 'service_interruption',
        title: `${input.isEmergency ? '🚨 ' : ''}${label} notice posted — ${prop?.name ?? 'property'}`,
        body: `${status === 'active' ? 'Active now' : 'Scheduled'}: ${label} interruption` +
              `${input.title ? ` — ${input.title}` : ''}.` +
              (input.expectedRestoreAt ? ` Expected back ${new Date(input.expectedRestoreAt).toLocaleString()}.` : ''),
        data: { serviceInterruptionId: row.id, propertyId: input.propertyId },
      })
      staffNotified++
    }
  } catch { /* best-effort — residents were already notified */ }

  return { row, residentsNotified, staffNotified }
}

/** Caller must have verified the actor may manage `si` (a service_interruptions row). */
export async function resolveServiceInterruption(si: any, sendAllClear: boolean) {
  if (si.status === 'resolved' || si.status === 'cancelled')
    throw new AppError(400, `Notice is already ${si.status}`)

  let restoreNotified: string | null = si.restore_notified_at
  if (sendAllClear) {
    await notifyServiceRestored({
      propertyId: si.property_id, landlordId: si.landlord_id,
      unitIds: si.unit_ids ?? [], utilityLabel: utilityLabel(si.utility_type),
    })
    restoreNotified = new Date().toISOString()
  }
  return queryOne<any>(
    `UPDATE service_interruptions
        SET status='resolved', resolved_at=now(), restore_notified_at=$2, updated_at=now()
      WHERE id=$1 RETURNING *`, [si.id, restoreNotified])
}

export async function activateDueServiceInterruptions(
  now: Date = new Date(),
): Promise<{ activated: number }> {
  const rows = await query<{ id: string }>(
    `UPDATE service_interruptions
        SET status='active', updated_at=now()
      WHERE status='scheduled' AND starts_at <= $1
      RETURNING id`,
    [now.toISOString()])
  return { activated: rows.length }
}
