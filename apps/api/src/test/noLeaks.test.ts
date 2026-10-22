/**
 * The rule that replaced the gamble, proved — including proved AGAINST the
 * thing that made it a gamble: ten thousand random ids, same verdict every one.
 */
import { randomUUID } from 'crypto'
import { describe, it, expect } from 'vitest'
import { figureLeaks, expectNoFigures, expectNoFiguresInText } from './noLeaks'

describe('a figure has leaked when somebody could read it', () => {
  it('a number equal to it, anywhere in the payload', () => {
    expect(figureLeaks({ rows: [{ amount: 700 }] }, [700]).map(l => l.at)).toEqual(['rows.0.amount'])
  })

  it('a string equal to it, however it was printed', () => {
    for (const v of ['700', '700.00', '$700.00', '$700']) {
      expect(figureLeaks({ total: v }, [700]), v).toHaveLength(1)
    }
  })

  it('said out loud inside a sentence somebody reads', () => {
    expect(figureLeaks({ note: 'You still owe $700 for August.' }, [700])).toHaveLength(1)
    expect(figureLeaks({ when: 'August of 2024' }, [2024])).toHaveLength(1)
  })

  it('a needle with a leading zero is an identifier, not an amount', () => {
    // "0199" is a bank's last four. Read as 199 it would call a $199 charge
    // somewhere else in the payload a leak.
    expect(figureLeaks({ charge: 199 }, ['0199'])).toEqual([])
    expect(figureLeaks({ last4: '0199' }, ['0199'])).toHaveLength(1)
    expect(figureLeaks({ note: 'Account ending 0199 was debited.' }, ['0199'])).toHaveLength(1)
  })

  it('but not a different figure that merely starts or ends the same', () => {
    expect(figureLeaks({ amount: 1700 }, [700])).toEqual([])
    expect(figureLeaks({ note: 'Invoice 7001 is open.' }, [700])).toEqual([])
    expect(figureLeaks({ amount: 70 }, [700])).toEqual([])
  })
})

describe('and a generated id is never a leak — this is the part that was a coin flip', () => {
  // The exact row that failed the 10/22 deploy gate.
  const firstDoor = (id: string) => ({ owingId: id, when: 'August of 2024', where: 'Las Vegas, NV' })

  it('the id that broke it reads clean', () => {
    expect(figureLeaks(firstDoor('a9ed3b20-9979-48c1-8336-49b521f3a147'), ['14', 1430.55])).toEqual([])
  })

  it('and so do ten thousand more, which is the whole point', () => {
    // The old assertion failed on roughly one of every six of these. If this
    // rule depended on luck, this test could not exist.
    const leaky: string[] = []
    for (let i = 0; i < 10_000; i++) {
      const id = randomUUID()
      if (figureLeaks(firstDoor(id), ['14', '1430', 1430.55]).length) leaky.push(id)
    }
    expect(leaky).toEqual([])
  })

  it('the day itself still cannot get out', () => {
    expect(figureLeaks({ owingId: randomUUID(), when: 'August 14, 2024' }, ['14'])).toHaveLength(1)
    expect(figureLeaks({ owingId: randomUUID(), when: '2024-08-14' }, ['14'])).toHaveLength(1)
  })

  it('a Stripe id or a test email is a token, not a sentence', () => {
    const payload = { id: 'cs_test_k3h1100xq', email: 'razo-1100abc@example.com' }
    expect(figureLeaks(payload, ['1100'])).toEqual([])
    // Said in prose, it leaks.
    expect(figureLeaks({ ...payload, note: 'Their read was 1100.' }, ['1100'])).toHaveLength(1)
  })
})

describe('a body that is not JSON', () => {
  it('has its ids taken out before anything is searched', () => {
    const csv = `id,town\n${'a9ed3b20-9979-48c1-8336-49b521f3a147'},Las Vegas\n`
    expectNoFiguresInText(csv, ['14', '1430'])
    expect(() => expectNoFiguresInText(`${csv}read,1430\n`, ['1430'])).toThrow()
  })

  it('runs clean on ten thousand ids as well', () => {
    for (let i = 0; i < 10_000; i++) expectNoFiguresInText(`id,${randomUUID()},done`, ['14'])
  })
})

describe('expectNoFigures says what leaked and where', () => {
  it('names the field, so a red test is a fix and not a hunt', () => {
    expect(() => expectNoFigures({ rows: [{ owed: 1430.55 }] }, [1430.55]))
      .toThrow(/rows\.0\.owed/)
  })
  it('passes quietly when nothing did', () => {
    expectNoFigures({ ok: true, who: 'Dale Pruitt' }, [1430.55, '14'])
  })
})
