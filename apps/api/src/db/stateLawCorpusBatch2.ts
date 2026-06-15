// @ts-nocheck
/**
 * S453 batch-2 verbatim statute parsers — WI MN SC OR CT UT IA.
 * Per-state parsers developed + live-tested by subagents, then integrated.
 * WI overridden to the whole-chapter page (single act_key); OR limited to
 * ORS Ch.90 residential. AL deferred (only stale 2019 Wayback available);
 * KY deferred (PDF-only bodies). Reuses runState from ingestStateLawCorpus.
 * Run: cd apps/api && node -r ts-node/register src/db/stateLawCorpusBatch2.ts <STATE|ALL>
 */

import { runState } from './ingestStateLawCorpus'

const SRC_DATE = '2026-06-13'

// ---- WI (WI: whole-chapter page, single act_key) ----
function parseWI(html) {
  // ---- HTML entity decoding ----
  function decodeEntities(s) {
    if (s.indexOf('&') === -1) return s;
    s = s.replace(/&#x([0-9a-fA-F]+);/g, function (_, h) {
      return String.fromCodePoint(parseInt(h, 16));
    });
    s = s.replace(/&#(\d+);/g, function (_, d) {
      return String.fromCodePoint(parseInt(d, 10));
    });
    var named = {
      'sect': '§', 'nbsp': ' ', 'amp': '&', 'lt': '<', 'gt': '>',
      'quot': '"', 'apos': "'", 'mdash': '—', 'ndash': '–',
      'hellip': '…', 'rsquo': '’', 'lsquo': '‘',
      'ldquo': '“', 'rdquo': '”', 'deg': '°',
      'frac12': '½', 'frac14': '¼', 'frac34': '¾',
      'reg': '®', 'copy': '©', 'trade': '™',
      'eacute': 'é', 'times': '×', 'middot': '·'
    };
    s = s.replace(/&([a-zA-Z][a-zA-Z0-9]+);/g, function (m, name) {
      return Object.prototype.hasOwnProperty.call(named, name) ? named[name] : m;
    });
    return s;
  }

  // ---- strip tags -> readable text (block closers + <br> -> newline) ----
  function tagsToText(frag) {
    if (frag == null) return '';
    var t = frag;
    t = t.replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, '');
    t = t.replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi, '');
    t = t.replace(/<br\s*\/?>/gi, '\n');
    t = t.replace(/<\/(p|div|li|tr|h[1-6]|ul|ol|table)\s*>/gi, '\n');
    t = t.replace(/<[^>]+>/g, '');
    t = decodeEntities(t);
    t = t.replace(/ /g, ' ');
    t = t.replace(/\r/g, '');
    t = t.replace(/[ \t]+/g, ' ');
    t = t.replace(/ *\n */g, '\n');
    t = t.replace(/\n{3,}/g, '\n\n');
    return t.trim();
  }

  // text of first element matching a class within a fragment (balanced same-tag)
  function firstClassText(frag, cls) {
    var re = new RegExp('<([a-z0-9]+)\\b[^>]*class="[^"]*\\b' + cls + '\\b[^"]*"[^>]*>', 'i');
    var m = re.exec(frag);
    if (!m) return null;
    var tag = m[1];
    var startContent = m.index + m[0].length;
    var openRe = new RegExp('<' + tag + '\\b', 'ig');
    var closeRe = new RegExp('</' + tag + '\\s*>', 'ig');
    var depth = 1, pos = startContent;
    while (depth > 0) {
      openRe.lastIndex = pos; closeRe.lastIndex = pos;
      var om = openRe.exec(frag), cm = closeRe.exec(frag);
      if (!cm) break;
      if (om && om.index < cm.index) { depth++; pos = om.index + om[0].length; }
      else { depth--; pos = cm.index + cm[0].length; if (depth === 0) return tagsToText(frag.slice(startContent, cm.index)); }
    }
    return tagsToText(frag.slice(startContent));
  }

  // remove first element of a given class (balanced same-tag) from a fragment
  function removeFirstClassBlock(frag, cls) {
    var re = new RegExp('<([a-z0-9]+)\\b[^>]*class="[^"]*\\b' + cls + '\\b[^"]*"[^>]*>', 'i');
    var m = re.exec(frag);
    if (!m) return frag;
    var tag = m[1];
    var startContent = m.index + m[0].length;
    var openRe = new RegExp('<' + tag + '\\b', 'ig');
    var closeRe = new RegExp('</' + tag + '\\s*>', 'ig');
    var depth = 1, pos = startContent;
    while (depth > 0) {
      openRe.lastIndex = pos; closeRe.lastIndex = pos;
      var om = openRe.exec(frag), cm = closeRe.exec(frag);
      if (!cm) return frag.slice(0, m.index) + frag.slice(startContent);
      if (om && om.index < cm.index) { depth++; pos = om.index + om[0].length; }
      else { depth--; pos = cm.index + cm[0].length; if (depth === 0) return frag.slice(0, m.index) + frag.slice(pos); }
    }
    return frag;
  }

  // data-section attribute of a div header
  function dataSection(header) {
    var m = /data-section="([^"]+)"/i.exec(header);
    return m ? m[1] : null;
  }

  // find matching </div> end for a div whose content starts at `from`
  function divEnd(from) {
    var openRe = /<div\b/ig;
    var closeRe = /<\/div\s*>/ig;
    var depth = 1, pos = from;
    while (depth > 0) {
      openRe.lastIndex = pos; closeRe.lastIndex = pos;
      var om = openRe.exec(html), cm = closeRe.exec(html);
      if (!cm) return html.length;
      if (om && om.index < cm.index) { depth++; pos = om.index + om[0].length; }
      else { depth--; pos = cm.index + cm[0].length; if (depth === 0) return cm.index; }
    }
    return html.length;
  }

  // ---- locate every qsatxt_* div (these hold ALL statute body; qsnote_*
  //      annotation divs are intentionally NOT qsatxt_* and therefore skipped) ----
  var divRe = /<div\b[^>]*class="(qsatxt_[a-z0-9]+)[^"]*"[^>]*>/ig;
  var matches = [];
  var dm;
  while ((dm = divRe.exec(html)) !== null) {
    matches.push({ kind: dm[1], contentStart: dm.index + dm[0].length, header: dm[0] });
  }
  if (!matches.length) return [];

  var order = [];
  var sections = {};

  for (var i = 0; i < matches.length; i++) {
    var mt = matches[i];
    var end = divEnd(mt.contentStart);
    var inner = html.slice(mt.contentStart, end);
    var secNum = dataSection(mt.header);
    if (!secNum) continue;

    if (!sections[secNum]) {
      sections[secNum] = { number: secNum, title: null, parts: [] };
      order.push(secNum);
    }
    var rec = sections[secNum];

    if (mt.kind === 'qsatxt_1sect') {
      var titleText = firstClassText(inner, 'qstitle_sect');
      if (titleText) rec.title = titleText.replace(/\s+/g, ' ').trim();
      var body1 = inner;
      body1 = body1.replace(/<a\b[^>]*class="reference"[^>]*>[\s\S]*?<\/a>/i, '');
      body1 = removeFirstClassBlock(body1, 'qsnum_sect');
      body1 = removeFirstClassBlock(body1, 'qstitle_sect');
      var leadBody = tagsToText(body1);
      if (leadBody) rec.parts.push(leadBody);
    } else {
      var body = inner.replace(/<a\b[^>]*class="reference"[^>]*>[\s\S]*?<\/a>/i, '');
      var txt = tagsToText(body);
      if (txt) rec.parts.push(txt);
    }
  }

  var out = [];
  for (var k = 0; k < order.length; k++) {
    var r = sections[order[k]];
    var number = r.number.replace(/^0+(?=\d)/, '');
    var text = r.parts.join('\n').replace(/[ \t]+/g, ' ').replace(/ *\n */g, '\n').replace(/\n{3,}/g, '\n\n').trim();
    if (!text || text.length < 20) continue;
    out.push({ number: number, title: r.title, text: text });
  }
  return out;
}

