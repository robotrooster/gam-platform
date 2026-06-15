// @ts-nocheck
/**
 * S453 batch-3 verbatim statute parsers — KS WV ID NH ME MT RI DE SD VT.
 * Per-state parsers developed + live-tested by subagents, then integrated.
 * NE deferred (its whole-chapter page = all of Real Property Ch.76, ~2000
 * non-LL/T sections — needs range-filtering). Reuses runState.
 * Run: cd apps/api && node -r ts-node/register src/db/stateLawCorpusBatch3.ts <STATE|ALL>
 */

import { runState } from './ingestStateLawCorpus'

const SRC_DATE = '2026-06-13'

// ---- KS (111 sections tested) ----
function parseKS(html) {
  const sections = [];
  if (!html || typeof html !== 'string') return sections;

  // Decode HTML entities (named + numeric decimal + hex)
  function decodeEntities(s) {
    if (!s) return s;
    return s
      .replace(/&#x([0-9a-fA-F]+);/g, function (_, h) { return String.fromCodePoint(parseInt(h, 16)); })
      .replace(/&#(\d+);/g, function (_, d) { return String.fromCodePoint(parseInt(d, 10)); })
      .replace(/&nbsp;/gi, ' ')
      .replace(/&sect;/gi, '§')
      .replace(/&mdash;/gi, '—')
      .replace(/&ndash;/gi, '–')
      .replace(/&rsquo;/gi, '’')
      .replace(/&lsquo;/gi, '‘')
      .replace(/&rdquo;/gi, '”')
      .replace(/&ldquo;/gi, '“')
      .replace(/&quot;/gi, '"')
      .replace(/&apos;/gi, "'")
      .replace(/&lt;/gi, '<')
      .replace(/&gt;/gi, '>')
      .replace(/&amp;/gi, '&'); // amp last
  }

  // Strip tags to readable text. Convert block-closers + <br> to newlines.
  function tagsToText(frag) {
    if (!frag) return '';
    let t = frag;
    t = t.replace(/<!--[\s\S]*?-->/g, '');
    t = t.replace(/<br\s*\/?>/gi, '\n');
    t = t.replace(/<\/(p|div|li|tr|h[1-6])\s*>/gi, '\n');
    t = t.replace(/<[^>]+>/g, '');
    t = decodeEntities(t);
    // collapse runs of spaces/tabs (incl. nbsp already decoded to space), keep newlines
    t = t.replace(/[ \t\f\v ]+/g, ' ');
    // collapse blocks of whitespace-only newlines to a single newline
    t = t.replace(/[ \t]*\n[ \t]*(\n[ \t]*)*/g, '\n');
    t = t.replace(/\n{2,}/g, '\n');
    return t.trim();
  }

  // Isolate the print/content block so sidebar/nav <p> never bleed in.
  let scope = html;
  const printIdx = html.indexOf('id="print"');
  if (printIdx !== -1) scope = html.slice(printIdx);

  // Section number (strip trailing period)
  let number = null;
  const numM = scope.match(/<span\s+class="stat_number"\s*>([\s\S]*?)<\/span>/i);
  if (numM) number = tagsToText(numM[1]).replace(/\.\s*$/, '').trim();

  // Title / catchline
  let title = null;
  const capM = scope.match(/<span\s+class="stat_caption"\s*>([\s\S]*?)<\/span>/i);
  if (capM) {
    title = tagsToText(capM[1]).replace(/\s+/g, ' ').trim();
    if (!title) title = null;
  }

  // Collect every <p class="ksa_stat"> block (exact class — excludes
  // ksa_stat_hist history + ksa_8pt_body annotations). The first block also
  // holds the number + caption spans, which we strip out.
  const bodyParts = [];
  const pRe = /<p\s+class="ksa_stat"\s*>([\s\S]*?)<\/p>/gi;
  let pm;
  while ((pm = pRe.exec(scope)) !== null) {
    let inner = pm[1];
    inner = inner.replace(/<span\s+class="stat_number"\s*>[\s\S]*?<\/span>/i, '');
    inner = inner.replace(/<span\s+class="stat_caption"\s*>[\s\S]*?<\/span>/i, '');
    const txt = tagsToText(inner);
    if (txt) bodyParts.push(txt);
  }

  let text = bodyParts.join('\n').replace(/\n{2,}/g, '\n').trim();

  if (!number) return sections;
  if (!text || text.length < 20) return sections; // skip repealed/empty/404

  sections.push({ number: number, title: title, text: text });
  return sections;
}

// ---- WV (61 sections tested) ----
function parseWV(html) {
  const sections = [];
  if (typeof html !== "string" || !html) return sections;

  function decodeEntities(s) {
    if (!s) return s;
    s = s.replace(/&#x([0-9a-fA-F]+);/g, function (_, h) {
      var cp = parseInt(h, 16);
      return Number.isFinite(cp) ? String.fromCodePoint(cp) : _;
    });
    s = s.replace(/&#(\d+);/g, function (_, d) {
      var cp = parseInt(d, 10);
      return Number.isFinite(cp) ? String.fromCodePoint(cp) : _;
    });
    var named = {
      "&nbsp;": " ", "&amp;": "&", "&lt;": "<", "&gt;": ">",
      "&quot;": '"', "&apos;": "'", "&sect;": "§",
      "&mdash;": "—", "&ndash;": "–",
      "&ldquo;": "“", "&rdquo;": "”",
      "&lsquo;": "‘", "&rsquo;": "’",
      "&hellip;": "…", "&deg;": "°"
    };
    s = s.replace(/&[a-zA-Z]+;/g, function (e) { return (e in named ? named[e] : e); });
    return s;
  }

  function htmlToText(frag) {
    var t = frag;
    t = t.replace(/<script[\s\S]*?<\/script>/gi, "");
    t = t.replace(/<style[\s\S]*?<\/style>/gi, "");
    t = t.replace(/<br\s*\/?>/gi, "\n");
    t = t.replace(/<\/(p|div|li|h[1-6]|tr|ul|ol|blockquote|section)\s*>/gi, "\n");
    t = t.replace(/<[^>]+>/g, "");
    t = decodeEntities(t);
    t = t.replace(/ /g, " ");
    t = t.replace(/\r\n?/g, "\n");
    t = t.replace(/[ \t]+/g, " ");
    t = t.replace(/[ \t]*\n[ \t]*/g, "\n");
    t = t.replace(/\n{3,}/g, "\n\n");
    return t.trim();
  }

  var divRe = /<div\s+class=['"]sectiontext[^'"]*['"]\s*>([\s\S]*?)<\/div>/gi;
  var dm;
  while ((dm = divRe.exec(html)) !== null) {
    var inner = dm[1];

    var h4m = inner.match(/<h4[^>]*>([\s\S]*?)<\/h4>/i);
    if (!h4m) continue;
    var headRaw = decodeEntities(h4m[1].replace(/<[^>]+>/g, ""))
      .replace(/ /g, " ")
      .replace(/\s+/g, " ")
      .trim();

    var hm = headRaw.match(/^[§\s]*([0-9A-Za-z]+(?:-[0-9A-Za-z]+)+)\s*\.?\s*([\s\S]*)$/);
    var number, title;
    if (hm) {
      number = hm[1].trim();
      title = hm[2].trim();
    } else {
      number = headRaw.replace(/^[§\s]*/, "").replace(/\s*\.?\s*$/, "").trim();
      title = "";
    }
    title = title.replace(/\s*\.\s*$/, "").trim();
    if (!title) title = null;

    var h4end = inner.toLowerCase().indexOf("</h4>");
    var afterH4 = h4end >= 0 ? inner.slice(h4end + 5) : inner;
    var text = htmlToText(afterH4);

    if (!number) continue;
    if (!text || text.length < 20) continue;

    sections.push({ number: number, title: title, text: text });
  }

  return sections;
}

// ---- ID (99 sections tested) ----
function parseID(html) {
  var sections = [];
  if (!html) return sections;

  // Idaho serves an embedded Arbortext HTML doc inside the WordPress shell.
  // The statute content lives between the embedded <body ...> and </body>.
  var bodyStart = html.search(/onunload="CloseFltwin\(\)"\s*>/);
  if (bodyStart === -1) bodyStart = html.search(/<div class="pgbrk"/);
  var content = bodyStart === -1 ? html : html.slice(bodyStart);
  var bodyEnd = content.indexOf("</body>");
  if (bodyEnd !== -1) content = content.slice(0, bodyEnd);

  function decodeEntities(s) {
    if (!s) return s;
    s = s.replace(/&#x([0-9a-fA-F]+);/g, function (_, h) {
      return String.fromCodePoint(parseInt(h, 16));
    });
    s = s.replace(/&#(\d+);/g, function (_, d) {
      return String.fromCodePoint(parseInt(d, 10));
    });
    var named = {
      nbsp: " ", amp: "&", lt: "<", gt: ">", quot: '"',
      apos: "'", sect: "§", sec: "§", ndash: "–",
      mdash: "—", lsquo: "‘", rsquo: "’",
      ldquo: "“", rdquo: "”", hellip: "…",
      deg: "°", para: "¶", reg: "®", copy: "©",
      trade: "™", frac12: "½", frac14: "¼",
      frac34: "¾", times: "×"
    };
    s = s.replace(/&([a-zA-Z][a-zA-Z0-9]*);/g, function (m, n) {
      return Object.prototype.hasOwnProperty.call(named, n) ? named[n] : m;
    });
    return s;
  }

  function tagsToText(frag) {
    if (!frag) return "";
    frag = frag.replace(/<br\s*\/?>/gi, "\n");
    frag = frag.replace(/<\/(p|div|li|tr|h[1-6])>/gi, "\n");
    frag = frag.replace(/<[^>]*>/g, "");
    frag = decodeEntities(frag);
    frag = frag.replace(/[ \t\f\v ]+/g, " ");
    frag = frag.replace(/ *\n */g, "\n");
    frag = frag.replace(/\n{3,}/g, "\n\n");
    return frag.trim();
  }

  var divRe = /<div\b([^>]*)>/gi;
  var blocks = [];
  var m;
  while ((m = divRe.exec(content))) {
    blocks.push({ style: m[1] || "", start: m.index, openEnd: divRe.lastIndex });
  }

  function innerOf(openEnd) {
    var depth = 1;
    var re = /<\/?div\b[^>]*>/gi;
    re.lastIndex = openEnd;
    var mm;
    while ((mm = re.exec(content))) {
      if (mm[0].charAt(1) === "/") {
        depth--;
        if (depth === 0) return content.slice(openEnd, mm.index);
      } else {
        depth++;
      }
    }
    return content.slice(openEnd);
  }

  // Section-number pattern at the very start of a section's lead div span.
  // e.g. 55-2002., 6-303A., 6-311C.
  var numLead = /^\s*(?:<[^>]*>\s*)*([0-9]+-[0-9]+[A-Za-z]?)\s*\.(?:&nbsp;|\s| )*/;

  for (var i = 0; i < blocks.length; i++) {
    var b = blocks[i];
    var inner = innerOf(b.openEnd);
    var leadMatch = inner.match(numLead);
    var isLead = leadMatch && /padding-top:\s*12pt/i.test(b.style) && /text-indent/i.test(b.style);
    if (!isLead) continue;

    var number = leadMatch[1];

    var title = null;
    var catchRe = /<span[^>]*text-transform:\s*uppercase[^>]*>([\s\S]*?)<\/span>/i;
    var cm = inner.match(catchRe);
    if (cm) {
      var t = tagsToText(cm[1]).replace(/\s*\.\s*$/, "").trim();
      title = t.length ? t : null;
    }

    var leadRest = inner.replace(numLead, "").replace(catchRe, "");
    var parts = [leadRest];

    var j = i + 1;
    for (; j < blocks.length; j++) {
      var nb = blocks[j];
      var ninner = innerOf(nb.openEnd);
      if (ninner.match(numLead) && /padding-top:\s*12pt/i.test(nb.style) && /text-indent/i.test(nb.style)) {
        break;
      }
      var ntext = tagsToText(ninner);
      if (/^History:/i.test(ntext)) break;
      if (!/Courier New/i.test(nb.style) && !/Courier New/i.test(ninner) &&
          !/text-indent/i.test(nb.style) && !/padding-left/i.test(nb.style)) {
        if (!/text-align:\s*justify/i.test(nb.style)) break;
      }
      parts.push(ninner);
    }

    var text = tagsToText(parts.join("\n"));
    if (text.length < 20) continue;

    sections.push({ number: number, title: title, text: text });
    i = j - 1;
  }

  return sections;
}

// ---- NH (106 sections tested) ----
function parseNH(html) {
  if (!html || typeof html !== 'string') return [];

  // ---- entity decode (numeric dec, numeric hex, named) ----
  function decodeEntities(s) {
    if (s.indexOf('&') === -1) return s;
    s = s.replace(/&#x([0-9a-fA-F]+);/g, function (_, h) {
      return cpToStr(parseInt(h, 16));
    });
    s = s.replace(/&#(\d+);/g, function (_, d) {
      return cpToStr(parseInt(d, 10));
    });
    var named = {
      'nbsp': ' ', 'amp': '&', 'lt': '<', 'gt': '>', 'quot': '"',
      'apos': "'", 'sect': '§', 'mdash': '—', 'ndash': '–',
      'rsquo': '’', 'lsquo': '‘', 'ldquo': '“', 'rdquo': '”',
      'hellip': '…', 'deg': '°', 'frac12': '½', 'frac14': '¼',
      'frac34': '¾', 'reg': '®', 'copy': '©', 'trade': '™',
      'eacute': 'é', 'bull': '•', 'middot': '·'
    };
    s = s.replace(/&([a-zA-Z][a-zA-Z0-9]+);/g, function (m, n) {
      var lc = n.toLowerCase();
      return Object.prototype.hasOwnProperty.call(named, lc) ? named[lc] : m;
    });
    return s;
  }
  // Map a code point to a string, remapping Windows-1252 C1 punctuation
  // (NH HTML uses &#150; = en dash as the catchline separator, &#145..148; curly quotes, etc.)
  function cpToStr(cp) {
    var win1252 = {
      128: '€', 130: '‚', 131: 'ƒ', 132: '„', 133: '…',
      134: '†', 135: '‡', 136: 'ˆ', 137: '‰', 138: 'Š',
      139: '‹', 140: 'Œ', 142: 'Ž', 145: '‘', 146: '’',
      147: '“', 148: '”', 149: '•', 150: '–', 151: '—',
      152: '˜', 153: '™', 154: 'š', 155: '›', 156: 'œ',
      158: 'ž', 159: 'Ÿ'
    };
    if (cp >= 128 && cp <= 159 && win1252[cp]) return win1252[cp];
    try { return String.fromCodePoint(cp); } catch (e) { return ''; }
  }

  // ---- strip a block of HTML to readable text ----
  function stripToText(block) {
    var s = block;
    s = s.replace(/<(script|style)\b[^>]*>[\s\S]*?<\/\1>/gi, ' ');
    s = s.replace(/<br\s*\/?>/gi, '\n');
    s = s.replace(/<\/(p|div|li|tr|h[1-6]|blockquote|td|th)\s*>/gi, '\n');
    s = s.replace(/<[^>]+>/g, '');
    s = decodeEntities(s);
    s = s.replace(/ /g, ' ');
    s = s.replace(/\r\n?/g, '\n');
    s = s.replace(/[ \t]+/g, ' ');
    s = s.replace(/[ \t]*\n[ \t]*/g, '\n');
    s = s.replace(/\n{3,}/g, '\n\n');
    return s.trim();
  }

  var sections = [];

  // Section delimiter: <center><h3>Section NUMBER</h3></center>  (NUMBER like 540-A:1, 540:1-a)
  var headRe = /<center>\s*<h3>\s*Section\s+([0-9A-Za-z:\-\.]+)\s*<\/h3>\s*<\/center>/gi;
  var heads = [];
  var m;
  while ((m = headRe.exec(html)) !== null) {
    heads.push({ number: m[1].trim(), headEnd: headRe.lastIndex, start: m.index });
  }
  if (heads.length === 0) return [];

  for (var i = 0; i < heads.length; i++) {
    var h = heads[i];
    var sliceEnd = (i + 1 < heads.length) ? heads[i + 1].start : html.length;
    var chunk = html.slice(h.headEnd, sliceEnd);

    // Title: first <b> NUM TITLE. &#150;</b> after the header
    var title = null;
    var bMatch = /<b>([\s\S]*?)<\/b>/i.exec(chunk);
    if (bMatch) {
      var t = stripToText(bMatch[1]);
      var numEsc = h.number.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      t = t.replace(new RegExp('^\\s*' + numEsc + '\\b\\s*'), '');
      // strip trailing dash separator(s) and surrounding whitespace ("Title. –")
      t = t.replace(/[–—‒―\-\s]+$/, '');
      t = t.replace(/\s+/g, ' ').trim();
      title = t.length ? t : null;
    }

    // Body: first <codesect>...</codesect>
    var bodyRaw = '';
    var cMatch = /<codesect>([\s\S]*?)<\/codesect>/i.exec(chunk);
    if (cMatch) bodyRaw = cMatch[1];
    var text = stripToText(bodyRaw);

    // Skip repealed/empty sections (body < 20 chars). Whole-section repeals
    // have an empty <codesect></codesect> with the repeal note in the <b> title.
    if (text.length < 20) continue;

    sections.push({ number: h.number, title: title, text: text });
  }

  return sections;
}

