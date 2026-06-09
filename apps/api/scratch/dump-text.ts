import fs from 'fs'
import { extractPositionedText } from '../src/lib/pdfText.js'

async function main() {
  const path = process.argv[2]
  if (!path) { console.error('usage: dump-text.ts <pdf>'); process.exit(1) }
  const buf = fs.readFileSync(path)
  const pdf = await extractPositionedText(buf)
  const text = pdf.pages.flatMap(p => p.items).map(i => i.text).join(' ')

  const anchors = [
    { label: 'Premises (D)',     re: /.{120}Premises.{20}/gi },
    { label: 'park or premises (D)', re: /.{30}(?:this|the)\s+(?:park|community|premises|property).{120}/gi },
    { label: 'expiration (G)',   re: /.{120}expiration.{20}/gi },
    { label: 'termination (G)',  re: /.{120}termination.{20}/gi },
    { label: 'remitted (F)',     re: /.{40}remitted.{120}/gi },
    { label: 'th day (F)',       re: /.{60}th\s+day.{40}/gi },
    { label: 'late charge (E)',  re: /.{40}late\s+(?:charge|fee).{120}/gi },
    { label: 'sublet (subleasing)', re: /.{40}sublet.{80}/gi },
  ]
  for (const a of anchors) {
    console.log(`\n=== ${a.label} ===`)
    const matches = [...text.matchAll(a.re)]
    if (matches.length === 0) { console.log('  (no match)'); continue }
    for (const m of matches.slice(0, 3)) console.log(`  ${JSON.stringify(m[0])}`)
  }
}
main().catch(e => { console.error(e); process.exit(1) })
