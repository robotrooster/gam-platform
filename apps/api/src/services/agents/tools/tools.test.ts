/**
 * Tool registry + allowlist + file_maintenance_request (Step 4).
 *
 * DB and the maintenance service are mocked — no DB, no model.
 */

import { vi, describe, it, expect, beforeEach } from 'vitest'

vi.mock('../../../db', () => ({ query: vi.fn(), queryOne: vi.fn() }))
vi.mock('../../maintenanceRequests', () => ({ createMaintenanceRequest: vi.fn() }))
vi.mock('../../notifications', () => ({ createNotification: vi.fn(), notifyMaintenanceUpdated: vi.fn() }))

import { query } from '../../../db'
import { createMaintenanceRequest } from '../../maintenanceRequests'
import { getToolsForProfile, getTool } from './index'
import { fileMaintenanceRequest } from './fileMaintenanceRequest'
import { getMyLease } from './getMyLease'
import { getMyPayments } from './getMyPayments'
import { getLandlordPortfolio } from './getLandlordPortfolio'
import { getMyMaintenanceRequests } from './getMyMaintenanceRequests'
import { getMyDocuments } from './getMyDocuments'
import { getPendingMaintenance } from './getPendingMaintenance'
import { lookupTenantPaymentStatus } from './lookupTenantPaymentStatus'
import { updateNotificationPreference } from './updateNotificationPreference'
import { getDelinquentTenants } from './getDelinquentTenants'
import { getMyInspections } from './getMyInspections'
import { getMyPaymentMethods } from './getMyPaymentMethods'
import { approveMaintenanceRequest } from './approveMaintenanceRequest'
import { getMaintenanceTeam } from './getMaintenanceTeam'
import { assignMaintenanceRequest } from './assignMaintenanceRequest'
import { getBooksSummary } from './getBooksSummary'
import { getTenantContact } from './getTenantContact'
import { rejectMaintenanceRequest } from './rejectMaintenanceRequest'
import { addMaintenanceComment } from './addMaintenanceComment'
import { cancelMaintenanceRequest } from './cancelMaintenanceRequest'
import { getTeam } from './getTeam'
import { scheduleMaintenance } from './scheduleMaintenance'
import { getMyContacts } from './getMyContacts'
import { getMyEntryRequests } from './getMyEntryRequests'
import { getMyLandlordPatterns } from './getMyLandlordPatterns'
import { getApplicableLaws } from './getApplicableLaws'
import { searchStateLaw } from './searchStateLaw'
import { checkAgainstLaw } from './checkAgainstLaw'
import { messageTenant } from './messageTenant'
import { getMyDeposit } from './getMyDeposit'
import { getMyInvoices } from './getMyInvoices'
import { getPendingApplications } from './getPendingApplications'
import { getMyPayouts } from './getMyPayouts'
import { markNotificationsRead } from './markNotificationsRead'
import { sendBulkMessage } from './sendBulkMessage'
import { getBackgroundCheckStatus } from './getBackgroundCheckStatus'
import { getMyBookings } from './getMyBookings'
import { getPropertyRentRoll } from './getPropertyRentRoll'
import { getSetupProgress } from './getSetupProgress'
import { queryOne } from '../../../db'
import { createNotification } from '../../notifications'
import { requireProfile } from '../profiles'
import type { AgentActor } from './types'

const mockQueryOne = queryOne as unknown as ReturnType<typeof vi.fn>
const mockCreateNotification = createNotification as unknown as ReturnType<typeof vi.fn>

const TENANT_ACTOR: AgentActor = { userId: 'u1', role: 'tenant', profileId: 't1' }
const LANDLORD_ACTOR: AgentActor = { userId: 'u2', role: 'landlord', profileId: 'L1' }

describe('tool allowlist', () => {
  it('gives tenant profiles the tenant tools, landlord profiles the landlord tools', () => {
    const t = getToolsForProfile(requireProfile('tenant_entry')).map((x) => x.name)
    for (const name of ['file_maintenance_request', 'add_maintenance_comment', 'cancel_maintenance_request', 'get_my_lease', 'get_my_inspections', 'get_my_entry_requests', 'get_my_payment_methods', 'get_my_deposit', 'get_my_invoices', 'get_my_bookings', 'get_my_contacts', 'get_my_landlord_patterns', 'get_applicable_laws', 'search_state_law', 'check_against_law', 'get_my_notifications', 'mark_notifications_read'])
      expect(t).toContain(name)

    const l = getToolsForProfile(requireProfile('landlord_entry')).map((x) => x.name)
    for (const name of ['get_landlord_portfolio', 'get_property_rent_roll', 'get_setup_progress', 'get_delinquent_tenants', 'get_vacant_units', 'get_lease_expirations', 'get_pending_applications', 'get_my_payouts', 'get_background_check_status', 'get_maintenance_team', 'get_books_summary', 'get_tenant_contact', 'get_team', 'get_applicable_laws', 'check_against_law', 'approve_maintenance_request', 'assign_maintenance_request', 'reject_maintenance_request', 'schedule_maintenance', 'message_tenant', 'send_bulk_message', 'get_my_notifications', 'mark_notifications_read'])
      expect(l).toContain(name)
  })

  it('never surfaces a tenant-only tool to a landlord profile (audience gate), and vice-versa', () => {
    const l = getToolsForProfile(requireProfile('landlord_entry')).map((t) => t.name)
    for (const name of ['file_maintenance_request', 'get_my_payment_status', 'get_my_documents', 'get_my_inspections', 'get_my_entry_requests'])
      expect(l).not.toContain(name)

    const t = getToolsForProfile(requireProfile('tenant_entry')).map((x) => x.name)
    for (const name of ['lookup_tenant_payment_status', 'get_pending_maintenance', 'get_delinquent_tenants', 'approve_maintenance_request', 'message_tenant'])
      expect(t).not.toContain(name)
  })

  it('would not surface a tool whose audience excludes the profile', () => {
    // file_maintenance_request is audience:['tenant'] — even if a landlord
    // profile listed it, the audience gate drops it.
    const fakeLandlord = { ...requireProfile('landlord_entry'), toolNames: ['file_maintenance_request'] }
    expect(getToolsForProfile(fakeLandlord)).toEqual([])
  })

  it('getTool resolves by name', () => {
    expect(getTool('file_maintenance_request')).toBe(fileMaintenanceRequest)
    expect(getTool('nope')).toBeUndefined()
  })
})

