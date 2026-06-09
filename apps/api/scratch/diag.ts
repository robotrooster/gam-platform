import fs from 'fs'
import path from 'path'
import { extractPositionedText } from '../src/lib/pdfText'
import { joinPageItems, joinPageItemsRelaxed } from '../src/jobs/leaseParser/itemJoin'

async function main() {
  const buf = fs.readFileSync(path.resolve(process.argv[2]))
  const ext = await extractPositionedText(buf)

  // 1. Audit page Title context
  const last = ext.pages[ext.pages.length - 1]
  const allText = last.items.map(i => i.text).join(' ')
  const idx = allText.indexOf('Title')
  console.log(`=== AUDIT 'Title' context ===`)
  if (idx === -1) console.log('  no Title found')
  else console.log(`  ${JSON.stringify(allText.slice(idx, idx + 250))}`)

  // 2. Page 2 strict-joined items, sorted top-down
  const page2 = ext.pages[1]
  console.log(`\n=== PAGE 2 STRICT-JOINED (top 40) ===`)
  for (const it of joinPageItems(page2).slice(0, 40)) {
    console.log(`  y=${it.y.toFixed(1).padStart(6)} x=${it.x.toFixed(1).padStart(6)} x2=${it.x2.toFixed(1).padStart(6)}  ${JSON.stringify(it.text.slice(0, 90))}`)
  }

  // 3. Page 2 relaxed-joined items
  console.log(`\n=== PAGE 2 RELAXED-JOINED (top 40) ===`)
  for (const it of joinPageItemsRelaxed(page2).slice(0, 40)) {
    console.log(`  y=${it.y.toFixed(1).padStart(6)} x=${it.x.toFixed(1).padStart(6)} x2=${it.x2.toFixed(1).padStart(6)}  ${JSON.stringify(it.text.slice(0, 90))}`)
  }

  // 4. Page 1 items containing 'Emergency' or 'Kevin'
  console.log(`\n=== PAGE 1 'Emergency' / 'Kevin' / 'Space No' / 'Names of All' items (relaxed) ===`)
  for (const it of joinPageItemsRelaxed(ext.pages[0])) {
    if (/Emergency|Kevin|Space\s*No|Names of All/.test(it.text)) {
      console.log(`  y=${it.y.toFixed(1).padStart(6)} x=${it.x.toFixed(1).padStart(6)} x2=${it.x2.toFixed(1).padStart(6)}  ${JSON.stringify(it.text.slice(0, 110))}`)
    }
  }
}

main().catch(e => { console.error(e); process.exit(1) })
