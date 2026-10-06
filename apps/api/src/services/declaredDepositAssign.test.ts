/**
 * 10/6 (Nic) — the one matcher between tenants' bank-deposit reports and the
 * bank's lines (pure; services/declaredDepositAssign).
 *
 * "for people that pay the exact same amount, the probability that they're
 * going to be in the bank at exactly the same time also kind of shrinks. And
 * even if they're there within the same five minutes of each other ... it
 * doesn't matter if one person's cash and the other person's cash get swapped
 * when it's at the same time. They're either both going to be late or they're
 * both going to be on time."
 */
import { describe, it, expect } from 'vitest'
import { assignReportsToLines, type ReportToAssign, type LineToAssign } from './declaredDepositAssign'

let seq = 0
const report = (o: Partial<ReportToAssign> & { id: string }): ReportToAssign => ({
  leaseId: `lease-${o.id}`, tenantId: `t-${o.id}`, amount: 450, declaredDate: '2026-10-02',
  hour: null, afterHours: false, method: 'cash',
  createdAt: `2026-10-02T20:00:${String(seq++ % 60).padStart(2, '0')}.000000Z`, ...o,
})
const line = (o: Partial<LineToAssign> & { id: string }): LineToAssign => ({
  amount: 450, postedDate: '2026-10-02', description: 'DEPOSIT *4662', ...o,
})
/** Mountain View's bank writes the deposit's own date and time. */
const branch = (mmddyy: string, time: string) =>
  `eDeposit in Branch ${mmddyy} ${time} 360 W CONTINENTAL RD GREEN VALLEY AZ`

const lineOf = (a: ReturnType<typeof assignReportsToLines>, reportId: string) => {
  const v = a.reports.get(reportId)
  return v && 'lineId' in v ? v.lineId : null
}
const conflictOf = (a: ReturnType<typeof assignReportsToLines>, lineId: string) => {
  const v = a.lines.get(lineId)
  return v?.kind === 'conflict' ? v.conflict : null
}

describe('one report, one deposit', () => {
  it('a single report matches the single deposit of its amount', () => {
    const a = assignReportsToLines([report({ id: 'A', hour: 15 })], [line({ id: 'L1' })])
    expect(lineOf(a, 'A')).toBe('L1')
    expect(a.lines.get('L1')).toEqual({ kind: 'assigned', reportId: 'A' })
  })

  it('never a deposit of another amount', () => {
    const a = assignReportsToLines([report({ id: 'A', amount: 450 })], [line({ id: 'L1', amount: 451 })])
    expect(a.reports.size).toBe(0)
    expect(a.lines.size).toBe(0)
  })

  it('the false-date rule still applies: a deposit posted later than the next business day is still theirs', () => {
    // Reported Thu Oct 1; the bank posted it Tue Oct 6 — the existing false-date
    // path (the bank's date decides, the report is flagged when recorded).
    const a = assignReportsToLines(
      [report({ id: 'A', declaredDate: '2026-10-01', hour: 10 })],
      [line({ id: 'L1', postedDate: '2026-10-06' })])
    expect(lineOf(a, 'A')).toBe('L1')
  })

  it('prefers the deposit made that day over a later one', () => {
    const a = assignReportsToLines(
      [report({ id: 'A', declaredDate: '2026-10-01' })],
      [line({ id: 'Llate', postedDate: '2026-10-05' }), line({ id: 'Lday', postedDate: '2026-10-01' })])
    expect(lineOf(a, 'A')).toBe('Lday')
  })
})