// ---- MN ----
function parseMN(html) {
  var sections = [];
  if (!html) return sections;

  // Decode HTML entities (named + numeric decimal + numeric hex).
  function decodeEntities(s) {
    if (s.indexOf('&') === -1) return s;
    var named = {
      'nbsp': ' ', 'amp': '&', 'lt': '<', 'gt': '>', 'quot': '"',
      'apos': "'", 'sect': '§', 'mdash': '—', 'ndash': '–',
      'lsquo': '‘', 'rsquo': '’', 'ldquo': '“', 'rdquo': '”',
      'hellip': '…', 'deg': '°', 'middot': '·', 'bull': '•',
      'frac12': '½', 'frac14': '¼', 'frac34': '¾', 'para': '¶',
      'reg': '®', 'copy': '©', 'trade': '™', 'eacute': 'é'
    };
    return s.replace(/&#x([0-9a-fA-F]+);/g, function (m, h) {
      return String.fromCodePoint(parseInt(h, 16));
    }).replace(/&#(\d+);/g, function (m, d) {
      return String.fromCodePoint(parseInt(d, 10));
    }).replace(/&([a-zA-Z][a-zA-Z0-9]*);/g, function (m, name) {
      return Object.prototype.hasOwnProperty.call(named, name) ? named[name] : m;
    });
  }

  // Turn an HTML fragment into readable text: block-closers + <br> -> newline,
  // strip remaining tags, decode entities, collapse spaces, normalize blank lines.
  function htmlToText(frag) {
    var t = frag;
    // Drop script/style outright.
    t = t.replace(/<script[\s\S]*?<\/script>/gi, ' ');
    t = t.replace(/<style[\s\S]*?<\/style>/gi, ' ');
    // Drop the "section-sign" permalink nav anchors (class="permalink") entirely.
    t = t.replace(/<a\b[^>]*class="[^"]*\bpermalink\b[^"]*"[^>]*>[\s\S]*?<\/a>/gi, ' ');
    // Ensure a space precedes the headnote span so "Subd. 2.Controlled substance."
    // reads "Subd. 2. Controlled substance." (subd number period is glued to title).
    t = t.replace(/<span class="headnote">/gi, ' <span class="headnote">');
    // <br> -> newline.
    t = t.replace(/<br\s*\/?>/gi, '\n');
    // Block-closers -> newline (paragraphs, list items, divs, headings, table cells/rows).
    t = t.replace(/<\/(p|div|li|h1|h2|h3|h4|h5|h6|tr|table|ul|ol|blockquote)\s*>/gi, '\n');
    // Strip all remaining tags.
    t = t.replace(/<[^>]+>/g, '');
    // Decode entities.
    t = decodeEntities(t);
    // Normalize CRLF, NBSP -> space.
    t = t.replace(/\r\n?/g, '\n').replace(/ /g, ' ');
    // Collapse runs of spaces/tabs (but keep newlines).
    t = t.replace(/[ \t\f\v]+/g, ' ');
    // Trim each line.
    t = t.split('\n').map(function (ln) { return ln.trim(); }).join('\n');
    // Collapse 3+ newlines to a paragraph break.
    t = t.replace(/\n{3,}/g, '\n\n');
    return t.trim();
  }

  // Locate every <div class="section" id="stat.NUM"> and slice each section body
  // up to its history block (or the start of the next section).
  var openRe = /<div class="section"\s+id="stat\.([^"]+)"[^>]*>/gi;
  var matches = [];
  var m;
  while ((m = openRe.exec(html)) !== null) {
    matches.push({ idRaw: m[1], start: m.index, contentStart: openRe.lastIndex });
  }

  for (var i = 0; i < matches.length; i++) {
    var cur = matches[i];
    var sliceEnd = (i + 1 < matches.length) ? matches[i + 1].start : html.length;
    var block = html.slice(cur.contentStart, sliceEnd);

    // Cut off the history block and everything after it (footer, nav, etc.).
    var histIdx = block.search(/<div class="history"/i);
    if (histIdx !== -1) block = block.slice(0, histIdx);

    // Section number from the id: "504B.001" (chapter.section). Defensively trim
    // any stray trailing dotted tail (e.g. ".history").
    var number = cur.idRaw;
    var partsBad = number.match(/^([0-9]+[A-Za-z]?)\.([0-9]+[A-Za-z]?)/);
    if (partsBad) number = partsBad[1] + '.' + partsBad[2];
    number = number.trim();

    // Title: <h1 class="shn">504B.001 DEFINITIONS.</h1>
    var title = null;
    var shnM = block.match(/<h1[^>]*class="[^"]*\bshn\b[^"]*"[^>]*>([\s\S]*?)<\/h1>/i);
    var bodyFrag = block;
    if (shnM) {
      var headText = htmlToText(shnM[1]);
      var numEsc = number.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      var titleOnly = headText.replace(new RegExp('^\\s*' + numEsc + '\\s+'), '');
      titleOnly = titleOnly.replace(/\.\s*$/, '').trim();
      title = titleOnly.length ? titleOnly : null;
      // Remove the <h1> from the body so the catchline isn't duplicated in text.
      bodyFrag = block.replace(shnM[0], ' ');
    }

    var text = htmlToText(bodyFrag);

    // EXCLUDE repealed/empty/stub sections (body too short to be real law).
    if (text.length < 20) continue;

    sections.push({ number: number, title: title, text: text });
  }

  return sections;
}