// ---- ME (50 sections tested) ----
function parseME(html) {
  var sections = [];
  if (!html) return sections;

  // ---- entity decoder ----
  function decode(s) {
    if (!s) return s;
    s = s.replace(/&#x([0-9a-fA-F]+);/g, function (_, h) {
      return String.fromCodePoint(parseInt(h, 16));
    });
    s = s.replace(/&#(\d+);/g, function (_, d) {
      return String.fromCodePoint(parseInt(d, 10));
    });
    var named = {
      'nbsp': ' ', 'sect': '§', 'amp': '&', 'lt': '<', 'gt': '>',
      'quot': '"', 'apos': "'", 'mdash': '—', 'ndash': '–',
      'lsquo': '‘', 'rsquo': '’', 'ldquo': '“', 'rdquo': '”',
      'hellip': '…', 'copy': '©', 'reg': '®', 'deg': '°',
      'frac12': '½', 'frac14': '¼', 'frac34': '¾', 'times': '×'
    };
    s = s.replace(/&([a-zA-Z][a-zA-Z0-9]*);/g, function (m, name) {
      var key = name.toLowerCase();
      return Object.prototype.hasOwnProperty.call(named, key) ? named[key] : m;
    });
    return s;
  }

  // ---- tag-stripper that preserves block structure as newlines ----
  var NLMARK = ''; // sentinel marking genuine block-level newlines
  function toText(frag) {
    if (!frag) return '';
    var t = frag;
    // Strip legislative-history annotations (not verbatim statute text):
    //   <span class="bhistory">[PL 1977, c. 401, sec.4 (NEW).]</span>
    //   <div class="qhistory">SECTION HISTORY ...</div>
    t = t.replace(/<span class="bhistory"[^>]*>[\s\S]*?<\/span>/gi, '');
    t = t.replace(/<div class="qhistory"[\s\S]*$/i, ''); // qhistory + everything after
    t = t.replace(/<span class="hist_chapter"[^>]*>[\s\S]*?<\/span>/gi, '');
    // Subsection / paragraph labels stay INLINE with the text that follows them.
    // The label <span> sits immediately before the body text in the same block,
    // so dropping just the tags (no newline) lets whitespace-collapse join them:
    //   "1. Definition. As used in this section ..."  /  "A. A condition ..."
    t = t.replace(/<span class="headnote"[^>]*>/gi, '');
    t = t.replace(/<span class="(?:let|num|sublet|subnum)para_id"[^>]*>/gi, '');
    // Block-closing tags -> sentinel newline (so subsection structure survives)
    t = t.replace(/<\/(p|div|li|h[1-6]|tr|blockquote)>/gi, NLMARK);
    t = t.replace(/<br\s*\/?>/gi, NLMARK);
    // Strip all remaining tags
    t = t.replace(/<[^>]+>/g, '');
    t = decode(t);
    // Collapse ALL real whitespace (incl. source-formatting newlines) to spaces
    t = t.replace(/\s+/g, ' ');
    // Restore genuine block newlines from the sentinel
    t = t.split(NLMARK).join('\n');
    // Trim each line, drop empty lines
    var lines = t.split('\n').map(function (l) { return l.trim(); }).filter(function (l) { return l.length > 0; });
    return lines.join('\n').trim();
  }

  // ---- locate each MRSSection block ----
  var sectRe = /<div class="col-sm-[0-9]+ MRSSection[^"]*">/gi;
  var m;
  var starts = [];
  while ((m = sectRe.exec(html)) !== null) {
    starts.push({ idx: m.index, after: sectRe.lastIndex });
  }
  if (starts.length === 0) return sections;

  for (var si = 0; si < starts.length; si++) {
    var blockStart = starts[si].after;
    // block ends at next MRSSection start, or EOF
    var blockEnd = (si + 1 < starts.length) ? starts[si + 1].idx : html.length;
    var block = html.slice(blockStart, blockEnd);
    // cut off at the page footer if it falls within this (last) block
    var footIdx = block.search(/<div class="row"[^>]*>\s*<div class="col-sm-10/i);
    if (footIdx !== -1) block = block.slice(0, footIdx);

    // ---- heading: <h3 class="heading_section">§NNN. Title</h3>
    var hMatch = block.match(/<h3 class="heading_section"[^>]*>([\s\S]*?)<\/h3>/i);
    if (!hMatch) continue;
    var headRaw = decode(hMatch[1].replace(/<[^>]+>/g, ' ')).replace(/\s+/g, ' ').trim();
    // headRaw like "§6021. Implied warranty and covenant of habitability"
    headRaw = headRaw.replace(/^§\s*/, ''); // drop leading section sign
    var number = null, title = null;
    var numTitle = headRaw.match(/^([0-9A-Za-z][0-9A-Za-z\-]*?)\.\s*([\s\S]*)$/);
    if (numTitle) {
      number = numTitle[1].trim();
      title = numTitle[2].trim();
      if (title.length === 0) title = null;
    } else {
      // fallback: bare number with no catchline
      var sp = headRaw.match(/^([0-9A-Za-z\-]+)\.?\s*([\s\S]*)$/);
      if (sp) { number = sp[1].trim(); title = (sp[2] || '').trim() || null; }
    }
    if (!number) continue;

    // ---- body: everything after the </h3>
    var bodyStart = block.indexOf('</h3>');
    var bodyFrag = bodyStart !== -1 ? block.slice(bodyStart + 5) : '';
    var text = toText(bodyFrag);

    // skip TOC/nav/repealed-empty bodies (e.g. "(REPEALED)")
    if (!text || text.length < 20) continue;

    sections.push({ number: number, title: title, text: text });
  }

  return sections;
}

// ---- MT (168 sections tested) ----
function parseMT(html) {
  var sections = [];

  // Decode HTML entities (named + numeric decimal + hex)
  function decodeEntities(s) {
    if (!s) return s;
    var named = {
      'nbsp': ' ', 'amp': '&', 'lt': '<', 'gt': '>', 'quot': '"',
      'apos': "'", 'sect': '§', 'mdash': '—', 'ndash': '–',
      'lsquo': '‘', 'rsquo': '’', 'ldquo': '“', 'rdquo': '”',
      'hellip': '…', 'deg': '°', 'middot': '·', 'bull': '•',
      'copy': '©', 'reg': '®', 'trade': '™', 'frac12': '½',
      'frac14': '¼', 'frac34': '¾', 'emsp': ' ', 'ensp': ' ',
      'thinsp': ' ', 'para': '¶'
    };
    s = s.replace(/&#x([0-9a-fA-F]+);/g, function (m, h) {
      return String.fromCodePoint(parseInt(h, 16));
    });
    s = s.replace(/&#(\d+);/g, function (m, d) {
      return String.fromCodePoint(parseInt(d, 10));
    });
    s = s.replace(/&([a-zA-Z][a-zA-Z0-9]*);/g, function (m, name) {
      var lower = name.toLowerCase();
      return Object.prototype.hasOwnProperty.call(named, lower) ? named[lower] : m;
    });
    return s;
  }

  // Convert an HTML fragment to readable text:
  // block-closing tags + <br> -> newline; strip remaining tags; decode; collapse spaces.
  function htmlToText(frag) {
    if (!frag) return '';
    var t = frag;
    t = t.replace(/<script[\s\S]*?<\/script>/gi, '');
    t = t.replace(/<style[\s\S]*?<\/style>/gi, '');
    t = t.replace(/<br\s*\/?>/gi, '\n');
    t = t.replace(/<\/(p|div|li|ul|ol|tr|h[1-6]|blockquote|table)>/gi, '\n');
    t = t.replace(/<[^>]+>/g, '');
    t = decodeEntities(t);
    // Normalize tabs + non-breaking/em/en spaces (U+00A0, U+2003, U+2002, U+2009) to regular space
    t = t.replace(/[\t    ]/g, ' ');
    t = t.replace(/\r\n?/g, '\n');
    t = t.replace(/[ ]{2,}/g, ' ');
    t = t.replace(/[ ]*\n[ ]*/g, '\n');
    t = t.replace(/\n{3,}/g, '\n\n');
    return t.trim();
  }

  // Each MT section page holds exactly one statute section inside
  // <div class="section-content"> ... </div></div>. Find each occurrence.
  var contentRe = /<div\s+class="section-content"\s*>([\s\S]*?)<\/div>\s*<\/div>/gi;
  var m;
  while ((m = contentRe.exec(html)) !== null) {
    var block = m[1];

    // Number from the first <span class="citation">NUMBER</span> inside the catchline.
    var numMatch = block.match(/<span\s+class="catchline">\s*<span\s+class="citation">\s*([^<]+?)\s*<\/span>/i);
    var number = numMatch ? decodeEntities(numMatch[1]).trim() : null;
    if (!number) {
      var alt = block.match(/<span\s+class="citation">\s*([^<]+?)\s*<\/span>/i);
      number = alt ? decodeEntities(alt[1]).trim() : null;
    }
    if (!number) continue;
    number = number.replace(/^\s*(?:&sect;|§|Section)\s*/i, '').replace(/\.\s*$/, '').trim();

    // Title: catchline inner text after the nested citation span, up to catchline close.
    var title = null;
    var catchOpen = block.search(/<span\s+class="catchline">/i);
    if (catchOpen >= 0) {
      var afterCite = block.slice(catchOpen).replace(/^<span\s+class="catchline">/i, '');
      afterCite = afterCite.replace(/<span\s+class="citation">[\s\S]*?<\/span>/i, '');
      var titleEnd = afterCite.search(/<\/span>/i);
      if (titleEnd >= 0) {
        var rawTitle = afterCite.slice(0, titleEnd);
        rawTitle = htmlToText(rawTitle);
        rawTitle = rawTitle.replace(/^[\s.—:-]+/, '').replace(/\s*\.\s*$/, '').trim();
        if (rawTitle) title = rawTitle;
      }
    }

    // Body: section-content block with the catchline span (number + title) removed.
    var bodyFrag = block.replace(
      /<span\s+class="catchline">\s*<span\s+class="citation">[\s\S]*?<\/span>[\s\S]*?<\/span>/i,
      ''
    );
    if (bodyFrag === block) {
      bodyFrag = block.replace(/<span\s+class="catchline">[\s\S]*?<\/span>/i, '');
    }
    var text = htmlToText(bodyFrag);

    // Skip repealed/reserved/terminated/renumbered sections (title or body marker).
    if (title && /^(repealed|reserved|terminated|renumbered|omitted)\b/i.test(title)) continue;
    if (/^\(?\s*(repealed|reserved|terminated|renumbered)\b/i.test(text) && text.length < 120) continue;
    if (!text || text.length < 20) continue;

    sections.push({ number: number, title: title, text: text });
  }

  return sections;
}

// ---- RI (169 sections tested) ----
function parseRI(html) {
  var sections = [];
  if (!html || typeof html !== 'string') return sections;

  // ---- entity decoding ----
  function decodeEntities(s) {
    if (!s) return s;
    s = s.replace(/&#(\d+);/g, function (m, n) {
      try { return String.fromCodePoint(parseInt(n, 10)); } catch (e) { return m; }
    });
    s = s.replace(/&#[xX]([0-9a-fA-F]+);/g, function (m, n) {
      try { return String.fromCodePoint(parseInt(n, 16)); } catch (e) { return m; }
    });
    var named = {
      '&nbsp;': ' ',
      '&sect;': '§',
      '&amp;': '&', '&lt;': '<', '&gt;': '>', '&quot;': '"',
      '&apos;': "'",
      '&mdash;': '—', '&ndash;': '–',
      '&lsquo;': '‘', '&rsquo;': '’',
      '&ldquo;': '“', '&rdquo;': '”',
      '&hellip;': '…',
      '&deg;': '°', '&frac12;': '½', '&plusmn;': '±'
    };
    s = s.replace(/&[a-zA-Z]+;/g, function (m) {
      return named.hasOwnProperty(m) ? named[m] : m;
    });
    return s;
  }

  // Convert an HTML fragment to readable text. Block closers + <br> become
  // newlines so subsection structure survives; intra-paragraph source line
  // wrapping is flattened to spaces; remaining tags stripped; entities decoded.
  function htmlToText(frag) {
    if (!frag) return '';
    var t = frag;
    // drop scripts/styles defensively
    t = t.replace(/<script[\s\S]*?<\/script>/gi, '');
    t = t.replace(/<style[\s\S]*?<\/style>/gi, '');
    // Source wraps mid-paragraph with literal newlines/tabs inside one <p>.
    // Those are not structural - flatten raw whitespace to single spaces so
    // only real block tags / <br> create newlines.
    t = t.replace(/[\r\n\t]+/g, ' ');
    // structural newlines
    t = t.replace(/<br\s*\/?>/gi, '\n');
    t = t.replace(/<\/(p|div|li|tr|h[1-6]|blockquote)>/gi, '\n');
    // strip every remaining tag
    t = t.replace(/<[^>]+>/g, '');
    // decode entities AFTER tag-strip so a decoded '<' can't be read as a tag
    t = decodeEntities(t);
    // collapse runs of spaces (nbsp already decoded to space)
    t = t.replace(/[^\S\n]+/g, ' ');
    // trim spaces around newlines
    t = t.replace(/ *\n */g, '\n');
    // collapse blank-line runs
    t = t.replace(/\n{2,}/g, '\n');
    return t.trim();
  }

  function stripTags(frag) {
    return decodeEntities(frag.replace(/<[^>]+>/g, '')).replace(/\s+/g, ' ').trim();
  }

  // ---- locate the section title paragraph ----
  // <p style="margin-left:0px"><b>&sect;&nbsp;NUMBER.&nbsp;TITLE.</b></p>
  // The title <b> always opens with a section symbol. NUMBER may be a range
  // (e.g. "31-44-1.1 - 31-44-1.3") for grouped/repealed entries.
  var titleRe = /<p\b[^>]*>\s*<b>\s*(?:&sect;|&#167;|§)\s*(?:&nbsp;|&#160;|\s)*([0-9][0-9A-Za-z.\-]*(?:\s*(?:&#8212;|&mdash;|—|-{1,2})\s*[0-9][0-9A-Za-z.\-]*)?)\.?(?:&nbsp;|&#160;|\s)*([\s\S]*?)<\/b>\s*<\/p>/i;
  var tm = html.match(titleRe);
  if (!tm) return sections;

  // bare section number: keep dotted/hyphen form, strip trailing period
  var number = stripTags(tm[1]).replace(/^§+\s*/, '').replace(/\.\s*$/, '').trim();

  // catchline title: strip trailing period; null if empty
  var title = stripTags(tm[2]).replace(/\.\s*$/, '').trim();
  if (title === '') title = null;

  // ---- body: from end of title <p> to the History-of-Section block ----
  var afterTitle = html.slice(tm.index + tm[0].length);

  var histIdx = afterTitle.search(/History\s+of\s+Section/i);
  var bodyFrag;
  if (histIdx !== -1) {
    var head = afterTitle.slice(0, histIdx);
    // cut at the opening of the block that encloses the history text
    var lastDiv = head.lastIndexOf('<div');
    var lastP = head.lastIndexOf('<p');
    var cut = Math.max(lastDiv, lastP);
    bodyFrag = cut !== -1 ? afterTitle.slice(0, cut) : head;
  } else {
    var bodyEnd = afterTitle.search(/<\/body>/i);
    bodyFrag = bodyEnd !== -1 ? afterTitle.slice(0, bodyEnd) : afterTitle;
  }

  var text = htmlToText(bodyFrag);

  // EXCLUDE repealed / empty / TOC stubs: skip when body text < 20 chars
  if (!text || text.length < 20) return sections;

  sections.push({ number: number, title: title, text: text });
  return sections;
}

