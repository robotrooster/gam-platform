/**
 * PM readiness 4 — THE OWNER STATEMENT AS A PDF.
 *
 * services/ownerStatement has computed the whole statement since S644 and the
 * owner-facing routes have shown it since S645. There was no document. An
 * owner whose park a manager runs on GAM could read figures on a screen they
 * do not sign in to, and had nothing to hand their accountant.
 *
 * This draws services/ownerStatement's figures and NEVER computes one — the
 * same rule monthlyReportPdf keeps, for the same reason: a document that
 * disagrees with the screen is worse than no document, and this one goes to
 * somebody who is not a GAM customer and will tie its total to their bank.
 *
 * WHERE THE PDF MACHINERY COMES FROM. pdf-lib, through the house layout in
 * services/monthlyReportPdf (the engine the e-signature subsystem and the
 * monthly property report already draw with) — no new dependency, and the
 * owner statement is the same document: landscape letter, white page, dark
 * ink, gold rules, a dark cover band, zebra tables, a page footer.
 *
 * HOW IT READS, AND WHY IN THAT ORDER. The owner's question is "what am I
 * being paid, and why is it not the rent roll". So:
 *
 *   1. what the month came to — gross, who held it, the manager's cut, the
 *      bills paid on their behalf, and the net. Net leads the summary line
 *      because that is the figure their bank will show.
 *   2. where each figure comes from, in plain words. Three of them are the
 *      ones an owner rings about: that gross is money the day it ARRIVED and
 *      the billed block counts bills the month they were DUE, so the two
 *      disagree on purpose; that a payment later returned stays in the month
 *      it settled; and that GAM's own per-unit fee is not on here (S644,
 *      DIRECTIVE: GAM bills the manager, not the owner).
 *   3. every property side by side, with a total row — the page a manager
 *      gets asked about.
 *   4. one section per property, with its expense lines itemized, because a
 *      disputed statement is disputed one line at a time.
 *
 * Buffer out, nothing written to disk: the email attaches it, a route can
 * stream it.
 */
import { PDFDocument, StandardFonts, rgb } from 'pdf-lib'
import {
  Layout, pdfText, pdfMoney, PAGE_W, PAGE_H, MX, BOTTOM, MUTED, INK, GOLD, RULE, BAND,
  type Col,
} from './monthlyReportPdf'
import type { OwnerStatement, OwnerStatementProperty, OwnerStatementBilled } from './ownerStatement'

const money = pdfMoney

/** Who the statement is for and from, in words — the statement itself carries only ids. */
export interface OwnerStatementDocMeta {
  /** The owner entity, as the owner knows it (their company, else their name). */
  entityName: string
  /** The person who owns the entity, for the greeting line. Null when unknown. */
  ownerName: string | null
  /** The manager who runs these properties, or null for a whole-portfolio statement. */
  pmCompanyName: string | null
  /** "September 2026". */
  monthLabel: string
  /** ISO instant the document was drawn. */
  generatedAt: string
}

/** "Sep 30, 2026" for a calendar day. */
function dayWords(ymd: string): string {
  const [y, m, d] = ymd.slice(0, 10).split('-').map(Number)
  return new Date(Date.UTC(y, m - 1, d)).toLocaleDateString('en-US',
    { month: 'short', day: 'numeric', year: 'numeric', timeZone: 'UTC' })
}

/** The columns of the all-properties table — and of each property's own summary. */
const PROPERTY_COLS: Col[] = [
  { label: 'Property',       width: 150 },
  { label: 'Collected',      width: 80, align: 'right' },
  { label: 'Through GAM',    width: 80, align: 'right' },
  { label: 'By the manager', width: 85, align: 'right' },
  { label: 'Returned',       width: 70, align: 'right' },
  { label: 'Your share',     width: 80, align: 'right' },
  { label: 'Management',     width: 80, align: 'right' },
  { label: 'Expenses',       width: 70, align: 'right' },
  { label: 'Net to you',     width: 75, align: 'right' },
]

