import { PDFDocument, StandardFonts, rgb } from 'pdf-lib'
import { FLEXPAY_TERMS } from '@gam/shared'

// S322: render a populated FlexSuite acceptance snapshot (Subscription
// Terms / Service Agreement) to a PDF byte buffer. Output is a clean
// multi-page monospaced text document with a gold/dark header on
// page 1 and a forensic footer on every page (tenant id + sha256 +
// accepted-at timestamp).
//
// The PDF is for tenant inbox durability — the load-bearing legal
// artifact remains flexsuite_enrollment_acceptances.rendered_text in
// the DB, but a copy in the tenant's email gives them their own
// retrievable record that strengthens the SLA-not-loan structural
// defense at recharacterization challenge.
//
// No file IO. Buffer in → buffer out. Caller attaches to the email
// directly; nothing persists to disk.

export interface FlexsuiteAcceptancePdfContext {
  product:            'flexpay' | 'flexdeposit'
  tenantName:         string
  tenantEmail:        string
  templateVersion:    string
  acceptedAt:         Date
  contentHash:        string  // sha256 hex
  renderedText:       string  // full populated SLA / Subscription Terms
  acceptanceId:       string
}

const PAGE_W = 612      // 8.5" * 72
const PAGE_H = 792      // 11"  * 72
const MARGIN_X = 48
const MARGIN_TOP = 80   // leaves room for header on page 1
const MARGIN_BOTTOM = 56
const LINE_HEIGHT = 11
const FONT_SIZE = 9
const FOOTER_FONT_SIZE = 7
const HEADER_GOLD = rgb(0.788, 0.635, 0.153)
const HEADER_BG = rgb(0.05, 0.07, 0.10)
const HEADER_HEIGHT = 68

function productTitle(p: 'flexpay' | 'flexdeposit'): string {
  return p === 'flexpay' ? 'FlexPay Subscription Terms' : 'FlexDeposit Service Agreement'
}

/**
 * S655 (money plan Step 4): FlexPay's terms in plain words — the ONE set of
 * sections the tenant app, emails and admin show (FLEXPAY_TERMS in
 * packages/shared), so the PDF in the tenant's inbox says exactly what the app
 * said when they joined: FlexPay pays the whole monthly bill on the last grace
 * day, GAM collects on the pull day (never the 1st-5th), the retry schedule,
 * and the $25 taken even in a month the tenant paid.
 *
 * It comes FIRST and is labeled apart from the accepted text, because the
 * footer's sha256 fingerprints the accepted text only.
 */
export function flexPayPlainTermsText(): string {
  return [
    'FLEXPAY IN PLAIN WORDS',
    'These are the same terms the GAM app shows. The full Subscription Terms you accepted follow; the fingerprint in the footer is of that full text.',
    '',
    ...FLEXPAY_TERMS.flatMap(sec => [sec.title, sec.body, '']),
    'THE SUBSCRIPTION TERMS YOU ACCEPTED',
    '',
  ].join('\n')
}

/** The text the PDF draws: FlexPay's plain terms, then the accepted snapshot. */
export function acceptancePdfBody(ctx: Pick<FlexsuiteAcceptancePdfContext, 'product' | 'renderedText'>): string {
  return ctx.product === 'flexpay'
    ? `${flexPayPlainTermsText()}\n${ctx.renderedText}`
    : ctx.renderedText
}

// pdf-lib's Helvetica doesn't support all unicode; replace the few
// chars likely to appear in our populated terms text with ASCII
// equivalents so the render doesn't throw a "WinAnsi encoding"
// error mid-document.
export function sanitizeForWinAnsi(s: string): string {
  return s
    .replace(/—/g, '--')   // em dash
    .replace(/–/g, '-')    // en dash
    .replace(/‘|’/g, "'")
    .replace(/“|”/g, '"')
    .replace(/…/g, '...')  // ellipsis
    .replace(/ /g, ' ')    // nbsp
    .replace(/•/g, '*')    // bullet
    .replace(/§/g, 'Sec.') // section sign §
    .replace(/→/g, '->')   // right arrow (e.g., "Read full terms →")
    .replace(/←/g, '<-')   // left arrow
    .replace(/✓/g, '[x]')  // checkmark
}