// ---- DE (115 sections tested) ----
function parseDE(html) {
  var sections = [];

  function decodeEntities(s) {
    if (!s) return s;
    s = s.replace(/&#x([0-9a-fA-F]+);/g, function (_, h) {
      return String.fromCodePoint(parseInt(h, 16));
    });
    s = s.replace(/&#(\d+);/g, function (_, d) {
      return String.fromCodePoint(parseInt(d, 10));
    });
    var named = {
      '&nbsp;': ' ',
      '&sect;': '§',
      '&amp;': '&',
      '&lt;': '<',
      '&gt;': '>',
      '&quot;': '"',
      '&apos;': "'",
      '&mdash;': '—',
      '&ndash;': '–',
      '&rsquo;': '’',
      '&lsquo;': '‘',
      '&rdquo;': '”',
      '&ldquo;': '“',
      '&hellip;': '…'
    };
    s = s.replace(/&[a-zA-Z]+;/g, function (m) {
      return named.hasOwnProperty(m) ? named[m] : m;
    });
    return s;
  }

  // Convert a block of HTML to readable plain text.
  function htmlToText(frag) {
    if (!frag) return '';
    var t = frag;
    // Drop script/style entirely.
    t = t.replace(/<script[\s\S]*?<\/script>/gi, ' ');
    t = t.replace(/<style[\s\S]*?<\/style>/gi, ' ');
    // Block-closing tags and <br> -> newline so subsection structure survives.
    t = t.replace(/<br\s*\/?>/gi, '\n');
    t = t.replace(/<\/(p|div|li|tr|h[1-6])\s*>/gi, '\n');
    // Strip all remaining tags.
    t = t.replace(/<[^>]+>/g, '');
    // Decode entities.
    t = decodeEntities(t);
    // Normalize non-breaking spaces to regular spaces.
    t = t.replace(/ /g, ' ');
    // Normalize CRLF.
    t = t.replace(/\r\n?/g, '\n');
    // Collapse runs of spaces/tabs (not newlines).
    t = t.replace(/[ \t]+/g, ' ');
    // Trim spaces around newlines.
    t = t.replace(/[ \t]*\n[ \t]*/g, '\n');
    // Collapse 3+ newlines to a max of 2.
    t = t.replace(/\n{3,}/g, '\n\n');
    return t.trim();
  }

  // Bound the working region to the statute body: everything before the
  // page <footer> is content; the footer carries site nav that would
  // otherwise bleed into the final section (which has no following
  // <div class="Section"> to terminate it).
  var work = html;
  var footerIdx = work.search(/<footer\b/i);
  if (footerIdx !== -1) work = work.slice(0, footerIdx);

  // Locate every Section div. Each section block runs from one
  // <div class="Section"> up to the next one (or end of the bounded body).
  var sectionRe = /<div class="Section">/gi;
  var starts = [];
  var m;
  while ((m = sectionRe.exec(work)) !== null) {
    starts.push(m.index);
  }
  if (starts.length === 0) return sections;
  starts.push(work.length); // sentinel for last block end

  for (var i = 0; i < starts.length - 1; i++) {
    var block = work.slice(starts[i], starts[i + 1]);

    // SectionHead: <div class="SectionHead" id="NUM"> § NUM. TITLE </div>
    var headMatch = block.match(
      /<div class="SectionHead"[^>]*\bid="([^"]*)"[^>]*>([\s\S]*?)<\/div>/i
    );
    if (!headMatch) continue;

    var rawId = headMatch[1] || '';
    var headInner = headMatch[2] || '';

    // Number: prefer the id attribute (bare section number incl. letter suffix).
    var number = decodeEntities(rawId).replace(/ /g, ' ').trim();

    // Title: take the SectionHead text, strip leading "§ NUM." then keep rest.
    var headText = htmlToText(headInner).replace(/\n+/g, ' ').replace(/\s+/g, ' ').trim();
    var title = null;
    if (headText) {
      // Remove a leading section symbol.
      var ht = headText.replace(/^§\s*/, '');
      var withoutSect = ht;
      // Remove the leading number (with optional letter suffix) and the dot.
      var escNum = number.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      var titleRe = new RegExp('^' + escNum + '\\.?\\s*');
      ht = ht.replace(titleRe, '');
      // Fallback: if number didn't match (unlikely), strip a generic leading "NN.".
      if (ht === withoutSect) {
        ht = ht.replace(/^[0-9A-Za-z.\-]+\.\s*/, '');
      }
      ht = ht.trim();
      title = ht.length ? ht : null;
    }

    // Body: everything in the block AFTER the SectionHead's closing </div>.
    var headEndIdx = headMatch.index + headMatch[0].length;
    var bodyHtml = block.slice(headEndIdx);

    var text = htmlToText(bodyHtml);

    // Skip empty / repealed / reserved stubs.
    if (!text || text.length < 20) continue;
    if (/^\[?\s*(reserved|repealed)\.?\s*\]?$/i.test(text)) continue;

    if (!number) continue;

    sections.push({ number: number, title: title, text: text });
  }

  return sections;
}

// ---- SD (64 sections tested) ----
function parseSD(html) {
  if (!html || typeof html !== 'string') return [];

  function decodeEntities(s) {
    if (!s) return s;
    s = s.replace(/&#x([0-9a-fA-F]+);/g, function (_, h) {
      return String.fromCodePoint(parseInt(h, 16));
    });
    s = s.replace(/&#(\d+);/g, function (_, d) {
      return String.fromCodePoint(parseInt(d, 10));
    });
    var named = {
      '&nbsp;': ' ', '&sect;': '§', '&amp;': '&',
      '&lt;': '<', '&gt;': '>', '&quot;': '"', '&apos;': "'",
      '&mdash;': '—', '&ndash;': '–',
      '&lsquo;': '‘', '&rsquo;': '’',
      '&ldquo;': '“', '&rdquo;': '”', '&hellip;': '…'
    };
    s = s.replace(/&[a-zA-Z]+;/g, function (m) {
      return named.hasOwnProperty(m) ? named[m] : m;
    });
    return s;
  }

  var NL = '';

  function htmlToText(frag) {
    if (!frag) return '';
    var t = frag;
    t = t.replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi, '');
    t = t.replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, '');
    t = t.replace(/<br\s*\/?>/gi, NL);
    t = t.replace(/<\/(p|div|li|tr|h[1-6])\s*>/gi, NL);
    t = t.replace(/<[^>]+>/g, '');
    t = decodeEntities(t);
    t = t.replace(/ /g, ' ');
    t = t.replace(/[ \t\r\n\f\v]+/g, ' ');
    var lines = t.split(NL).map(function (l) {
      return l.replace(/ +([.,;:])/g, '$1').trim();
    }).filter(function (l) { return l.length > 0; });
    return lines.join('\n').trim();
  }

  function inlineText(frag) {
    if (!frag) return '';
    var t = frag.replace(/<[^>]+>/g, '');
    t = decodeEntities(t);
    t = t.replace(/ /g, ' ');
    t = t.replace(/[ \t\r\n\f\v]+/g, ' ');
    return t.trim();
  }

  var results = [];

  var bodyMatch = /<body\b[^>]*>([\s\S]*?)<\/body>/i.exec(html);
  var scope = bodyMatch ? bodyMatch[1] : html;

  var headRe = /<p\b[^>]*>([\s\S]*?)<\/p>/gi;
  var headFrag = null, headEnd = -1, m;
  while ((m = headRe.exec(scope))) {
    if (/class="[^"]*SENU(?![A-Za-z])[^"]*"/i.test(m[1])) {
      headFrag = m[1];
      headEnd = headRe.lastIndex;
      break;
    }
  }
  if (headFrag === null) return results;

  var numRe = /<span[^>]*class="[^"]*SENU(?![A-Za-z])[^"]*"[^>]*>\s*([0-9]+(?:-[0-9A-Za-z.]+)+)\s*<\/span>/i;
  var numMatch = numRe.exec(headFrag);
  if (!numMatch) return results;
  var number = decodeEntities(numMatch[1]).trim();

  var clSpanRe = /<span[^>]*class="[^"]*?([0-9A-Za-z\-])CL(?![A-Za-z])[^"]*"[^>]*>([\s\S]*?)<\/span>/gi;
  var titleParts = [];
  var cm;
  while ((cm = clSpanRe.exec(headFrag))) {
    if (cm[1] === 'S' || cm[1] === 's') continue;
    titleParts.push(inlineText(cm[2]));
  }
  var title = titleParts.join('').replace(/\s+/g, ' ').trim();
  if (title) title = title.replace(/\.$/, '').trim();
  if (!title) title = null;

  var bodyRegion = scope.slice(headEnd);
  var srcIdx = bodyRegion.search(/Source\s*:/i);
  if (srcIdx !== -1) {
    bodyRegion = bodyRegion.slice(0, srcIdx);
    bodyRegion = bodyRegion.replace(/<p[^>]*>(\s*<span[^>]*>)?\s*$/i, '');
  }

  var text = htmlToText(bodyRegion);

  if (!text || text.length < 20) return results;

  results.push({ number: number, title: title, text: text });
  return results;
}

// ---- VT (50 sections tested) ----
function parseVT(html) {
  var sections = [];
  if (!html) return sections;

  // Locate the statute body container.
  var ulMarker = '<ul class="item-list statutes-detail">';
  var ulStart = html.indexOf(ulMarker);
  if (ulStart === -1) return sections;

  // Hard stop: the sidebar div that follows the statute list.
  var region = html.slice(ulStart);
  var stop = region.indexOf('<div class="sidebar"');
  if (stop !== -1) region = region.slice(0, stop);

  // Entity decoder.
  function decodeEntities(s) {
    if (!s) return s;
    s = s.replace(/&#x([0-9a-fA-F]+);/g, function (_, h) {
      try { return String.fromCodePoint(parseInt(h, 16)); } catch (e) { return _; }
    });
    s = s.replace(/&#(\d+);/g, function (_, d) {
      try { return String.fromCodePoint(parseInt(d, 10)); } catch (e) { return _; }
    });
    var named = {
      '&nbsp;': ' ', '&sect;': '§', '&amp;': '&',
      '&lt;': '<', '&gt;': '>', '&quot;': '"', '&apos;': "'",
      '&mdash;': '—', '&ndash;': '–',
      '&lsquo;': '‘', '&rsquo;': '’',
      '&ldquo;': '“', '&rdquo;': '”',
      '&hellip;': '…', '&deg;': '°',
      '&frac12;': '½', '&frac14;': '¼', '&frac34;': '¾'
    };
    s = s.replace(/&[a-zA-Z]+;/g, function (m) {
      return named.hasOwnProperty(m) ? named[m] : m;
    });
    return s;
  }

  // Convert an HTML fragment to readable, newline-structured text.
  function htmlToText(frag) {
    if (!frag) return '';
    var t = frag;
    // Drop scripts/styles entirely.
    t = t.replace(/<script[\s\S]*?<\/script>/gi, '');
    t = t.replace(/<style[\s\S]*?<\/style>/gi, '');
    // Block-closing tags and <br> become newlines so structure survives.
    t = t.replace(/<br\s*\/?>/gi, '\n');
    t = t.replace(/<\/(p|div|li|ul|ol|tr|h[1-6]|blockquote)>/gi, '\n');
    // Strip all remaining tags.
    t = t.replace(/<[^>]+>/g, '');
    // Decode entities.
    t = decodeEntities(t);
    // Normalize non-breaking spaces to regular spaces.
    t = t.replace(/ /g, ' ');
    // Normalize CR.
    t = t.replace(/\r\n?/g, '\n');
    // Collapse runs of spaces/tabs (not newlines).
    t = t.replace(/[ \t]+/g, ' ');
    // Trim spaces around each line.
    t = t.replace(/[ \t]*\n[ \t]*/g, '\n');
    // Collapse 3+ newlines to a max of 2.
    t = t.replace(/\n{3,}/g, '\n\n');
    return t.trim();
  }

  // Section header pattern: <p style="margin-left:0px"><b>§ NNNN. Title</b></p>
  var hdrRe = /<p[^>]*style="margin-left:0px"[^>]*>\s*<b>\s*(?:&#167;|&sect;|§)\s*([^<]*?)<\/b>\s*<\/p>/gi;

  // Collect all header matches with positions.
  var heads = [];
  var m;
  while ((m = hdrRe.exec(region)) !== null) {
    heads.push({ index: m.index, end: hdrRe.lastIndex, raw: m[1] });
  }
  if (heads.length === 0) return sections;

  for (var i = 0; i < heads.length; i++) {
    var h = heads[i];
    var bodyStart = h.end;
    var bodyEnd = (i + 1 < heads.length) ? heads[i + 1].index : region.length;
    var bodyFrag = region.slice(bodyStart, bodyEnd);

    // Header text e.g. "4461. Security deposits" or "4466. Repealed.  1987, No. 74, § 2(b)."
    var headText = decodeEntities(h.raw).replace(/ /g, ' ').replace(/\s+/g, ' ').trim();

    // Split number from title at the first separator that follows the number token.
    var number = null, title = null;
    var nm = headText.match(/^([0-9]+[A-Za-z]?(?:[.\-][0-9A-Za-z]+)*?)\s*[.—:\-]\s*([\s\S]*)$/);
    if (nm) {
      number = nm[1];
      title = nm[2].trim();
    } else {
      // Fallback: leading token is the number, rest is title.
      var sp = headText.indexOf(' ');
      if (sp === -1) { number = headText.replace(/\.$/, ''); title = ''; }
      else { number = headText.slice(0, sp).replace(/\.$/, ''); title = headText.slice(sp + 1).trim(); }
    }
    if (number) number = number.replace(/\.+$/, '').trim();
    if (title === '') title = null;

    var text = htmlToText(bodyFrag);

    // Skip repealed/recodified/empty stubs (body < 20 chars).
    if (!text || text.length < 20) continue;

    sections.push({ number: number, title: title, text: text });
  }

  return sections;
}