// ---- SC ----
function parseSC(html) {
  var sections = [];
  if (!html || typeof html !== 'string') return sections;

  // Decode HTML entities (named + numeric decimal + numeric hex).
  function decodeEntities(s) {
    if (!s) return s;
    s = s.replace(/&#x([0-9a-fA-F]+);/g, function (_, h) {
      var cp = parseInt(h, 16);
      return isNaN(cp) ? _ : String.fromCodePoint(cp);
    });
    s = s.replace(/&#(\d+);/g, function (_, d) {
      var cp = parseInt(d, 10);
      return isNaN(cp) ? _ : String.fromCodePoint(cp);
    });
    var named = {
      '&nbsp;': ' ', '&sect;': '§', '&amp;': '&', '&lt;': '<',
      '&gt;': '>', '&quot;': '"', '&apos;': "'", '&mdash;': '—',
      '&ndash;': '–', '&rsquo;': '’', '&lsquo;': '‘',
      '&ldquo;': '“', '&rdquo;': '”', '&hellip;': '…',
      '&deg;': '°', '&para;': '¶', '&copy;': '©',
      '&reg;': '®', '&trade;': '™', '&frac12;': '½',
      '&frac14;': '¼', '&frac34;': '¾'
    };
    s = s.replace(/&[a-zA-Z]+;/g, function (m) {
      return named.hasOwnProperty(m) ? named[m] : m;
    });
    return s;
  }

  // Convert an HTML fragment to readable plain text, preserving
  // block/line structure as newlines, then collapsing whitespace.
  function htmlToText(frag) {
    if (!frag) return '';
    var t = frag;
    t = t.replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, ' ');
    t = t.replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi, ' ');
    // <br> and block-closing tags -> newline.
    t = t.replace(/<br\s*\/?>/gi, '\n');
    t = t.replace(/<\/(p|div|li|tr|h[1-6]|blockquote)>/gi, '\n');
    // Strip all remaining tags.
    t = t.replace(/<[^>]+>/g, '');
    // Decode entities after tag strip.
    t = decodeEntities(t);
    // Normalize line endings.
    t = t.replace(/\r\n?/g, '\n');
    // Treat NBSP as a regular space for collapsing.
    t = t.replace(/ /g, ' ');
    // Collapse spaces/tabs (not newlines).
    t = t.replace(/[ \t\f\v]+/g, ' ');
    // Trim each line.
    t = t.split('\n').map(function (ln) { return ln.trim(); }).join('\n');
    // Collapse 3+ newlines to 2.
    t = t.replace(/\n{3,}/g, '\n\n');
    return t.trim();
  }

  // Anchor: bold span holding "SECTION 27-40-110." etc.
  var spanRe = /<span\s+style="font-weight:\s*bold;">\s*SECTION\s+([0-9A-Za-z][0-9A-Za-z\-.]*?)\.?\s*<\/span>/gi;

  var anchors = [];
  var m;
  while ((m = spanRe.exec(html)) !== null) {
    anchors.push({ number: m[1], spanStart: m.index, bodyStart: spanRe.lastIndex });
  }
  if (anchors.length === 0) return sections;

  for (var i = 0; i < anchors.length; i++) {
    var a = anchors[i];
    var sliceEnd = (i + 1 < anchors.length) ? anchors[i + 1].spanStart : html.length;
    var chunk = html.slice(a.bodyStart, sliceEnd);

    var number = a.number.replace(/\.+$/, '').trim();

    // Catchline = text up to the first <br/><br/> (or first <br/>).
    var title = null;
    var bodyHtml = chunk;
    var brBreak = chunk.search(/<br\s*\/?>\s*<br\s*\/?>/i);
    if (brBreak === -1) brBreak = chunk.search(/<br\s*\/?>/i);
    if (brBreak !== -1) {
      var catchHtml = chunk.slice(0, brBreak);
      title = htmlToText(catchHtml).replace(/\s*\.\s*$/, '').trim();
      if (title === '') title = null;
      var afterCatch = chunk.slice(brBreak).replace(/^(?:\s*<br\s*\/?>\s*){1,2}/i, '');
      bodyHtml = afterCatch;
    }

    // Cut the body at the HISTORY citation line (everything from
    // HISTORY: onward is metadata, and centered ARTICLE/SUBARTICLE
    // headings live after it before the next section span).
    var bodyText = htmlToText(bodyHtml);
    var histIdx = bodyText.search(/(^|\n)\s*HISTORY\s*:/i);
    if (histIdx !== -1) {
      bodyText = bodyText.slice(0, histIdx);
    }
    bodyText = bodyText.replace(/\n{3,}/g, '\n\n').trim();

    // Skip repealed/empty/too-short bodies.
    if (!bodyText || bodyText.length < 20) continue;
    if (/^\[?\s*(reserved|repealed|blank)\b/i.test(bodyText) && bodyText.length < 60) continue;

    sections.push({ number: number, title: title, text: bodyText });
  }

  return sections;
}