describe('same amount, same day — the outcome is the same, so report order decides', () => {
  it('two reports and two deposits with no time on the lines: earliest report takes the earliest deposit', () => {
    const first = report({ id: 'first', hour: 15, createdAt: '2026-10-02T21:00:00.000000Z' })
    const second = report({ id: 'second', hour: 15, createdAt: '2026-10-02T22:00:00.000000Z' })
    // Given out of order on purpose.
    const a = assignReportsToLines([second, first], [line({ id: 'L-b' }), line({ id: 'L-a' })])
    expect(lineOf(a, 'first')).toBe('L-a')
    expect(lineOf(a, 'second')).toBe('L-b')
    expect([...a.lines.values()].every(v => v.kind === 'assigned')).toBe(true)
  })

  it('same-day deposits posted a day apart, both honest: still report order, nobody is late either way', () => {
    // Reported Fri Oct 2; one posted Oct 2, the other Mon Oct 5 (next business
    // day). Both reports count from Oct 2 whichever line they get.
    const r1 = report({ id: 'r1', createdAt: '2026-10-02T21:00:00.000000Z' })
    const r2 = report({ id: 'r2', createdAt: '2026-10-02T21:05:00.000000Z' })
    const a = assignReportsToLines([r1, r2],
      [line({ id: 'Lmon', postedDate: '2026-10-05' }), line({ id: 'Lfri', postedDate: '2026-10-02' })])
    expect(lineOf(a, 'r1')).toBe('Lfri')
    expect(lineOf(a, 'r2')).toBe('Lmon')
  })

  it('within the same few minutes at the same hour: earliest report, earliest deposit', () => {
    const r1 = report({ id: 'r1', hour: 15, createdAt: '2026-10-02T21:00:00.000000Z' })
    const r2 = report({ id: 'r2', hour: 15, createdAt: '2026-10-02T21:01:00.000000Z' })
    const a = assignReportsToLines([r2, r1], [
      line({ id: 'L340', description: branch('10/02/26', '03:40:11 PM') }),
      line({ id: 'L310', description: branch('10/02/26', '03:10:05 PM') }),
    ])
    expect(lineOf(a, 'r1')).toBe('L310')
    expect(lineOf(a, 'r2')).toBe('L340')
  })
})

describe('a time on the bank line picks the nearest hour', () => {
  it('matches each report to the deposit nearest the hour it gave, whatever order they reported in', () => {
    // The 4 PM depositor reported first; the 9 AM one second.
    const four = report({ id: 'four', hour: 16, createdAt: '2026-10-02T21:00:00.000000Z' })
    const nine = report({ id: 'nine', hour: 9, createdAt: '2026-10-02T22:00:00.000000Z' })
    const a = assignReportsToLines([four, nine], [
      line({ id: 'Lmorning', description: branch('10/02/26', '09:12:40 AM') }),
      line({ id: 'Lafternoon', description: branch('10/02/26', '04:20:03 PM') }),
    ])
    expect(lineOf(a, 'four')).toBe('Lafternoon')
    expect(lineOf(a, 'nine')).toBe('Lmorning')
  })

  it('the bank line’s own date counts as the deposit’s day even when it posts the next day', () => {
    // Deposited Sep 30 at 4:39 PM, posted Oct 1; another $450 deposited Oct 1 at 10 AM.
    const sep30 = report({ id: 'sep30', declaredDate: '2026-09-30', hour: 16, createdAt: '2026-10-01T23:00:00.000000Z' })
    const oct1 = report({ id: 'oct1', declaredDate: '2026-10-01', hour: 10, createdAt: '2026-10-01T22:00:00.000000Z' })
    const a = assignReportsToLines([sep30, oct1], [
      line({ id: 'Lsep30', postedDate: '2026-10-01', description: branch('09/30/26', '04:39:28 PM') }),
      line({ id: 'Loct1', postedDate: '2026-10-01', description: branch('10/01/26', '10:05:00 AM') }),
    ])
    expect(lineOf(a, 'sep30')).toBe('Lsep30')
    expect(lineOf(a, 'oct1')).toBe('Loct1')
  })

  it('two reports, one deposit: the nearer hour takes it, the other waits for its own', () => {
    const three = report({ id: 'three', hour: 15 })
    const five = report({ id: 'five', hour: 17 })
    const a = assignReportsToLines([five, three], [line({ id: 'L', description: branch('10/02/26', '03:05:00 PM') })])
    expect(lineOf(a, 'three')).toBe('L')
    expect(a.reports.has('five')).toBe(false)
  })

  it('10/6 review: the pick is the whole hour — a 3:45 deposit is the 3 PM report’s, not the 4 PM one’s', () => {
    const three = report({ id: 'three', hour: 15, createdAt: '2026-10-02T22:00:00.000000Z' })
    const four = report({ id: 'four', hour: 16, createdAt: '2026-10-02T21:00:00.000000Z' })
    const a = assignReportsToLines([four, three], [line({ id: 'L345', description: branch('10/02/26', '03:45:10 PM') })])
    expect(lineOf(a, 'three')).toBe('L345')
    expect(a.reports.has('four')).toBe(false)
  })

  it('10/6 review: a time that fits neither report decides nothing — the landlord picks', () => {
    // Stamped 9 AM; one tenant said 3 PM, the other 4 PM.
    const a = assignReportsToLines(
      [report({ id: 'three', hour: 15 }), report({ id: 'four', hour: 16 })],
      [line({ id: 'L9', description: branch('10/02/26', '09:00:00 AM') })])
    const c = conflictOf(a, 'L9')
    expect(c?.kind).toBe('fewer_deposits')
    expect(c?.reportIds.sort()).toEqual(['four', 'three'])
  })

  it('a time that fits one report beats one that is known to be off for the other', () => {
    // 5:30 PM: inside an hour of the 4 PM pick, an hour and a half past the 3 PM one.
    const a = assignReportsToLines(
      [report({ id: 'three', hour: 15 }), report({ id: 'four', hour: 16 })],
      [line({ id: 'L', description: branch('10/02/26', '05:30:00 PM') })])
    expect(lineOf(a, 'four')).toBe('L')
    expect(a.reports.has('three')).toBe(false)
  })

  it('after hours / ATM fits a deposit made at night', () => {
    const night = report({ id: 'night', afterHours: true, hour: null })
    const noon = report({ id: 'noon', hour: 12 })
    const a = assignReportsToLines([noon, night], [
      line({ id: 'L2140', description: branch('10/02/26', '09:40:00 PM') }),
      line({ id: 'L1210', description: branch('10/02/26', '12:10:00 PM') }),
    ])
    expect(lineOf(a, 'night')).toBe('L2140')
    expect(lineOf(a, 'noon')).toBe('L1210')
  })
})

