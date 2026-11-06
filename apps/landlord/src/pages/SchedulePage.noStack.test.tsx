/**
 * THE TIMELINE IS A PICTURE, NOT A LIST — AND NOTHING WAS GUARDING THAT.
 *
 * 10/30: the phone package turns every table into cards at 820px and below,
 * which is what Nic asked for ("I don't want the tables to scroll... condensed
 * into a card") and which is right for a list of residents. The Master Schedule
 * is not a list. Its cells are placed by the table's own geometry and its inline
 * width is one column per day, so the card rules — display:block on tbody, tr
 * and td, plus max-width:100% — flattened the whole grid into a single 145px
 * column of blocks. Measured in the browser before the fix: display "block",
 * cells "block", a 5,491px timeline clamped to 145px.
 *
 * The stylesheet's opt-out is [data-no-stack] on an ancestor. One deleted
 * attribute puts the timeline back in that state, and nothing about the page
 * looks wrong on a desk monitor when it happens — the damage is only visible on
 * a phone, which is the one place nobody runs the suite.
 *
 * So this reads the source. The same reasoning applies to any future table
 * whose inline style sets a computed pixel `width` (as opposed to a minWidth):
 * that is the signature of a grid drawn by geometry, and it needs the opt-out
 * too. Today the schedule is the only one in the portal.
 */

import { describe, it, expect } from 'vitest'
import fs from 'fs'
import path from 'path'

const SRC = path.join(__dirname, 'SchedulePage.tsx')

describe('the Master Schedule timeline opts out of phone card-stacking', () => {
  const src = fs.readFileSync(SRC, 'utf8')

  it('puts data-no-stack on the scroll container that holds the timeline table', () => {
    // The container is the element the table sits inside, so the stylesheet's
    // `table:not([data-no-stack] table)` stops matching.
    const scroller = src.indexOf('className="schedule-scroll"\n            data-no-stack')
    expect(
      scroller,
      'the timeline scroll container must carry data-no-stack — without it the ' +
      'phone rules turn the timeline into one column of blocks',
    ).toBeGreaterThan(-1)
  })

  it('keeps the attribute on an ancestor of the timeline table, not somewhere later in the file', () => {
    const optOut = src.indexOf('data-no-stack')
    const table = src.indexOf('<table')
    expect(optOut).toBeGreaterThan(-1)
    expect(table).toBeGreaterThan(-1)
    // The opt-out has to be opened BEFORE the table it protects.
    expect(
      optOut,
      'data-no-stack has to sit on an element that wraps the timeline table',
    ).toBeLessThan(table)
  })

  it('keeps the day-ruler strip on one line', () => {
    // The strip above the grid is a flex row whose width is one column per day.
    // The phone package wraps any inline flex row that does not say otherwise,
    // and a wrapped ruler stops lining up with the columns underneath it. It
    // happens to survive because its declared width matches its children
    // exactly — too thin a margin to leave to chance.
    expect(
      /style=\{\{display:'flex',flexWrap:'nowrap',width:days\.length\*colW/.test(src),
      'the day-ruler strip must declare flexWrap nowrap so the phone rules leave it alone',
    ).toBe(true)
  })

  it('is the only table in the portal drawn by geometry rather than content', () => {
    // If this starts failing, a new picture-grid arrived and needs the same
    // opt-out; read the comment at the top of this file before changing it.
    const pagesDir = __dirname
    const offenders: string[] = []
    for (const f of fs.readdirSync(pagesDir)) {
      if (!f.endsWith('.tsx') || f.includes('.test.')) continue
      const body = fs.readFileSync(path.join(pagesDir, f), 'utf8')
      // an inline width computed from a count, on a table
      const re = /<table[^>]{0,400}?width:\s*[A-Za-z_$][\w.$]*\.length\s*\*/s
      if (re.test(body)) offenders.push(f)
    }
    expect(offenders.sort()).toEqual(['SchedulePage.tsx'])
  })
})