// ---- OR (OR: Ch90 only (dropped Ch105 to avoid non-LLT pollution)) ----
function parseOR(html) {
  var sections = [];
  if (!html || typeof html !== "string") return sections;

  // ---- entity decode helper ----
  function decodeEntities(str) {
    if (str.indexOf("&") === -1) return str;
    return str
      .replace(/&#x([0-9a-fA-F]+);/g, function (_, h) {
        return String.fromCodePoint(parseInt(h, 16));
      })
      .replace(/&#(\d+);/g, function (_, d) {
        return String.fromCodePoint(parseInt(d, 10));
      })
      .replace(/&nbsp;/gi, " ")
      .replace(/&sect;/gi, "§")
      .replace(/&amp;/gi, "&")
      .replace(/&lt;/gi, "<")
      .replace(/&gt;/gi, ">")
      .replace(/&quot;/gi, '"')
      .replace(/&apos;/gi, "'")
      .replace(/&mdash;/gi, "—")
      .replace(/&ndash;/gi, "–")
      .replace(/&ldquo;/gi, "“")
      .replace(/&rdquo;/gi, "”")
      .replace(/&lsquo;/gi, "‘")
      .replace(/&rsquo;/gi, "’")
      .replace(/&hellip;/gi, "…");
  }

  var SENT = "BRK"; // structural-break sentinel (never appears in statute text)
  function htmlToText(frag) {
    if (!frag) return "";
    var t = frag;
    // drop scripts/styles
    t = t.replace(/<script[\s\S]*?<\/script>/gi, "");
    t = t.replace(/<style[\s\S]*?<\/style>/gi, "");
    // block-closers and <br> -> sentinel (real structural break)
    t = t.replace(/<br\s*\/?>/gi, SENT);
    t = t.replace(/<\/(p|div|li|tr|h[1-6])>/gi, SENT);
    // strip all remaining tags
    t = t.replace(/<[^>]+>/g, "");
    // decode entities
    t = decodeEntities(t);
    // collapse ALL whitespace (incl Word-export CR/LF hard-wraps) to single space
    t = t.replace(/\s+/g, " ");
    // sentinel -> newline (only true subsection/paragraph breaks survive)
    var lines = t.split(SENT);
    var out = [];
    for (var i = 0; i < lines.length; i++) {
      var ln = lines[i].replace(/^\s+|\s+$/g, "");
      if (ln.length) out.push(ln);
    }
    return out.join("\n").replace(/\n{3,}/g, "\n\n").replace(/^\s+|\s+$/g, "");
  }

  // ---- locate real body section headers ----
  // Real section: <b><span ...> NUMBER  Catchline.</span></b>
  // Stub/renumbered: <b><span ...> NUMBER</span></b><span> [history]</span> (no catchline) -> skip
  // Note paragraphs: <b><span ...> Note:</span></b> -> not a header (no number) -> stays in prior body
  var headerRe = /<b>\s*<span\b[^>]*>([\s\S]*?)<\/span>\s*<\/b>/gi;
  var heads = [];
  var m;
  while ((m = headerRe.exec(html)) !== null) {
    var inner = decodeEntities(m[1].replace(/<[^>]+>/g, ""))
      .replace(/\s+/g, " ")
      .replace(/^\s+|\s+$/g, "");
    // must START with a section number (NN.NNN optionally trailing letter)
    var nm = inner.match(/^(\d{1,3}\.\d{1,4}[A-Za-z]?)\b/);
    if (!nm) continue; // e.g. "Note:" / "GENERAL PROVISIONS"
    var num = nm[1];
    var rest = inner.slice(nm[1].length).replace(/^\s+/, "");
    // stub: nothing after number, or only a bracketed history note -> not a real section
    if (rest.length === 0 || rest.charAt(0) === "[") continue;
    var title = rest.replace(/\.\s*$/, "").replace(/\s+/g, " ").replace(/^\s+|\s+$/g, "");
    if (!title) continue;
    heads.push({ num: num, title: title, start: m.index });
  }

  // ---- boundary index: any bold-span starting with a number (real OR stub) ----
  // Each boundary carries its section number so we can skip the Oregon
  // "future-operative text" pattern, where the SAME number reappears as a bare
  // header (e.g. "90.303.") introducing an amended-version block that still
  // belongs to that section. A section's body extends to the next header whose
  // number DIFFERS, so both the current and future-effective text are kept.
  var boundRe = /<b>\s*<span\b[^>]*>\s*(?:&nbsp;|\s)*(\d{1,3}\.\d{1,4}[A-Za-z]?)\b/gi;
  var boundaries = [];
  while ((m = boundRe.exec(html)) !== null) {
    boundaries.push({ idx: m.index, num: m[1] });
  }
  boundaries.sort(function (a, b) { return a.idx - b.idx; });

  function nextBoundary(after, sameNum) {
    for (var i = 0; i < boundaries.length; i++) {
      if (boundaries[i].idx > after && boundaries[i].num !== sameNum) {
        return boundaries[i].idx;
      }
    }
    return html.length;
  }

  for (var h = 0; h < heads.length; h++) {
    var hd = heads[h];
    var bodyEnd = nextBoundary(hd.start, hd.num);
    // include the catchline header itself in the verbatim text (it's part of the statute)
    var raw = html.slice(hd.start, bodyEnd);
    var text = htmlToText(raw);
    if (!text || text.length < 20) continue;
    sections.push({ number: hd.num, title: hd.title, text: text });
  }

  return sections;
}

// ---- CT ----
function parseCT(html) {
  var sections = [];
  if (!html || typeof html !== 'string') return sections;

  function decodeEntities(s) {
    if (!s) return s;
    s = s.replace(/&#x([0-9a-fA-F]+);/g, function (_, h) {
      var cp = parseInt(h, 16);
      return isNaN(cp) ? _ : String.fromCodePoint(cp);
    });
    s = s.replace(/&#(\d+);/g, function (_, d) {
      var cp = parseInt(d, 10);
      return isNaN(cp) ? _ : String.fromCodePoint(cp);
    });
    var named = {
      '&nbsp;': ' ', '&sect;': '§', '&amp;': '&', '&lt;': '<',
      '&gt;': '>', '&quot;': '"', '&apos;': "'", '&mdash;': '—',
      '&ndash;': '–', '&rsquo;': '’', '&lsquo;': '‘',
      '&ldquo;': '“', '&rdquo;': '”', '&hellip;': '…',
      '&deg;': '°'
    };
    s = s.replace(/&[a-zA-Z]+;/g, function (m) {
      return Object.prototype.hasOwnProperty.call(named, m) ? named[m] : m;
    });
    return s;
  }

  function htmlToText(frag) {
    if (!frag) return '';
    var t = frag;
    t = t.replace(/<script\b[\s\S]*?<\/script>/gi, ' ');
    t = t.replace(/<style\b[\s\S]*?<\/style>/gi, ' ');
    t = t.replace(/<br\s*\/?>/gi, '\n');
    t = t.replace(/<\/(p|div|li|tr|h[1-6]|table|ul|ol|blockquote)>/gi, '\n');
    t = t.replace(/<[^>]+>/g, '');
    t = decodeEntities(t);
    t = t.replace(/\r\n?/g, '\n');
    t = t.replace(/[ \t\f\v ]+/g, ' ');
    var lines = t.split('\n').map(function (l) { return l.trim(); });
    lines = lines.filter(function (l) { return l.length > 0; });
    return lines.join('\n').trim();
  }

  function parseCatchline(spanInner) {
    var plain = decodeEntities(spanInner.replace(/<[^>]+>/g, '').replace(/\s+/g, ' ')).trim();
    var m = plain.match(/^Sec\.\s+([0-9][0-9A-Za-z\-]*)\.?\s*([\s\S]*)$/);
    if (!m) return null;
    var number = m[1].replace(/\.+$/, '');
    var title = m[2] ? m[2].trim() : '';
    title = title.replace(/\s+$/, '');
    if (title.length === 0) title = null;
    return { number: number, title: title };
  }

  var openerRe = /<span\s+class="catchln"\s+id="sec_[^"]*">([\s\S]*?)<\/span>/gi;
  var opens = [];
  var m;
  while ((m = openerRe.exec(html)) !== null) {
    opens.push({ inner: m[1], start: m.index, bodyStart: openerRe.lastIndex });
  }

  for (var i = 0; i < opens.length; i++) {
    var cur = opens[i];
    var nextStart = (i + 1 < opens.length) ? opens[i + 1].start : html.length;
    var raw = html.slice(cur.bodyStart, nextStart);

    var cutIdx = raw.length;
    var cutters = [
      /<p[^>]*class="[^"]*\bsource(?:-first)?\b[^"]*"/i,
      /<p[^>]*class="[^"]*\bhistory(?:-first)?\b[^"]*"/i,
      /<p[^>]*class="[^"]*\bannotation(?:-first)?\b[^"]*"/i,
      /<p[^>]*class="[^"]*\bcross-ref(?:-first)?\b[^"]*"/i,
      /<p[^>]*class="[^"]*\bfront-note(?:-first)?\b[^"]*"/i,
      /<table[^>]*class="[^"]*\bnav_tbl\b[^"]*"/i,
      /<hr[^>]*class="[^"]*\bchaps_pg_bar\b[^"]*"/i
    ];
    for (var c = 0; c < cutters.length; c++) {
      var cm = raw.match(cutters[c]);
      if (cm && cm.index < cutIdx) cutIdx = cm.index;
    }
    var bodyFrag = raw.slice(0, cutIdx);

    var meta = parseCatchline(cur.inner);
    if (!meta) continue;

    var text = htmlToText(bodyFrag);

    if (text.length < 20) continue;
    var lead = text.slice(0, 60).toLowerCase();
    if (/^transferred\b/.test(lead)) continue;
    if (/^repealed\b/.test(lead) && text.length < 80) continue;
    if (/^reserved\b/.test(lead) && text.length < 40) continue;

    sections.push({ number: meta.number, title: meta.title, text: text });
  }

  return sections;
}

