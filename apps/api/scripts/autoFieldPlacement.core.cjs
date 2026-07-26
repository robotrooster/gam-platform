// Auto field-placement core (S555). Deterministic detection + positioning of
// e-sign field boxes on a raw lease PDF. Standalone (cjs) so it can be iterated
// against real PDFs and rendered; the validated logic ports to
// services/autoFieldPlacement.ts. See ~/gam/AUTO_FIELD_PLACEMENT_SPEC.md.
//
// Coordinates: ESignPage editor space — PDF points, TOP-LEFT origin, y-DOWN
// (pdfjs baseline y-up flipped: y = H - y_text - h). Box width = the REAL
// rendered extent of the blank underscores (sub-item proportional), never an
// estimate and never crossing into printed text (spec rule #1).

const UNDERSCORE_RUN = /_{3,}/g;
const SLASHDATE = /\/\s*\/|\/\s*$/; // "/ /" style date placeholders

function columnFor(ctx) {
  const c = ctx.toLowerCase();
  if (/apartment\s*#|apt\.?\s*#|space no\.?|unit\s*#/.test(c)) return 'unit_number';
  if (/beginning on/.test(c)) return 'start_date';
  if (/ending on|ending upon|ending/.test(c)) return 'end_date';
  if (/installments of|monthly installments|rental rate|first month.?s rent/.test(c)) return 'rent_amount';
  if (/security deposit/.test(c)) return 'security_deposit';
  if (/pet deposit/.test(c)) return 'pet_deposit';
  if (/pet fee/.test(c)) return 'pet_fee';
  if (/guest fee/.test(c)) return 'other_fee';
  return null;
}

// Sub-item underscore runs, positioned proportionally within the item.
function blankRuns(it) {
  const runs = [];
  const charW = it.w / Math.max(1, it.str.length);
  let m;
  UNDERSCORE_RUN.lastIndex = 0;
  while ((m = UNDERSCORE_RUN.exec(it.str))) {
    runs.push({ x: it.x + m.index * charW, width: Math.max(24, m[0].length * charW), before: it.str.slice(0, m.index) });
  }
  return runs;
}

async function detect(pdfjs, fontUrl, pdfBuffer) {
  const doc = await pdfjs.getDocument({
    data: new Uint8Array(pdfBuffer), standardFontDataUrl: fontUrl,
    useSystemFonts: false, isEvalSupported: false,
  }).promise;

  const fields = [];
  const pageHasSignature = {};

  for (let p = 1; p <= doc.numPages; p++) {
    const page = await doc.getPage(p);
    const vp = page.getViewport({ scale: 1 });
    const H = vp.height, W = vp.width;
    const tc = await page.getTextContent();
    const items = tc.items
      .filter(i => typeof i.str === 'string' && i.str.length)
      .map(i => ({ str: i.str, x: i.transform[4], y: i.transform[5], x2: i.transform[4] + (i.width || 0), w: i.width || 0, h: i.height || 10 }));

    // lines by baseline y
    const lines = [];
    for (const it of items.slice().sort((a, b) => b.y - a.y || a.x - b.x)) {
      let line = lines.find(l => Math.abs(l.y - it.y) < 3);
      if (!line) { line = { y: it.y, items: [] }; lines.push(line); }
      line.items.push(it);
    }
    lines.forEach(l => l.items.sort((a, b) => a.x - b.x));

    // signature/role labels on this page: {role, x} from "... SIGNATURE"
    const sigLabels = [];
    for (const line of lines) {
      const t = line.items.map(i => i.str).join(' ');
      const lo = t.toLowerCase();
      if (/signature/.test(lo)) {
        // find each SIGNATURE token's x and the role word before it
        for (let i = 0; i < line.items.length; i++) {
          if (/signature/i.test(line.items[i].str)) {
            const pre = line.items.slice(Math.max(0, i - 3), i + 1).map(x => x.str).join(' ').toLowerCase();
            sigLabels.push({ role: /landlord/.test(pre) ? 'landlord' : 'tenant', x: line.items[i].x, y: line.items[i].y });
          }
        }
      }
    }
    const roleByX = (bx, by) => {
      // nearest signature label above the box, by horizontal distance
      const cand = sigLabels.filter(s => s.y > by - 6).sort((a, b) => Math.abs(a.x - bx) - Math.abs(b.x - bx));
      return cand[0]?.role || 'tenant';
    };

    const flipY = (it) => Math.round(H - it.y - it.h - 2);

    for (const line of lines) {
      const lineText = line.items.map(i => i.str).join(' ');
      const loLine = lineText.toLowerCase();
      const aboveText = lines.filter(l => l.y > line.y && l.y - line.y < 24)
        .flatMap(l => l.items).map(i => i.str).join(' ').toLowerCase();
      // signature headers ("TENANT(S) SIGNATURE:") sit farther above the line
      const sigAboveText = lines.filter(l => l.y > line.y && l.y - line.y < 48)
        .flatMap(l => l.items).map(i => i.str).join(' ').toLowerCase();
      const belowText = lines.filter(l => l.y < line.y && line.y - l.y < 16)
        .flatMap(l => l.items).map(i => i.str).join(' ').toLowerCase();

      // occupancy / tenant-name multi-name line → 4 boxes (spec #2)
      // Only the actual name-ENTRY lines (not prose that merely says "occupy"
      // or "persons staying N days"), else inline term blanks get name-split.
      const isNameLine = /following named persons|names of all persons|names of all|tenant\(s\):\s*_|mailing address.*tenant\(s\)/i.test(lineText)
        || /^\s*tenant\(s\):/i.test(lineText);

      for (let k = 0; k < line.items.length; k++) {
        const it = line.items[k];
        if (!/_{3,}/.test(it.str)) continue;
        const nextText = line.items.slice(k + 1).find(o => !/^[_\s]+$/.test(o.str));

        for (const run of blankRuns(it)) {
          // clamp right edge so it never crosses the next real text token
          let right = run.x + run.width;
          if (nextText && nextText.x > run.x) right = Math.min(right, nextText.x - 2);
          right = Math.min(right, W - 20);
          const width = Math.max(20, Math.round(right - run.x));
          if (width < 20) continue;

          const leftCtx = (line.items.slice(0, k).map(i => i.str).join(' ') + ' ' + run.before).trim();

          // ---- classify ----
          let fieldType = 'text', signerRole = 'landlord', leaseColumn = columnFor(leftCtx), label = null;
          const sigNear = (/signature/.test(sigAboveText) || /signature/.test(leftCtx.toLowerCase())) && run.width > 100;
          const dateNear = /\bdate\b/.test(belowText) || /\bdate\b/.test(leftCtx.toLowerCase());

          if (isNameLine && run.width > 60) {
            // split this long blank into 4 tenant-name boxes
            const total = Math.min(right, W - 30) - run.x;
            const bw = Math.max(60, Math.floor(total / 4) - 6);
            for (let n = 0; n < 4; n++) {
              fields.push({ page: p, x: Math.round(run.x + n * (bw + 6)), y: flipY(it), width: bw, height: 20,
                fieldType: 'text', signerRole: 'tenant', leaseColumn: n === 0 ? 'tenant_name' : null, label: `Occupant ${n + 1}` });
            }
            continue;
          }
          if (sigNear) {
            fieldType = 'signature';
            signerRole = roleByX(run.x, it.y);
            leaseColumn = signerRole === 'landlord' ? 'landlord_signature' : 'tenant_signature';
            pageHasSignature[p] = true;
          } else if (dateNear) {
            fieldType = 'date'; leaseColumn = 'date_signed'; signerRole = roleByX(run.x, it.y);
          } else if (leaseColumn === 'start_date' || leaseColumn === 'end_date') {
            fieldType = 'date';
          }

          fields.push({ page: p, x: Math.round(run.x), y: flipY(it), width, height: 20, fieldType, signerRole, leaseColumn, label });
        }
      }

      // date placeholders written as "/ /" (label "Date" below) → date_signed box
      if (SLASHDATE.test(lineText) && /\bdate\b/.test(belowText)) {
        const slash = line.items.find(i => i.str.includes('/'));
        if (slash) {
          fields.push({ page: p, x: Math.round(slash.x - 60), y: flipY(slash), width: 90, height: 18,
            fieldType: 'date', signerRole: roleByX(slash.x, slash.y), leaseColumn: 'date_signed', label: 'Date' });
        }
      }
    }
    page.cleanup && page.cleanup();
  }

  // per-page TENANT initials on no-signature pages (spec #5), bottom-right,
  // horizontal row of up to 4 (unused signer roles drop at send, esign.ts:281)
  for (let p = 1; p <= doc.numPages; p++) {
    if (pageHasSignature[p]) continue;
    const page = await doc.getPage(p);
    const vp = page.getViewport({ scale: 1 });
    const bw = 44, gap = 6;
    const startX = vp.width - 36 - (bw * 4 + gap * 3);
    const y = vp.height - 32;
    for (let n = 0; n < 4; n++) {
      fields.push({ page: p, x: Math.round(startX + n * (bw + gap)), y: Math.round(y), width: bw, height: 18,
        fieldType: 'initials', signerRole: 'tenant', leaseColumn: 'tenant_initial', label: `Initial ${n + 1}` });
    }
    page.cleanup && page.cleanup();
  }

  return { pageCount: doc.numPages, fields: resolveOverlaps(fields) };
}

// Hard rule (Nic S555): no two boxes may overlap. For any intersecting pair,
// trim the right edge of the left/upper box back to the other's left edge.
// If that shrinks it below a usable width, drop it.
function resolveOverlaps(fields) {
  const MINW = 18, GAP = 2;
  const intersect = (a, b) =>
    a.x < b.x + b.width && b.x < a.x + a.width &&
    a.y < b.y + b.height && b.y < a.y + a.height;
  const out = [];
  // process page by page, left-to-right / top-to-bottom for determinism
  const byPage = {};
  for (const f of fields) (byPage[f.page] = byPage[f.page] || []).push(f);
  for (const p of Object.keys(byPage)) {
    const boxes = byPage[p].sort((a, b) => a.y - b.y || a.x - b.x);
    for (let i = 0; i < boxes.length; i++) {
      const a = boxes[i];
      if (a._drop) continue;
      for (let j = 0; j < boxes.length; j++) {
        if (i === j) continue;
        const b = boxes[j];
        if (b._drop) continue;
        if (!intersect(a, b)) continue;
        // trim whichever starts further right (keep the earlier-starting box whole)
        const left = a.x <= b.x ? a : b;
        const right = a.x <= b.x ? b : a;
        const newW = right.x - GAP - left.x;
        if (newW >= MINW) left.width = newW;
        else left._drop = true; // can't fit without overlap
      }
    }
    for (const b of boxes) if (!b._drop) { delete b._drop; out.push(b); }
  }
  return out;
}

module.exports = { detect };
