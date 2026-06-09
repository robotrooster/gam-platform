import fs from 'fs'
import { extractPositionedText } from '../src/lib/pdfText.js'
import { joinPageItemsRelaxed } from '../src/jobs/leaseParser/itemJoin.js'

async function main() {
  const buf = fs.readFileSync(process.argv[2])
  const pdf = await extractPositionedText(buf)
  console.log(`pages: ${pdf.pageCount}`)

  const labelPattern = /Emergency Contact:/i
  for (const page of pdf.pages) {
    const relaxed = joinPageItemsRelaxed(page)
    let count = 0
    for (const prose of relaxed) {
      if (labelPattern.test(prose.text)) {
        count++
        console.log(`page ${page.pageNumber} match #${count}: y=${prose.y.toFixed(1)} x=${prose.x.toFixed(1)} ${JSON.stringify(prose.text.slice(0, 80))}`)
      }
    }
  }
}
main().catch(e => { console.error(e); process.exit(1) })
