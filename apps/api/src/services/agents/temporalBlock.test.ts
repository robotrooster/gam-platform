/**
 * S626 — the agents did not know what day it was.
 *
 * Nothing in the system had ever told them: not the system prompt, not the
 * context block, not a tool result. So every agent reasoned about dates from
 * its training prior, and on the booking site that meant proposing "September
 * 2024" to a customer in 2026, then "September 2025" when corrected — asking
 * which month twice while cycling through guessed years.
 */
import { describe, it, expect } from 'vitest'
import { DateTime } from 'luxon'
import { buildTemporalBlock } from './agentRunner'

const AUG_2026 = DateTime.fromISO('2026-08-27T09:00:00', { zone: 'America/Phoenix' })

describe('buildTemporalBlock', () => {
  const block = buildTemporalBlock(AUG_2026)

  it('states the full date, so a relative question has an anchor', () => {
    expect(block).toContain('Thursday, 27 August 2026')
  })

  it('states the YEAR on its own — the thing that was actually being invented', () => {
    expect(block).toContain('The current year is 2026')
  })

  it('names the zone, so "today" is not ambiguous near midnight', () => {
    expect(block).toContain('America/Phoenix')
  })

  it('gives the bare-day-number rule, which is where this first showed up', () => {
    expect(block.toLowerCase()).toContain('never a past date')
  })

  it('stays short — prompt length costs tool selection and this is on every turn', () => {
    expect(block.split('\n')).toHaveLength(3)
    expect(block.length).toBeLessThan(420)
  })

  it('follows whatever zone it is handed', () => {
    const nc = buildTemporalBlock(AUG_2026.setZone('America/New_York'))
    expect(nc).toContain('America/New_York')
  })

  it('rolls the year over correctly at the end of December', () => {
    const nye = DateTime.fromISO('2026-12-31T23:00:00', { zone: 'America/Phoenix' })
    expect(buildTemporalBlock(nye)).toContain('The current year is 2026')
    expect(buildTemporalBlock(nye.plus({ hours: 2 }))).toContain('The current year is 2027')
  })
})