function propertyRow(name: string, p: {
  grossCollected: number; collectedThroughGam: number; collectedDirectly: number
  returnedOrDisputed: number; ownerShare: number; managementFee: number
  expenses: number; net: number
}): string[] {
  return [
    name, money(p.grossCollected), money(p.collectedThroughGam), money(p.collectedDirectly),
    money(p.returnedOrDisputed), money(p.ownerShare), money(p.managementFee),
    money(p.expenses), money(p.net),
  ]
}

/**
 * S655's information block, said as information. It changes no share, and it
 * is NOT the same money in the same month as what was collected: bills count
 * in the month they were due, money counts on the day it arrived.
 */
function billedBlock(L: Layout, b: OwnerStatementBilled, monthLabel: string): void {
  L.table([
    { label: `Bills due in ${monthLabel}`, width: 300 },
    { label: 'Amount', width: 140, align: 'right' },
    { label: '', width: 280 },
  ], [
    ['Billed', money(b.billed), ''],
    ['Collected against those bills', money(b.collectedSoFar), ''],
    ['Clearing', money(b.clearing), ''],
    ['Still owed', money(b.stillOwed), ''],
  ])
  L.paragraph('Information only: this block changes nothing you are paid. It counts each bill in the month it '
    + 'was DUE, while the money above counts on the day it ARRIVED — so money paid ahead, or a September bill '
    + 'paid at the desk in October, lands in different months in the two. The two are not meant to match.',
    8, MUTED)
  L.y -= 4
}

function cover(L: Layout, s: OwnerStatement, meta: OwnerStatementDocMeta): void {
  L.newPage(false)
  const band = 74
  L.page.drawRectangle({ x: 0, y: PAGE_H - band, width: PAGE_W, height: band, color: BAND })
  L.text('OWNER STATEMENT', MX, PAGE_H - 32, 15, L.bold, GOLD)
  const who = meta.pmCompanyName
    ? `${meta.entityName}  ·  ${meta.monthLabel}  ·  managed by ${meta.pmCompanyName}`
    : `${meta.entityName}  ·  ${meta.monthLabel}`
  L.text(who, MX, PAGE_H - 52, 10, L.font, rgb(0.85, 0.86, 0.88))
  L.text(`Prepared ${dayWords(meta.generatedAt.slice(0, 10))} by Gold Asset Management from the record of the money that moved.`,
    MX, PAGE_H - 65, 7.5, L.font, rgb(0.6, 0.62, 0.66))
  L.y = PAGE_H - band - 22

  const T = s.totals
  L.heading(`What ${meta.monthLabel} came to`)
  L.pairs([
    ['Net to you', money(T.net)],
    ['Your share of what was collected', money(T.ownerShare)],
    ['Bills paid on your behalf', money(T.expenses)],
    ['Collected from residents', money(T.grossCollected)],
  ])
  L.pairs([
    ['Of that, money GAM held and paid out', money(T.collectedThroughGam)],
    [`Of that, money ${meta.pmCompanyName ?? 'the manager'} took directly`, money(T.collectedDirectly)],
    ['Returned or disputed this month', money(T.returnedOrDisputed)],
    [meta.pmCompanyName ? `${meta.pmCompanyName}'s fee` : 'Management fee', money(T.managementFee)],
  ])

  L.heading('Where these figures come from')
  L.paragraph('Every figure on this statement is read from the record of money that actually moved — not from rent '
    + 'that was due. Collected is what residents paid before anyone took a cut. Your share is what was allocated to '
    + 'you at the moment each payment settled, after management and GAM; it is the figure your bank will agree with. '
    + 'Net to you is your share less the bills paid on your behalf, which are itemized by property further on.', 8.5)
  L.paragraph('Money still clearing is not counted here. Rent in flight has not paid anybody yet, and counting it '
    + 'would print a month that collected more than it allocated.', 8.5, MUTED)
  L.paragraph('A payment later returned or disputed stays in the month it settled, with its share, so a statement '
    + 'you have already filed is never rewritten. What the reversal took back is shown as Returned, in the month it '
    + 'happened.', 8.5, MUTED)
  L.paragraph("GAM's own fee is not on this statement. GAM bills the management company for the units it runs, not "
    + 'you. Anything the manager passes through to you appears as one of their expense lines, in their words.', 8.5, MUTED)

  if (!s.properties.length) {
    L.heading('Properties')
    L.paragraph(meta.pmCompanyName
      ? `No properties were under ${meta.pmCompanyName} in ${meta.monthLabel}.`
      : `No properties were on this statement in ${meta.monthLabel}.`, 9, MUTED)
    return
  }

  L.heading('Every property')
  const rows = s.properties.map(p => propertyRow(p.propertyName, p))
  rows.push(propertyRow('Total', T))
  L.table(PROPERTY_COLS, rows, { totalRow: true })

  L.heading(`Bills due in ${meta.monthLabel} — all properties`)
  billedBlock(L, T.billed, meta.monthLabel)
}