// ---- UT ----
function parseUT(html) {
  var sections = [];
  if (!html || typeof html !== 'string') return sections;

  // Isolate the statute container. Utah CONTENT pages (C{section}_{version}.html)
  // put the section number, title, and body inside <div id="secdiv">...</div>,
  // followed by <table id="childtbl"> (empty on leaf section pages). NOTE: the
  // TOC's per-section links point to JS-shell pages (57-22-S3.html) whose body
  // is injected client-side and is empty in raw bytes; the ingester must fetch
  // the content URL (derived from the TOC link's ?v= value), which is what the
  // returned acts[].urls list contains.
  var secStart = html.indexOf('<div id="secdiv"');
  if (secStart === -1) return sections;
  var afterOpen = html.indexOf('>', secStart);
  if (afterOpen === -1) return sections;
  var inner = html.slice(afterOpen + 1);

  // Cut at childtbl (always present after the body on a section page) or
  // failing that the closing </div>.
  var cut = inner.indexOf('<table id="childtbl"');
  if (cut === -1) cut = inner.indexOf('</div>');
  if (cut !== -1) inner = inner.slice(0, cut);

  // --- Number + title -------------------------------------------------
  // Leading optional <b><i>Effective .../Superseded ...</i></b> appears
  // before the real number <b>. The first <b> WITHOUT a nested <i> that
  // looks like "NN-NN-NN." is the section number; the next <b> is title.
  var bRe = /<b>([\s\S]*?)<\/b>/g;
  var bm, numRaw = null, titleRaw = null, numEndIdx = -1;
  while ((bm = bRe.exec(inner)) !== null) {
    var content = bm[1];
    // Skip the effective/superseded italic marker bold.
    if (/<i>/.test(content)) continue;
    var txt = decodeEntities(stripTags(content)).replace(/\s+/g, ' ').trim();
    if (numRaw === null) {
      // Expect a section-number token like "57-22-3." possibly w/ &nbsp;
      var nm = txt.match(/^([0-9]+[0-9A-Za-z.\-]*?)\.?\s*$/);
      if (nm) {
        numRaw = nm[1];
        numEndIdx = bRe.lastIndex;
      }
      continue;
    }
    // First non-italic bold after the number is the catchline/title.
    titleRaw = txt;
    break;
  }
  if (numRaw === null) return sections;

  var number = numRaw.replace(/\.+$/, '').trim();
  var title = titleRaw ? titleRaw.replace(/\s+/g, ' ').trim() : null;
  if (title === '') title = null;

  // --- Body -----------------------------------------------------------
  // Body is everything after the title <b>. If no title was found, after
  // the number <b>.
  var bodyStart = numEndIdx;
  if (titleRaw !== null) {
    var tIdx = inner.indexOf('</b>', numEndIdx);
    if (tIdx !== -1) bodyStart = tIdx + 4;
  }
  var body = inner.slice(bodyStart);

  // Drop the legislative credit trailer:
  //   <br><br>Enacted by Chapter ... / Amended by Chapter ... / Repealed by ...
  // It is the tail of secdiv, separated by a blank-line <br><br>.
  body = body.replace(/<br>\s*<br>\s*(?:Enacted|Amended|Repealed|Renumbered|Substituted)\b[\s\S]*$/i, '');

  // Remove anchor tags entirely (id/name targets + cross-ref links) but
  // keep their visible text (cross-ref link text like "(2)").
  body = body.replace(/<a\b[^>]*>/gi, '').replace(/<\/a>/gi, '');

  // Each subsection row is a <tr><td>(marker)</td><td>text</td></tr>.
  // Put a newline at every <tr> so each subsection starts a fresh line;
  // strip the inter-cell <td>/</td> boundaries to nothing so the marker
  // glues directly onto its text -> "(1)text", "(a)text".
  body = body.replace(/<tr\b[^>]*>/gi, '\n');
  body = body.replace(/<\/tr>/gi, '');
  body = body.replace(/<td\b[^>]*>/gi, '');
  body = body.replace(/<\/td>/gi, '');
  body = body.replace(/<\/?table[^>]*>/gi, '');

  // Block closers + <br> -> newline so structure survives.
  body = body.replace(/<br\s*\/?>/gi, '\n');
  body = body.replace(/<\/(p|div|li|h[1-6])>/gi, '\n');

  // Strip remaining tags.
  body = stripTags(body);

  // Decode entities.
  body = decodeEntities(body);

  // Normalize whitespace: collapse runs of spaces/tabs, trim each line,
  // drop empty lines.
  body = body.replace(/\r/g, '');
  body = body.replace(/[ \t  ]+/g, ' ');
  var lines = body.split('\n');
  var cleaned = [];
  for (var i = 0; i < lines.length; i++) {
    var ln = lines[i].trim();
    if (ln !== '') cleaned.push(ln);
  }
  // Glue bare subsection-marker lines onto their following text line so
  // markers stay inline, e.g. "(1)" + "As used..." -> "(1)As used...",
  // "(a)" + '"Corrective..."' -> '(a)"Corrective...'. A bare marker line
  // is one consisting solely of one or more "(token)" groups.
  var out = [];
  for (var j = 0; j < cleaned.length; j++) {
    var cur = cleaned[j];
    if (/^(?:\([0-9A-Za-z]+\))+$/.test(cur) && j + 1 < cleaned.length) {
      out.push(cur + cleaned[j + 1]);
      j++;
    } else {
      out.push(cur);
    }
  }
  var text = out.join('\n').trim();

  // Skip empty / repealed / placeholder bodies.
  if (text.replace(/\s+/g, '').length < 20) return sections;

  sections.push({ number: number, title: title, text: text });
  return sections;

  // --- helpers --------------------------------------------------------
  function stripTags(s) {
    return s.replace(/<[^>]*>/g, '');
  }

  function decodeEntities(s) {
    if (!s) return s;
    s = s.replace(/&#(\d+);/g, function (_, n) {
      var code = parseInt(n, 10);
      return isNaN(code) ? _ : String.fromCharCode(code);
    });
    s = s.replace(/&#x([0-9a-fA-F]+);/g, function (_, n) {
      var code = parseInt(n, 16);
      return isNaN(code) ? _ : String.fromCharCode(code);
    });
    var named = {
      '&sect;': '§',
      '&nbsp;': ' ',
      '&amp;': '&',
      '&lt;': '<',
      '&gt;': '>',
      '&quot;': '"',
      '&apos;': "'",
      '&mdash;': '—',
      '&ndash;': '–',
      '&rsquo;': '’',
      '&lsquo;': '‘',
      '&ldquo;': '“',
      '&rdquo;': '”',
      '&hellip;': '…',
      '&deg;': '°'
    };
    s = s.replace(/&[a-zA-Z]+;/g, function (m) {
      return named.hasOwnProperty(m) ? named[m] : m;
    });
    return s;
  }
}