describe('file_maintenance_request.execute', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('validates title/description before touching the DB', async () => {
    const r1 = await fileMaintenanceRequest.execute({ title: 'x', description: 'broken sink' }, TENANT_ACTOR)
    expect(r1).toMatchObject({ ok: false })
    expect(query).not.toHaveBeenCalled()
    expect(createMaintenanceRequest).not.toHaveBeenCalled()
  })

  it('files for the tenant’s single active unit', async () => {
    ;(query as any).mockResolvedValue([{ unit_id: 'unit-9', unit_number: '12', property_name: 'Maple Court' }])
    ;(createMaintenanceRequest as any).mockResolvedValue({ id: 'req-1', status: 'open', priority: 'normal' })

    const res: any = await fileMaintenanceRequest.execute(
      { title: 'Leaking sink', description: 'Kitchen sink drips constantly' },
      TENANT_ACTOR
    )

    expect(createMaintenanceRequest).toHaveBeenCalledWith(
      expect.objectContaining({ unitId: 'unit-9', title: 'Leaking sink', actor: TENANT_ACTOR })
    )
    expect(res.ok).toBe(true)
    expect(res.requestId).toBe('req-1')
  })

  it('asks which unit when the tenant is on several', async () => {
    ;(query as any).mockResolvedValue([
      { unit_id: 'a', unit_number: '1', property_name: 'Maple' },
      { unit_id: 'b', unit_number: '2', property_name: 'Oak' },
    ])
    const res: any = await fileMaintenanceRequest.execute(
      { title: 'Broken heater', description: 'No heat in the unit' },
      TENANT_ACTOR
    )
    expect(res.ok).toBe(false)
    expect(res.needsUnitSelection).toBe(true)
    expect(res.units).toHaveLength(2)
    expect(createMaintenanceRequest).not.toHaveBeenCalled()
  })

  it('refuses a unitId the tenant is not on', async () => {
    ;(query as any).mockResolvedValue([{ unit_id: 'a', unit_number: '1', property_name: 'Maple' }])
    const res: any = await fileMaintenanceRequest.execute(
      { title: 'Broken heater', description: 'No heat', unitId: 'someone-elses-unit' },
      TENANT_ACTOR
    )
    expect(res.ok).toBe(false)
    expect(createMaintenanceRequest).not.toHaveBeenCalled()
  })

  it('reports no active lease cleanly', async () => {
    ;(query as any).mockResolvedValue([])
    const res: any = await fileMaintenanceRequest.execute(
      { title: 'Broken heater', description: 'No heat in the unit' },
      TENANT_ACTOR
    )
    expect(res.ok).toBe(false)
    expect(res.error).toMatch(/no active lease/i)
  })
})

