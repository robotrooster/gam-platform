import fs from 'fs'
import { extractPositionedText } from '../src/lib/pdfText.js'
import { joinPageItems, joinPageItemsRelaxed } from '../src/jobs/leaseParser/itemJoin.js'
import { isNoiseValue, findFieldByLabel } from '../src/jobs/leaseParser/anchors.js'

async function main() {
  const buf = fs.readFileSync(process.argv[2])
  const pdf = await extractPositionedText(buf)
  const page1 = pdf.pages[0]

  console.log('=== Direct findFieldByLabel call (loose shape, same as production) ===')
  const hit1 = findFieldByLabel(page1, {
    labelPattern: /Emergency Contact:/i,
    valueShape:   /[A-Za-z]/,
    valuePosition: 'right_then_below',
  })
  console.log(`hit:`, hit1 ? { text: hit1.value.text, matchKind: hit1.matchKind, x: hit1.value.x, y: hit1.value.y } : null)

  console.log('\n=== Without valueShape ===')
  const hit2 = findFieldByLabel(page1, {
    labelPattern: /Emergency Contact:/i,
    valuePosition: 'right_then_below',
  })
  console.log(`hit:`, hit2 ? { text: hit2.value.text, matchKind: hit2.matchKind, x: hit2.value.x, y: hit2.value.y } : null)

  console.log('\n=== Same-line iteration with full filter (including valueShape) ===')
  const Y_TOL = 6
  const labelPattern = /Emergency Contact:/i
  const valueShape = /[A-Za-z]/
  const relaxed = joinPageItemsRelaxed(page1)
  const strict = joinPageItems(page1)
  for (const prose of relaxed) {
    const m = prose.text.match(labelPattern)
    if (!m || m.index === undefined) continue
    const totalChars = prose.text.length
    const totalWidth = prose.x2 - prose.x
    const labelEndChar = m.index + m[0].length
    const labelEndX = prose.x + (labelEndChar / totalChars) * totalWidth
    console.log(`label-prose: ${JSON.stringify(prose.text.slice(0, 50))} y=${prose.y.toFixed(1)} labelEndX=${labelEndX.toFixed(1)}`)

    const sameLine = strict.filter(it => it !== prose && Math.abs(it.y - prose.y) < Y_TOL)
    for (const it of sameLine) {
      const passes = {
        xOk:       it.x >= prose.x,
        rightOk:   it.x - labelEndX < 600,
        notLabel:  !labelPattern.test(it.text),
        notNoise:  !isNoiseValue(it),
        nonempty:  it.text.trim().length > 0,
        shapeOk:   valueShape.test(it.text.trim()),
      }
      const all = Object.values(passes).every(Boolean)
      console.log(`  ${all ? 'PASS' : 'FAIL'} y=${it.y.toFixed(1)} x=${it.x.toFixed(1)} ${JSON.stringify(it.text)}`)
      if (!all) {
        const fails = Object.entries(passes).filter(([_, v]) => !v).map(([k]) => k)
        console.log(`     fails: ${fails.join(',')}`)
      }
    }
  }
}
main().catch(e => { console.error(e); process.exit(1) })