const CONFIGS = {
  KS: { state: 'KS', sourceDate: SRC_DATE, acts: [
    { actKey: 'residential', kind: 'whole', encoding: 'utf-8', urls: ['https://ksrevisor.gov/statutes/chapters/ch58/058_025_0040.html', 'https://ksrevisor.gov/statutes/chapters/ch58/058_025_0041.html', 'https://ksrevisor.gov/statutes/chapters/ch58/058_025_0042.html', 'https://ksrevisor.gov/statutes/chapters/ch58/058_025_0043.html', 'https://ksrevisor.gov/statutes/chapters/ch58/058_025_0044.html', 'https://ksrevisor.gov/statutes/chapters/ch58/058_025_0045.html', 'https://ksrevisor.gov/statutes/chapters/ch58/058_025_0046.html', 'https://ksrevisor.gov/statutes/chapters/ch58/058_025_0047.html', 'https://ksrevisor.gov/statutes/chapters/ch58/058_025_0048.html', 'https://ksrevisor.gov/statutes/chapters/ch58/058_025_0049.html', 'https://ksrevisor.gov/statutes/chapters/ch58/058_025_0050.html', 'https://ksrevisor.gov/statutes/chapters/ch58/058_025_0051.html', 'https://ksrevisor.gov/statutes/chapters/ch58/058_025_0052.html', 'https://ksrevisor.gov/statutes/chapters/ch58/058_025_0053.html', 'https://ksrevisor.gov/statutes/chapters/ch58/058_025_0054.html', 'https://ksrevisor.gov/statutes/chapters/ch58/058_025_0055.html', 'https://ksrevisor.gov/statutes/chapters/ch58/058_025_0056.html', 'https://ksrevisor.gov/statutes/chapters/ch58/058_025_0057.html', 'https://ksrevisor.gov/statutes/chapters/ch58/058_025_0058.html', 'https://ksrevisor.gov/statutes/chapters/ch58/058_025_0059.html', 'https://ksrevisor.gov/statutes/chapters/ch58/058_025_0060.html', 'https://ksrevisor.gov/statutes/chapters/ch58/058_025_0061.html', 'https://ksrevisor.gov/statutes/chapters/ch58/058_025_0062.html', 'https://ksrevisor.gov/statutes/chapters/ch58/058_025_0063.html', 'https://ksrevisor.gov/statutes/chapters/ch58/058_025_0064.html', 'https://ksrevisor.gov/statutes/chapters/ch58/058_025_0065.html', 'https://ksrevisor.gov/statutes/chapters/ch58/058_025_0066.html', 'https://ksrevisor.gov/statutes/chapters/ch58/058_025_0067.html', 'https://ksrevisor.gov/statutes/chapters/ch58/058_025_0068.html', 'https://ksrevisor.gov/statutes/chapters/ch58/058_025_0069.html', 'https://ksrevisor.gov/statutes/chapters/ch58/058_025_0070.html', 'https://ksrevisor.gov/statutes/chapters/ch58/058_025_0071.html', 'https://ksrevisor.gov/statutes/chapters/ch58/058_025_0072.html'], parse: parseKS },
    { actKey: 'mobile_home_park', kind: 'whole', encoding: 'utf-8', urls: ['https://ksrevisor.gov/statutes/chapters/ch58/058_025_0100.html', 'https://ksrevisor.gov/statutes/chapters/ch58/058_025_0101.html', 'https://ksrevisor.gov/statutes/chapters/ch58/058_025_0102.html', 'https://ksrevisor.gov/statutes/chapters/ch58/058_025_0103.html', 'https://ksrevisor.gov/statutes/chapters/ch58/058_025_0104.html', 'https://ksrevisor.gov/statutes/chapters/ch58/058_025_0105.html', 'https://ksrevisor.gov/statutes/chapters/ch58/058_025_0106.html', 'https://ksrevisor.gov/statutes/chapters/ch58/058_025_0107.html', 'https://ksrevisor.gov/statutes/chapters/ch58/058_025_0108.html', 'https://ksrevisor.gov/statutes/chapters/ch58/058_025_0109.html', 'https://ksrevisor.gov/statutes/chapters/ch58/058_025_0110.html', 'https://ksrevisor.gov/statutes/chapters/ch58/058_025_0111.html', 'https://ksrevisor.gov/statutes/chapters/ch58/058_025_0112.html', 'https://ksrevisor.gov/statutes/chapters/ch58/058_025_0113.html', 'https://ksrevisor.gov/statutes/chapters/ch58/058_025_0114.html', 'https://ksrevisor.gov/statutes/chapters/ch58/058_025_0115.html', 'https://ksrevisor.gov/statutes/chapters/ch58/058_025_0116.html', 'https://ksrevisor.gov/statutes/chapters/ch58/058_025_0117.html', 'https://ksrevisor.gov/statutes/chapters/ch58/058_025_0118.html', 'https://ksrevisor.gov/statutes/chapters/ch58/058_025_0119.html', 'https://ksrevisor.gov/statutes/chapters/ch58/058_025_0120.html', 'https://ksrevisor.gov/statutes/chapters/ch58/058_025_0121.html', 'https://ksrevisor.gov/statutes/chapters/ch58/058_025_0122.html', 'https://ksrevisor.gov/statutes/chapters/ch58/058_025_0123.html', 'https://ksrevisor.gov/statutes/chapters/ch58/058_025_0124.html', 'https://ksrevisor.gov/statutes/chapters/ch58/058_025_0125.html', 'https://ksrevisor.gov/statutes/chapters/ch58/058_025_0126.html'], parse: parseKS },
    { actKey: 'general_landlord_tenant', kind: 'whole', encoding: 'utf-8', urls: ['https://ksrevisor.gov/statutes/chapters/ch58/058_025_0001.html', 'https://ksrevisor.gov/statutes/chapters/ch58/058_025_0001a.html', 'https://ksrevisor.gov/statutes/chapters/ch58/058_025_0002.html', 'https://ksrevisor.gov/statutes/chapters/ch58/058_025_0003.html', 'https://ksrevisor.gov/statutes/chapters/ch58/058_025_0004.html', 'https://ksrevisor.gov/statutes/chapters/ch58/058_025_0005.html', 'https://ksrevisor.gov/statutes/chapters/ch58/058_025_0006.html', 'https://ksrevisor.gov/statutes/chapters/ch58/058_025_0006a.html', 'https://ksrevisor.gov/statutes/chapters/ch58/058_025_0007.html', 'https://ksrevisor.gov/statutes/chapters/ch58/058_025_0008.html', 'https://ksrevisor.gov/statutes/chapters/ch58/058_025_0009.html', 'https://ksrevisor.gov/statutes/chapters/ch58/058_025_0010.html', 'https://ksrevisor.gov/statutes/chapters/ch58/058_025_0011.html', 'https://ksrevisor.gov/statutes/chapters/ch58/058_025_0012.html', 'https://ksrevisor.gov/statutes/chapters/ch58/058_025_0013.html', 'https://ksrevisor.gov/statutes/chapters/ch58/058_025_0014.html', 'https://ksrevisor.gov/statutes/chapters/ch58/058_025_0015.html', 'https://ksrevisor.gov/statutes/chapters/ch58/058_025_0016.html', 'https://ksrevisor.gov/statutes/chapters/ch58/058_025_0017.html', 'https://ksrevisor.gov/statutes/chapters/ch58/058_025_0018.html', 'https://ksrevisor.gov/statutes/chapters/ch58/058_025_0019.html', 'https://ksrevisor.gov/statutes/chapters/ch58/058_025_0020.html', 'https://ksrevisor.gov/statutes/chapters/ch58/058_025_0021.html', 'https://ksrevisor.gov/statutes/chapters/ch58/058_025_0022.html', 'https://ksrevisor.gov/statutes/chapters/ch58/058_025_0023.html', 'https://ksrevisor.gov/statutes/chapters/ch58/058_025_0024.html', 'https://ksrevisor.gov/statutes/chapters/ch58/058_025_0025.html', 'https://ksrevisor.gov/statutes/chapters/ch58/058_025_0026.html', 'https://ksrevisor.gov/statutes/chapters/ch58/058_025_0027.html', 'https://ksrevisor.gov/statutes/chapters/ch58/058_025_0028.html', 'https://ksrevisor.gov/statutes/chapters/ch58/058_025_0029.html', 'https://ksrevisor.gov/statutes/chapters/ch58/058_025_0030.html', 'https://ksrevisor.gov/statutes/chapters/ch58/058_025_0031.html', 'https://ksrevisor.gov/statutes/chapters/ch58/058_025_0032.html', 'https://ksrevisor.gov/statutes/chapters/ch58/058_025_0033.html'], parse: parseKS },
    { actKey: 'self_storage', kind: 'whole', encoding: 'utf-8', urls: ['https://ksrevisor.gov/statutes/chapters/ch58/058_008_0013.html', 'https://ksrevisor.gov/statutes/chapters/ch58/058_008_0014.html', 'https://ksrevisor.gov/statutes/chapters/ch58/058_008_0015.html', 'https://ksrevisor.gov/statutes/chapters/ch58/058_008_0016.html', 'https://ksrevisor.gov/statutes/chapters/ch58/058_008_0016a.html', 'https://ksrevisor.gov/statutes/chapters/ch58/058_008_0017.html', 'https://ksrevisor.gov/statutes/chapters/ch58/058_008_0017a.html', 'https://ksrevisor.gov/statutes/chapters/ch58/058_008_0018.html'], parse: parseKS },
    { actKey: 'eviction', kind: 'whole', encoding: 'utf-8', urls: ['https://ksrevisor.gov/statutes/chapters/ch61/061_038_0001.html', 'https://ksrevisor.gov/statutes/chapters/ch61/061_038_0002.html', 'https://ksrevisor.gov/statutes/chapters/ch61/061_038_0003.html', 'https://ksrevisor.gov/statutes/chapters/ch61/061_038_0004.html', 'https://ksrevisor.gov/statutes/chapters/ch61/061_038_0005.html', 'https://ksrevisor.gov/statutes/chapters/ch61/061_038_0006.html', 'https://ksrevisor.gov/statutes/chapters/ch61/061_038_0007.html', 'https://ksrevisor.gov/statutes/chapters/ch61/061_038_0008.html'], parse: parseKS },
  ] },
  WV: { state: 'WV', sourceDate: SRC_DATE, acts: [
    { actKey: 'residential', kind: 'whole', encoding: 'utf-8', urls: ['https://code.wvlegislature.gov/37-6-1/', 'https://code.wvlegislature.gov/37-6-2/', 'https://code.wvlegislature.gov/37-6-3/', 'https://code.wvlegislature.gov/37-6-4/', 'https://code.wvlegislature.gov/37-6-5/', 'https://code.wvlegislature.gov/37-6-6/', 'https://code.wvlegislature.gov/37-6-7/', 'https://code.wvlegislature.gov/37-6-8/', 'https://code.wvlegislature.gov/37-6-9/', 'https://code.wvlegislature.gov/37-6-10/', 'https://code.wvlegislature.gov/37-6-11/', 'https://code.wvlegislature.gov/37-6-12/', 'https://code.wvlegislature.gov/37-6-13/', 'https://code.wvlegislature.gov/37-6-14/', 'https://code.wvlegislature.gov/37-6-15/', 'https://code.wvlegislature.gov/37-6-16/', 'https://code.wvlegislature.gov/37-6-17/', 'https://code.wvlegislature.gov/37-6-18/', 'https://code.wvlegislature.gov/37-6-19/', 'https://code.wvlegislature.gov/37-6-20/', 'https://code.wvlegislature.gov/37-6-21/', 'https://code.wvlegislature.gov/37-6-22/', 'https://code.wvlegislature.gov/37-6-23/', 'https://code.wvlegislature.gov/37-6-24/', 'https://code.wvlegislature.gov/37-6-25/', 'https://code.wvlegislature.gov/37-6-26/', 'https://code.wvlegislature.gov/37-6-27/', 'https://code.wvlegislature.gov/37-6-28/', 'https://code.wvlegislature.gov/37-6-29/', 'https://code.wvlegislature.gov/37-6-30/', 'https://code.wvlegislature.gov/37-6-31/', 'https://code.wvlegislature.gov/37-6A-1/', 'https://code.wvlegislature.gov/37-6A-2/', 'https://code.wvlegislature.gov/37-6A-3/', 'https://code.wvlegislature.gov/37-6A-4/', 'https://code.wvlegislature.gov/37-6A-5/', 'https://code.wvlegislature.gov/37-6A-6/'], parse: parseWV },
    { actKey: 'mobile_home_park', kind: 'whole', encoding: 'utf-8', urls: ['https://code.wvlegislature.gov/37-15-1/', 'https://code.wvlegislature.gov/37-15-2/', 'https://code.wvlegislature.gov/37-15-3/', 'https://code.wvlegislature.gov/37-15-4/', 'https://code.wvlegislature.gov/37-15-5/', 'https://code.wvlegislature.gov/37-15-6/', 'https://code.wvlegislature.gov/37-15-7/', 'https://code.wvlegislature.gov/37-15-8/'], parse: parseWV },
    { actKey: 'eviction', kind: 'whole', encoding: 'utf-8', urls: ['https://code.wvlegislature.gov/55-3-1/', 'https://code.wvlegislature.gov/55-3-2/', 'https://code.wvlegislature.gov/55-3-3/', 'https://code.wvlegislature.gov/55-3-4/', 'https://code.wvlegislature.gov/55-3-5/', 'https://code.wvlegislature.gov/55-3-6/', 'https://code.wvlegislature.gov/55-3A-1/', 'https://code.wvlegislature.gov/55-3A-2/', 'https://code.wvlegislature.gov/55-3A-3/', 'https://code.wvlegislature.gov/55-3B-1/', 'https://code.wvlegislature.gov/55-3B-2/', 'https://code.wvlegislature.gov/55-3B-3/', 'https://code.wvlegislature.gov/55-3B-4/', 'https://code.wvlegislature.gov/55-3B-5/', 'https://code.wvlegislature.gov/55-3B-6/', 'https://code.wvlegislature.gov/55-3B-7/'], parse: parseWV },
  ] },
  ID: { state: 'ID', sourceDate: SRC_DATE, acts: [
    { actKey: 'residential', kind: 'whole', encoding: 'utf-8', urls: ['https://legislature.idaho.gov/statutesrules/idstat/Title55/T55CH3/SECT55-301', 'https://legislature.idaho.gov/statutesrules/idstat/Title55/T55CH3/SECT55-302', 'https://legislature.idaho.gov/statutesrules/idstat/Title55/T55CH3/SECT55-303', 'https://legislature.idaho.gov/statutesrules/idstat/Title55/T55CH3/SECT55-304', 'https://legislature.idaho.gov/statutesrules/idstat/Title55/T55CH3/SECT55-305', 'https://legislature.idaho.gov/statutesrules/idstat/Title55/T55CH3/SECT55-306', 'https://legislature.idaho.gov/statutesrules/idstat/Title55/T55CH3/SECT55-307', 'https://legislature.idaho.gov/statutesrules/idstat/Title55/T55CH3/SECT55-308', 'https://legislature.idaho.gov/statutesrules/idstat/Title55/T55CH3/SECT55-309', 'https://legislature.idaho.gov/statutesrules/idstat/Title55/T55CH3/SECT55-310', 'https://legislature.idaho.gov/statutesrules/idstat/Title55/T55CH3/SECT55-311', 'https://legislature.idaho.gov/statutesrules/idstat/Title55/T55CH3/SECT55-312', 'https://legislature.idaho.gov/statutesrules/idstat/Title55/T55CH3/SECT55-313', 'https://legislature.idaho.gov/statutesrules/idstat/Title55/T55CH3/SECT55-314', 'https://legislature.idaho.gov/statutesrules/idstat/Title55/T55CH3/SECT55-315'], parse: parseID },
    { actKey: 'mobile_home_park', kind: 'whole', encoding: 'utf-8', urls: ['https://legislature.idaho.gov/statutesrules/idstat/Title55/T55CH20/SECT55-2001', 'https://legislature.idaho.gov/statutesrules/idstat/Title55/T55CH20/SECT55-2002', 'https://legislature.idaho.gov/statutesrules/idstat/Title55/T55CH20/SECT55-2003', 'https://legislature.idaho.gov/statutesrules/idstat/Title55/T55CH20/SECT55-2004', 'https://legislature.idaho.gov/statutesrules/idstat/Title55/T55CH20/SECT55-2005', 'https://legislature.idaho.gov/statutesrules/idstat/Title55/T55CH20/SECT55-2006', 'https://legislature.idaho.gov/statutesrules/idstat/Title55/T55CH20/SECT55-2007', 'https://legislature.idaho.gov/statutesrules/idstat/Title55/T55CH20/SECT55-2008', 'https://legislature.idaho.gov/statutesrules/idstat/Title55/T55CH20/SECT55-2009', 'https://legislature.idaho.gov/statutesrules/idstat/Title55/T55CH20/SECT55-2009A', 'https://legislature.idaho.gov/statutesrules/idstat/Title55/T55CH20/SECT55-2009B', 'https://legislature.idaho.gov/statutesrules/idstat/Title55/T55CH20/SECT55-2009C', 'https://legislature.idaho.gov/statutesrules/idstat/Title55/T55CH20/SECT55-2009D', 'https://legislature.idaho.gov/statutesrules/idstat/Title55/T55CH20/SECT55-2009E', 'https://legislature.idaho.gov/statutesrules/idstat/Title55/T55CH20/SECT55-2009F', 'https://legislature.idaho.gov/statutesrules/idstat/Title55/T55CH20/SECT55-2010', 'https://legislature.idaho.gov/statutesrules/idstat/Title55/T55CH20/SECT55-2011', 'https://legislature.idaho.gov/statutesrules/idstat/Title55/T55CH20/SECT55-2012', 'https://legislature.idaho.gov/statutesrules/idstat/Title55/T55CH20/SECT55-2013', 'https://legislature.idaho.gov/statutesrules/idstat/Title55/T55CH20/SECT55-2013A', 'https://legislature.idaho.gov/statutesrules/idstat/Title55/T55CH20/SECT55-2014', 'https://legislature.idaho.gov/statutesrules/idstat/Title55/T55CH20/SECT55-2015', 'https://legislature.idaho.gov/statutesrules/idstat/Title55/T55CH20/SECT55-2016', 'https://legislature.idaho.gov/statutesrules/idstat/Title55/T55CH20/SECT55-2017', 'https://legislature.idaho.gov/statutesrules/idstat/Title55/T55CH20/SECT55-2018', 'https://legislature.idaho.gov/statutesrules/idstat/Title55/T55CH20/SECT55-2019', 'https://legislature.idaho.gov/statutesrules/idstat/Title55/T55CH20/SECT55-2020'], parse: parseID },
    { actKey: 'self_storage', kind: 'whole', encoding: 'utf-8', urls: ['https://legislature.idaho.gov/statutesrules/idstat/Title55/T55CH23/SECT55-2301', 'https://legislature.idaho.gov/statutesrules/idstat/Title55/T55CH23/SECT55-2302', 'https://legislature.idaho.gov/statutesrules/idstat/Title55/T55CH23/SECT55-2303', 'https://legislature.idaho.gov/statutesrules/idstat/Title55/T55CH23/SECT55-2304', 'https://legislature.idaho.gov/statutesrules/idstat/Title55/T55CH23/SECT55-2305', 'https://legislature.idaho.gov/statutesrules/idstat/Title55/T55CH23/SECT55-2306', 'https://legislature.idaho.gov/statutesrules/idstat/Title55/T55CH23/SECT55-2307', 'https://legislature.idaho.gov/statutesrules/idstat/Title55/T55CH23/SECT55-2308', 'https://legislature.idaho.gov/statutesrules/idstat/Title55/T55CH23/SECT55-2309'], parse: parseID },
    { actKey: 'manufactured_home_park', kind: 'whole', encoding: 'utf-8', urls: ['https://legislature.idaho.gov/statutesrules/idstat/Title55/T55CH27/SECT55-2701', 'https://legislature.idaho.gov/statutesrules/idstat/Title55/T55CH27/SECT55-2702', 'https://legislature.idaho.gov/statutesrules/idstat/Title55/T55CH27/SECT55-2703', 'https://legislature.idaho.gov/statutesrules/idstat/Title55/T55CH27/SECT55-2704', 'https://legislature.idaho.gov/statutesrules/idstat/Title55/T55CH27/SECT55-2705', 'https://legislature.idaho.gov/statutesrules/idstat/Title55/T55CH27/SECT55-2706', 'https://legislature.idaho.gov/statutesrules/idstat/Title55/T55CH27/SECT55-2707', 'https://legislature.idaho.gov/statutesrules/idstat/Title55/T55CH27/SECT55-2708', 'https://legislature.idaho.gov/statutesrules/idstat/Title55/T55CH27/SECT55-2709', 'https://legislature.idaho.gov/statutesrules/idstat/Title55/T55CH27/SECT55-2710', 'https://legislature.idaho.gov/statutesrules/idstat/Title55/T55CH27/SECT55-2711', 'https://legislature.idaho.gov/statutesrules/idstat/Title55/T55CH27/SECT55-2712', 'https://legislature.idaho.gov/statutesrules/idstat/Title55/T55CH27/SECT55-2713', 'https://legislature.idaho.gov/statutesrules/idstat/Title55/T55CH27/SECT55-2714', 'https://legislature.idaho.gov/statutesrules/idstat/Title55/T55CH27/SECT55-2715', 'https://legislature.idaho.gov/statutesrules/idstat/Title55/T55CH27/SECT55-2716', 'https://legislature.idaho.gov/statutesrules/idstat/Title55/T55CH27/SECT55-2717', 'https://legislature.idaho.gov/statutesrules/idstat/Title55/T55CH27/SECT55-2718', 'https://legislature.idaho.gov/statutesrules/idstat/Title55/T55CH27/SECT55-2719', 'https://legislature.idaho.gov/statutesrules/idstat/Title55/T55CH27/SECT55-2720'], parse: parseID },
    { actKey: 'eviction', kind: 'whole', encoding: 'utf-8', urls: ['https://legislature.idaho.gov/statutesrules/idstat/Title6/T6CH3/SECT6-301', 'https://legislature.idaho.gov/statutesrules/idstat/Title6/T6CH3/SECT6-302', 'https://legislature.idaho.gov/statutesrules/idstat/Title6/T6CH3/SECT6-303', 'https://legislature.idaho.gov/statutesrules/idstat/Title6/T6CH3/SECT6-303A', 'https://legislature.idaho.gov/statutesrules/idstat/Title6/T6CH3/SECT6-304', 'https://legislature.idaho.gov/statutesrules/idstat/Title6/T6CH3/SECT6-305', 'https://legislature.idaho.gov/statutesrules/idstat/Title6/T6CH3/SECT6-308', 'https://legislature.idaho.gov/statutesrules/idstat/Title6/T6CH3/SECT6-309', 'https://legislature.idaho.gov/statutesrules/idstat/Title6/T6CH3/SECT6-310', 'https://legislature.idaho.gov/statutesrules/idstat/Title6/T6CH3/SECT6-310A', 'https://legislature.idaho.gov/statutesrules/idstat/Title6/T6CH3/SECT6-311', 'https://legislature.idaho.gov/statutesrules/idstat/Title6/T6CH3/SECT6-311A', 'https://legislature.idaho.gov/statutesrules/idstat/Title6/T6CH3/SECT6-311C', 'https://legislature.idaho.gov/statutesrules/idstat/Title6/T6CH3/SECT6-311D', 'https://legislature.idaho.gov/statutesrules/idstat/Title6/T6CH3/SECT6-311E', 'https://legislature.idaho.gov/statutesrules/idstat/Title6/T6CH3/SECT6-312', 'https://legislature.idaho.gov/statutesrules/idstat/Title6/T6CH3/SECT6-313', 'https://legislature.idaho.gov/statutesrules/idstat/Title6/T6CH3/SECT6-314', 'https://legislature.idaho.gov/statutesrules/idstat/Title6/T6CH3/SECT6-315', 'https://legislature.idaho.gov/statutesrules/idstat/Title6/T6CH3/SECT6-316', 'https://legislature.idaho.gov/statutesrules/idstat/Title6/T6CH3/SECT6-317', 'https://legislature.idaho.gov/statutesrules/idstat/Title6/T6CH3/SECT6-318', 'https://legislature.idaho.gov/statutesrules/idstat/Title6/T6CH3/SECT6-319', 'https://legislature.idaho.gov/statutesrules/idstat/Title6/T6CH3/SECT6-320', 'https://legislature.idaho.gov/statutesrules/idstat/Title6/T6CH3/SECT6-321', 'https://legislature.idaho.gov/statutesrules/idstat/Title6/T6CH3/SECT6-322', 'https://legislature.idaho.gov/statutesrules/idstat/Title6/T6CH3/SECT6-323', 'https://legislature.idaho.gov/statutesrules/idstat/Title6/T6CH3/SECT6-324'], parse: parseID },
  ] },
  NH: { state: 'NH', sourceDate: SRC_DATE, acts: [
    { actKey: 'residential', kind: 'whole', encoding: 'utf-8', urls: ['https://www.gencourt.state.nh.us/rsa/html/LV/540-A/540-A-mrg.htm'], parse: parseNH },
    { actKey: 'eviction', kind: 'whole', encoding: 'utf-8', urls: ['https://www.gencourt.state.nh.us/rsa/html/LV/540/540-mrg.htm'], parse: parseNH },
    { actKey: 'manufactured_home_park', kind: 'whole', encoding: 'utf-8', urls: ['https://www.gencourt.state.nh.us/rsa/html/XVII/205-A/205-A-mrg.htm'], parse: parseNH },
    { actKey: 'general_landlord_tenant', kind: 'whole', encoding: 'utf-8', urls: ['https://www.gencourt.state.nh.us/rsa/html/LV/540-B/540-B-mrg.htm'], parse: parseNH },
    { actKey: 'rv_long_term', kind: 'whole', encoding: 'utf-8', urls: ['https://www.gencourt.state.nh.us/rsa/html/LV/540-C/540-C-mrg.htm'], parse: parseNH },
    { actKey: 'self_storage', kind: 'whole', encoding: 'utf-8', urls: ['https://www.gencourt.state.nh.us/rsa/html/XLI/451-C/451-C-mrg.htm'], parse: parseNH },
  ] },
  ME: { state: 'ME', sourceDate: SRC_DATE, acts: [
    { actKey: 'residential', kind: 'whole', encoding: 'utf-8', urls: ['https://legislature.maine.gov/statutes/14/title14sec6021.html', 'https://legislature.maine.gov/statutes/14/title14sec6021-A.html', 'https://legislature.maine.gov/statutes/14/title14sec6022.html', 'https://legislature.maine.gov/statutes/14/title14sec6022-A.html', 'https://legislature.maine.gov/statutes/14/title14sec6023.html', 'https://legislature.maine.gov/statutes/14/title14sec6024.html', 'https://legislature.maine.gov/statutes/14/title14sec6024-A.html', 'https://legislature.maine.gov/statutes/14/title14sec6025.html', 'https://legislature.maine.gov/statutes/14/title14sec6025-A.html', 'https://legislature.maine.gov/statutes/14/title14sec6026.html', 'https://legislature.maine.gov/statutes/14/title14sec6026-A.html', 'https://legislature.maine.gov/statutes/14/title14sec6027.html', 'https://legislature.maine.gov/statutes/14/title14sec6028.html', 'https://legislature.maine.gov/statutes/14/title14sec6029.html', 'https://legislature.maine.gov/statutes/14/title14sec6030.html', 'https://legislature.maine.gov/statutes/14/title14sec6030-A.html', 'https://legislature.maine.gov/statutes/14/title14sec6030-B.html', 'https://legislature.maine.gov/statutes/14/title14sec6030-C.html', 'https://legislature.maine.gov/statutes/14/title14sec6030-D.html', 'https://legislature.maine.gov/statutes/14/title14sec6030-E.html', 'https://legislature.maine.gov/statutes/14/title14sec6030-F.html', 'https://legislature.maine.gov/statutes/14/title14sec6030-G.html', 'https://legislature.maine.gov/statutes/14/title14sec6030-H.html', 'https://legislature.maine.gov/statutes/14/title14sec6030-I.html', 'https://legislature.maine.gov/statutes/14/title14sec6030-J.html', 'https://legislature.maine.gov/statutes/14/title14sec6030-K.html', 'https://legislature.maine.gov/statutes/14/title14sec6031.html', 'https://legislature.maine.gov/statutes/14/title14sec6032.html', 'https://legislature.maine.gov/statutes/14/title14sec6033.html', 'https://legislature.maine.gov/statutes/14/title14sec6034.html', 'https://legislature.maine.gov/statutes/14/title14sec6035.html', 'https://legislature.maine.gov/statutes/14/title14sec6036.html', 'https://legislature.maine.gov/statutes/14/title14sec6037.html', 'https://legislature.maine.gov/statutes/14/title14sec6038.html', 'https://legislature.maine.gov/statutes/14/title14sec6039.html'], parse: parseME },
    { actKey: 'eviction', kind: 'whole', encoding: 'utf-8', urls: ['https://legislature.maine.gov/statutes/14/title14sec6000.html', 'https://legislature.maine.gov/statutes/14/title14sec6001.html', 'https://legislature.maine.gov/statutes/14/title14sec6002.html', 'https://legislature.maine.gov/statutes/14/title14sec6003.html', 'https://legislature.maine.gov/statutes/14/title14sec6004.html', 'https://legislature.maine.gov/statutes/14/title14sec6004-A.html', 'https://legislature.maine.gov/statutes/14/title14sec6005.html', 'https://legislature.maine.gov/statutes/14/title14sec6006.html', 'https://legislature.maine.gov/statutes/14/title14sec6007.html', 'https://legislature.maine.gov/statutes/14/title14sec6008.html', 'https://legislature.maine.gov/statutes/14/title14sec6009.html', 'https://legislature.maine.gov/statutes/14/title14sec6010.html', 'https://legislature.maine.gov/statutes/14/title14sec6010-A.html', 'https://legislature.maine.gov/statutes/14/title14sec6011.html', 'https://legislature.maine.gov/statutes/14/title14sec6012.html', 'https://legislature.maine.gov/statutes/14/title14sec6013.html', 'https://legislature.maine.gov/statutes/14/title14sec6014.html', 'https://legislature.maine.gov/statutes/14/title14sec6015-2.html', 'https://legislature.maine.gov/statutes/14/title14sec6016.html', 'https://legislature.maine.gov/statutes/14/title14sec6016-A.html', 'https://legislature.maine.gov/statutes/14/title14sec6017.html'], parse: parseME },
  ] },
  MT: { state: 'MT', sourceDate: SRC_DATE, acts: [
    { actKey: 'residential', kind: 'whole', encoding: 'utf-8', urls: ['https://archive.legmt.gov/bills/mca/title_0700/chapter_0240/part_0010/section_0010/0700-0240-0010-0010.html', 'https://archive.legmt.gov/bills/mca/title_0700/chapter_0240/part_0010/section_0020/0700-0240-0010-0020.html', 'https://archive.legmt.gov/bills/mca/title_0700/chapter_0240/part_0010/section_0030/0700-0240-0010-0030.html', 'https://archive.legmt.gov/bills/mca/title_0700/chapter_0240/part_0010/section_0040/0700-0240-0010-0040.html', 'https://archive.legmt.gov/bills/mca/title_0700/chapter_0240/part_0010/section_0050/0700-0240-0010-0050.html', 'https://archive.legmt.gov/bills/mca/title_0700/chapter_0240/part_0010/section_0060/0700-0240-0010-0060.html', 'https://archive.legmt.gov/bills/mca/title_0700/chapter_0240/part_0010/section_0070/0700-0240-0010-0070.html', 'https://archive.legmt.gov/bills/mca/title_0700/chapter_0240/part_0010/section_0080/0700-0240-0010-0080.html', 'https://archive.legmt.gov/bills/mca/title_0700/chapter_0240/part_0010/section_0090/0700-0240-0010-0090.html', 'https://archive.legmt.gov/bills/mca/title_0700/chapter_0240/part_0010/section_0100/0700-0240-0010-0100.html', 'https://archive.legmt.gov/bills/mca/title_0700/chapter_0240/part_0010/section_0110/0700-0240-0010-0110.html', 'https://archive.legmt.gov/bills/mca/title_0700/chapter_0240/part_0010/section_0120/0700-0240-0010-0120.html', 'https://archive.legmt.gov/bills/mca/title_0700/chapter_0240/part_0010/section_0130/0700-0240-0010-0130.html', 'https://archive.legmt.gov/bills/mca/title_0700/chapter_0240/part_0010/section_0140/0700-0240-0010-0140.html', 'https://archive.legmt.gov/bills/mca/title_0700/chapter_0240/part_0020/section_0010/0700-0240-0020-0010.html', 'https://archive.legmt.gov/bills/mca/title_0700/chapter_0240/part_0020/section_0020/0700-0240-0020-0020.html', 'https://archive.legmt.gov/bills/mca/title_0700/chapter_0240/part_0020/section_0030/0700-0240-0020-0030.html', 'https://archive.legmt.gov/bills/mca/title_0700/chapter_0240/part_0020/section_0040/0700-0240-0020-0040.html', 'https://archive.legmt.gov/bills/mca/title_0700/chapter_0240/part_0020/section_0050/0700-0240-0020-0050.html', 'https://archive.legmt.gov/bills/mca/title_0700/chapter_0240/part_0030/section_0010/0700-0240-0030-0010.html', 'https://archive.legmt.gov/bills/mca/title_0700/chapter_0240/part_0030/section_0020/0700-0240-0030-0020.html', 'https://archive.legmt.gov/bills/mca/title_0700/chapter_0240/part_0030/section_0030/0700-0240-0030-0030.html', 'https://archive.legmt.gov/bills/mca/title_0700/chapter_0240/part_0030/section_0040/0700-0240-0030-0040.html', 'https://archive.legmt.gov/bills/mca/title_0700/chapter_0240/part_0030/section_0050/0700-0240-0030-0050.html', 'https://archive.legmt.gov/bills/mca/title_0700/chapter_0240/part_0030/section_0060/0700-0240-0030-0060.html', 'https://archive.legmt.gov/bills/mca/title_0700/chapter_0240/part_0030/section_0070/0700-0240-0030-0070.html', 'https://archive.legmt.gov/bills/mca/title_0700/chapter_0240/part_0030/section_0080/0700-0240-0030-0080.html', 'https://archive.legmt.gov/bills/mca/title_0700/chapter_0240/part_0030/section_0090/0700-0240-0030-0090.html', 'https://archive.legmt.gov/bills/mca/title_0700/chapter_0240/part_0030/section_0100/0700-0240-0030-0100.html', 'https://archive.legmt.gov/bills/mca/title_0700/chapter_0240/part_0030/section_0210/0700-0240-0030-0210.html', 'https://archive.legmt.gov/bills/mca/title_0700/chapter_0240/part_0030/section_0220/0700-0240-0030-0220.html', 'https://archive.legmt.gov/bills/mca/title_0700/chapter_0240/part_0030/section_0230/0700-0240-0030-0230.html', 'https://archive.legmt.gov/bills/mca/title_0700/chapter_0240/part_0030/section_0240/0700-0240-0030-0240.html', 'https://archive.legmt.gov/bills/mca/title_0700/chapter_0240/part_0040/section_0010/0700-0240-0040-0010.html', 'https://archive.legmt.gov/bills/mca/title_0700/chapter_0240/part_0040/section_0020/0700-0240-0040-0020.html', 'https://archive.legmt.gov/bills/mca/title_0700/chapter_0240/part_0040/section_0030/0700-0240-0040-0030.html', 'https://archive.legmt.gov/bills/mca/title_0700/chapter_0240/part_0040/section_0040/0700-0240-0040-0040.html', 'https://archive.legmt.gov/bills/mca/title_0700/chapter_0240/part_0040/section_0050/0700-0240-0040-0050.html', 'https://archive.legmt.gov/bills/mca/title_0700/chapter_0240/part_0040/section_0060/0700-0240-0040-0060.html', 'https://archive.legmt.gov/bills/mca/title_0700/chapter_0240/part_0040/section_0070/0700-0240-0040-0070.html', 'https://archive.legmt.gov/bills/mca/title_0700/chapter_0240/part_0040/section_0080/0700-0240-0040-0080.html', 'https://archive.legmt.gov/bills/mca/title_0700/chapter_0240/part_0040/section_0090/0700-0240-0040-0090.html', 'https://archive.legmt.gov/bills/mca/title_0700/chapter_0240/part_0040/section_0100/0700-0240-0040-0100.html', 'https://archive.legmt.gov/bills/mca/title_0700/chapter_0240/part_0040/section_0110/0700-0240-0040-0110.html', 'https://archive.legmt.gov/bills/mca/title_0700/chapter_0240/part_0040/section_0120/0700-0240-0040-0120.html', 'https://archive.legmt.gov/bills/mca/title_0700/chapter_0240/part_0040/section_0130/0700-0240-0040-0130.html', 'https://archive.legmt.gov/bills/mca/title_0700/chapter_0240/part_0040/section_0140/0700-0240-0040-0140.html', 'https://archive.legmt.gov/bills/mca/title_0700/chapter_0240/part_0040/section_0150/0700-0240-0040-0150.html', 'https://archive.legmt.gov/bills/mca/title_0700/chapter_0240/part_0040/section_0160/0700-0240-0040-0160.html', 'https://archive.legmt.gov/bills/mca/title_0700/chapter_0240/part_0040/section_0210/0700-0240-0040-0210.html', 'https://archive.legmt.gov/bills/mca/title_0700/chapter_0240/part_0040/section_0220/0700-0240-0040-0220.html', 'https://archive.legmt.gov/bills/mca/title_0700/chapter_0240/part_0040/section_0230/0700-0240-0040-0230.html', 'https://archive.legmt.gov/bills/mca/title_0700/chapter_0240/part_0040/section_0240/0700-0240-0040-0240.html', 'https://archive.legmt.gov/bills/mca/title_0700/chapter_0240/part_0040/section_0250/0700-0240-0040-0250.html', 'https://archive.legmt.gov/bills/mca/title_0700/chapter_0240/part_0040/section_0260/0700-0240-0040-0260.html', 'https://archive.legmt.gov/bills/mca/title_0700/chapter_0240/part_0040/section_0270/0700-0240-0040-0270.html', 'https://archive.legmt.gov/bills/mca/title_0700/chapter_0240/part_0040/section_0280/0700-0240-0040-0280.html', 'https://archive.legmt.gov/bills/mca/title_0700/chapter_0240/part_0040/section_0290/0700-0240-0040-0290.html', 'https://archive.legmt.gov/bills/mca/title_0700/chapter_0240/part_0040/section_0300/0700-0240-0040-0300.html', 'https://archive.legmt.gov/bills/mca/title_0700/chapter_0240/part_0040/section_0310/0700-0240-0040-0310.html', 'https://archive.legmt.gov/bills/mca/title_0700/chapter_0240/part_0040/section_0320/0700-0240-0040-0320.html', 'https://archive.legmt.gov/bills/mca/title_0700/chapter_0240/part_0040/section_0410/0700-0240-0040-0410.html', 'https://archive.legmt.gov/bills/mca/title_0700/chapter_0240/part_0040/section_0420/0700-0240-0040-0420.html', 'https://archive.legmt.gov/bills/mca/title_0700/chapter_0250/part_0010/section_0010/0700-0250-0010-0010.html', 'https://archive.legmt.gov/bills/mca/title_0700/chapter_0250/part_0010/section_0020/0700-0250-0010-0020.html', 'https://archive.legmt.gov/bills/mca/title_0700/chapter_0250/part_0010/section_0030/0700-0250-0010-0030.html', 'https://archive.legmt.gov/bills/mca/title_0700/chapter_0250/part_0020/section_0010/0700-0250-0020-0010.html', 'https://archive.legmt.gov/bills/mca/title_0700/chapter_0250/part_0020/section_0020/0700-0250-0020-0020.html', 'https://archive.legmt.gov/bills/mca/title_0700/chapter_0250/part_0020/section_0030/0700-0250-0020-0030.html', 'https://archive.legmt.gov/bills/mca/title_0700/chapter_0250/part_0020/section_0040/0700-0250-0020-0040.html', 'https://archive.legmt.gov/bills/mca/title_0700/chapter_0250/part_0020/section_0050/0700-0250-0020-0050.html', 'https://archive.legmt.gov/bills/mca/title_0700/chapter_0250/part_0020/section_0060/0700-0250-0020-0060.html', 'https://archive.legmt.gov/bills/mca/title_0700/chapter_0260/part_0010/section_0010/0700-0260-0010-0010.html', 'https://archive.legmt.gov/bills/mca/title_0700/chapter_0260/part_0010/section_0020/0700-0260-0010-0020.html', 'https://archive.legmt.gov/bills/mca/title_0700/chapter_0260/part_0010/section_0030/0700-0260-0010-0030.html', 'https://archive.legmt.gov/bills/mca/title_0700/chapter_0260/part_0010/section_0040/0700-0260-0010-0040.html', 'https://archive.legmt.gov/bills/mca/title_0700/chapter_0260/part_0010/section_0050/0700-0260-0010-0050.html', 'https://archive.legmt.gov/bills/mca/title_0700/chapter_0260/part_0010/section_0060/0700-0260-0010-0060.html', 'https://archive.legmt.gov/bills/mca/title_0700/chapter_0260/part_0010/section_0070/0700-0260-0010-0070.html', 'https://archive.legmt.gov/bills/mca/title_0700/chapter_0260/part_0010/section_0080/0700-0260-0010-0080.html', 'https://archive.legmt.gov/bills/mca/title_0700/chapter_0260/part_0010/section_0090/0700-0260-0010-0090.html', 'https://archive.legmt.gov/bills/mca/title_0700/chapter_0260/part_0010/section_0100/0700-0260-0010-0100.html', 'https://archive.legmt.gov/bills/mca/title_0700/chapter_0260/part_0020/section_0010/0700-0260-0020-0010.html', 'https://archive.legmt.gov/bills/mca/title_0700/chapter_0260/part_0020/section_0020/0700-0260-0020-0020.html', 'https://archive.legmt.gov/bills/mca/title_0700/chapter_0260/part_0020/section_0030/0700-0260-0020-0030.html', 'https://archive.legmt.gov/bills/mca/title_0700/chapter_0260/part_0020/section_0040/0700-0260-0020-0040.html', 'https://archive.legmt.gov/bills/mca/title_0700/chapter_0260/part_0020/section_0050/0700-0260-0020-0050.html', 'https://archive.legmt.gov/bills/mca/title_0700/chapter_0260/part_0020/section_0060/0700-0260-0020-0060.html', 'https://archive.legmt.gov/bills/mca/title_0700/chapter_0260/part_0020/section_0070/0700-0260-0020-0070.html'], parse: parseMT },
    { actKey: 'eviction', kind: 'whole', encoding: 'utf-8', urls: ['https://archive.legmt.gov/bills/mca/title_0700/chapter_0270/part_0010/section_0010/0700-0270-0010-0010.html', 'https://archive.legmt.gov/bills/mca/title_0700/chapter_0270/part_0010/section_0020/0700-0270-0010-0020.html', 'https://archive.legmt.gov/bills/mca/title_0700/chapter_0270/part_0010/section_0030/0700-0270-0010-0030.html', 'https://archive.legmt.gov/bills/mca/title_0700/chapter_0270/part_0010/section_0040/0700-0270-0010-0040.html', 'https://archive.legmt.gov/bills/mca/title_0700/chapter_0270/part_0010/section_0050/0700-0270-0010-0050.html', 'https://archive.legmt.gov/bills/mca/title_0700/chapter_0270/part_0010/section_0060/0700-0270-0010-0060.html', 'https://archive.legmt.gov/bills/mca/title_0700/chapter_0270/part_0010/section_0070/0700-0270-0010-0070.html', 'https://archive.legmt.gov/bills/mca/title_0700/chapter_0270/part_0010/section_0080/0700-0270-0010-0080.html', 'https://archive.legmt.gov/bills/mca/title_0700/chapter_0270/part_0010/section_0090/0700-0270-0010-0090.html', 'https://archive.legmt.gov/bills/mca/title_0700/chapter_0270/part_0010/section_0100/0700-0270-0010-0100.html', 'https://archive.legmt.gov/bills/mca/title_0700/chapter_0270/part_0010/section_0110/0700-0270-0010-0110.html', 'https://archive.legmt.gov/bills/mca/title_0700/chapter_0270/part_0010/section_0120/0700-0270-0010-0120.html', 'https://archive.legmt.gov/bills/mca/title_0700/chapter_0270/part_0010/section_0130/0700-0270-0010-0130.html', 'https://archive.legmt.gov/bills/mca/title_0700/chapter_0270/part_0010/section_0140/0700-0270-0010-0140.html', 'https://archive.legmt.gov/bills/mca/title_0700/chapter_0270/part_0010/section_0150/0700-0270-0010-0150.html', 'https://archive.legmt.gov/bills/mca/title_0700/chapter_0270/part_0010/section_0160/0700-0270-0010-0160.html', 'https://archive.legmt.gov/bills/mca/title_0700/chapter_0270/part_0010/section_0170/0700-0270-0010-0170.html', 'https://archive.legmt.gov/bills/mca/title_0700/chapter_0270/part_0020/section_0010/0700-0270-0020-0010.html', 'https://archive.legmt.gov/bills/mca/title_0700/chapter_0270/part_0020/section_0020/0700-0270-0020-0020.html', 'https://archive.legmt.gov/bills/mca/title_0700/chapter_0270/part_0020/section_0030/0700-0270-0020-0030.html', 'https://archive.legmt.gov/bills/mca/title_0700/chapter_0270/part_0020/section_0040/0700-0270-0020-0040.html', 'https://archive.legmt.gov/bills/mca/title_0700/chapter_0270/part_0020/section_0050/0700-0270-0020-0050.html', 'https://archive.legmt.gov/bills/mca/title_0700/chapter_0270/part_0020/section_0060/0700-0270-0020-0060.html', 'https://archive.legmt.gov/bills/mca/title_0700/chapter_0270/part_0020/section_0070/0700-0270-0020-0070.html', 'https://archive.legmt.gov/bills/mca/title_0700/chapter_0270/part_0020/section_0080/0700-0270-0020-0080.html', 'https://archive.legmt.gov/bills/mca/title_0700/chapter_0270/part_0020/section_0090/0700-0270-0020-0090.html', 'https://archive.legmt.gov/bills/mca/title_0700/chapter_0270/part_0020/section_0100/0700-0270-0020-0100.html', 'https://archive.legmt.gov/bills/mca/title_0700/chapter_0270/part_0020/section_0110/0700-0270-0020-0110.html', 'https://archive.legmt.gov/bills/mca/title_0700/chapter_0270/part_0020/section_0120/0700-0270-0020-0120.html'], parse: parseMT },
    { actKey: 'mobile_home_park', kind: 'whole', encoding: 'utf-8', urls: ['https://archive.legmt.gov/bills/mca/title_0700/chapter_0330/part_0010/section_0010/0700-0330-0010-0010.html', 'https://archive.legmt.gov/bills/mca/title_0700/chapter_0330/part_0010/section_0020/0700-0330-0010-0020.html', 'https://archive.legmt.gov/bills/mca/title_0700/chapter_0330/part_0010/section_0030/0700-0330-0010-0030.html', 'https://archive.legmt.gov/bills/mca/title_0700/chapter_0330/part_0010/section_0040/0700-0330-0010-0040.html', 'https://archive.legmt.gov/bills/mca/title_0700/chapter_0330/part_0010/section_0050/0700-0330-0010-0050.html', 'https://archive.legmt.gov/bills/mca/title_0700/chapter_0330/part_0010/section_0060/0700-0330-0010-0060.html', 'https://archive.legmt.gov/bills/mca/title_0700/chapter_0330/part_0010/section_0070/0700-0330-0010-0070.html', 'https://archive.legmt.gov/bills/mca/title_0700/chapter_0330/part_0010/section_0080/0700-0330-0010-0080.html', 'https://archive.legmt.gov/bills/mca/title_0700/chapter_0330/part_0010/section_0090/0700-0330-0010-0090.html', 'https://archive.legmt.gov/bills/mca/title_0700/chapter_0330/part_0010/section_0100/0700-0330-0010-0100.html', 'https://archive.legmt.gov/bills/mca/title_0700/chapter_0330/part_0020/section_0010/0700-0330-0020-0010.html', 'https://archive.legmt.gov/bills/mca/title_0700/chapter_0330/part_0020/section_0020/0700-0330-0020-0020.html', 'https://archive.legmt.gov/bills/mca/title_0700/chapter_0330/part_0020/section_0030/0700-0330-0020-0030.html', 'https://archive.legmt.gov/bills/mca/title_0700/chapter_0330/part_0030/section_0010/0700-0330-0030-0010.html', 'https://archive.legmt.gov/bills/mca/title_0700/chapter_0330/part_0030/section_0020/0700-0330-0030-0020.html', 'https://archive.legmt.gov/bills/mca/title_0700/chapter_0330/part_0030/section_0030/0700-0330-0030-0030.html', 'https://archive.legmt.gov/bills/mca/title_0700/chapter_0330/part_0030/section_0040/0700-0330-0030-0040.html', 'https://archive.legmt.gov/bills/mca/title_0700/chapter_0330/part_0030/section_0050/0700-0330-0030-0050.html', 'https://archive.legmt.gov/bills/mca/title_0700/chapter_0330/part_0030/section_0060/0700-0330-0030-0060.html', 'https://archive.legmt.gov/bills/mca/title_0700/chapter_0330/part_0030/section_0070/0700-0330-0030-0070.html', 'https://archive.legmt.gov/bills/mca/title_0700/chapter_0330/part_0030/section_0080/0700-0330-0030-0080.html', 'https://archive.legmt.gov/bills/mca/title_0700/chapter_0330/part_0030/section_0090/0700-0330-0030-0090.html', 'https://archive.legmt.gov/bills/mca/title_0700/chapter_0330/part_0030/section_0100/0700-0330-0030-0100.html', 'https://archive.legmt.gov/bills/mca/title_0700/chapter_0330/part_0030/section_0110/0700-0330-0030-0110.html', 'https://archive.legmt.gov/bills/mca/title_0700/chapter_0330/part_0030/section_0210/0700-0330-0030-0210.html', 'https://archive.legmt.gov/bills/mca/title_0700/chapter_0330/part_0030/section_0220/0700-0330-0030-0220.html', 'https://archive.legmt.gov/bills/mca/title_0700/chapter_0330/part_0030/section_0230/0700-0330-0030-0230.html', 'https://archive.legmt.gov/bills/mca/title_0700/chapter_0330/part_0040/section_0010/0700-0330-0040-0010.html', 'https://archive.legmt.gov/bills/mca/title_0700/chapter_0330/part_0040/section_0020/0700-0330-0040-0020.html', 'https://archive.legmt.gov/bills/mca/title_0700/chapter_0330/part_0040/section_0030/0700-0330-0040-0030.html', 'https://archive.legmt.gov/bills/mca/title_0700/chapter_0330/part_0040/section_0040/0700-0330-0040-0040.html', 'https://archive.legmt.gov/bills/mca/title_0700/chapter_0330/part_0040/section_0050/0700-0330-0040-0050.html', 'https://archive.legmt.gov/bills/mca/title_0700/chapter_0330/part_0040/section_0060/0700-0330-0040-0060.html', 'https://archive.legmt.gov/bills/mca/title_0700/chapter_0330/part_0040/section_0070/0700-0330-0040-0070.html', 'https://archive.legmt.gov/bills/mca/title_0700/chapter_0330/part_0040/section_0080/0700-0330-0040-0080.html', 'https://archive.legmt.gov/bills/mca/title_0700/chapter_0330/part_0040/section_0090/0700-0330-0040-0090.html', 'https://archive.legmt.gov/bills/mca/title_0700/chapter_0330/part_0040/section_0100/0700-0330-0040-0100.html', 'https://archive.legmt.gov/bills/mca/title_0700/chapter_0330/part_0040/section_0110/0700-0330-0040-0110.html', 'https://archive.legmt.gov/bills/mca/title_0700/chapter_0330/part_0040/section_0120/0700-0330-0040-0120.html', 'https://archive.legmt.gov/bills/mca/title_0700/chapter_0330/part_0040/section_0130/0700-0330-0040-0130.html', 'https://archive.legmt.gov/bills/mca/title_0700/chapter_0330/part_0040/section_0140/0700-0330-0040-0140.html', 'https://archive.legmt.gov/bills/mca/title_0700/chapter_0330/part_0040/section_0150/0700-0330-0040-0150.html', 'https://archive.legmt.gov/bills/mca/title_0700/chapter_0330/part_0040/section_0160/0700-0330-0040-0160.html', 'https://archive.legmt.gov/bills/mca/title_0700/chapter_0330/part_0040/section_0170/0700-0330-0040-0170.html', 'https://archive.legmt.gov/bills/mca/title_0700/chapter_0330/part_0040/section_0180/0700-0330-0040-0180.html', 'https://archive.legmt.gov/bills/mca/title_0700/chapter_0330/part_0040/section_0190/0700-0330-0040-0190.html', 'https://archive.legmt.gov/bills/mca/title_0700/chapter_0330/part_0040/section_0200/0700-0330-0040-0200.html', 'https://archive.legmt.gov/bills/mca/title_0700/chapter_0330/part_0040/section_0310/0700-0330-0040-0310.html', 'https://archive.legmt.gov/bills/mca/title_0700/chapter_0330/part_0040/section_0320/0700-0330-0040-0320.html', 'https://archive.legmt.gov/bills/mca/title_0700/chapter_0330/part_0040/section_0330/0700-0330-0040-0330.html', 'https://archive.legmt.gov/bills/mca/title_0700/chapter_0330/part_0040/section_0340/0700-0330-0040-0340.html'], parse: parseMT },
  ] },
  RI: { state: 'RI', sourceDate: SRC_DATE, acts: [
    { actKey: 'residential', kind: 'whole', encoding: 'utf-8', urls: ['https://webserver.rilegislature.gov/Statutes/TITLE34/34-18/34-18-1.htm', 'https://webserver.rilegislature.gov/Statutes/TITLE34/34-18/34-18-2.htm', 'https://webserver.rilegislature.gov/Statutes/TITLE34/34-18/34-18-3.htm', 'https://webserver.rilegislature.gov/Statutes/TITLE34/34-18/34-18-4.htm', 'https://webserver.rilegislature.gov/Statutes/TITLE34/34-18/34-18-5.htm', 'https://webserver.rilegislature.gov/Statutes/TITLE34/34-18/34-18-6.htm', 'https://webserver.rilegislature.gov/Statutes/TITLE34/34-18/34-18-7.htm', 'https://webserver.rilegislature.gov/Statutes/TITLE34/34-18/34-18-8.htm', 'https://webserver.rilegislature.gov/Statutes/TITLE34/34-18/34-18-9.htm', 'https://webserver.rilegislature.gov/Statutes/TITLE34/34-18/34-18-10.htm', 'https://webserver.rilegislature.gov/Statutes/TITLE34/34-18/34-18-11.htm', 'https://webserver.rilegislature.gov/Statutes/TITLE34/34-18/34-18-12.htm', 'https://webserver.rilegislature.gov/Statutes/TITLE34/34-18/34-18-13.htm', 'https://webserver.rilegislature.gov/Statutes/TITLE34/34-18/34-18-14.htm', 'https://webserver.rilegislature.gov/Statutes/TITLE34/34-18/34-18-15.htm', 'https://webserver.rilegislature.gov/Statutes/TITLE34/34-18/34-18-16.htm', 'https://webserver.rilegislature.gov/Statutes/TITLE34/34-18/34-18-16.1.htm', 'https://webserver.rilegislature.gov/Statutes/TITLE34/34-18/34-18-17.htm', 'https://webserver.rilegislature.gov/Statutes/TITLE34/34-18/34-18-18.htm', 'https://webserver.rilegislature.gov/Statutes/TITLE34/34-18/34-18-19.htm', 'https://webserver.rilegislature.gov/Statutes/TITLE34/34-18/34-18-20.htm', 'https://webserver.rilegislature.gov/Statutes/TITLE34/34-18/34-18-21.htm', 'https://webserver.rilegislature.gov/Statutes/TITLE34/34-18/34-18-22.htm', 'https://webserver.rilegislature.gov/Statutes/TITLE34/34-18/34-18-22.1.htm', 'https://webserver.rilegislature.gov/Statutes/TITLE34/34-18/34-18-22.2.htm', 'https://webserver.rilegislature.gov/Statutes/TITLE34/34-18/34-18-22.3.htm', 'https://webserver.rilegislature.gov/Statutes/TITLE34/34-18/34-18-23.htm', 'https://webserver.rilegislature.gov/Statutes/TITLE34/34-18/34-18-24.htm', 'https://webserver.rilegislature.gov/Statutes/TITLE34/34-18/34-18-25.htm', 'https://webserver.rilegislature.gov/Statutes/TITLE34/34-18/34-18-26.htm', 'https://webserver.rilegislature.gov/Statutes/TITLE34/34-18/34-18-27.htm', 'https://webserver.rilegislature.gov/Statutes/TITLE34/34-18/34-18-28.htm', 'https://webserver.rilegislature.gov/Statutes/TITLE34/34-18/34-18-29.htm', 'https://webserver.rilegislature.gov/Statutes/TITLE34/34-18/34-18-30.htm', 'https://webserver.rilegislature.gov/Statutes/TITLE34/34-18/34-18-31.htm', 'https://webserver.rilegislature.gov/Statutes/TITLE34/34-18/34-18-32.htm', 'https://webserver.rilegislature.gov/Statutes/TITLE34/34-18/34-18-33.htm', 'https://webserver.rilegislature.gov/Statutes/TITLE34/34-18/34-18-34.htm', 'https://webserver.rilegislature.gov/Statutes/TITLE34/34-18/34-18-35.htm', 'https://webserver.rilegislature.gov/Statutes/TITLE34/34-18/34-18-36.htm', 'https://webserver.rilegislature.gov/Statutes/TITLE34/34-18/34-18-37.htm', 'https://webserver.rilegislature.gov/Statutes/TITLE34/34-18/34-18-38.htm', 'https://webserver.rilegislature.gov/Statutes/TITLE34/34-18/34-18-38.1.htm', 'https://webserver.rilegislature.gov/Statutes/TITLE34/34-18/34-18-38.2.htm', 'https://webserver.rilegislature.gov/Statutes/TITLE34/34-18/34-18-39.htm', 'https://webserver.rilegislature.gov/Statutes/TITLE34/34-18/34-18-40.htm', 'https://webserver.rilegislature.gov/Statutes/TITLE34/34-18/34-18-41.htm', 'https://webserver.rilegislature.gov/Statutes/TITLE34/34-18/34-18-42.htm', 'https://webserver.rilegislature.gov/Statutes/TITLE34/34-18/34-18-43.htm', 'https://webserver.rilegislature.gov/Statutes/TITLE34/34-18/34-18-44.htm', 'https://webserver.rilegislature.gov/Statutes/TITLE34/34-18/34-18-45.htm', 'https://webserver.rilegislature.gov/Statutes/TITLE34/34-18/34-18-46.htm', 'https://webserver.rilegislature.gov/Statutes/TITLE34/34-18/34-18-47.htm', 'https://webserver.rilegislature.gov/Statutes/TITLE34/34-18/34-18-48.htm', 'https://webserver.rilegislature.gov/Statutes/TITLE34/34-18/34-18-49.htm', 'https://webserver.rilegislature.gov/Statutes/TITLE34/34-18/34-18-50.htm', 'https://webserver.rilegislature.gov/Statutes/TITLE34/34-18/34-18-51.htm', 'https://webserver.rilegislature.gov/Statutes/TITLE34/34-18/34-18-52.htm', 'https://webserver.rilegislature.gov/Statutes/TITLE34/34-18/34-18-53.htm', 'https://webserver.rilegislature.gov/Statutes/TITLE34/34-18/34-18-54.htm', 'https://webserver.rilegislature.gov/Statutes/TITLE34/34-18/34-18-55.htm', 'https://webserver.rilegislature.gov/Statutes/TITLE34/34-18/34-18-56.htm', 'https://webserver.rilegislature.gov/Statutes/TITLE34/34-18/34-18-57.htm', 'https://webserver.rilegislature.gov/Statutes/TITLE34/34-18/34-18-58.htm', 'https://webserver.rilegislature.gov/Statutes/TITLE34/34-18/34-18-59.htm', 'https://webserver.rilegislature.gov/Statutes/TITLE34/34-18/34-18-60.htm', 'https://webserver.rilegislature.gov/Statutes/TITLE34/34-18/34-18-61.htm', 'https://webserver.rilegislature.gov/Statutes/TITLE34/34-18/34-18-62.htm', 'https://webserver.rilegislature.gov/Statutes/TITLE34/34-18.2/34-18.2-1.htm', 'https://webserver.rilegislature.gov/Statutes/TITLE34/34-18.2/34-18.2-2.htm', 'https://webserver.rilegislature.gov/Statutes/TITLE34/34-18.2/34-18.2-3.htm', 'https://webserver.rilegislature.gov/Statutes/TITLE34/34-18.2/34-18.2-4.htm', 'https://webserver.rilegislature.gov/Statutes/TITLE34/34-18.2/34-18.2-5.htm', 'https://webserver.rilegislature.gov/Statutes/TITLE34/34-18.2/34-18.2-6.htm'], parse: parseRI },
    { actKey: 'commercial', kind: 'whole', encoding: 'utf-8', urls: ['https://webserver.rilegislature.gov/Statutes/TITLE34/34-18.1/34-18.1-1.htm', 'https://webserver.rilegislature.gov/Statutes/TITLE34/34-18.1/34-18.1-2.htm', 'https://webserver.rilegislature.gov/Statutes/TITLE34/34-18.1/34-18.1-3.htm', 'https://webserver.rilegislature.gov/Statutes/TITLE34/34-18.1/34-18.1-4.htm', 'https://webserver.rilegislature.gov/Statutes/TITLE34/34-18.1/34-18.1-5.htm', 'https://webserver.rilegislature.gov/Statutes/TITLE34/34-18.1/34-18.1-6.htm', 'https://webserver.rilegislature.gov/Statutes/TITLE34/34-18.1/34-18.1-7.htm', 'https://webserver.rilegislature.gov/Statutes/TITLE34/34-18.1/34-18.1-8.htm', 'https://webserver.rilegislature.gov/Statutes/TITLE34/34-18.1/34-18.1-9.htm', 'https://webserver.rilegislature.gov/Statutes/TITLE34/34-18.1/34-18.1-10.htm', 'https://webserver.rilegislature.gov/Statutes/TITLE34/34-18.1/34-18.1-11.htm', 'https://webserver.rilegislature.gov/Statutes/TITLE34/34-18.1/34-18.1-12.htm', 'https://webserver.rilegislature.gov/Statutes/TITLE34/34-18.1/34-18.1-13.htm', 'https://webserver.rilegislature.gov/Statutes/TITLE34/34-18.1/34-18.1-14.htm', 'https://webserver.rilegislature.gov/Statutes/TITLE34/34-18.1/34-18.1-15.htm', 'https://webserver.rilegislature.gov/Statutes/TITLE34/34-18.1/34-18.1-16.htm', 'https://webserver.rilegislature.gov/Statutes/TITLE34/34-18.1/34-18.1-17.htm', 'https://webserver.rilegislature.gov/Statutes/TITLE34/34-18.1/34-18.1-18.htm', 'https://webserver.rilegislature.gov/Statutes/TITLE34/34-18.1/34-18.1-19.htm', 'https://webserver.rilegislature.gov/Statutes/TITLE34/34-18.1/34-18.1-20.htm'], parse: parseRI },
    { actKey: 'eviction', kind: 'whole', encoding: 'utf-8', urls: ['https://webserver.rilegislature.gov/Statutes/TITLE34/34-19/34-19-1.htm', 'https://webserver.rilegislature.gov/Statutes/TITLE34/34-19/34-19-2.htm', 'https://webserver.rilegislature.gov/Statutes/TITLE34/34-19/34-19-3.htm', 'https://webserver.rilegislature.gov/Statutes/TITLE34/34-19/34-19-4.htm', 'https://webserver.rilegislature.gov/Statutes/TITLE34/34-19/34-19-5.htm', 'https://webserver.rilegislature.gov/Statutes/TITLE34/34-19/34-19-6.htm', 'https://webserver.rilegislature.gov/Statutes/TITLE34/34-19/34-19-7.htm', 'https://webserver.rilegislature.gov/Statutes/TITLE34/34-19/34-19-8.htm', 'https://webserver.rilegislature.gov/Statutes/TITLE34/34-19/34-19-9.htm', 'https://webserver.rilegislature.gov/Statutes/TITLE34/34-19/34-19-10.htm', 'https://webserver.rilegislature.gov/Statutes/TITLE34/34-19/34-19-11.htm'], parse: parseRI },
    { actKey: 'self_storage', kind: 'whole', encoding: 'utf-8', urls: ['https://webserver.rilegislature.gov/Statutes/TITLE34/34-42/34-42-1.htm', 'https://webserver.rilegislature.gov/Statutes/TITLE34/34-42/34-42-2.htm', 'https://webserver.rilegislature.gov/Statutes/TITLE34/34-42/34-42-3.htm', 'https://webserver.rilegislature.gov/Statutes/TITLE34/34-42/34-42-4.htm', 'https://webserver.rilegislature.gov/Statutes/TITLE34/34-42/34-42-5.htm', 'https://webserver.rilegislature.gov/Statutes/TITLE34/34-42/34-42-6.htm', 'https://webserver.rilegislature.gov/Statutes/TITLE34/34-42/34-42-7.htm', 'https://webserver.rilegislature.gov/Statutes/TITLE34/34-42/34-42-8.htm', 'https://webserver.rilegislature.gov/Statutes/TITLE34/34-42/34-42-9.htm'], parse: parseRI },
    { actKey: 'mobile_home_park', kind: 'whole', encoding: 'utf-8', urls: ['https://webserver.rilegislature.gov/Statutes/TITLE31/31-44/31-44-1.htm', 'https://webserver.rilegislature.gov/Statutes/TITLE31/31-44/31-44-1.1.htm', 'https://webserver.rilegislature.gov/Statutes/TITLE31/31-44/31-44-1.4.htm', 'https://webserver.rilegislature.gov/Statutes/TITLE31/31-44/31-44-1.5.htm', 'https://webserver.rilegislature.gov/Statutes/TITLE31/31-44/31-44-1.6.htm', 'https://webserver.rilegislature.gov/Statutes/TITLE31/31-44/31-44-1.7.htm', 'https://webserver.rilegislature.gov/Statutes/TITLE31/31-44/31-44-1.8.htm', 'https://webserver.rilegislature.gov/Statutes/TITLE31/31-44/31-44-2.htm', 'https://webserver.rilegislature.gov/Statutes/TITLE31/31-44/31-44-3.htm', 'https://webserver.rilegislature.gov/Statutes/TITLE31/31-44/31-44-3.1.htm', 'https://webserver.rilegislature.gov/Statutes/TITLE31/31-44/31-44-3.2.htm', 'https://webserver.rilegislature.gov/Statutes/TITLE31/31-44/31-44-3.3.htm', 'https://webserver.rilegislature.gov/Statutes/TITLE31/31-44/31-44-4.htm', 'https://webserver.rilegislature.gov/Statutes/TITLE31/31-44/31-44-4.1.htm', 'https://webserver.rilegislature.gov/Statutes/TITLE31/31-44/31-44-5.htm', 'https://webserver.rilegislature.gov/Statutes/TITLE31/31-44/31-44-6.htm', 'https://webserver.rilegislature.gov/Statutes/TITLE31/31-44/31-44-7.htm', 'https://webserver.rilegislature.gov/Statutes/TITLE31/31-44/31-44-7.1.htm', 'https://webserver.rilegislature.gov/Statutes/TITLE31/31-44/31-44-7.2.htm', 'https://webserver.rilegislature.gov/Statutes/TITLE31/31-44/31-44-8.htm', 'https://webserver.rilegislature.gov/Statutes/TITLE31/31-44/31-44-9.htm', 'https://webserver.rilegislature.gov/Statutes/TITLE31/31-44/31-44-9.1.htm', 'https://webserver.rilegislature.gov/Statutes/TITLE31/31-44/31-44-9.2.htm', 'https://webserver.rilegislature.gov/Statutes/TITLE31/31-44/31-44-10.htm', 'https://webserver.rilegislature.gov/Statutes/TITLE31/31-44/31-44-11.htm', 'https://webserver.rilegislature.gov/Statutes/TITLE31/31-44/31-44-12.htm', 'https://webserver.rilegislature.gov/Statutes/TITLE31/31-44/31-44-13.htm', 'https://webserver.rilegislature.gov/Statutes/TITLE31/31-44/31-44-14.htm', 'https://webserver.rilegislature.gov/Statutes/TITLE31/31-44/31-44-15.htm', 'https://webserver.rilegislature.gov/Statutes/TITLE31/31-44/31-44-16.htm', 'https://webserver.rilegislature.gov/Statutes/TITLE31/31-44/31-44-17.htm', 'https://webserver.rilegislature.gov/Statutes/TITLE31/31-44/31-44-18.htm', 'https://webserver.rilegislature.gov/Statutes/TITLE31/31-44/31-44-19.htm', 'https://webserver.rilegislature.gov/Statutes/TITLE31/31-44/31-44-20.htm', 'https://webserver.rilegislature.gov/Statutes/TITLE31/31-44/31-44-21.htm', 'https://webserver.rilegislature.gov/Statutes/TITLE31/31-44/31-44-22.htm', 'https://webserver.rilegislature.gov/Statutes/TITLE31/31-44/31-44-23.htm', 'https://webserver.rilegislature.gov/Statutes/TITLE31/31-44.1/31-44.1-1.htm', 'https://webserver.rilegislature.gov/Statutes/TITLE31/31-44.1/31-44.1-2.htm', 'https://webserver.rilegislature.gov/Statutes/TITLE31/31-44.1/31-44.1-3.htm'], parse: parseRI },
    { actKey: 'rv_park', kind: 'whole', encoding: 'utf-8', urls: ['https://webserver.rilegislature.gov/Statutes/TITLE32/32-7/32-7-1.htm', 'https://webserver.rilegislature.gov/Statutes/TITLE32/32-7/32-7-2.htm', 'https://webserver.rilegislature.gov/Statutes/TITLE32/32-7/32-7-3.htm', 'https://webserver.rilegislature.gov/Statutes/TITLE32/32-7/32-7-4.htm', 'https://webserver.rilegislature.gov/Statutes/TITLE32/32-7/32-7-5.htm', 'https://webserver.rilegislature.gov/Statutes/TITLE32/32-7/32-7-6.htm', 'https://webserver.rilegislature.gov/Statutes/TITLE32/32-7/32-7-7.htm', 'https://webserver.rilegislature.gov/Statutes/TITLE32/32-7/32-7-8.htm', 'https://webserver.rilegislature.gov/Statutes/TITLE32/32-7/32-7-9.htm', 'https://webserver.rilegislature.gov/Statutes/TITLE32/32-7/32-7-10.htm', 'https://webserver.rilegislature.gov/Statutes/TITLE32/32-7/32-7-11.htm', 'https://webserver.rilegislature.gov/Statutes/TITLE32/32-7/32-7-12.htm', 'https://webserver.rilegislature.gov/Statutes/TITLE32/32-7/32-7-13.htm', 'https://webserver.rilegislature.gov/Statutes/TITLE32/32-7/32-7-14.htm', 'https://webserver.rilegislature.gov/Statutes/TITLE32/32-7/32-7-15.htm'], parse: parseRI },
  ] },
  DE: { state: 'DE', sourceDate: SRC_DATE, acts: [
    { actKey: 'residential', kind: 'whole', encoding: 'utf-8', urls: ['http://delcode.delaware.gov/title25/c053/index.html', 'http://delcode.delaware.gov/title25/c055/index.html'], parse: parseDE },
    { actKey: 'manufactured_home_park', kind: 'whole', encoding: 'utf-8', urls: ['http://delcode.delaware.gov/title25/c070/sc02/index.html'], parse: parseDE },
    { actKey: 'self_storage', kind: 'whole', encoding: 'utf-8', urls: ['http://delcode.delaware.gov/title25/c049/index.html'], parse: parseDE },
    { actKey: 'commercial', kind: 'whole', encoding: 'utf-8', urls: ['http://delcode.delaware.gov/title25/c061/index.html'], parse: parseDE },
    { actKey: 'eviction', kind: 'whole', encoding: 'utf-8', urls: ['http://delcode.delaware.gov/title25/c057/index.html'], parse: parseDE },
    { actKey: 'general_landlord_tenant', kind: 'whole', encoding: 'utf-8', urls: ['http://delcode.delaware.gov/title25/c056/index.html', 'http://delcode.delaware.gov/title25/c059/index.html', 'http://delcode.delaware.gov/title25/c063/index.html'], parse: parseDE },
  ] },
  SD: { state: 'SD', sourceDate: SRC_DATE, acts: [
    { actKey: 'residential', kind: 'whole', encoding: 'utf-8', urls: ['https://sdlegislature.gov/api/Statutes/43-32-1.html', 'https://sdlegislature.gov/api/Statutes/43-32-2.html', 'https://sdlegislature.gov/api/Statutes/43-32-3.html', 'https://sdlegislature.gov/api/Statutes/43-32-4.html', 'https://sdlegislature.gov/api/Statutes/43-32-5.html', 'https://sdlegislature.gov/api/Statutes/43-32-6.html', 'https://sdlegislature.gov/api/Statutes/43-32-6.1.html', 'https://sdlegislature.gov/api/Statutes/43-32-7.html', 'https://sdlegislature.gov/api/Statutes/43-32-8.html', 'https://sdlegislature.gov/api/Statutes/43-32-9.html', 'https://sdlegislature.gov/api/Statutes/43-32-10.html', 'https://sdlegislature.gov/api/Statutes/43-32-11.html', 'https://sdlegislature.gov/api/Statutes/43-32-12.html', 'https://sdlegislature.gov/api/Statutes/43-32-13.html', 'https://sdlegislature.gov/api/Statutes/43-32-14.html', 'https://sdlegislature.gov/api/Statutes/43-32-15.html', 'https://sdlegislature.gov/api/Statutes/43-32-16.html', 'https://sdlegislature.gov/api/Statutes/43-32-17.html', 'https://sdlegislature.gov/api/Statutes/43-32-18.html', 'https://sdlegislature.gov/api/Statutes/43-32-18.1.html', 'https://sdlegislature.gov/api/Statutes/43-32-19.html', 'https://sdlegislature.gov/api/Statutes/43-32-19.1.html', 'https://sdlegislature.gov/api/Statutes/43-32-19.2.html', 'https://sdlegislature.gov/api/Statutes/43-32-20.html', 'https://sdlegislature.gov/api/Statutes/43-32-21.html', 'https://sdlegislature.gov/api/Statutes/43-32-22.html', 'https://sdlegislature.gov/api/Statutes/43-32-22.1.html', 'https://sdlegislature.gov/api/Statutes/43-32-23.html', 'https://sdlegislature.gov/api/Statutes/43-32-24.html', 'https://sdlegislature.gov/api/Statutes/43-32-24.1.html', 'https://sdlegislature.gov/api/Statutes/43-32-25.html', 'https://sdlegislature.gov/api/Statutes/43-32-26.html', 'https://sdlegislature.gov/api/Statutes/43-32-27.html', 'https://sdlegislature.gov/api/Statutes/43-32-28.html', 'https://sdlegislature.gov/api/Statutes/43-32-29.html', 'https://sdlegislature.gov/api/Statutes/43-32-30.html', 'https://sdlegislature.gov/api/Statutes/43-32-31.html', 'https://sdlegislature.gov/api/Statutes/43-32-32.html', 'https://sdlegislature.gov/api/Statutes/43-32-33.html', 'https://sdlegislature.gov/api/Statutes/43-32-34.html', 'https://sdlegislature.gov/api/Statutes/43-32-35.html', 'https://sdlegislature.gov/api/Statutes/43-32-36.html', 'https://sdlegislature.gov/api/Statutes/43-32-37.html'], parse: parseSD },
    { actKey: 'eviction', kind: 'whole', encoding: 'utf-8', urls: ['https://sdlegislature.gov/api/Statutes/21-16-1.html', 'https://sdlegislature.gov/api/Statutes/21-16-2.html', 'https://sdlegislature.gov/api/Statutes/21-16-3.html', 'https://sdlegislature.gov/api/Statutes/21-16-4.html', 'https://sdlegislature.gov/api/Statutes/21-16-5.html', 'https://sdlegislature.gov/api/Statutes/21-16-6.html', 'https://sdlegislature.gov/api/Statutes/21-16-6.1.html', 'https://sdlegislature.gov/api/Statutes/21-16-7.html', 'https://sdlegislature.gov/api/Statutes/21-16-8.html', 'https://sdlegislature.gov/api/Statutes/21-16-9.html', 'https://sdlegislature.gov/api/Statutes/21-16-10.html', 'https://sdlegislature.gov/api/Statutes/21-16-11.html', 'https://sdlegislature.gov/api/Statutes/21-16-12.html'], parse: parseSD },
    { actKey: 'self_storage', kind: 'whole', encoding: 'utf-8', urls: ['https://sdlegislature.gov/api/Statutes/44-14-1.html', 'https://sdlegislature.gov/api/Statutes/44-14-2.html', 'https://sdlegislature.gov/api/Statutes/44-14-3.html', 'https://sdlegislature.gov/api/Statutes/44-14-4.html', 'https://sdlegislature.gov/api/Statutes/44-14-5.html', 'https://sdlegislature.gov/api/Statutes/44-14-6.html', 'https://sdlegislature.gov/api/Statutes/44-14-7.html', 'https://sdlegislature.gov/api/Statutes/44-14-8.html', 'https://sdlegislature.gov/api/Statutes/44-14-9.html', 'https://sdlegislature.gov/api/Statutes/44-14-10.html'], parse: parseSD },
  ] },
  VT: { state: 'VT', sourceDate: SRC_DATE, acts: [
    { actKey: 'residential', kind: 'whole', encoding: 'utf-8', urls: ['https://legislature.vermont.gov/statutes/fullchapter/09/137'], parse: parseVT },
    { actKey: 'manufactured_home_park', kind: 'whole', encoding: 'utf-8', urls: ['https://legislature.vermont.gov/statutes/fullchapter/09/136'], parse: parseVT },
    { actKey: 'self_storage', kind: 'whole', encoding: 'utf-8', urls: ['https://legislature.vermont.gov/statutes/fullchapter/09/098'], parse: parseVT },
    { actKey: 'eviction', kind: 'whole', encoding: 'utf-8', urls: ['https://legislature.vermont.gov/statutes/fullchapter/12/171'], parse: parseVT },
  ] },
}

async function main() {
  const st = (process.argv[2] || 'ALL').toUpperCase()
  const targets = st === 'ALL' ? Object.keys(CONFIGS) : [st]
  for (const t of targets) { if (!CONFIGS[t]) { console.error('no config', t); continue } await runState(CONFIGS[t]) }
  process.exit(0)
}
main().catch((e) => { console.error(e); process.exit(1) })