describe('read tools scope to the actor', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('get_my_lease queries by the tenant’s own id and shapes the result', async () => {
    ;(query as any).mockResolvedValue([
      { id: 'L', status: 'active', rent_amount: '1400.00', rent_due_day: 3, start_date: '2026-01-01', end_date: null, late_fee_grace_days: 5, unit_number: '12', property_name: 'Maple Court' },
    ])
    const res: any = await getMyLease.execute({}, TENANT_ACTOR)
    expect((query as any).mock.calls[0][1]).toEqual(['t1']) // scoped to actor.profileId
    expect(res.leases[0]).toMatchObject({ monthlyRent: 1400, rentDueDay: 3, property: 'Maple Court' })
  })

  it('get_my_payment_status scopes by tenant and totals the outstanding balance', async () => {
    ;(query as any)
      .mockResolvedValueOnce([{ type: 'rent', amount: '1400.00', status: 'settled', due_date: '2026-05-03', processed_at: '2026-05-03' }])
      .mockResolvedValueOnce([{ outstanding: '1400.00', count: '1' }])
    const res: any = await getMyPayments.execute({}, TENANT_ACTOR)
    expect((query as any).mock.calls[0][1][0]).toBe('t1')
    expect(res.outstandingBalance).toBe(1400)
    expect(res.recentPayments[0]).toMatchObject({ type: 'rent', amount: 1400, status: 'settled' })
  })

  it('get_landlord_portfolio scopes by landlord id and summarizes occupancy', async () => {
    ;(query as any)
      .mockResolvedValueOnce([{ property_count: 2, total_units: 10, occupied_units: 8, vacant_units: 2 }])
      .mockResolvedValueOnce([{ amount: '5000.00', status: 'settled', unit_count: 8, target_date: '2026-06-01', settled_at: '2026-06-01' }])
    const res: any = await getLandlordPortfolio.execute({}, LANDLORD_ACTOR)
    expect((query as any).mock.calls[0][1]).toEqual(['L1'])
    expect(res.portfolio).toMatchObject({ properties: 2, totalUnits: 10, occupiedUnits: 8, vacantUnits: 2 })
    expect(res.recentPayouts[0]).toMatchObject({ amount: 5000, unitCount: 8 })
  })

  it('get_my_maintenance_requests scopes by the tenant id', async () => {
    ;(query as any).mockResolvedValue([{ title: 'Leak', status: 'open', priority: 'normal', created_at: 'd', unit_number: '1', property_name: 'Maple' }])
    const res: any = await getMyMaintenanceRequests.execute({}, TENANT_ACTOR)
    expect((query as any).mock.calls[0][1][0]).toBe('t1')
    expect(res.requests[0]).toMatchObject({ title: 'Leak', status: 'open', property: 'Maple' })
  })

  it('get_my_documents scopes by the tenant id and returns no urls', async () => {
    ;(query as any).mockResolvedValue([{ name: 'Lease.pdf', type: 'lease', signed_by_tenant: true, signed_by_landlord: false, created_at: 'd' }])
    const res: any = await getMyDocuments.execute({}, TENANT_ACTOR)
    expect((query as any).mock.calls[0][1][0]).toBe('t1')
    expect(JSON.stringify(res)).not.toMatch(/url/i)
    expect(res.documents[0]).toMatchObject({ name: 'Lease.pdf', signedByTenant: true })
  })

  it('get_pending_maintenance scopes by landlord id and counts awaiting-approval', async () => {
    ;(query as any).mockResolvedValue([
      { title: 'Big repair', status: 'awaiting_approval', priority: 'high', created_at: 'd', unit_number: '2', property_name: 'Oak' },
      { title: 'Small', status: 'open', priority: 'normal', created_at: 'd', unit_number: '3', property_name: 'Oak' },
    ])
    const res: any = await getPendingMaintenance.execute({}, LANDLORD_ACTOR)
    expect((query as any).mock.calls[0][1][0]).toBe('L1')
    expect(res.awaitingApproval).toBe(1)
    expect(res.count).toBe(2)
  })

  describe('lookup_tenant_payment_status (landlord, doubly scoped)', () => {
    it('binds the match query to the landlord id', async () => {
      ;(query as any)
        .mockResolvedValueOnce([{ tenant_id: 'tX', first_name: 'Jane', last_name: 'Doe', email: 'jane@x.dev' }])
        .mockResolvedValueOnce([{ outstanding: '1200.00', count: '1' }])
        .mockResolvedValueOnce([{ type: 'rent', amount: '1200.00', status: 'failed', due_date: 'd' }])
      const res: any = await lookupTenantPaymentStatus.execute({ tenant: 'Jane' }, LANDLORD_ACTOR)
      // match query scoped to landlord id
      expect((query as any).mock.calls[0][1][0]).toBe('L1')
      // payment query scoped to BOTH tenant AND landlord
      expect((query as any).mock.calls[1][1]).toEqual(['tX', 'L1', expect.any(Array)])
      expect(res.outstandingBalance).toBe(1200)
      expect(res.tenant).toMatchObject({ name: 'Jane Doe' })
    })

    it('returns not-found when no tenant on the landlord’s leases matches', async () => {
      ;(query as any).mockResolvedValueOnce([])
      const res: any = await lookupTenantPaymentStatus.execute({ tenant: 'Nobody' }, LANDLORD_ACTOR)
      expect(res.ok).toBe(false)
      expect((query as any)).toHaveBeenCalledTimes(1) // never reaches the payment query
    })

    it('asks to disambiguate on multiple matches', async () => {
      ;(query as any).mockResolvedValueOnce([
        { tenant_id: 'a', first_name: 'Jane', last_name: 'Doe', email: 'jane@x.dev' },
        { tenant_id: 'b', first_name: 'Jane', last_name: 'Smith', email: 'jane@y.dev' },
      ])
      const res: any = await lookupTenantPaymentStatus.execute({ tenant: 'Jane' }, LANDLORD_ACTOR)
      expect(res.needsDisambiguation).toBe(true)
      expect(res.matches).toHaveLength(2)
    })
  })

  describe('update_notification_preference (scoped to actor.userId)', () => {
    it('updates an existing type, keeping unspecified channels', async () => {
      ;(query as any)
        .mockResolvedValueOnce([{ type: 'rent_due', email_enabled: true, sms_enabled: false, in_app_enabled: true }])
        .mockResolvedValueOnce([]) // the UPDATE
      const res: any = await updateNotificationPreference.execute({ type: 'rent_due', emailEnabled: false }, TENANT_ACTOR)
      expect((query as any).mock.calls[0][1]).toEqual(['u1']) // read scoped to userId
      const updateParams = (query as any).mock.calls[1][1]
      expect(updateParams[0]).toBe('u1') // update scoped to userId
      expect(res).toMatchObject({ ok: true, email: false, sms: false, inApp: true })
    })

    it('lists current types when the requested type is unknown', async () => {
      ;(query as any).mockResolvedValueOnce([{ type: 'rent_due', email_enabled: true, sms_enabled: false, in_app_enabled: true }])
      const res: any = await updateNotificationPreference.execute({ type: 'nonexistent' }, TENANT_ACTOR)
      expect(res.needsType).toBe(true)
      expect(res.types[0].type).toBe('rent_due')
      expect((query as any)).toHaveBeenCalledTimes(1) // no UPDATE issued
    })
  })

  describe('new read tools scope to the actor', () => {
    beforeEach(() => {
      vi.clearAllMocks()
    })

    it('get_my_inspections binds to the tenant id', async () => {
      ;(query as any).mockResolvedValue([])
      await getMyInspections.execute({}, TENANT_ACTOR)
      expect((query as any).mock.calls[0][1][0]).toBe('t1')
    })

    it('get_my_payment_methods binds to userId and never returns full account numbers', async () => {
      ;(query as any).mockResolvedValue([{ nickname: 'Checking', account_type: 'checking', account_number_last4: '6789', status: 'verified' }])
      const res: any = await getMyPaymentMethods.execute({}, TENANT_ACTOR)
      expect((query as any).mock.calls[0][1]).toEqual(['u1'])
      const sql = (query as any).mock.calls[0][0]
      expect(sql).not.toMatch(/account_number_encrypted|routing_number/)
      expect(res.methods[0]).toMatchObject({ last4: '6789' })
    })

    it('get_delinquent_tenants binds payments to the landlord id', async () => {
      ;(query as any).mockResolvedValue([{ first_name: 'Jane', last_name: 'Doe', email: 'j@x.dev', overdue: '1400', items: '1', oldest_due: 'd' }])
      const res: any = await getDelinquentTenants.execute({}, LANDLORD_ACTOR)
      const sql = (query as any).mock.calls[0][0]
      expect(sql).toMatch(/p\.landlord_id = \$1/)
      expect((query as any).mock.calls[0][1][0]).toBe('L1')
      expect(res.delinquentTenants[0]).toMatchObject({ name: 'Jane Doe', amountOverdue: 1400 })
    })

    it('get_my_deposit binds to the tenant id and omits Flex/interest fields', async () => {
      ;(query as any)
        .mockResolvedValueOnce([{ total_amount: '1500.00', collected_amount: '1500.00', status: 'held', damage_claimed: false, disbursed_to_landlord: false, held_by: 'gam' }])
        .mockResolvedValueOnce([])
      const res: any = await getMyDeposit.execute({}, TENANT_ACTOR)
      expect((query as any).mock.calls[0][1]).toEqual(['t1'])
      expect((query as any).mock.calls[0][0]).not.toMatch(/flex_deposit|gam_advance|interest_accrued/)
      expect(res.deposit).toMatchObject({ totalAmount: 1500, status: 'held' })
    })

    it('get_my_invoices binds to the tenant id', async () => {
      ;(query as any).mockResolvedValue([{ invoice_number: 'INV-1', due_date: 'd', total_amount: '1400.00', status: 'paid', sent_at: 'd' }])
      const res: any = await getMyInvoices.execute({}, TENANT_ACTOR)
      expect((query as any).mock.calls[0][1][0]).toBe('t1')
      expect(res.invoices[0]).toMatchObject({ invoiceNumber: 'INV-1', total: 1400 })
    })

    it('get_pending_applications binds to the landlord id and exposes no SSN', async () => {
      ;(query as any).mockResolvedValue([{ first_name: 'Sam', last_name: 'Lee', email: 's@x.dev', phone: '555', move_in_date: 'd', occupants: 2, has_pets: false, status: 'pending', created_at: 'd', unit_number: '4', property_name: 'Oak' }])
      const res: any = await getPendingApplications.execute({}, LANDLORD_ACTOR)
      expect((query as any).mock.calls[0][1][0]).toBe('L1')
      expect((query as any).mock.calls[0][0]).not.toMatch(/ssn|date_of_birth/i)
      expect(res.applications[0]).toMatchObject({ applicant: 'Sam Lee', status: 'pending', unit: '4' })
    })

    it('get_my_payouts binds to the landlord id', async () => {
      ;(query as any).mockResolvedValue([{ amount: '5000.00', status: 'settled', unit_count: 8, target_date: 'd', settled_at: 'd', trigger_type: 'auto' }])
      const res: any = await getMyPayouts.execute({}, LANDLORD_ACTOR)
      expect((query as any).mock.calls[0][1][0]).toBe('L1')
      expect(res.payouts[0]).toMatchObject({ amount: 5000, status: 'settled' })
    })

    it('mark_notifications_read updates only the actor’s own unread rows', async () => {
      ;(query as any).mockResolvedValue([{ id: 'n1' }, { id: 'n2' }])
      const res: any = await markNotificationsRead.execute({}, TENANT_ACTOR)
      const sql = (query as any).mock.calls[0][0]
      expect(sql).toMatch(/user_id = \$1/)
      expect(sql).toMatch(/read = FALSE/)
      expect((query as any).mock.calls[0][1]).toEqual(['u1'])
      expect(res.markedRead).toBe(2)
    })

    it('get_my_bookings binds to the tenant id', async () => {
      ;(query as any).mockResolvedValue([{ check_in: 'd', check_out: 'd2', nights: 3, total_amount: '300.00', status: 'confirmed', lease_type: 'rv_nightly' }])
      const res: any = await getMyBookings.execute({}, TENANT_ACTOR)
      expect((query as any).mock.calls[0][1][0]).toBe('t1')
      expect(res.bookings[0]).toMatchObject({ nights: 3, total: 300, status: 'confirmed' })
    })

    it('get_setup_progress scopes Connect by userId, counts by landlord id, and finds the next step', async () => {
      ;(mockQueryOne as any)
        .mockResolvedValueOnce({ connect_details_submitted: true, connect_charges_enabled: true, connect_payouts_enabled: false }) // users (by userId)
        .mockResolvedValueOnce({ properties: '1', units: '0', active_leases: '0', onboarding_complete: false }) // counts (by landlord_id)
      const res: any = await getSetupProgress.execute({}, LANDLORD_ACTOR)
      expect((mockQueryOne as any).mock.calls[0][1]).toEqual(['u2']) // connect by actor.userId
      expect((mockQueryOne as any).mock.calls[1][1]).toEqual(['L1']) // counts by actor.profileId
      expect(res.complete).toBe(false)
      expect(res.completedSteps).toBe(2) // bank (details submitted) + property
      expect(res.nextStep).toMatch(/units/i) // next incomplete step
    })

    it('get_property_rent_roll binds units to the landlord id, supports a property filter', async () => {
      ;(query as any).mockResolvedValue([{ property_name: 'Maple', unit_number: '1', status: 'active', rent_amount: '1400.00', tenants: 'Jane Doe' }])
      const res: any = await getPropertyRentRoll.execute({ propertyName: 'Maple' }, LANDLORD_ACTOR)
      const sql = (query as any).mock.calls[0][0]
      expect(sql).toMatch(/u\.landlord_id = \$1/)
      expect((query as any).mock.calls[0][1][0]).toBe('L1')
      expect((query as any).mock.calls[0][1]).toContain('%Maple%') // property filter param
      expect(res.rentRoll[0]).toMatchObject({ property: 'Maple', rent: 1400, tenants: 'Jane Doe' })
    })
  })

  describe('landlord action tools are scoped + guarded', () => {
    beforeEach(() => {
      vi.clearAllMocks()
    })

    it('approve_maintenance_request only touches a request owned by the landlord', async () => {
      ;(mockQueryOne as any)
        .mockResolvedValueOnce({ id: 'r1', landlord_id: 'L1', status: 'awaiting_approval', contractor_id: null, tenant_id: 't9', unit_id: 'u9', title: 'Leak' }) // ownership-scoped fetch
        .mockResolvedValueOnce({ id: 'r1', status: 'open' }) // the UPDATE
        .mockResolvedValueOnce(null) // tenant notify lookup
      const res: any = await approveMaintenanceRequest.execute({ requestId: 'r1' }, LANDLORD_ACTOR)
      // the fetch query is scoped to both id AND landlord id
      expect((mockQueryOne as any).mock.calls[0][1]).toEqual(['r1', 'L1'])
      expect(res.ok).toBe(true)
    })

    it('approve_maintenance_request refuses a request not in awaiting_approval', async () => {
      ;(mockQueryOne as any).mockResolvedValueOnce({ id: 'r1', landlord_id: 'L1', status: 'completed' })
      const res: any = await approveMaintenanceRequest.execute({ requestId: 'r1' }, LANDLORD_ACTOR)
      expect(res.ok).toBe(false)
    })

    it('approve_maintenance_request refuses an unknown / not-owned request', async () => {
      ;(mockQueryOne as any).mockResolvedValueOnce(null) // ownership filter found nothing
      const res: any = await approveMaintenanceRequest.execute({ requestId: 'r1' }, LANDLORD_ACTOR)
      expect(res.ok).toBe(false)
    })

    it('approve_maintenance_request handles a concurrent change (self-scoped UPDATE matches nothing)', async () => {
      ;(mockQueryOne as any)
        .mockResolvedValueOnce({ id: 'r1', landlord_id: 'L1', status: 'awaiting_approval', contractor_id: null, tenant_id: 't9', unit_id: 'u9', title: 'Leak' })
        .mockResolvedValueOnce(null) // the self-scoped UPDATE no longer matched (raced)
      const res: any = await approveMaintenanceRequest.execute({ requestId: 'r1' }, LANDLORD_ACTOR)
      expect(res.ok).toBe(false)
      expect(res.error).toMatch(/just updated/i)
      // the self-scoped UPDATE binds landlord id as a param
      expect((mockQueryOne as any).mock.calls[1][1]).toContain('L1')
    })

    it('message_tenant only messages a tenant on the landlord’s lease', async () => {
      ;(query as any).mockResolvedValueOnce([{ user_id: 'tenantUser', first_name: 'Jane', last_name: 'Doe', email: 'j@x.dev' }])
      const res: any = await messageTenant.execute({ tenant: 'Jane', message: 'Plumber comes Tuesday' }, LANDLORD_ACTOR)
      // tenant match query scoped to landlord id
      expect((query as any).mock.calls[0][1][0]).toBe('L1')
      expect(mockCreateNotification).toHaveBeenCalledWith(expect.objectContaining({ userId: 'tenantUser', landlordId: 'L1', body: 'Plumber comes Tuesday' }))
      expect(res.ok).toBe(true)
    })

    it('message_tenant refuses when no owned tenant matches', async () => {
      ;(query as any).mockResolvedValueOnce([])
      const res: any = await messageTenant.execute({ tenant: 'Nobody', message: 'hi there' }, LANDLORD_ACTOR)
      expect(res.ok).toBe(false)
      expect(mockCreateNotification).not.toHaveBeenCalled()
    })

    it('send_bulk_message previews the reach (no send) until confirmed, scoped to the landlord', async () => {
      ;(query as any).mockResolvedValueOnce([{ n: '3' }]) // COUNT
      const res: any = await sendBulkMessage.execute({ message: 'Water shutoff Tuesday' }, LANDLORD_ACTOR)
      expect(res.needsConfirmation).toBe(true)
      expect(res.recipientCount).toBe(3)
      // recipient query scoped to the landlord, COUNT only (no INSERT)
      expect((query as any).mock.calls[0][1][0]).toBe('L1')
      expect((query as any).mock.calls[0][0]).toMatch(/COUNT/i)
      expect((query as any).mock.calls[0][0]).not.toMatch(/INSERT/i)
    })

    it('send_bulk_message inserts one notification per tenant when confirmed', async () => {
      ;(query as any).mockResolvedValueOnce([{ id: 'a' }, { id: 'b' }, { id: 'c' }]) // INSERT ... RETURNING
      const res: any = await sendBulkMessage.execute({ message: 'Water shutoff Tuesday', confirmed: true }, LANDLORD_ACTOR)
      const sql = (query as any).mock.calls[0][0]
      expect(sql).toMatch(/INSERT INTO notifications/i)
      expect(sql).toMatch(/l\.landlord_id = \$1/) // recipients scoped to the landlord
      expect((query as any).mock.calls[0][1][0]).toBe('L1')
      expect(res.ok).toBe(true)
      expect(res.sent).toBe(3)
    })

    it('get_background_check_status scopes by landlord and exposes no SSN/DOB/PII', async () => {
      ;(query as any).mockResolvedValue([{ first_name: 'Sam', last_name: 'Lee', status: 'complete', result_url: 'https://portal/report/1', created_at: 'd' }])
      const res: any = await getBackgroundCheckStatus.execute({}, LANDLORD_ACTOR)
      const sql = (query as any).mock.calls[0][0]
      expect((query as any).mock.calls[0][1][0]).toBe('L1')
      expect(sql).not.toMatch(/ssn|date_of_birth|monthly_income|employer/i)
      expect(res.checks[0]).toMatchObject({ applicant: 'Sam Lee', status: 'complete', reportLink: 'https://portal/report/1' })
    })
  })
})

