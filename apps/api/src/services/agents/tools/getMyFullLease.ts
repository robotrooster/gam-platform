/**
 * Tool: get_my_full_lease (tenant). The WHOLE lease, assembled — terms, every
 * fee, rent components, pets, occupants, and whatever the PDF import captured
 * that has no column of its own. Hard-scoped to actor.profileId (tenant_id).
 *
 * S618 (Nic): "anything the tenant asks, the agent should be able to pull up
 * the full lease, read it, and answer any questions about the lease, whether
 * it's — hey, what's my pet deposit? Or, help me decipher, according to the
 * lease am I getting part of it back or any of it back?"
 *
 * get_my_lease answers the headline terms and get_my_lease_fees the fee rows.
 * Neither lets the agent reason ACROSS the document, which is what a question
 * like "according to my lease, do I get any of the deposit back" needs: the
 * deposit, the deductions the lease allows, the notice period, and the
 * termination terms all at once. This returns the lease as one object so that
 * kind of question has one lookup behind it.
 *
 * LEASE IS LAW. Every field is read from the signed lease. Nothing here is
 * computed, estimated or inferred — where the lease is silent, the field comes
 * back null and the agent must say the lease does not cover it rather than
 * reason about what is customary.
 *
 * `importedExtras` is the parser's leftovers: terms found in an uploaded PDF
 * that map to no column. It is the closest thing to reading the document's own
 * words, and it is the reason a custom clause can be quoted at all.
 *
 * Deliberately omits the FlexDeposit / interest / advance columns, exactly as
 * get_my_deposit does — those are legally sensitive and are not lease terms.
 */

import { LEASE_COLUMN_LABEL } from '@gam/shared'
import { query } from '../../../db'
import type { AgentTool, AgentActor } from './types'

interface LeaseRow {
  id: string
  status: string
  start_date: string | null
  end_date: string | null
  rent_amount: string | null
  rent_due_day: number | null
  lease_type: string | null
  notice_days_required: number | null
  auto_renew: boolean | null
  subleasing_allowed: boolean | null
  late_fee_enabled: boolean | null
  late_fee_grace_days: number | null
  late_fee_initial_amount: string | null
  late_fee_initial_type: string | null
  late_fee_accrual_amount: string | null
  late_fee_accrual_type: string | null
  late_fee_accrual_period: string | null
  late_fee_cap_amount: string | null
  late_fee_cap_type: string | null
  lease_source: string | null
  import_extra_data: unknown
  extraction_extras: unknown
  unit_number: string | null
  property_name: string | null
}

const TIMING_LABEL: Record<string, string> = {
  move_in: 'due at move-in',
  monthly_ongoing: 'charged every month',
  move_out: 'settled at move-out',
  other: 'one-off',
}

const num = (v: string | null | undefined) => (v != null ? Number(v) : null)

