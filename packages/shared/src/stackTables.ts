/**
 * TABLES BECOME CARDS ON A PHONE.
 *
 * 10/30: this lives in @gam/shared because every portal needs it and it was
 * already two byte-identical copies (landlord and pos) with three more
 * proposed — admin, books, admin-ops. Eighty-eight lines of load-bearing
 * runtime behavior duplicated five ways, under no parity test, where the next
 * fix has to be applied by hand in every copy. printTheme.ts and
 * versionWatch.ts are browser-only modules that already ship from here, so
 * there was nothing to invent. A portal wires it with one line in its shell:
 *
 *   useEffect(() => installTableStacking(document.body), [])
 *
 * document.body rather than the page container, so a dialog rendered through a
 * portal is covered too.
 *
 * 10/30 (Nic): "I don't want the tables to scroll. I want the things to be
 * resized so you can view. When I see the tenant's name and the unit number
 * and I have to scroll over to the right to see if they paid, that's not okay.
 * It needs to be shortened and condensed into a card."
 *
 * He is right, and two earlier attempts at this were wrong. Last night the
 * table was given `display:block; overflow-x:auto`, which did not even scroll —
 * without a width clamp the block simply grew to its content (measured 880px
 * inside a 375px screen) and the right-hand columns were clipped. Clamping it
 * made it scroll, which was the wrong goal: a row whose "did they pay" column
 * is off-screen is useless whether or not you can drag to it.
 *
 * So each ROW becomes a card and each CELL becomes a labelled line. The
 * stylesheet does the layout (see globals.css, the phone block); it needs one
 * thing it cannot get by itself — the column's name next to the value, since a
 * stacked cell with its header hidden is a bare number with no meaning.
 *
 * That name lives in the <thead>. Rather than hand-write data-label onto the
 * cells of 96 tables — which would also mean every table written next month
 * starts out broken again — this copies it off the header at runtime, by
 * column position. One mechanism, every table, including ones that do not
 * exist yet.
 *
 * Deliberately conservative: a row whose cell count does not match the header
 * is left alone (that is a colspan row — the "no results yet" line, a subtotal,
 * a group heading — and labelling it by position would attach the wrong name).
 * A table inside [data-no-stack] is skipped, which is the opt-out for a grid
 * that is a picture rather than a list, like the Master Schedule timeline.
 */

/** Tables under an element carrying this attribute keep their own layout. */
const OPT_OUT = '[data-no-stack]'

function labelCells(root: ParentNode): void {
  root.querySelectorAll('table').forEach((tbl) => {
    if (tbl.closest(OPT_OUT)) return
    const ths = Array.from(tbl.querySelectorAll(':scope > thead > tr > th'))
    if (!ths.length) return
    // 10/31: a table whose author already wrote data-label on its cells is
    // left exactly as it is. The tenant portal's documents table is the case
    // that found this: its first cell is the document's NAME, which is the
    // card's title and deliberately carries no label, and the last is an
    // action button. Reading the labels off the header would have put a
    // "DOCUMENT" caption above the title and undone a hand-tuned card. Partial
    // labelling is a choice, so it is honoured rather than completed.
    if (tbl.querySelector(':scope > tbody > tr > td[data-label]')) return
    // A header cell can carry markup (a sort arrow, an info icon); its text is
    // the part worth repeating, trimmed to something that reads as a label.
    const labels = ths.map((th) => (th.textContent || '').trim())
    tbl.querySelectorAll(':scope > tbody > tr').forEach((tr) => {
      const tds = Array.from(tr.children).filter(
        (c): c is HTMLElement => c.tagName === 'TD',
      )
      // Colspan rows (empty states, subtotals, group headers) never line up
      // with the header, and a label placed by position would be a lie.
      if (tds.length !== labels.length) return
      tds.forEach((td, i) => {
        const label = labels[i]
        if (!label) return
        if (td.getAttribute('data-label') !== label) td.setAttribute('data-label', label)
      })
    })
  })
}

/**
 * Watch a container and keep every table's cells labelled.
 *
 * Returns the teardown. Setting an attribute does not itself produce a
 * childList record, so this cannot drive itself in a loop; the work is still
 * coalesced into one animation frame because React commits a page in many
 * small mutations.
 */
export function installTableStacking(root: HTMLElement): () => void {
  let queued = 0
  const run = () => {
    queued = 0
    labelCells(root)
  }
  const schedule = () => {
    if (queued) return
    queued = requestAnimationFrame(run)
  }

  labelCells(root)
  const mo = new MutationObserver(schedule)
  mo.observe(root, { childList: true, subtree: true })

  return () => {
    mo.disconnect()
    if (queued) cancelAnimationFrame(queued)
  }
}