describe('maintenance assignment tools (landlord, team-scoped)', () => {
  beforeEach(() => { vi.clearAllMocks() })

  it('get_maintenance_team binds to the landlord id and shapes workers', async () => {
    ;(query as any).mockResolvedValueOnce([
      { user_id: 'w1', first_name: 'Mike', last_name: 'Diaz', job_categories: ['plumbing'], all_properties: false, property_count: 2 },
    ])
    const res: any = await getMaintenanceTeam.execute({}, LANDLORD_ACTOR)
    expect((query as any).mock.calls[0][1]).toEqual(['L1']) // scoped to actor.profileId
    expect(res.ok).toBe(true)
    expect(res.workers[0]).toMatchObject({ workerId: 'w1', name: 'Mike Diaz', coverage: '2 properties' })
  })

  it('assign_maintenance_request assigns by name: doubly scoped, open→assigned, notifies', async () => {
    mockQueryOne
      .mockResolvedValueOnce({ id: 'r1', landlord_id: 'L1', status: 'open', title: 'Leak', priority: 'high', tenant_id: null, unit_id: 'unit-1', description: 'd', category: 'plumbing' }) // request load
      .mockResolvedValueOnce({ status: 'assigned' }) // self-scoped UPDATE RETURNING
      .mockResolvedValueOnce({ unit_number: '12' }) // unit lookup
    ;(query as any)
      .mockResolvedValueOnce([{ user_id: 'w1', first_name: 'Mike', last_name: 'Diaz', email: 'mike@x.dev', phone: null }]) // team match by name
      .mockResolvedValueOnce(undefined) // comment insert

    const res: any = await assignMaintenanceRequest.execute({ requestId: 'r1', workerName: 'Mike' }, LANDLORD_ACTOR)

    expect(res).toMatchObject({ ok: true, assignedTo: 'Mike Diaz', newStatus: 'assigned' })
    expect(mockQueryOne.mock.calls[0][1]).toEqual(['r1', 'L1']) // request scoped to landlord
    expect((query as any).mock.calls[0][1][0]).toBe('L1') // worker resolution scoped to landlord
    expect(mockQueryOne.mock.calls[1][1]).toEqual(['w1', 'assigned', 'r1', 'L1']) // UPDATE scoped to worker+request+landlord
    expect(mockCreateNotification).toHaveBeenCalledTimes(1) // worker notified
  })

  it('assign_maintenance_request asks to disambiguate on multiple name matches (no write)', async () => {
    mockQueryOne.mockResolvedValueOnce({ id: 'r1', landlord_id: 'L1', status: 'open', title: 'Leak', priority: 'high', tenant_id: null, unit_id: 'u1' })
    ;(query as any).mockResolvedValueOnce([
      { user_id: 'w1', first_name: 'Mike', last_name: 'Diaz', email: 'a' },
      { user_id: 'w2', first_name: 'Mike', last_name: 'Ruiz', email: 'b' },
    ])
    const res: any = await assignMaintenanceRequest.execute({ requestId: 'r1', workerName: 'Mike' }, LANDLORD_ACTOR)
    expect(res.needsDisambiguation).toBe(true)
    expect(res.candidates).toHaveLength(2)
    expect(mockQueryOne).toHaveBeenCalledTimes(1) // never reaches the UPDATE
    expect(mockCreateNotification).not.toHaveBeenCalled()
  })

  it('assign_maintenance_request refuses a request the landlord does not own', async () => {
    mockQueryOne.mockResolvedValueOnce(null) // request not found for this landlord
    const res: any = await assignMaintenanceRequest.execute({ requestId: 'r9', workerName: 'Mike' }, LANDLORD_ACTOR)
    expect(res.ok).toBe(false)
    expect(query as any).not.toHaveBeenCalled() // never resolves a worker
  })

  it('assign_maintenance_request refuses a worker not on the landlord’s team', async () => {
    mockQueryOne.mockResolvedValueOnce({ id: 'r1', landlord_id: 'L1', status: 'open', title: 'Leak', priority: 'high', tenant_id: null, unit_id: 'u1' })
    ;(query as any).mockResolvedValueOnce([]) // no team match
    const res: any = await assignMaintenanceRequest.execute({ requestId: 'r1', workerName: 'Ghost' }, LANDLORD_ACTOR)
    expect(res.ok).toBe(false)
    expect(mockQueryOne).toHaveBeenCalledTimes(1) // never reaches the UPDATE
  })
})

