/**
 * 10/31 (Nic) — "That last meter read, when I review it, it's only off by one,
 * and it has two options now: meter read rolled past, or meter was replaced or
 * reset. I thought we were detecting rounding errors."
 *
 * We were — in the billing arithmetic (READING_BARELY_MOVED_UNITS, 10/24: a read
 * within a unit or two of the one before is a rounding error or a face that is
 * not turning). The REVIEW WINDOW never knew. Reviewing Mountain View RV 37 at
 * 64062 against 64063, the only answers on offer were:
 *
 *   "Meter rolled past 99999 — bill the wrap-around usage"   → 99,999 kWh
 *   "Meter was replaced or reset — no charge this cycle"     → simply untrue
 *
 * A wrap is arithmetically impossible one unit below the last read, so it must
 * not be offered there, and there has to be an answer that is true.
 *
 * Source-level because the window is an inner component of a 3,600-line page and
 * exporting it to assert two radio buttons is a worse trade than reading the
 * source. Same approach as SchedulePage.noStack.test.tsx.
 */
import { describe, it, expect } from 'vitest'
import { readFileSync } from 'fs'
import { join } from 'path'
import { READING_BARELY_MOVED_UNITS } from '@gam/shared'

const SRC = readFileSync(join(__dirname, 'UtilityMetersPage.tsx'), 'utf8')

describe('the low-read review window', () => {
  it('offers the rounding-error answer, and only when the read is barely lower', () => {
    expect(SRC).toMatch(/const barelyMoved = reasonNeeded && lowBy != null/)
    expect(SRC).toMatch(/lowBy <= READING_BARELY_MOVED_UNITS/)
    expect(SRC).toMatch(/checked=\{reason==='rounding'\}/)
    // The branch is a ternary on barelyMoved, so the two cases are exclusive.
    expect(SRC).toMatch(/\{barelyMoved \? \(/)
  })

  it('does NOT offer the odometer wrap when the read is within the margin', () => {
    // The wrap option must sit in the ELSE arm of the barelyMoved ternary.
    const i = SRC.indexOf('{barelyMoved ? (')
    const wrap = SRC.indexOf("checked={reason==='rollover'}", i)
    const elseArm = SRC.indexOf(') : (', i)
    expect(i).toBeGreaterThan(-1)
    expect(elseArm).toBeGreaterThan(i)
    expect(wrap).toBeGreaterThan(elseArm)   // wrap is after the ') : (' — the else
  })

  it('takes the margin from @gam/shared, never a local literal', () => {
    expect(READING_BARELY_MOVED_UNITS).toBe(2)
    expect(SRC).toMatch(/READING_BARELY_MOVED_UNITS/)
    // No hand-rolled "within 2" arithmetic hiding beside it.
    expect(SRC).not.toMatch(/lowBy <= 2\b/)
  })

  it('still asks for a reason at all — a low read never resolves silently', () => {
    expect(SRC).toMatch(/enteredIsLow && reason == null/)
    expect(SRC).toMatch(/correctionIsLow && reason == null/)
  })
})
