import { PDFDocument, rgb, StandardFonts } from 'pdf-lib'
import * as fs from 'fs'

interface FieldStamp {
  page: number
  x: number
  y: number
  width: number
  height: number
  field_type: string
  value: string
  /** S637: the signature style the signer chose, as a CSS font shorthand. */
  font_css?: string | null
  /** S641: how a ticked box is drawn — 'x' (default) or 'check'. */
  checkbox_mark?: string | null
}

interface SignerInfo {
  name: string
  email: string
  role: string
  signed_at: string
}

/**
 * S652 — a value has to FIT ITS BOX, and nothing on a lease may be shortened.
 *
 * Blu, reading Lot 1: "the tenant name, Nancy Sheptock, was cut off. The last
 * name just has S-H-E dot dot dot. The box in the template should have been big
 * enough for that whole name to fit."
 *
 * He was looking at the signing screen, which shrinks text to fit and then
 * CSS-ellipsises whatever still does not. This stamper did something different
 * and arguably worse: it sized text by the box's HEIGHT alone and never its
 * width, so a long name was drawn in full at up to 10pt and simply ran out past
 * the box and across whatever was printed next to it.
 *
 * Two wrongs that disagreed with each other, which for an e-sign product is the
 * real defect: what somebody reads before signing has to be what gets stamped.
 * Both now shrink on width as well as height.
 *
 * NOTHING IS EVER TRUNCATED HERE. A name shortened on a lease is a different
 * person, and a document that quietly drops half of one is worse than an ugly
 * one. Below MIN_PT the text is drawn at MIN_PT and allowed to overflow, because
 * a landlord seeing a name spill past its box will fix the template; a landlord
 * seeing "She..." has no idea anything is wrong.
 */
const MIN_PT = 5
function fitSize(font: any, text: string, boxW: number, boxH: number, maxPt: number): number {
  const byHeight = Math.min(boxH * 0.55, maxPt)
  if (!text) return byHeight
  const w = font.widthOfTextAtSize(text, byHeight)
  const usable = Math.max(boxW - 4, 1)
  if (w <= usable) return byHeight
  return Math.max(MIN_PT, byHeight * (usable / w))
}