describe('get_books_summary (landlord, ledger-scoped)', () => {
  beforeEach(() => { vi.clearAllMocks() })

  it('binds both income and expense queries to the landlord id and computes net', async () => {
    ;(query as any)
      .mockResolvedValueOnce([
        { code: '4010', name: 'Rental Income', period_amount: '5000' },
        { code: '4020', name: 'Late Fee Income', period_amount: '150' },
      ]) // income
      .mockResolvedValueOnce([
        { code: '5040', name: 'Repairs & Maintenance', period_amount: '1200' },
        { code: '5050', name: 'Utilities', period_amount: '300' },
      ]) // expenses
    const res: any = await getBooksSummary.execute({ period: 'last_month' }, LANDLORD_ACTOR)
    expect((query as any).mock.calls[0][1][0]).toBe('L1') // income scoped to landlord
    expect((query as any).mock.calls[1][1][0]).toBe('L1') // expenses scoped to landlord
    expect(res).toMatchObject({ totalIncome: 5150, totalExpenses: 1500, netIncome: 3650, period: 'last month' })
    expect(res.topExpenses[0]).toMatchObject({ category: 'Repairs & Maintenance', amount: 1200 })
  })

  it('reports cleanly when no bookkeeping accounts exist', async () => {
    ;(query as any).mockResolvedValueOnce([]).mockResolvedValueOnce([])
    const res: any = await getBooksSummary.execute({}, LANDLORD_ACTOR)
    expect(res.ok).toBe(true)
    expect(res.netIncome).toBe(0)
    expect(res.note).toMatch(/no bookkeeping accounts/i)
  })
})

