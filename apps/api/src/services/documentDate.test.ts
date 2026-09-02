/**
 * S636 — a typed date must survive the trip to the document and back.
 *
 * Nic, on the Fierro household at Mountain View MH 07 mid-signature:
 * "one person is still trying to sign it, and the date keeps correcting
 * their birthday to something else. The date formatting is wrong...
 * they're trying to put March thirty first, and every time they go to
 * click on the year, it changes it back to March third."
 *
 * The signed value is stored as the literal string stamped on the PDF
 * and re-parsed to repopulate the field. That used toLocaleDateString()
 * out and a M/D/YYYY regex in — fine on a US phone, corrupt on any
 * other.
 */
import { describe, it, expect } from 'vitest'
import { isoToDocumentDate, documentDateToIso, dateDigitSettles } from '@gam/shared'

describe('document date round-trip', () => {
  it('survives the trip out and back', () => {
    for (const iso of ['1962-03-31', '1962-03-03', '2001-12-01', '1999-01-31']) {
      expect(documentDateToIso(isoToDocumentDate(iso))).toBe(iso)
    }
  })

  it('writes M/D/YYYY regardless of the machine it runs on', () => {
    expect(isoToDocumentDate('1962-03-31')).toBe('3/31/1962')
    expect(isoToDocumentDate('1962-12-05')).toBe('12/5/1962')
  })

  it('reads a legacy D/M/YYYY string rather than inventing month 31', () => {
    // What a Spanish or en-GB device wrote before the format was pinned.
    expect(documentDateToIso('31/03/1962')).toBe('1962-03-31')
    expect(documentDateToIso('25/12/1980')).toBe('1980-12-25')
  })

  it('keeps reading plain US strings, including unpadded ones', () => {
    expect(documentDateToIso('3/31/1962')).toBe('1962-03-31')
    expect(documentDateToIso('03/31/1962')).toBe('1962-03-31')
  })

  it('returns empty for junk instead of a wrong date', () => {
    for (const junk of ['', undefined, 'March 31', '1962', 'x/y/z']) {
      expect(documentDateToIso(junk as any)).toBe('')
    }
  })

  it('never emits a date the signer did not type', () => {
    expect(isoToDocumentDate('')).toBe('')
    expect(isoToDocumentDate('not-a-date')).toBe('')
  })
})

describe('typing a date without ever clicking between boxes', () => {
  it('settles a month the moment a second digit is impossible', () => {
    // 2..9 can only be February..September — nothing follows them.
    for (const d of ['2','3','4','5','6','7','8','9']) {
      expect(dateDigitSettles('mm', d)).toBe(true)
    }
  })

  it('waits on 0 and 1, which can still become 01 or 10/11/12', () => {
    expect(dateDigitSettles('mm', '0')).toBe(false)
    expect(dateDigitSettles('mm', '1')).toBe(false)
  })

  it('settles a day above 3 — no day starts with 4', () => {
    for (const d of ['4','5','6','7','8','9']) {
      expect(dateDigitSettles('dd', d)).toBe(true)
    }
  })

  it('waits on 1, 2 and 3 so the 31st is still reachable — the Fierro case', () => {
    expect(dateDigitSettles('dd', '3')).toBe(false)   // 3 → 30, 31
    expect(dateDigitSettles('dd', '1')).toBe(false)
    expect(dateDigitSettles('dd', '2')).toBe(false)
    expect(dateDigitSettles('dd', '0')).toBe(false)
  })

  it('never settles a box that already holds two digits', () => {
    expect(dateDigitSettles('mm', '03')).toBe(false)
    expect(dateDigitSettles('dd', '31')).toBe(false)
    expect(dateDigitSettles('dd', '')).toBe(false)
  })
})