// ---- IA ----
function parseIA(html) {
  if (!html || typeof html !== "string") return [];

  function decodeEntities(s) {
    if (!s) return s;
    s = s.replace(/&#x([0-9a-fA-F]+);/g, function (_, h) {
      try { return String.fromCodePoint(parseInt(h, 16)); } catch (e) { return _; }
    });
    s = s.replace(/&#(\d+);/g, function (_, d) {
      try { return String.fromCodePoint(parseInt(d, 10)); } catch (e) { return _; }
    });
    var named = {
      nbsp: " ", amp: "&", lt: "<", gt: ">", quot: '"', apos: "'",
      sect: "§", mdash: "—", ndash: "–",
      lsquo: "‘", rsquo: "’", ldquo: "“", rdquo: "”",
      hellip: "…", deg: "°", para: "¶", middot: "·",
      bull: "•", reg: "®", copy: "©", trade: "™"
    };
    s = s.replace(/&([a-zA-Z]+);/g, function (m, n) {
      return Object.prototype.hasOwnProperty.call(named, n) ? named[n] : m;
    });
    return s;
  }

  // Strip markup to readable multi-line text; block-closers and <br> become newlines.
  function htmlToText(frag) {
    var t = frag;
    t = t.replace(/<script[\s\S]*?<\/script>/gi, " ");
    t = t.replace(/<style[\s\S]*?<\/style>/gi, " ");
    t = t.replace(/\r\n?/g, "\n");
    t = t.replace(/<\s*br\s*\/?\s*>/gi, "\n");
    t = t.replace(/<\/\s*(p|div|li|tr|h[1-6]|blockquote)\s*>/gi, "\n");
    t = t.replace(/<[^>]+>/g, "");
    t = decodeEntities(t);
    // normalize NBSP and unicode spaces to plain space
    t = t.replace(/[  -   　﻿]/g, " ");
    t = t.replace(/[ \t\f\v]+/g, " ");
    t = t.replace(/[ \t]*\n[ \t]*/g, "\n").replace(/\n{2,}/g, "\n");
    return t.trim();
  }

  // Single-line flatten (for headings/titles).
  function flatten(frag) {
    return htmlToText(frag).replace(/\s+/g, " ").trim();
  }

  var body = html.replace(/^[\s\S]*?<\/head>/i, "");

  // Each statute section is wrapped in <div class=" x-codeSection-N-0">. Block boundaries
  // run from one opening tag to the next (Arbortext output isn't reliably balanced).
  var openRe = /<div class="\s*x-codeSection-\d+-\d+"\s*>/g;
  var starts = [];
  var m;
  while ((m = openRe.exec(body)) !== null) starts.push(m.index);
  if (starts.length === 0) return [];

  var SEC_NUM = /(\d+[A-Z]?\.\d+[A-Z]?)/;

  var sections = [];
  for (var i = 0; i < starts.length; i++) {
    var blockEnd = (i + 1 < starts.length) ? starts[i + 1] : body.length;
    var block = body.slice(starts[i], blockEnd);

    // Heading region: from block start to the end of the section catchline
    // (x-headnote-12-0). Active sections wrap the heading in <div x-heading-34-0>,
    // repealed in <span x-heading-34-0 ...>, reserved in <span x-heading-33-0>. The
    // identifier span + headnote are present in all variants, so anchor on those.
    var hnMatch = block.match(/<div class="\s*x-headnote-12-0"[^>]*>([\s\S]*?)<\/div>/);
    var headRegion;
    if (hnMatch) {
      headRegion = block.slice(0, block.indexOf(hnMatch[0]) + hnMatch[0].length);
    } else {
      headRegion = block.slice(0, 600);
    }

    var headText = flatten(headRegion);
    var nmatch = headText.match(SEC_NUM);
    if (!nmatch) continue; // not a real numbered section
    var number = nmatch[1];

    // catchline / title
    var title = null;
    if (hnMatch) {
      var tt = flatten(hnMatch[1]);
      if (tt) title = tt;
    }

    // body text
    var bodyFrag = block;
    bodyFrag = bodyFrag.replace(/<span class="\s*x-header-1-0">[\s\S]*?<\/span>/g, " ");
    bodyFrag = bodyFrag.replace(/<span class="\s*x-footer-1-0">[\s\S]*?<\/span>/g, " ");
    bodyFrag = bodyFrag.replace(/<div class="\s*x-meta-1-0">[\s\S]*?<\/div>/g, " ");
    // remove the catchline headnote so it doesn't duplicate into the body
    if (hnMatch) bodyFrag = bodyFrag.replace(hnMatch[0], " ");
    // drop version-annotation spacer spans (tab leaders / em-spaces around the number)
    bodyFrag = bodyFrag.replace(/<span class="\s*x--ufe-codeSectionVersionAnnotation[^"]*">[\s\S]*?<\/span>/g, " ");

    var text = htmlToText(bodyFrag);

    // The bare section-number text node survives the strip (it sits in an x-identifier
    // span we didn't remove); drop it if it leads the body.
    var escNum = number.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    text = text.replace(new RegExp("^\\s*" + escNum + "\\b\\s*"), "");
    // drop a leading duplicate of the catchline if present
    if (title) {
      var escTitle = title.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
      text = text.replace(new RegExp("^\\s*" + escTitle + "\\s*"), "");
    }
    text = text.replace(/\n{2,}/g, "\n").trim();

    if (!text || text.length < 20) continue;

    // skip repealed / reserved / transferred tombstones (no operative statute text)
    var probe = text.replace(/\s+/g, " ").trim();
    if (/^\(?Repealed\b/i.test(probe) || /^Reserved\b/i.test(probe) ||
        /^Transferred\b/i.test(probe)) {
      continue;
    }

    sections.push({ number: number, title: title, text: text });
  }

  return sections;
}