describe('reject_maintenance_request (landlord action)', () => {
  beforeEach(() => { vi.clearAllMocks() })

  it('cancels the landlord’s own request (self-scoped) and notifies the tenant', async () => {
    mockQueryOne
      .mockResolvedValueOnce({ id: 'r1', landlord_id: 'L1', status: 'awaiting_approval', title: 'Leak', tenant_id: 't9', unit_id: 'u1' }) // load
      .mockResolvedValueOnce({ id: 'r1', status: 'cancelled' }) // self-scoped UPDATE
      .mockResolvedValueOnce({ id: 'tu', email: 'a@b.dev', phone: null }) // tenant lookup
      .mockResolvedValueOnce({ unit_number: '4' }) // unit
    ;(query as any).mockResolvedValueOnce(undefined) // comment insert
    const res: any = await rejectMaintenanceRequest.execute({ requestId: 'r1', reason: 'duplicate' }, LANDLORD_ACTOR)
    expect(res).toMatchObject({ ok: true, newStatus: 'cancelled' })
    expect(mockQueryOne.mock.calls[0][1]).toEqual(['r1', 'L1']) // load scoped to landlord
    expect(mockQueryOne.mock.calls[1][1]).toEqual(['r1', 'L1']) // UPDATE scoped to landlord
  })

  it('refuses a request the landlord does not own', async () => {
    mockQueryOne.mockResolvedValueOnce(null)
    const res: any = await rejectMaintenanceRequest.execute({ requestId: 'rX' }, LANDLORD_ACTOR)
    expect(res.ok).toBe(false)
  })

  it('refuses one already completed', async () => {
    mockQueryOne.mockResolvedValueOnce({ id: 'r1', landlord_id: 'L1', status: 'completed', title: 'X' })
    const res: any = await rejectMaintenanceRequest.execute({ requestId: 'r1' }, LANDLORD_ACTOR)
    expect(res.ok).toBe(false)
    expect(mockQueryOne).toHaveBeenCalledTimes(1) // never reaches the UPDATE
  })
})

describe('get_tenant_contact (landlord, lease-scoped)', () => {
  beforeEach(() => { vi.clearAllMocks() })

  it('binds the match to the landlord id and returns contact + units', async () => {
    ;(query as any)
      .mockResolvedValueOnce([{ tenant_id: 't9', first_name: 'Jane', last_name: 'Doe', email: 'jane@x.dev', phone: '555-1234' }]) // match
      .mockResolvedValueOnce([{ unit_number: '4', property_name: 'Maple Park', lease_status: 'active' }]) // units
    const res: any = await getTenantContact.execute({ tenant: 'Jane' }, LANDLORD_ACTOR)
    expect((query as any).mock.calls[0][1][0]).toBe('L1') // match scoped to landlord
    expect((query as any).mock.calls[1][1]).toEqual(['L1', 't9']) // units scoped to landlord + tenant
    expect(res.tenant).toMatchObject({ name: 'Jane Doe', phone: '555-1234' })
    expect(res.tenant.units[0]).toMatchObject({ unit: '4', property: 'Maple Park' })
  })

  it('asks to disambiguate on multiple matches (no second query)', async () => {
    ;(query as any).mockResolvedValueOnce([
      { tenant_id: 'a', first_name: 'Jane', last_name: 'Doe', email: 'jane@x.dev', phone: null },
      { tenant_id: 'b', first_name: 'Jane', last_name: 'Smith', email: 'jane@y.dev', phone: null },
    ])
    const res: any = await getTenantContact.execute({ tenant: 'Jane' }, LANDLORD_ACTOR)
    expect(res.needsDisambiguation).toBe(true)
    expect((query as any)).toHaveBeenCalledTimes(1) // never reaches the units query
  })
})

describe('tenant maintenance actions (scoped to the tenant)', () => {
  beforeEach(() => { vi.clearAllMocks() })

  it('add_maintenance_comment binds to the tenant’s own request and writes a tenant comment', async () => {
    mockQueryOne.mockResolvedValueOnce({ id: 'r1', title: 'Leak' }) // own-request check
    ;(query as any).mockResolvedValueOnce(undefined) // INSERT comment
    const res: any = await addMaintenanceComment.execute({ requestId: 'r1', message: 'getting worse' }, TENANT_ACTOR)
    expect(res.ok).toBe(true)
    expect(mockQueryOne.mock.calls[0][1]).toEqual(['r1', 't1']) // scoped to actor.profileId (tenant)
    const insertParams = (query as any).mock.calls[0][1]
    expect(insertParams).toEqual(['r1', 'u1', 'getting worse']) // role 'tenant' is literal in the SQL
  })

  it('add_maintenance_comment refuses a request the tenant does not own', async () => {
    mockQueryOne.mockResolvedValueOnce(null)
    const res: any = await addMaintenanceComment.execute({ requestId: 'rX', message: 'hi' }, TENANT_ACTOR)
    expect(res.ok).toBe(false)
    expect(query as any).not.toHaveBeenCalled()
  })

  it('cancel_maintenance_request cancels an open request (self-scoped)', async () => {
    mockQueryOne
      .mockResolvedValueOnce({ id: 'r1', title: 'Leak', status: 'open' }) // own-request check
      .mockResolvedValueOnce({ id: 'r1' }) // self-scoped UPDATE
    ;(query as any).mockResolvedValueOnce(undefined) // comment insert
    const res: any = await cancelMaintenanceRequest.execute({ requestId: 'r1' }, TENANT_ACTOR)
    expect(res).toMatchObject({ ok: true, newStatus: 'cancelled' })
    expect(mockQueryOne.mock.calls[0][1]).toEqual(['r1', 't1']) // load scoped to tenant
    expect(mockQueryOne.mock.calls[1][1]).toEqual(['r1', 't1', ['open', 'awaiting_approval']]) // UPDATE scoped + state-guarded
  })

  it('cancel_maintenance_request refuses once work is in progress', async () => {
    mockQueryOne.mockResolvedValueOnce({ id: 'r1', title: 'Leak', status: 'in_progress' })
    const res: any = await cancelMaintenanceRequest.execute({ requestId: 'r1' }, TENANT_ACTOR)
    expect(res.ok).toBe(false)
    expect(mockQueryOne).toHaveBeenCalledTimes(1) // never reaches the UPDATE
  })
})

describe('get_team (landlord, all-role roster)', () => {
  beforeEach(() => { vi.clearAllMocks() })

  it('binds members + invitations to the landlord id and labels roles/coverage', async () => {
    ;(query as any)
      .mockResolvedValueOnce([
        { role: 'maintenance', first_name: 'Mike', last_name: 'Diaz', all_properties: false, prop_count: 2 },
        { role: 'bookkeeper', first_name: 'Bea', last_name: 'Cook', all_properties: null, prop_count: null },
      ]) // members
      .mockResolvedValueOnce([{ email: 'new@x.dev', role: 'onsite_manager' }]) // invites
    const res: any = await getTeam.execute({}, LANDLORD_ACTOR)
    expect((query as any).mock.calls[0][1]).toEqual(['L1']) // members scoped to landlord
    expect((query as any).mock.calls[1][1]).toEqual(['L1']) // invites scoped to landlord
    expect(res.members).toEqual([
      { name: 'Mike Diaz', role: 'Maintenance', coverage: '2 properties' },
      { name: 'Bea Cook', role: 'Bookkeeper', coverage: 'books access' },
    ])
    expect(res.pendingInvites[0]).toMatchObject({ email: 'new@x.dev', role: 'On-site Manager' })
  })
})