// Word-wrap a paragraph to fit the page width at the given font size.
// Preserves single newlines as paragraph breaks; collapses runs of
// whitespace within a line. Returns the array of physical lines to
// render.
function wrapLines(text: string, font: any, fontSize: number, maxWidth: number): string[] {
  const out: string[] = []
  for (const para of text.split('\n')) {
    if (para.trim() === '') { out.push(''); continue }
    const words = para.split(/\s+/)
    let line = ''
    for (const w of words) {
      const candidate = line === '' ? w : line + ' ' + w
      const width = font.widthOfTextAtSize(candidate, fontSize)
      if (width <= maxWidth) {
        line = candidate
      } else {
        if (line !== '') out.push(line)
        // single word longer than maxWidth — hard-break to keep going
        if (font.widthOfTextAtSize(w, fontSize) > maxWidth) {
          let chunk = ''
          for (const ch of w) {
            const c2 = chunk + ch
            if (font.widthOfTextAtSize(c2, fontSize) <= maxWidth) chunk = c2
            else { out.push(chunk); chunk = ch }
          }
          line = chunk
        } else {
          line = w
        }
      }
    }
    if (line !== '') out.push(line)
  }
  return out
}

export async function renderAcceptancePdf(
  ctx: FlexsuiteAcceptancePdfContext,
): Promise<Buffer> {
  const pdfDoc = await PDFDocument.create()
  pdfDoc.setTitle(`${productTitle(ctx.product)} — ${ctx.tenantName}`)
  pdfDoc.setAuthor('Gold Asset Management')
  pdfDoc.setSubject('Click-accepted enrollment terms snapshot')
  pdfDoc.setCreationDate(ctx.acceptedAt)

  const helv = await pdfDoc.embedFont(StandardFonts.Helvetica)
  const helvBold = await pdfDoc.embedFont(StandardFonts.HelveticaBold)

  const bodyMaxWidth = PAGE_W - MARGIN_X * 2
  const lines = wrapLines(sanitizeForWinAnsi(acceptancePdfBody(ctx)), helv, FONT_SIZE, bodyMaxWidth)

  const footerY = MARGIN_BOTTOM - 28
  const footerHashFragment = ctx.contentHash.slice(0, 16) + '…'
  const footerText = `Acceptance ${ctx.acceptanceId.slice(0, 8)} · sha256 ${footerHashFragment} · ${ctx.acceptedAt.toISOString()}`

  let page = pdfDoc.addPage([PAGE_W, PAGE_H])
  let isFirstPage = true
  let y = PAGE_H - MARGIN_TOP

  function drawHeader() {
    page.drawRectangle({ x: 0, y: PAGE_H - HEADER_HEIGHT, width: PAGE_W, height: HEADER_HEIGHT, color: HEADER_BG })
    page.drawText(productTitle(ctx.product).toUpperCase(), {
      x: MARGIN_X, y: PAGE_H - 32, size: 13, font: helvBold, color: HEADER_GOLD,
    })
    page.drawText(`${ctx.tenantName} (${ctx.tenantEmail}) · v${ctx.templateVersion}`, {
      x: MARGIN_X, y: PAGE_H - 50, size: 8, font: helv, color: rgb(0.7, 0.7, 0.7),
    })
  }

  function drawFooter() {
    page.drawLine({
      start: { x: MARGIN_X, y: footerY + 12 }, end: { x: PAGE_W - MARGIN_X, y: footerY + 12 },
      thickness: 0.4, color: rgb(0.8, 0.8, 0.8),
    })
    page.drawText(footerText, {
      x: MARGIN_X, y: footerY, size: FOOTER_FONT_SIZE, font: helv, color: rgb(0.5, 0.5, 0.5),
    })
  }

  drawHeader()

  for (const line of lines) {
    if (y < MARGIN_BOTTOM) {
      drawFooter()
      page = pdfDoc.addPage([PAGE_W, PAGE_H])
      isFirstPage = false
      y = PAGE_H - MARGIN_X  // subsequent pages have no header → smaller top margin
    }
    if (line !== '') {
      page.drawText(line, { x: MARGIN_X, y, size: FONT_SIZE, font: helv, color: rgb(0, 0, 0) })
    }
    y -= LINE_HEIGHT
  }
  drawFooter()
  void isFirstPage  // anchor: header-vs-content-area future tweak hook

  const bytes = await pdfDoc.save()
  return Buffer.from(bytes)
}
