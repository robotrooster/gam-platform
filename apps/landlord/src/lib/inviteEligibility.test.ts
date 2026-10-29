/**
 * Which units an invite may offer, and which may be TAKEN OVER (Nic, 10/26):
 * "that unit list only populates with vacancies. It doesn't populate with the
 * ability to click on one that's occupied and then initiate that takeover
 * process."
 *
 * The rule that must survive both: one space is never promised to two
 * households. That is what S613 hid occupied units for, and it applies to a
 * takeover just as hard — one layer up.
 */
import { describe, it, expect } from 'vitest'
import { canInviteToUnit, canTakeOverUnit, hiddenUnitReasons } from './inviteEligibility'

const vacant = { tenantId: null, status: 'available', pendingInviteCount: 0 }
const occupied = { tenantId: 't1', status: 'occupied', pendingInviteCount: 0 }
const invited = { tenantId: null, status: 'available', pendingInviteCount: 1 }
const ownerUse = { tenantId: null, status: 'owner_use', pendingInviteCount: 0 }
const occupiedAndPromised = { tenantId: 't1', status: 'occupied', pendingInviteCount: 1 }

describe('an ordinary invite', () => {
  it('offers a vacancy and nothing else', () => {
    expect(canInviteToUnit(vacant)).toBe(true)
    expect(canInviteToUnit(occupied)).toBe(false)
    expect(canInviteToUnit(invited)).toBe(false)
    expect(canInviteToUnit(ownerUse)).toBe(false)
  })
})

describe('a takeover', () => {
  it('offers an occupied spot — the thing that was missing', () => {
    expect(canTakeOverUnit(occupied)).toBe(true)
  })

  it('never offers a vacancy: there is nobody to take over from', () => {
    expect(canTakeOverUnit(vacant)).toBe(false)
  })

  it('never offers a spot already promised to an incoming lease', () => {
    // Otherwise two replacements are promised the same spot — the S613 bug,
    // one layer up. Blu sent thirty invites in a sitting; this is how that goes
    // wrong quietly.
    expect(canTakeOverUnit(occupiedAndPromised)).toBe(false)
  })

  it('never offers an owner-occupied unit: no tenancy to take over', () => {
    expect(canTakeOverUnit(ownerUse)).toBe(false)
    expect(canTakeOverUnit({ tenantId: 't1', status: 'owner_use', pendingInviteCount: 0 })).toBe(false)
  })

  it('and the two doors never offer the same unit', () => {
    for (const u of [vacant, occupied, invited, ownerUse, occupiedAndPromised]) {
      expect(canInviteToUnit(u) && canTakeOverUnit(u), JSON.stringify(u)).toBe(false)
    }
  })
})

describe('what the line underneath says is missing', () => {
  it('stops calling an occupied spot missing once it can be taken over', () => {
    expect(hiddenUnitReasons([vacant, occupied])).toEqual([])
  })

  it('still counts a spot whose takeover is already promised', () => {
    expect(hiddenUnitReasons([occupiedAndPromised])).toEqual(['1 occupied'])
  })

  it('still counts invited and owner-occupied units', () => {
    expect(hiddenUnitReasons([invited, ownerUse])).toEqual(['1 already invited', '1 owner-occupied'])
  })
})
