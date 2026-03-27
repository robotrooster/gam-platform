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
}

interface SignerInfo {
  name: string
  email: string
  role: string
  signed_at: string
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

  for (const field of fields) {
    if (!field.value) continue
    const pageIndex = (field.page || 1) - 1
    if (pageIndex >= pages.length) continue
    const page = pages[pageIndex]
    const { height: pageHeight } = page.getSize()
    const pdfY = pageHeight - field.y - field.height

    if (field.field_type === 'signature' || field.field_type === 'initials') {
      if (field.value.startsWith('data:image')) {
        try {
          const base64Data = field.value.split(',')[1]
          const imgBytes = Buffer.from(base64Data, 'base64')
          const img = field.value.includes('image/png')
            ? await pdfDoc.embedPng(imgBytes)
            : await pdfDoc.embedJpg(imgBytes)
          page.drawImage(img, { x:field.x, y:pdfY, width:field.width, height:field.height })
        } catch(e) {
          page.drawText(field.value, { x:field.x+2, y:pdfY+field.height*0.25, size:Math.min(field.height*0.6,20), font:helvetica, color:rgb(0,0,0.5) })
        }
      } else {
        page.drawText(field.value, { x:field.x+2, y:pdfY+field.height*0.2, size:Math.min(field.height*0.6,20), font:helvetica, color:rgb(0,0,0.4) })
      }
      page.drawLine({ start:{x:field.x,y:pdfY}, end:{x:field.x+field.width,y:pdfY}, thickness:0.5, color:rgb(0.4,0.4,0.4) })
    } else if (field.field_type === 'date') {
      page.drawText(field.value, { x:field.x+2, y:pdfY+field.height*0.2, size:Math.min(field.height*0.55,10), font:helvetica, color:rgb(0,0,0) })
    } else if (field.field_type === 'checkbox' && field.value === 'checked') {
      page.drawText('X', { x:field.x+field.width*0.2, y:pdfY+field.height*0.15, size:field.height*0.65, font:helveticaBold, color:rgb(0,0.4,0) })
    } else if (field.value) {
      page.drawText(field.value, { x:field.x+2, y:pdfY+field.height*0.2, size:Math.min(field.height*0.55,10), font:helvetica, color:rgb(0,0,0) })
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