function propertySection(L: Layout, p: OwnerStatementProperty, meta: OwnerStatementDocMeta): void {
  L.ensure(60)
  L.text(p.propertyName, MX, L.y, 16, L.bold, INK)
  L.y -= 24

  L.heading(`Money — ${meta.monthLabel}`)
  L.table(PROPERTY_COLS, [propertyRow(p.propertyName, p)], { bolds: [0] })

  L.heading('Bills paid on your behalf')
  if (p.expenseLines.length) {
    L.table([
      { label: 'Date',        width: 90 },
      { label: 'Category',    width: 140 },
      { label: 'Description', width: 230 },
      { label: 'Paid to',     width: 170 },
      { label: 'Amount',      width: 90, align: 'right' },
    ], [
      ...p.expenseLines.map(l => [
        dayWords(l.date), l.category, l.description ?? '', l.vendor ?? '', money(l.amount),
      ]),
      ['Total', '', '', '', money(p.expenses)],
    ], { totalRow: true })
  } else {
    L.paragraph('No bills were paid on your behalf at this property this month.', 8.5, MUTED)
  }

  L.heading(`Bills due in ${meta.monthLabel} — ${p.propertyName}`)
  billedBlock(L, p.billed, meta.monthLabel)
}

/** The statement as a PDF (a Buffer to attach or stream). */
export async function renderOwnerStatementPdf(
  s: OwnerStatement, meta: OwnerStatementDocMeta,
): Promise<Buffer> {
  const doc = await PDFDocument.create()
  doc.setTitle(pdfText(`Owner statement - ${meta.entityName} - ${meta.monthLabel}`))
  doc.setAuthor('Gold Asset Management')
  doc.setSubject(pdfText(`${meta.monthLabel}: what was collected, what management took, and what is yours`))
  doc.setCreationDate(new Date(meta.generatedAt))
  const font = await doc.embedFont(StandardFonts.Helvetica)
  const bold = await doc.embedFont(StandardFonts.HelveticaBold)
  const L = new Layout(doc, font, bold, `Owner statement · ${meta.entityName}`, meta.monthLabel)

  cover(L, s, meta)
  // One page per property, so a property's own section is never split across
  // the all-properties table — unless there is only one, which has already
  // been said in full on the cover's table.
  for (const p of s.properties) {
    L.newPage()
    propertySection(L, p, meta)
  }

  const n = L.pages.length
  L.pages.forEach((pg, i) => {
    const line = pdfText(`${meta.entityName}  ·  ${meta.monthLabel}  ·  Page ${i + 1} of ${n}`)
    pg.drawLine({ start: { x: MX, y: BOTTOM - 14 }, end: { x: PAGE_W - MX, y: BOTTOM - 14 }, thickness: 0.4, color: RULE })
    pg.drawText(line, { x: MX, y: BOTTOM - 26, size: 7, font, color: MUTED })
  })
  return Buffer.from(await doc.save())
}

/** "Owner-statement-Olive-Owner-LLC-2026-09.pdf" */
export function ownerStatementFilename(meta: Pick<OwnerStatementDocMeta, 'entityName'>, periodMonth: string): string {
  const slug = pdfText(meta.entityName).replace(/[^A-Za-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 60) || 'owner'
  return `Owner-statement-${slug}-${periodMonth.slice(0, 7)}.pdf`
}