export async function stampPdf(
  sourcePath: string,
  fields: FieldStamp[],
  signers: SignerInfo[],
  outputPath: string
): Promise<void> {
  const existingPdfBytes = fs.readFileSync(sourcePath)
  const pdfDoc = await PDFDocument.load(existingPdfBytes)
  const pages = pdfDoc.getPages()
  const helvetica = await pdfDoc.embedFont(StandardFonts.Helvetica)
  const helveticaBold = await pdfDoc.embedFont(StandardFonts.HelveticaBold)

  // ── S637: A TYPED SIGNATURE IS STAMPED IN THE STYLE THE SIGNER PICKED ────
  //
  // Nic: "the leases are not stamping the font choice for signature or
  // initials. They come back as plain text."
  //
  // They did, and in Helvetica — the same face as the body text, so an executed
  // lease showed a name typed in the document's own font where a signature
  // should be. The signer picks from five styles, sees a live preview, and the
  // choice was thrown away on submit; font_css has been on this table since the
  // initial schema and nothing ever wrote to it.
  //
  // Four of the five styles are italic serif faces (Georgia, Palatino,
  // Garamond, and the serif fallbacks the script options carry), which
  // Times-Italic represents honestly. It is embedded once, lazily, and only if
  // some field actually asks for it.
  //
  // S637: the two genuinely cursive options were REMOVED from the chooser
  // rather than approximated — Nic: "the ones that need something that's a
  // licensing pick, just remove those." Every style a signer can now pick is an
  // italic serif face that Times-Italic reproduces faithfully, so the preview
  // and the executed PDF agree. The cursive keywords stay in the matcher below
  // to keep any already-signed document rendering as it did.
  const timesItalic = await pdfDoc.embedFont(StandardFonts.TimesRomanItalic)
  // S641 (Nic): "it needs to be a check or an x, not just a solid square,
  // because that could be ambiguous." A filled square reads as redaction to one
  // person and "not applicable" to another. ZapfDingbats is one of the fourteen
  // fonts every PDF reader carries, and its '3' is a check mark — Helvetica's
  // WinAnsi encoding has no such glyph, so a literal ✓ would stamp as garbage.
  const signatureFontFor = (fontCss: string | null | undefined) => {
    if (!fontCss) return helvetica
    const css = String(fontCss).toLowerCase()
    const scriptish = ['italic', 'cursive', 'script', 'georgia', 'palatino',
                       'garamond', 'chancery', 'roundhand', 'serif']
    return scriptish.some(k => css.includes(k)) ? timesItalic : helvetica
  }

  for (const field of fields) {
    if (!field.value) continue
    const pageIndex = (field.page || 1) - 1
    if (pageIndex >= pages.length) continue
    const page = pages[pageIndex]
    const { height: pageHeight } = page.getSize()
    const pdfY = pageHeight - field.y - field.height

    // S652: a CHOICE box marked with initials prints like an initial; marked
    // with X or a check it prints like a ticked checkbox. Fixed text prints
    // as text, in the default branch below.
    const choiceAsInitials = field.field_type === 'choice' && field.checkbox_mark === 'initials'
    const choiceAsMark = field.field_type === 'choice' && !choiceAsInitials
    if (field.field_type === 'signature' || field.field_type === 'initials' || choiceAsInitials) {
      if (field.value.startsWith('data:image')) {
        try {
          const base64Data = field.value.split(',')[1]
          const imgBytes = Buffer.from(base64Data, 'base64')
          const img = field.value.includes('image/png')
            ? await pdfDoc.embedPng(imgBytes)
            : await pdfDoc.embedJpg(imgBytes)
          page.drawImage(img, { x:field.x, y:pdfY, width:field.width, height:field.height })
        } catch(e) {
          page.drawText(field.value, { x:field.x+2, y:pdfY+field.height*0.25,
            size:fitSize(signatureFontFor(field.font_css), field.value, field.width, field.height, 20),
            font:signatureFontFor(field.font_css), color:rgb(0,0,0.5) })
        }
      } else {
        // S637: the signer's own style, not the body font.
        page.drawText(field.value, { x:field.x+2, y:pdfY+field.height*0.2,
          size:fitSize(signatureFontFor(field.font_css), field.value, field.width, field.height, 20),
          font:signatureFontFor(field.font_css), color:rgb(0,0,0.4) })
      }
      page.drawLine({ start:{x:field.x,y:pdfY}, end:{x:field.x+field.width,y:pdfY}, thickness:0.5, color:rgb(0.4,0.4,0.4) })
    } else if (field.field_type === 'date') {
      page.drawText(field.value, { x:field.x+2, y:pdfY+field.height*0.2,
        size:fitSize(helvetica, field.value, field.width, field.height, 10), font:helvetica, color:rgb(0,0,0) })
    } else if ((field.field_type === 'checkbox' && field.value === 'checked') || choiceAsMark) {
      const useCheck = field.checkbox_mark === 'check'
      if (useCheck) {
        // S652: drawn as two strokes. ZapfDingbats' check glyph was addressed
        // as '3', which pdf-lib cannot encode — every check-marked box threw.
        const w = field.width, h = field.height
        const p1 = { x: field.x + w * 0.2,  y: pdfY + h * 0.5 }
        const p2 = { x: field.x + w * 0.42, y: pdfY + h * 0.2 }
        const p3 = { x: field.x + w * 0.85, y: pdfY + h * 0.85 }
        const t = Math.max(1, Math.min(w, h) * 0.12)
        page.drawLine({ start: p1, end: p2, thickness: t, color: rgb(0, 0.4, 0) })
        page.drawLine({ start: p2, end: p3, thickness: t, color: rgb(0, 0.4, 0) })
      } else {
        page.drawText('X', {
          x: field.x + field.width * 0.2,
          y: pdfY + field.height * 0.15,
          size: field.height * 0.65,
          font: helveticaBold,
          color: rgb(0, 0.4, 0),
        })
      }
    } else if (field.value) {
      page.drawText(field.value, { x:field.x+2, y:pdfY+field.height*0.2,
        size:fitSize(helvetica, field.value, field.width, field.height, 10), font:helvetica, color:rgb(0,0,0) })
    }
  }

  // Execution certificate page
  const certPage = pdfDoc.addPage([612, 792])
  const { width:cw, height:ch } = certPage.getSize()

  certPage.drawRectangle({ x:0, y:ch-80, width:cw, height:80, color:rgb(0.05,0.07,0.10) })
  certPage.drawText('ELECTRONIC SIGNATURE CERTIFICATE', { x:40, y:ch-50, size:14, font:helveticaBold, color:rgb(0.788,0.635,0.153) })
  certPage.drawText('This certificate confirms the legal execution of the attached document.', { x:40, y:ch-68, size:9, font:helvetica, color:rgb(0.6,0.6,0.6) })
  certPage.drawText('Executed under the Uniform Electronic Transactions Act (UETA) and E-SIGN Act (15 U.S.C. § 7001).', { x:40, y:ch-110, size:8, font:helvetica, color:rgb(0.3,0.3,0.3) })

  let y = ch-150
  certPage.drawText('SIGNERS', { x:40, y, size:11, font:helveticaBold, color:rgb(0,0,0) })
  y -= 20

  for (const signer of signers) {
    certPage.drawRectangle({ x:40, y:y-60, width:cw-80, height:65, borderColor:rgb(0.8,0.8,0.8), borderWidth:0.5, color:rgb(0.97,0.97,0.97) })
    certPage.drawText(signer.name, { x:50, y:y-15, size:11, font:helveticaBold, color:rgb(0,0,0) })
    certPage.drawText(signer.role.replace(/_/g,' ').toUpperCase(), { x:50, y:y-28, size:8, font:helvetica, color:rgb(0.5,0.5,0.5) })
    certPage.drawText(signer.email, { x:50, y:y-41, size:9, font:helvetica, color:rgb(0.3,0.3,0.3) })
    certPage.drawText('Signed: '+new Date(signer.signed_at).toLocaleString(), { x:50, y:y-54, size:9, font:helvetica, color:rgb(0.3,0.3,0.3) })
    certPage.drawText('SIGNED', { x:cw-120, y:y-32, size:10, font:helveticaBold, color:rgb(0,0.5,0) })
    y -= 80
  }

  certPage.drawLine({ start:{x:40,y:60}, end:{x:cw-40,y:60}, thickness:0.5, color:rgb(0.8,0.8,0.8) })
  certPage.drawText('GAM Platform · '+new Date().toISOString(), { x:40, y:45, size:8, font:helvetica, color:rgb(0.6,0.6,0.6) })
  certPage.drawText('UETA Compliant · E-SIGN Act Compliant · Legally Binding', { x:40, y:32, size:8, font:helvetica, color:rgb(0.6,0.6,0.6) })

  const pdfBytes = await pdfDoc.save()
  fs.writeFileSync(outputPath, pdfBytes)
}