export const getMyFullLease: AgentTool = {
  name: 'get_my_full_lease',
  description:
    'Read the tenant’s ENTIRE active lease at once — rent and due day, start/end dates, the full ' +
    'late-fee terms, notice period, every fee and deposit on the lease, rent components, pets, ' +
    'other occupants, and any extra terms captured from the signed document. Use this for any ' +
    'question that needs more than one part of the lease together, or that asks what the lease ' +
    'itself says — "according to my lease, do I get my deposit back?", "what am I actually paying ' +
    'for each month?", "what does my lease say about pets?". Read-only.',
  parameters: { type: 'object', properties: {} },
  audiences: ['tenant'],
  async execute(_args, actor: AgentActor) {
    const [lease] = await query<LeaseRow>(
      `SELECT l.id, l.status, l.start_date, l.end_date, l.rent_amount, l.rent_due_day,
              l.lease_type, l.notice_days_required, l.auto_renew, l.subleasing_allowed,
              l.late_fee_enabled, l.late_fee_grace_days,
              l.late_fee_initial_amount, l.late_fee_initial_type,
              l.late_fee_accrual_amount, l.late_fee_accrual_type, l.late_fee_accrual_period,
              l.late_fee_cap_amount, l.late_fee_cap_type,
              l.lease_source, l.import_extra_data, l.extraction_extras,
              u.unit_number, p.name AS property_name
         FROM leases l
         JOIN lease_tenants lt ON lt.lease_id = l.id AND lt.status = 'active'
         JOIN units u          ON u.id = l.unit_id
         JOIN properties p     ON p.id = u.property_id
        WHERE lt.tenant_id = $1 AND l.status = 'active'
        ORDER BY l.start_date DESC
        LIMIT 1`,
      [actor.profileId]
    )

    if (!lease) {
      return {
        ok: true,
        hasLease: false,
        note: 'No active lease is on record for this tenant. Do not describe lease terms.',
      }
    }

    const [fees, components, pets, occupants] = await Promise.all([
      query<any>(
        `SELECT fee_type, amount, is_refundable, due_timing, description
           FROM lease_fees WHERE lease_id = $1 ORDER BY fee_type`, [lease.id]),
      query<any>(
        `SELECT kind, label, amount FROM lease_rent_components
          WHERE lease_id = $1 ORDER BY sort_order`, [lease.id]),
      query<any>(
        `SELECT name, species, breed, weight_lbs, is_service_animal, is_emotional_support
           FROM lease_pets WHERE lease_id = $1 ORDER BY name`, [lease.id]),
      query<any>(
        `SELECT full_name, relationship_to_primary_tenant, is_minor
           FROM lease_occupants WHERE lease_id = $1 ORDER BY full_name`, [lease.id]),
    ])

    return {
      ok: true,
      hasLease: true,
      lease: {
        property: lease.property_name,
        unit: lease.unit_number,
        startDate: lease.start_date,
        endDate: lease.end_date,
        // A month-to-month lease has no end date. That is a real answer, not a
        // gap — say it rolls month to month rather than inventing a date.
        isMonthToMonth: !lease.end_date,
        rent: num(lease.rent_amount),
        rentDueDay: lease.rent_due_day,
        noticeDaysRequired: lease.notice_days_required,
        autoRenew: lease.auto_renew,
        subleasingAllowed: lease.subleasing_allowed,
      },
      // Nic: late fees are "per property and per state and landlord" — the
      // whole schedule, not just the grace period.
      lateFees: lease.late_fee_enabled === false ? { enabled: false } : {
        enabled: lease.late_fee_enabled,
        graceDays: lease.late_fee_grace_days,
        initialAmount: num(lease.late_fee_initial_amount),
        initialType: lease.late_fee_initial_type,
        accrualAmount: num(lease.late_fee_accrual_amount),
        accrualType: lease.late_fee_accrual_type,
        accrualPeriod: lease.late_fee_accrual_period,
        capAmount: num(lease.late_fee_cap_amount),
        capType: lease.late_fee_cap_type,
      },
      fees: fees.map((f) => ({
        fee: LEASE_COLUMN_LABEL[f.fee_type as keyof typeof LEASE_COLUMN_LABEL] ?? f.fee_type,
        amount: num(f.amount),
        refundable: f.is_refundable,
        when: f.due_timing ? (TIMING_LABEL[f.due_timing] ?? f.due_timing) : null,
        note: f.description,
      })),
      rentComponents: components.map((c) => ({
        part: c.label ?? c.kind, amount: num(c.amount),
      })),
      pets: pets.map((p) => ({
        name: p.name, species: p.species, breed: p.breed,
        weightLbs: p.weight_lbs,
        serviceAnimal: p.is_service_animal, emotionalSupport: p.is_emotional_support,
      })),
      otherOccupants: occupants.map((o) => ({
        name: o.full_name, relationship: o.relationship_to_primary_tenant, isMinor: o.is_minor,
      })),
      // Terms the import captured that have no column of their own — the
      // closest thing to the document's own wording.
      importedExtras: lease.import_extra_data ?? lease.extraction_extras ?? null,
      note:
        'These are the terms of the signed lease. Answer only from what is here — where a field is ' +
        'null the lease does not state it, and the honest answer is that the lease does not cover ' +
        'it. Never estimate a fee or a date that is not present.',
    }
  },
}