describe('a real conflict goes to the landlord', () => {
  it('two reports claiming one deposit with nothing to tell them apart', () => {
    const a = assignReportsToLines(
      [report({ id: 'A', hour: 15 }), report({ id: 'B', hour: 15 })],
      [line({ id: 'L' })])
    const c = conflictOf(a, 'L')
    expect(c?.kind).toBe('fewer_deposits')
    expect(c?.reportIds.sort()).toEqual(['A', 'B'])
    expect(c?.text).toMatch(/^Two residents reported \$450\.00 on Oct 2 — pick which deposit is whose\./)
    expect(a.reports.get('A')).toEqual({ conflict: c })
  })

  it('same amount on DIFFERENT days where who gets which decides who paid late', () => {
    // Both said Thu Oct 1. One deposit posted Oct 1 (on time), the other Oct 7
    // (later than the next business day — whoever gets it counts from Oct 7).
    const a = assignReportsToLines(
      [report({ id: 'A', declaredDate: '2026-10-01' }), report({ id: 'B', declaredDate: '2026-10-01' })],
      [line({ id: 'Lon', postedDate: '2026-10-01' }), line({ id: 'Llate', postedDate: '2026-10-07' })])
    const c = conflictOf(a, 'Lon')
    expect(c?.kind).toBe('who_is_late')
    expect(conflictOf(a, 'Llate')).toEqual(c)
    expect(c?.text).toContain('Two residents reported $450.00 on Oct 1 — pick which deposit is whose.')
    expect(c?.text).toContain('decides who paid late')
  })

  it('an hour picked does not decide who paid late against a line with no time', () => {
    // Lon carries 3:10 PM; Llate (a week later) carries no time at all.
    const a = assignReportsToLines(
      [report({ id: 'A', declaredDate: '2026-10-01', hour: 15 }), report({ id: 'B', declaredDate: '2026-10-01', hour: 16 })],
      [line({ id: 'Lon', postedDate: '2026-10-01', description: branch('10/01/26', '03:10:00 PM') }),
       line({ id: 'Llate', postedDate: '2026-10-07', description: 'DEPOSIT *4662' })])
    expect(conflictOf(a, 'Lon')?.kind).toBe('who_is_late')
  })

  it('10/6 spec: the bank’s times never decide who paid late — deposits on different days go to the landlord', () => {
    // Both said Thu Oct 1. Lon posted Oct 1 at 3:05 PM; Llate posted Oct 7, but
    // the bank wrote Oct 1, 4:10 PM on it. The times line up with each tenant's
    // hour, yet whoever gets Llate counts from Oct 7 and is flagged.
    const a = assignReportsToLines(
      [report({ id: 'A', declaredDate: '2026-10-01', hour: 15 }), report({ id: 'B', declaredDate: '2026-10-01', hour: 16 })],
      [line({ id: 'Lon', postedDate: '2026-10-01', description: branch('10/01/26', '03:05:00 PM') }),
       line({ id: 'Llate', postedDate: '2026-10-07', description: branch('10/01/26', '04:10:00 PM') })])
    expect(conflictOf(a, 'Lon')?.kind).toBe('who_is_late')
    expect(conflictOf(a, 'Llate')?.kind).toBe('who_is_late')
  })

  it('one resident, two deposits that could be theirs on different days: worded for one resident', () => {
    // Said Wed Oct 7. One $450 posted Mon Oct 5, one Fri Oct 9 (two days late, flagged).
    const a = assignReportsToLines(
      [report({ id: 'A', declaredDate: '2026-10-07', hour: 10 })],
      [line({ id: 'Lmon', postedDate: '2026-10-05' }), line({ id: 'Lfri', postedDate: '2026-10-09' })])
    const c = conflictOf(a, 'Lmon')
    expect(c?.kind).toBe('who_is_late')
    expect(c?.text).toBe('A resident reported $450.00 on Oct 7, and two $450.00 deposits could be theirs — '
      + 'the one you pick decides whether it counts on time.')
  })

  it('one household reporting twice counts as one resident', () => {
    const a = assignReportsToLines(
      [report({ id: 'A1', tenantId: 't-same', hour: 15 }), report({ id: 'A2', tenantId: 't-same', hour: 15 })],
      [line({ id: 'L' })])
    expect(conflictOf(a, 'L')?.text).toBe('One resident reported $450.00 two times on Oct 2, and only one $450.00 '
      + 'deposit has shown up at the bank so far — pick which report it is for.')
  })

  it('one deposit equal to what two residents reported together', () => {
    const a = assignReportsToLines(
      [report({ id: 'A', amount: 450 }), report({ id: 'B', amount: 450 })],
      [line({ id: 'L900', amount: 900 })])
    const c = conflictOf(a, 'L900')
    expect(c?.kind).toBe('combined')
    expect(c?.reportIds.sort()).toEqual(['A', 'B'])
    expect(c?.text).toBe('This $900.00 deposit equals what two residents reported together '
      + '($450.00 each, on Oct 2). GAM can\'t split one deposit between residents — record each resident\'s part from the payments screen.')
  })

  it('a combined deposit is not matched to a single report of the whole amount either', () => {
    const a = assignReportsToLines(
      [report({ id: 'whole', amount: 900 }), report({ id: 'A', amount: 450 }), report({ id: 'B', amount: 450 })],
      [line({ id: 'L900', amount: 900 })])
    const c = conflictOf(a, 'L900')
    expect(c?.kind).toBe('combined')
    expect(c?.reportIds).toContain('whole')
    expect(a.reports.get('whole')).toEqual({ conflict: c })
  })

  it('reports each paired with a deposit of their own never make a combined one', () => {
    const a = assignReportsToLines(
      [report({ id: 'whole', amount: 900 }), report({ id: 'A', amount: 450 }), report({ id: 'B', amount: 450 })],
      [line({ id: 'L900', amount: 900 }), line({ id: 'La', amount: 450 }), line({ id: 'Lb', amount: 450 })])
    expect(lineOf(a, 'whole')).toBe('L900')
    expect(lineOf(a, 'A')).not.toBeNull()
    expect(lineOf(a, 'B')).not.toBeNull()
  })

  it('resolves itself once the second deposit posts and both are on time either way', () => {
    const A = report({ id: 'A', hour: 15 }), B = report({ id: 'B', hour: 15 })
    expect(conflictOf(assignReportsToLines([A, B], [line({ id: 'L1' })]), 'L1')).not.toBeNull()
    const later = assignReportsToLines([A, B], [line({ id: 'L1' }), line({ id: 'L2', postedDate: '2026-10-05' })])
    expect(lineOf(later, 'A')).toBe('L1')
    expect(lineOf(later, 'B')).toBe('L2')
  })
})

describe('Undo means "not this line"', () => {
  it('a report the landlord un-tied from a line is never paired with it again', () => {
    const a = assignReportsToLines([report({ id: 'A', hour: 15 })],
      [line({ id: 'Lundone', untiedReportIds: ['A'] })])
    expect(a.reports.size).toBe(0)
    expect(a.lines.size).toBe(0)
  })

  it('it pairs with its real deposit instead, even one that ranks lower', () => {
    const a = assignReportsToLines([report({ id: 'A', hour: 15 })], [
      line({ id: 'Lundone', untiedReportIds: ['A'] }),
      line({ id: 'Lreal', postedDate: '2026-10-05' }),
    ])
    expect(lineOf(a, 'A')).toBe('Lreal')
  })

  it('nor counts toward a combined deposit on that line', () => {
    const a = assignReportsToLines(
      [report({ id: 'A' }), report({ id: 'B' })],
      [line({ id: 'L900', amount: 900, untiedReportIds: ['A'] })])
    expect(a.lines.size).toBe(0)
  })
})