const CONFIGS = {
  WI: { state: 'WI', sourceDate: SRC_DATE, acts: [
    { actKey: 'residential', kind: 'whole', encoding: 'utf-8', urls: ['https://docs.legis.wisconsin.gov/document/statutes/704.01', 'https://docs.legis.wisconsin.gov/document/statutes/704.02', 'https://docs.legis.wisconsin.gov/document/statutes/704.03', 'https://docs.legis.wisconsin.gov/document/statutes/704.05', 'https://docs.legis.wisconsin.gov/document/statutes/704.055', 'https://docs.legis.wisconsin.gov/document/statutes/704.06', 'https://docs.legis.wisconsin.gov/document/statutes/704.07', 'https://docs.legis.wisconsin.gov/document/statutes/704.08', 'https://docs.legis.wisconsin.gov/document/statutes/704.085', 'https://docs.legis.wisconsin.gov/document/statutes/704.09', 'https://docs.legis.wisconsin.gov/document/statutes/704.10', 'https://docs.legis.wisconsin.gov/document/statutes/704.11', 'https://docs.legis.wisconsin.gov/document/statutes/704.13', 'https://docs.legis.wisconsin.gov/document/statutes/704.14', 'https://docs.legis.wisconsin.gov/document/statutes/704.15', 'https://docs.legis.wisconsin.gov/document/statutes/704.16', 'https://docs.legis.wisconsin.gov/document/statutes/704.165', 'https://docs.legis.wisconsin.gov/document/statutes/704.17', 'https://docs.legis.wisconsin.gov/document/statutes/704.19', 'https://docs.legis.wisconsin.gov/document/statutes/704.21', 'https://docs.legis.wisconsin.gov/document/statutes/704.22', 'https://docs.legis.wisconsin.gov/document/statutes/704.23', 'https://docs.legis.wisconsin.gov/document/statutes/704.25', 'https://docs.legis.wisconsin.gov/document/statutes/704.27', 'https://docs.legis.wisconsin.gov/document/statutes/704.28', 'https://docs.legis.wisconsin.gov/document/statutes/704.29', 'https://docs.legis.wisconsin.gov/document/statutes/704.31', 'https://docs.legis.wisconsin.gov/document/statutes/704.40', 'https://docs.legis.wisconsin.gov/document/statutes/704.44', 'https://docs.legis.wisconsin.gov/document/statutes/704.45', 'https://docs.legis.wisconsin.gov/document/statutes/704.50', 'https://docs.legis.wisconsin.gov/document/statutes/704.90', 'https://docs.legis.wisconsin.gov/document/statutes/704.95', 'https://docs.legis.wisconsin.gov/document/statutes/704.96'], parse: parseWI },
  ] },
  MN: { state: 'MN', sourceDate: SRC_DATE, acts: [
    { actKey: 'residential', kind: 'whole', encoding: 'utf-8', urls: ['https://www.revisor.mn.gov/statutes/cite/504B/full'], parse: parseMN },
  ] },
  SC: { state: 'SC', sourceDate: SRC_DATE, acts: [
    { actKey: 'general_landlord_tenant', kind: 'whole', encoding: 'utf-8', urls: ['https://www.scstatehouse.gov/code/t27c033.php', 'https://www.scstatehouse.gov/code/t27c035.php', 'https://www.scstatehouse.gov/code/t27c039.php', 'https://www.scstatehouse.gov/code/t27c040.php'], parse: parseSC },
    { actKey: 'eviction', kind: 'whole', encoding: 'utf-8', urls: ['https://www.scstatehouse.gov/code/t27c037.php'], parse: parseSC },
    { actKey: 'manufactured_home_park', kind: 'whole', encoding: 'utf-8', urls: ['https://www.scstatehouse.gov/code/t27c047.php'], parse: parseSC },
    { actKey: 'self_storage', kind: 'whole', encoding: 'utf-8', urls: ['https://www.scstatehouse.gov/code/t39c020.php'], parse: parseSC },
  ] },
  OR: { state: 'OR', sourceDate: SRC_DATE, acts: [
    { actKey: 'residential', kind: 'whole', encoding: 'windows-1252', urls: ['https://www.oregonlegislature.gov/bills_laws/ORS/ORS090.html'], parse: parseOR },
  ] },
  CT: { state: 'CT', sourceDate: SRC_DATE, acts: [
    { actKey: 'residential', kind: 'whole', encoding: 'utf-8', urls: ['https://www.cga.ct.gov/current/pub/chap_830.htm', 'https://www.cga.ct.gov/current/pub/chap_831.htm', 'https://www.cga.ct.gov/current/pub/chap_833a.htm'], parse: parseCT },
    { actKey: 'eviction', kind: 'whole', encoding: 'utf-8', urls: ['https://www.cga.ct.gov/current/pub/chap_832.htm', 'https://www.cga.ct.gov/current/pub/chap_833.htm'], parse: parseCT },
    { actKey: 'general_landlord_tenant', kind: 'whole', encoding: 'utf-8', urls: ['https://www.cga.ct.gov/current/pub/chap_834.htm'], parse: parseCT },
    { actKey: 'mobile_home_park', kind: 'whole', encoding: 'utf-8', urls: ['https://www.cga.ct.gov/current/pub/chap_412.htm'], parse: parseCT },
  ] },
  UT: { state: 'UT', sourceDate: SRC_DATE, acts: [
    { actKey: 'residential', kind: 'whole', encoding: 'utf-8', urls: ['https://le.utah.gov/xcode/Title57/Chapter22/C57-22-S1_1800010118000101.html', 'https://le.utah.gov/xcode/Title57/Chapter22/C57-22-S2_2017050920170509.html', 'https://le.utah.gov/xcode/Title57/Chapter22/C57-22-S3_2025050720250507.html', 'https://le.utah.gov/xcode/Title57/Chapter22/C57-22-S4_2021050520210505.html', 'https://le.utah.gov/xcode/Title57/Chapter22/C57-22-S4.1_1800010118000101.html', 'https://le.utah.gov/xcode/Title57/Chapter22/C57-22-S5_1800010118000101.html', 'https://le.utah.gov/xcode/Title57/Chapter22/C57-22-S5.1_2025050720250507.html', 'https://le.utah.gov/xcode/Title57/Chapter22/C57-22-S6_2023050320240701.html', 'https://le.utah.gov/xcode/Title57/Chapter22/C57-22-S7_2023050320230503.html', 'https://le.utah.gov/xcode/Title57/Chapter17/C57-17-S1_1800010118000101.html', 'https://le.utah.gov/xcode/Title57/Chapter17/C57-17-S2_1800010118000101.html', 'https://le.utah.gov/xcode/Title57/Chapter17/C57-17-S3_2025050720250507.html', 'https://le.utah.gov/xcode/Title57/Chapter17/C57-17-S4_1800010118000101.html', 'https://le.utah.gov/xcode/Title57/Chapter17/C57-17-S5_2023050320240701.html'], parse: parseUT },
    { actKey: 'mobile_home_park', kind: 'whole', encoding: 'utf-8', urls: ['https://le.utah.gov/xcode/Title57/Chapter16/C57-16-S1_1800010118000101.html', 'https://le.utah.gov/xcode/Title57/Chapter16/C57-16-S2_1800010118000101.html', 'https://le.utah.gov/xcode/Title57/Chapter16/C57-16-S3_2020051220200512.html', 'https://le.utah.gov/xcode/Title57/Chapter16/C57-16-S4_2020051220200512.html', 'https://le.utah.gov/xcode/Title57/Chapter16/C57-16-S4.1_1800010118000101.html', 'https://le.utah.gov/xcode/Title57/Chapter16/C57-16-S5_2017050920170509.html', 'https://le.utah.gov/xcode/Title57/Chapter16/C57-16-S6_2017050920170509.html', 'https://le.utah.gov/xcode/Title57/Chapter16/C57-16-S7_2017050920170509.html', 'https://le.utah.gov/xcode/Title57/Chapter16/C57-16-S7.5_1800010118000101.html', 'https://le.utah.gov/xcode/Title57/Chapter16/C57-16-S8_1800010118000101.html', 'https://le.utah.gov/xcode/Title57/Chapter16/C57-16-S9_1800010118000101.html', 'https://le.utah.gov/xcode/Title57/Chapter16/C57-16-S10_1800010118000101.html', 'https://le.utah.gov/xcode/Title57/Chapter16/C57-16-S11_1800010118000101.html', 'https://le.utah.gov/xcode/Title57/Chapter16/C57-16-S12_1800010118000101.html', 'https://le.utah.gov/xcode/Title57/Chapter16/C57-16-S13_1800010118000101.html', 'https://le.utah.gov/xcode/Title57/Chapter16/C57-16-S14_2017050920170509.html', 'https://le.utah.gov/xcode/Title57/Chapter16/C57-16-S15_1800010118000101.html', 'https://le.utah.gov/xcode/Title57/Chapter16/C57-16-S16_1800010118000101.html', 'https://le.utah.gov/xcode/Title57/Chapter16/C57-16-S17_1800010118000101.html', 'https://le.utah.gov/xcode/Title57/Chapter16/C57-16-S18_1800010118000101.html', 'https://le.utah.gov/xcode/Title57/Chapter16/C57-16-S19_2017050920170509.html'], parse: parseUT },
    { actKey: 'self_storage', kind: 'whole', encoding: 'utf-8', urls: ['https://le.utah.gov/xcode/Title38/Chapter8/C38-8-S1_2015051220150512.html', 'https://le.utah.gov/xcode/Title38/Chapter8/C38-8-S2_2024050120240501.html', 'https://le.utah.gov/xcode/Title38/Chapter8/C38-8-S3_2024050120240501.html', 'https://le.utah.gov/xcode/Title38/Chapter8/C38-8-S3.5_2014040320140513.html', 'https://le.utah.gov/xcode/Title38/Chapter8/C38-8-S4_1800010118000101.html', 'https://le.utah.gov/xcode/Title38/Chapter8/C38-8-S5_1800010118000101.html', 'https://le.utah.gov/xcode/Title38/Chapter8/C38-8-S6_2024050120240501.html'], parse: parseUT },
  ] },
  IA: { state: 'IA', sourceDate: SRC_DATE, acts: [
    { actKey: 'residential', kind: 'whole', encoding: 'utf-8', urls: ['https://www.legis.iowa.gov/docs/code/562A.html'], parse: parseIA },
    { actKey: 'mobile_home_park', kind: 'whole', encoding: 'utf-8', urls: ['https://www.legis.iowa.gov/docs/code/562B.html'], parse: parseIA },
    { actKey: 'self_storage', kind: 'whole', encoding: 'utf-8', urls: ['https://www.legis.iowa.gov/docs/code/578A.html'], parse: parseIA },
    { actKey: 'commercial', kind: 'whole', encoding: 'utf-8', urls: ['https://www.legis.iowa.gov/docs/code/562.html'], parse: parseIA },
    { actKey: 'eviction', kind: 'whole', encoding: 'utf-8', urls: ['https://www.legis.iowa.gov/docs/code/648.html'], parse: parseIA },
  ] },
}

async function main() {
  const st = (process.argv[2] || 'ALL').toUpperCase()
  const targets = st === 'ALL' ? Object.keys(CONFIGS) : [st]
  for (const t of targets) { if (!CONFIGS[t]) { console.error('no config', t); continue } await runState(CONFIGS[t]) }
  process.exit(0)
}
main().catch((e) => { console.error(e); process.exit(1) })
