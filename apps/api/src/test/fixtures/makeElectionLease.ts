/**
 * S622: a synthetic lease built to be HARD in exactly the ways Oak Park's is.
 *
 * Nic: "if our engine can be trained on this version of complication, it should
 * be able to handle almost anybody's leases because it's going through a lot in
 * that one section." The section is the hardest thing in the document and it had
 * no test, because the detector needs a parsed PDF and the repo has no lease to
 * parse. So this builds one.
 *
 * Every difficulty from the real lease is reproduced deliberately:
 *   - a "(check one)" election whose options are split ACROSS A PAGE BREAK
 *   - a multi-line option, so the scan cannot stop at the first continuation
 *   - a SECOND "(check one)" nested inside the first option, indented
 *   - the nested election's own two options also split across the break
 *   - fill-in blanks inside each branch, which must bind to that branch
 *   - a numbered clause after the section, which is where it must stop
 *
 * Nothing here is Oak Park's wording — it is the SHAPE that has to keep working.
 */
import { PDFDocument, StandardFonts } from 'pdf-lib'

const OUTER_X = 43
const INNER_X = 79

export async function makeElectionLease(): Promise<Buffer> {
  const doc = await PDFDocument.create()
  const font = await doc.embedFont(StandardFonts.Helvetica)
  const put = (pg: any, x: number, y: number, t: string) =>
    pg.drawText(t, { x, y, size: 9, font })

  const p1 = doc.addPage([612, 792])
  put(p1, OUTER_X, 700, '3. Occupants: The following persons may occupy the Premises ______________.')
  put(p1, OUTER_X, 660, '4. Rental Term : This Agreement shall be considered a: (check one)')
  put(p1, OUTER_X, 640, '_____ FIXED TERM. Tenant may occupy the Premises beginning on ______________')
  put(p1, OUTER_X, 626, 'and ending on ______________ ("Rental Term"). At the end of the Rental Term,')
  put(p1, OUTER_X, 612, 'the Tenant: (check one)')
  put(p1, INNER_X, 596, '____ May continue to rent the Premises on a month-to-month basis; or')

  const p2 = doc.addPage([612, 792])
  put(p2, INNER_X, 720, '____ Must vacate the Premises.')
  put(p2, OUTER_X, 690, '_____ MONTH-TO-MONTH TERM. Tenant may occupy the Premises on a month-to-month')
  put(p2, OUTER_X, 676, 'rental beginning on ______________ and ending upon ______ days notice.')
  put(p2, OUTER_X, 640, '5. Rent: Tenant shall pay monthly installments of $__________ each month.')

  return Buffer.from(await doc.save())
}