describe('schedule_maintenance (landlord action)', () => {
  beforeEach(() => { vi.clearAllMocks() })

  it('sets scheduled_at on the landlord’s own request (self-scoped) and notifies the tenant', async () => {
    mockQueryOne
      .mockResolvedValueOnce({ id: 'r1', landlord_id: 'L1', status: 'assigned', title: 'Leak', tenant_id: 't9', unit_id: 'u1' }) // load
      .mockResolvedValueOnce({ id: 'r1', scheduled_at: '2026-06-13T09:00:00.000Z' }) // UPDATE
      .mockResolvedValueOnce({ id: 'tu', email: 'a@b.dev', phone: null }) // tenant lookup
      .mockResolvedValueOnce({ unit_number: '4' }) // unit
    ;(query as any).mockResolvedValueOnce(undefined) // comment insert
    const res: any = await scheduleMaintenance.execute({ requestId: 'r1', scheduledAt: '2026-06-13T09:00:00Z' }, LANDLORD_ACTOR)
    expect(res.ok).toBe(true)
    expect(mockQueryOne.mock.calls[0][1]).toEqual(['r1', 'L1']) // load scoped to landlord
    expect(mockQueryOne.mock.calls[1][1]).toEqual(['2026-06-13T09:00:00.000Z', 'r1', 'L1']) // UPDATE scoped to landlord
    expect(mockCreateNotification).not.toHaveBeenCalled() // schedule uses notifyMaintenanceUpdated, not createNotification
  })

  it('rejects an unparseable date before touching the DB', async () => {
    const res: any = await scheduleMaintenance.execute({ requestId: 'r1', scheduledAt: 'whenever' }, LANDLORD_ACTOR)
    expect(res.ok).toBe(false)
    expect(mockQueryOne).not.toHaveBeenCalled()
  })
})

describe('get_my_landlord_patterns (tenant transparency, scoped to own data)', () => {
  beforeEach(() => { vi.clearAllMocks() })

  it('summarizes the landlord’s entry pattern from the tenant’s OWN history (scoped, local time)', async () => {
    ;(query as any).mockResolvedValueOnce([
      { reason_category: 'inspection', local_hour: 13, notice_window_hours: 48, ymd: '2026-01-10', local_at: 'Jan 10, 2026 at 01:00pm' },
      { reason_category: 'inspection', local_hour: 14, notice_window_hours: 48, ymd: '2026-07-10', local_at: 'Jul 10, 2026 at 02:00pm' },
    ])
    const res: any = await getMyLandlordPatterns.execute({}, TENANT_ACTOR)
    expect((query as any).mock.calls[0][1]).toEqual(['t1']) // scoped to the tenant's own entries
    expect(res.basedOnEntries).toBe(2)
    const insp = res.patterns.find((p: any) => p.activity === 'Inspections')
    expect(insp).toMatchObject({ count: 2, usualTime: '1pm–2pm', usualNotice: 'about 2 days' })
    expect(insp.howOften).toMatch(/every 6 months/i)
    expect(res.flags).toBeUndefined() // 1pm/2pm are normal hours
  })

  it('flags an objectively odd-hour entry (e.g. a midnight inspection) factually', async () => {
    ;(query as any).mockResolvedValueOnce([
      { reason_category: 'inspection', local_hour: 0, notice_window_hours: 24, ymd: '2026-03-01', local_at: 'Mar 01, 2026 at 12:00am' },
    ])
    const res: any = await getMyLandlordPatterns.execute({}, TENANT_ACTOR)
    expect(res.flags).toHaveLength(1)
    expect(res.flags[0]).toMatch(/outside typical daytime hours/i)
    expect(res.flags[0]).toMatch(/reasonable times/i)
    // factual + points to local law, no legal conclusion
    expect(JSON.stringify(res)).not.toMatch(/illegal|violation|not allowed/i)
  })

  it('returns a clean note when there’s no entry history', async () => {
    ;(query as any).mockResolvedValueOnce([])
    const res: any = await getMyLandlordPatterns.execute({}, TENANT_ACTOR)
    expect(res.basedOnEntries).toBe(0)
    expect(res.note).toMatch(/no entries/i)
  })
})

describe('tenant contact + entry-notice (read, scoped + compliant)', () => {
  beforeEach(() => { vi.clearAllMocks() })

  it('get_my_contacts binds to the tenant’s active lease and returns landlord contact', async () => {
    ;(query as any).mockResolvedValueOnce([
      { property_name: 'Maple Park', unit_number: '4', business_name: 'Rhoades RE', first_name: 'Nic', last_name: 'R', email: 'n@x.dev', phone: '555-1', pm_company_id: null },
    ])
    const res: any = await getMyContacts.execute({}, TENANT_ACTOR)
    expect((query as any).mock.calls[0][1]).toEqual(['t1']) // scoped to actor.profileId (tenant)
    expect(res.contacts[0]).toMatchObject({ property: 'Maple Park', contactName: 'Nic R', businessName: 'Rhoades RE', email: 'n@x.dev', managedByCompany: false })
  })

  it('get_my_entry_requests surfaces per-request notice hours + the landlord policy + a neutral disclaimer', async () => {
    ;(query as any)
      .mockResolvedValueOnce([
        { reason: 'inspection', reason_category: 'inspection', status: 'pending', notice_given_at: 'd', notice_window_hours: 48, proposed_entry_window_start: 's', proposed_entry_window_end: 'e', entry_actual_at: null },
      ]) // requests
      .mockResolvedValueOnce([{ default_entry_notice_hours: 24 }]) // landlord policy
    const res: any = await getMyEntryRequests.execute({}, TENANT_ACTOR)
    expect((query as any).mock.calls[0][1][0]).toBe('t1') // requests scoped to tenant
    expect((query as any).mock.calls[1][1]).toEqual(['t1']) // policy scoped to tenant
    expect(res.entryRequests[0].noticeHours).toBe(48)
    expect(res.landlordNoticePolicyHours).toBe(24)
    // Compliant: no state-specific legal assertion — a neutral "check local laws" pointer.
    expect(res.noticeDisclaimer).toMatch(/check your local laws/i)
    expect(JSON.stringify(res)).not.toMatch(/required by law|legally required|statute|§/i)
  })
})

