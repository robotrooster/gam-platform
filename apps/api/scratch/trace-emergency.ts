import fs from 'fs'
import { extractPositionedText } from '../src/lib/pdfText.js'
import { joinPageItems, joinPageItemsRelaxed } from '../src/jobs/leaseParser/itemJoin.js'
import { isNoiseValue } from '../src/jobs/leaseParser/anchors.js'

const Y_TOL = 6
const labelPattern = /Emergency Contact:/i

async function main() {
  const buf = fs.readFileSync(process.argv[2])
  const pdf = await extractPositionedText(buf)

  for (const page of pdf.pages) {
    const relaxed = joinPageItemsRelaxed(page)
    const strict  = joinPageItems(page)

    for (const prose of relaxed) {
      const m = prose.text.match(labelPattern)
      if (!m || m.index === undefined) continue

      const totalChars = prose.text.length
      const totalWidth = prose.x2 - prose.x
      const labelEndChar = m.index + m[0].length
      const labelEndX = prose.x + (labelEndChar / totalChars) * totalWidth

      console.log(`\n=== page ${page.pageNumber} ===`)
      console.log(`label match: ${JSON.stringify(prose.text)}`)
      console.log(`  prose.x=${prose.x.toFixed(1)} prose.x2=${prose.x2.toFixed(1)} prose.y=${prose.y.toFixed(1)}`)
      console.log(`  labelEndX=${labelEndX.toFixed(1)}`)

      // Same-line candidates
      console.log(`\n--- same-line candidates ---`)
      const sameLine = strict.filter(it => it !== prose && Math.abs(it.y - prose.y) < Y_TOL)
      for (const it of sameLine) {
        const dy = it.y - prose.y
        const dx = it.x - labelEndX
        const passes = {
          xOk:    it.x >= prose.x,
          rightOk: dx < 600,
          notLabel: !labelPattern.test(it.text),
          notNoise: !isNoiseValue(it),
          nonempty: it.text.trim().length > 0,
        }
        const allPass = Object.values(passes).every(Boolean)
        console.log(`  ${allPass ? 'PASS' : 'FAIL'} y=${it.y.toFixed(1)} (dy=${dy.toFixed(1)}) x=${it.x.toFixed(1)} (dx=${dx.toFixed(1)}) ${JSON.stringify(it.text)}`)
        if (!allPass) {
          const fails = Object.entries(passes).filter(([_, v]) => !v).map(([k]) => k)
          console.log(`     fails: ${fails.join(',')}`)
        }
      }

      // Below candidates
      console.log(`\n--- below candidates (within 30pt) ---`)
      const below = strict.filter(it => it !== prose && prose.y - it.y > 0 && prose.y - it.y < 30)
      for (const it of below) {
        const dy = prose.y - it.y
        console.log(`  y=${it.y.toFixed(1)} (dy=${dy.toFixed(1)}) x=${it.x.toFixed(1)} ${JSON.stringify(it.text)}`)
      }
    }
  }
}
main().catch(e => { console.error(e); process.exit(1) })