describe('get_applicable_laws (both audiences, sourced state-law KB)', () => {
  beforeEach(() => { vi.clearAllMocks() })

  it('tenant: resolves state + unit type from their own lease, returns acts + dated disclaimer', async () => {
    mockQueryOne.mockResolvedValueOnce({ state: 'AZ', unit_type: 'rv_spot' }) // lease resolve
    ;(query as any)
      .mockResolvedValueOnce([{ id: 'act1', state_code: 'AZ', act_name: 'AZ RV Long-Term Act', unit_types: ['rv_spot'], official_url: 'u', summary: 's', source_date: '2026-06-09', effective_year: 2026 }]) // getApplicableActs
      .mockResolvedValueOnce([]) // getProvisionsForActIds (none for rv yet)
    const res: any = await getApplicableLaws.execute({}, TENANT_ACTOR)
    expect(mockQueryOne.mock.calls[0][1]).toEqual(['t1']) // lease resolve scoped to tenant
    expect(res.state).toBe('AZ')
    expect(res.acts).toHaveLength(1)
    expect(res.disclaimer).toMatch(/not legal advice/i)
  })

  it('landlord: returns governing acts + key sections as pointers, with NO compliance judgment', async () => {
    ;(query as any)
      .mockResolvedValueOnce([{ id: 'act1', state_code: 'AZ', act_name: 'AZ Residential Act', unit_types: ['apartment'], official_url: 'u', summary: 's', source_date: '2026-06-09', effective_year: 2026 }]) // acts
      .mockResolvedValueOnce([{ topic: 'entry_notice_hours', summary: 'At least 48h notice', statute_citation: 'A.R.S. § 33-1343', source_url: 'u', source_date: '2026-06-09' }]) // provisions
    const res: any = await getApplicableLaws.execute({ state: 'AZ', unitType: 'apartment' }, LANDLORD_ACTOR)
    expect(res.acts).toHaveLength(1)
    expect(res.keySections[0]).toMatchObject({ citation: 'A.R.S. § 33-1343' })
    expect(res.warnings).toBeUndefined() // GAM makes no compliance call
    expect(res.note).toMatch(/compare/i)
    // No guidance language anywhere in the payload.
    expect(JSON.stringify(res)).not.toMatch(/may not comply|looks like it may|should|recommend/i)
  })

  it('returns a clean note for an unsourced state (no false alarm)', async () => {
    ;(query as any).mockResolvedValueOnce([]) // getApplicableActs → none for NV
    const res: any = await getApplicableLaws.execute({ state: 'NV', unitType: 'apartment' }, LANDLORD_ACTOR)
    expect(res.ok).toBe(true)
    expect(res.acts).toEqual([])
    expect(res.note).toMatch(/doesn’t have NV/i)
  })
})

describe('search_state_law (full-text statute search, both audiences)', () => {
  beforeEach(() => { vi.clearAllMocks() })

  it('tenant: resolves state from lease, returns the matching section verbatim + AZ citation + disclaimer', async () => {
    mockQueryOne.mockResolvedValueOnce({ state: 'AZ' }) // lease state
    ;(query as any).mockResolvedValueOnce([
      { act_key: 'residential', section_number: '33-1370', section_title: 'Abandonment', full_text: 'If the tenant abandons the dwelling unit...', source_url: 'https://www.azleg.gov/ars/33/01370.htm', source_date: '2026-06-09', rank: 0.6 },
    ])
    const res: any = await searchStateLaw.execute({ query: 'what happens to abandoned property' }, TENANT_ACTOR)
    expect(mockQueryOne.mock.calls[0][1]).toEqual(['t1']) // lease scoped to tenant
    expect((query as any).mock.calls[0][1]).toEqual(['AZ', 'what happens to abandoned property', 4]) // FTS scoped to state
    expect(res.results[0]).toMatchObject({ citation: 'A.R.S. § 33-1370', section: '33-1370' })
    expect(res.disclaimer).toMatch(/not legal advice/i)
  })

  it('landlord: searches the state they pass', async () => {
    ;(query as any).mockResolvedValueOnce([
      { act_key: 'residential', section_number: '33-1368', section_title: 'Noncompliance', full_text: 'text', source_url: 'u', source_date: '2026-06-09', rank: 0.4 },
    ])
    const res: any = await searchStateLaw.execute({ query: 'late fees', state: 'az' }, LANDLORD_ACTOR)
    expect((query as any).mock.calls[0][1][0]).toBe('AZ') // uppercased
    expect(res.results).toHaveLength(1)
  })

  it('returns a clean note when nothing matches', async () => {
    ;(query as any).mockResolvedValueOnce([])
    const res: any = await searchStateLaw.execute({ query: 'zzz', state: 'AZ' }, LANDLORD_ACTOR)
    expect(res.ok).toBe(true)
    expect(res.results).toEqual([])
    expect(res.note).toMatch(/couldn’t find/i)
  })
})

describe('check_against_law (objective numeric/timeline mismatch, both audiences)', () => {
  beforeEach(() => { vi.clearAllMocks() })

  it('landlord: flags a late fee above the statutory $5/day, factually + cited (not advice)', async () => {
    ;(query as any)
      .mockResolvedValueOnce([{ topic: 'late_fee', rule_kind: 'max', threshold_numeric: '5', threshold_unit: 'dollars per day', summary: 'cap', statute_citation: 'A.R.S. § 33-2105', source_url: 'u', source_date: '2026-06-09' }]) // getLatestProvision (tool)
      .mockResolvedValueOnce([{ topic: 'late_fee', rule_kind: 'max', threshold_numeric: '5', threshold_unit: 'dollars per day', summary: 'cap', statute_citation: 'A.R.S. § 33-2105', source_url: 'u', source_date: '2026-06-09' }]) // getLatestProvision (checkAgainstStatute)
    const res: any = await checkAgainstLaw.execute({ topic: 'late_fee', value: 100, state: 'AZ' }, LANDLORD_ACTOR)
    expect(res.mismatch).toBe(true)
    expect(res.message).toMatch(/above the 5 dollars per day/i)
    expect(res.message).toMatch(/not legal advice/i)
    expect(res.statute).toMatchObject({ citation: 'A.R.S. § 33-2105', figure: 5 })
  })

  it('tenant: resolves state from lease; value within the figure → no mismatch', async () => {
    mockQueryOne.mockResolvedValueOnce({ state: 'AZ' }) // lease state
    ;(query as any)
      .mockResolvedValueOnce([{ topic: 'deposit_max_months', rule_kind: 'max', threshold_numeric: '1.5', threshold_unit: 'months of rent', summary: 'cap', statute_citation: 'A.R.S. § 33-1321', source_url: 'u', source_date: '2026-06-09' }]) // getLatestProvision
      .mockResolvedValueOnce([{ topic: 'deposit_max_months', rule_kind: 'max', threshold_numeric: '1.5', threshold_unit: 'months of rent', summary: 'cap', statute_citation: 'A.R.S. § 33-1321', source_url: 'u', source_date: '2026-06-09' }]) // checkAgainstStatute
    const res: any = await checkAgainstLaw.execute({ topic: 'deposit_max_months', value: 1 }, TENANT_ACTOR)
    expect(mockQueryOne.mock.calls[0][1]).toEqual(['t1'])
    expect(res.mismatch).toBe(false)
    expect(res.message).toMatch(/within the 1.5/i)
  })

  it('clean note when the topic isn’t on file for the state', async () => {
    ;(query as any).mockResolvedValueOnce([]) // getLatestProvision → none
    const res: any = await checkAgainstLaw.execute({ topic: 'late_fee', value: 50, state: 'NV' }, LANDLORD_ACTOR)
    expect(res.ok).toBe(true)
    expect(res.matched).toBe(false)
    expect(res.note).toMatch(/doesn’t have/i)
  })
})
