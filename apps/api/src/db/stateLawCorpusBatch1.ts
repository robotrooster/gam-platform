// @ts-nocheck
/**
 * S453 batch-1 verbatim statute parsers — OH NC MI VA WA MA MO.
 * Each parse fn was developed + LIVE-TESTED by a per-state subagent against
 * that state's official legislature site (counts cross-checked, verbatim
 * fidelity spot-verified) then integrated here. Reuses the runState driver +
 * state_law_section_texts schema from ingestStateLawCorpus.ts. @ts-nocheck
 * because the generated parsers use untyped params; they are runtime-tested.
 *
 * Run: cd apps/api && node -r ts-node/register src/db/stateLawCorpusBatch1.ts <STATE|ALL>
 * Idempotent (ON CONFLICT DO NOTHING via runState/insertSections).
 */

import { runState } from './ingestStateLawCorpus'

const SRC_DATE = '2026-06-13'

// ---- OH (126 sections tested) ----
function parseOH(html) {
  var sections = [];
  if (!html || typeof html !== 'string') return sections;

  // --- entity decode -------------------------------------------------------
  function decodeEntities(s) {
    if (s.indexOf('&') === -1) return s;
    s = s.replace(/&#x([0-9a-fA-F]+);/g, function (_, h) {
      return String.fromCodePoint(parseInt(h, 16));
    });
    s = s.replace(/&#(\d+);/g, function (_, d) {
      return String.fromCodePoint(parseInt(d, 10));
    });
    var named = {
      'nbsp': ' ', 'amp': '&', 'lt': '<', 'gt': '>', 'quot': '"',
      'apos': "'", 'sect': '§', 'mdash': '—', 'ndash': '–',
      'lsquo': '‘', 'rsquo': '’', 'ldquo': '“', 'rdquo': '”',
      'hellip': '…', 'deg': '°', 'frac12': '½', 'frac14': '¼',
      'frac34': '¾', 'reg': '®', 'copy': '©', 'trade': '™',
      'eacute': 'é', 'middot': '·', 'bull': '•'
    };
    s = s.replace(/&([a-zA-Z][a-zA-Z0-9]*);/g, function (m, name) {
      return Object.prototype.hasOwnProperty.call(named, name) ? named[name] : m;
    });
    return s;
  }

  // --- tag -> readable text ------------------------------------------------
  function htmlToText(frag) {
    frag = frag.replace(/<script[\s\S]*?<\/script>/gi, '');
    frag = frag.replace(/<style[\s\S]*?<\/style>/gi, '');
    frag = frag.replace(/<br\s*\/?>/gi, '\n');
    frag = frag.replace(/<\/(p|div|li|tr|h[1-6]|section|ul|ol|table|blockquote)\s*>/gi, '\n');
    frag = frag.replace(/<[^>]+>/g, '');
    frag = decodeEntities(frag);
    frag = frag.replace(/ /g, ' ');
    frag = frag.replace(/\r\n?/g, '\n');
    frag = frag.replace(/[ \t]+/g, ' ');
    frag = frag.replace(/ *\n */g, '\n');
    frag = frag.replace(/\n{3,}/g, '\n\n');
    return frag.trim();
  }

  // --- iterate section heads ----------------------------------------------
  // Each section head:
  //   <a href="section-XXXX.YY">Section XXXX.YY <span class='codes-separator'>|</span> Title</a>
  var headRe = /<a\s+href="section-([0-9A-Za-z.\-]+)"[^>]*>([\s\S]*?)<\/a>/g;
  var heads = [];
  var hm;
  while ((hm = headRe.exec(html)) !== null) {
    heads.push({ number: hm[1], rawTitle: hm[2], idx: hm.index, end: headRe.lastIndex });
  }

  for (var i = 0; i < heads.length; i++) {
    var head = heads[i];
    var number = head.number.replace(/\.+$/, '').trim();

    // Title: text after the codes-separator span inside the anchor
    var titleHtml = head.rawTitle;
    var sepSplit = titleHtml.split(/<span[^>]*class=['"]codes-separator['"][^>]*>[\s\S]*?<\/span>/i);
    var titlePart = sepSplit.length > 1 ? sepSplit.slice(1).join(' ') : titleHtml;
    var title = htmlToText(titlePart).replace(/\s*\n\s*/g, ' ').trim();
    if (title === '') title = null;

    // Body: FIRST <section class="laws-body"> after this head, before the next head.
    var searchStart = head.end;
    var searchEnd = (i + 1 < heads.length) ? heads[i + 1].idx : html.length;
    var slice = html.slice(searchStart, searchEnd);

    var bodyMatch = /<section\s+class="laws-body"[^>]*>([\s\S]*?)<\/section>/i.exec(slice);
    if (!bodyMatch) continue;
    var bodyInner = bodyMatch[1];

    // strip trailing "laws-notice" (Last updated ...) block from the body
    bodyInner = bodyInner.replace(/<div\s+class="laws-notice"[\s\S]*$/i, '');

    var text = htmlToText(bodyInner);
    if (!text || text.length < 20) continue;

    sections.push({ number: number, title: title, text: text });
  }

  return sections;
}

// ---- NC (118 sections tested) ----
function parseNC(html) {
  // Decode a limited set of HTML entities to readable text.
  function decodeEntities(s) {
    if (s.indexOf('&') === -1) return s;
    return s
      .replace(/&#x([0-9a-fA-F]+);/g, function (_, h) {
        var cp = parseInt(h, 16);
        return isNaN(cp) ? _ : String.fromCodePoint(cp);
      })
      .replace(/&#(\d+);/g, function (_, d) {
        var cp = parseInt(d, 10);
        return isNaN(cp) ? _ : String.fromCodePoint(cp);
      })
      .replace(/&sect;/g, '§')
      .replace(/&nbsp;/g, ' ')
      .replace(/&mdash;/g, '—')
      .replace(/&ndash;/g, '–')
      .replace(/&ldquo;/g, '“')
      .replace(/&rdquo;/g, '”')
      .replace(/&lsquo;/g, '‘')
      .replace(/&rsquo;/g, '’')
      .replace(/&quot;/g, '"')
      .replace(/&apos;/g, "'")
      .replace(/&lt;/g, '<')
      .replace(/&gt;/g, '>')
      .replace(/&amp;/g, '&'); // ampersand last
  }

  // Strip tags from a fragment, converting block-closers / <br> to newlines,
  // then decode entities, normalize whitespace per-line, and trim.
  function stripToText(frag) {
    var t = frag;
    // Drop script/style content entirely.
    t = t.replace(/<script[\s\S]*?<\/script>/gi, '');
    t = t.replace(/<style[\s\S]*?<\/style>/gi, '');
    // Block-closing tags + <br> => newline.
    t = t.replace(/<br\s*\/?>/gi, '\n');
    t = t.replace(/<\/(p|div|li|h[1-6]|tr|blockquote)\s*>/gi, '\n');
    // Remaining tags => nothing.
    t = t.replace(/<[^>]+>/g, '');
    // Decode entities AFTER tag strip.
    t = decodeEntities(t);
    // Normalize NBSP ( ) to a regular space for collapsing.
    t = t.replace(/ /g, ' ');
    // Normalize CRLF/CR to LF.
    t = t.replace(/\r\n?/g, '\n');
    // Collapse runs of spaces/tabs (not newlines).
    t = t.replace(/[ \t]+/g, ' ');
    // Trim each line, drop empty lines, then rejoin with single newlines.
    var lines = t.split('\n');
    var out = [];
    for (var i = 0; i < lines.length; i++) {
      var ln = lines[i].trim();
      if (ln.length) out.push(ln);
    }
    return out.join('\n').trim();
  }

  var sections = [];

  // Section header pattern:
  // <p class="cs8E357F70"><span class="cs72F7C9C5">&sect; NUM. &nbsp;TITLE</span></p>
  // Match each header paragraph, capture its inner span content, then take the
  // body as everything up to the next header (or end of document).
  // Allow optional empty anchors (e.g. <a name="GSDocumentHeader"></a>) between
  // the header <p> and its <span>, and after </span> before </p> (e.g. a
  // trailing <a name="_GoBack">) -- both variants occur in the live source.
  var headerRe = /<p class="cs8E357F70">(?:\s*<a\b[^>]*>\s*<\/a>)*\s*<span class="cs72F7C9C5">([\s\S]*?)<\/span>(?:\s*<a\b[^>]*>\s*<\/a>)*\s*<\/p>/gi;

  var matches = [];
  var m;
  while ((m = headerRe.exec(html)) !== null) {
    matches.push({ index: m.index, end: headerRe.lastIndex, inner: m[1] });
  }

  for (var k = 0; k < matches.length; k++) {
    var headInner = decodeEntities(matches[k].inner);
    // headInner looks like: "§ 42-1.  Lessor and lessee not partners."
    // or "§ 42-14.1.  Preemption of local regulations." (42-14.1 is the
    // number; the period/colon that separates number from title is the one
    // followed by whitespace/end -- internal ".1" is not followed by space).
    var hm = /^\s*§\s*([0-9A-Za-z][0-9A-Za-z.\-]*?)[.:](?=\s|$)\s*([\s\S]*)$/.exec(headInner);
    if (!hm) continue; // not a real section header
    var number = hm[1].replace(/\.+$/, '').trim();
    var rawTitle = hm[2].replace(/ /g, ' ').replace(/[ \t]+/g, ' ').trim();
    // Strip trailing period from title if present.
    var title = rawTitle.replace(/\.\s*$/, '').trim();
    if (!title.length) title = null;

    // Body = HTML between end of this header and start of next header.
    var bodyStart = matches[k].end;
    var bodyEnd = (k + 1 < matches.length) ? matches[k + 1].index : html.length;
    var bodyHtml = html.slice(bodyStart, bodyEnd);

    // Remove Chapter/Article heading paragraphs + h3 headings from the body
    // (class cs2E44D3A6 carries "Chapter 42.", "Article 1.", "General Provisions.").
    bodyHtml = bodyHtml.replace(/<h3 class="cs2E44D3A6">[\s\S]*?<\/h3>/gi, '');
    bodyHtml = bodyHtml.replace(/<p class="cs2E44D3A6">[\s\S]*?<\/p>/gi, '');

    var text = stripToText(bodyHtml);

    // Skip repealed/reserved/empty/too-short sections (still acted as a
    // boundary above, so they correctly terminate the preceding body).
    if (text.length < 20) continue;

    sections.push({ number: number, title: title, text: text });
  }

  return sections;
}

// ---- MI (65 sections tested) ----
function parseMI(html) {
  var sections = [];
  if (typeof html !== 'string' || html.length === 0) return sections;

  // ---- entity decoder (handles &lt; &gt; &amp; &quot; &apos; &#NNN; &#xNN; named) ----
  function decodeEntities(s) {
    if (s.indexOf('&') === -1) return s;
    var named = {
      'amp': '&', 'lt': '<', 'gt': '>', 'quot': '"', 'apos': "'",
      'nbsp': ' ', 'sect': '§', 'mdash': '—', 'ndash': '–',
      'rsquo': '’', 'lsquo': '‘', 'ldquo': '“', 'rdquo': '”',
      'hellip': '…', 'deg': '°', 'frac12': '½', 'frac14': '¼',
      'frac34': '¾', 'reg': '®', 'copy': '©', 'trade': '™',
      'times': '×', 'middot': '·', 'bull': '•'
    };
    return s.replace(/&(#x[0-9a-fA-F]+|#[0-9]+|[a-zA-Z][a-zA-Z0-9]*);/g, function (m, body) {
      if (body.charAt(0) === '#') {
        var code;
        if (body.charAt(1) === 'x' || body.charAt(1) === 'X') {
          code = parseInt(body.slice(2), 16);
        } else {
          code = parseInt(body.slice(1), 10);
        }
        if (isNaN(code)) return m;
        try { return String.fromCodePoint(code); } catch (e) { return m; }
      }
      var lower = body.toLowerCase();
      if (Object.prototype.hasOwnProperty.call(named, lower)) return named[lower];
      return m;
    });
  }

  // ---- range membership: segment-wise, never float ----
  // (MCL section numbers like 554.14 vs 554.131 are NOT decimals; the part
  //  after the dot is its own integer segment with an optional letter suffix.)
  function inLLTRange(numStr) {
    var parts = numStr.split('.');
    if (parts.length < 2) return false;
    var chap = parts[0];
    var m = parts[1].match(/^(\d+)([a-zA-Z]*)$/);
    if (!m) return false;
    var seg = parseInt(m[1], 10);
    if (chap === '554') {
      // security deposits / truth-in-renting
      return (seg >= 131 && seg <= 201) || (seg >= 601 && seg <= 641);
    }
    if (chap === '600') {
      // summary proceedings to recover possession
      return seg >= 5701 && seg <= 5759;
    }
    return false;
  }

  // ---- turn the (entity-decoded) inner XML body into readable text ----
  function bodyToText(rawBody) {
    // rawBody is the literal contents of <BodyText>...</BodyText>, which is
    // itself entity-encoded XML. Decode the outer layer first so the inner
    // tags become real angle brackets we can process.
    var inner = decodeEntities(rawBody);

    // Drop the leading "Sec. N." marker entirely (it is navigational, not
    // part of the verbatim statutory prose surfaced to users).
    inner = inner.replace(/<Section-Number>[\s\S]*?<\/Section-Number>/gi, '');

    // The subsection marker lives in <Paragraph-Number>(a)</Paragraph-Number>
    // and is followed by its <P>text</P> within the SAME <Paragraph>. Keep the
    // marker INLINE with its prose: close it with a single space, not a newline.
    inner = inner.replace(/<\/paragraph-number\s*>/gi, ' ');

    // Convert block-closing tags + <br> to newlines so subsection structure
    // (each <P>/<Paragraph>/<tr>/<td>) lands on its own line.
    inner = inner.replace(/<br\s*\/?>/gi, '\n');
    inner = inner.replace(/<\/(p|paragraph|div|li|tr|td|section-body)\s*>/gi, '\n');
    // Opening table-ish tags also act as separators so cells don't run together.
    inner = inner.replace(/<(tr|table)\b[^>]*>/gi, '\n');
    inner = inner.replace(/<td\b[^>]*>/gi, '\t');

    // Strip every remaining tag (Emph, span, a, b, i, u, P opens, etc.).
    inner = inner.replace(/<[^>]+>/g, '');

    // Decode any entities that were double-encoded or appeared in the prose.
    inner = decodeEntities(inner);

    // Normalize whitespace: collapse runs of spaces/tabs, tidy newlines, trim.
    inner = inner.replace(/\r\n?/g, '\n');
    inner = inner.replace(/[ \t]*\n[ \t]*/g, '\n');     // trim around newlines
    inner = inner.replace(/\n{3,}/g, '\n\n');           // cap blank-line runs
    inner = inner.replace(/[ \t]{2,}/g, ' ');           // collapse inline space runs
    inner = inner.replace(/^\n+/, '').replace(/\n+$/, '');
    return inner.trim();
  }

  // ---- walk each <MCLSectionInfo> block ----
  var re = /<MCLSectionInfo\b[^>]*>([\s\S]*?)<\/MCLSectionInfo>/g;
  var match;
  while ((match = re.exec(html)) !== null) {
    var block = match[1];

    var numM = block.match(/<MCLNumber>([\s\S]*?)<\/MCLNumber>/);
    if (!numM) continue;
    var number = decodeEntities(numM[1]).trim();
    if (!number) continue;
    if (!inLLTRange(number)) continue;

    // Skip explicitly repealed sections.
    var repM = block.match(/<Repealed>([\s\S]*?)<\/Repealed>/);
    if (repM && repM[1].trim().toLowerCase() === 'true') continue;

    var catchM = block.match(/<CatchLine>([\s\S]*?)<\/CatchLine>/);
    var title = catchM ? decodeEntities(catchM[1]).replace(/\s+/g, ' ').trim() : null;
    if (title === '') title = null;

    var btM = block.match(/<BodyText>([\s\S]*?)<\/BodyText>/);
    var text = btM ? bodyToText(btM[1]) : '';

    // Skip repealed/empty bodies (< 20 chars of real content).
    if (text.replace(/\s/g, '').length < 20) continue;

    sections.push({ number: number, title: title, text: text });
  }

  return sections;
}

// ---- VA (126 sections tested) ----
function parseVA(html) {
  var sections = [];
  if (!html || typeof html !== 'string') return sections;

  // Decode HTML entities to readable text.
  function decodeEntities(s) {
    if (!s) return s;
    s = s.replace(/&#x([0-9a-fA-F]+);/g, function (_, h) {
      return String.fromCodePoint(parseInt(h, 16));
    });
    s = s.replace(/&#(\d+);/g, function (_, d) {
      return String.fromCodePoint(parseInt(d, 10));
    });
    var named = {
      'nbsp': ' ', 'amp': '&', 'lt': '<', 'gt': '>',
      'quot': '"', 'apos': "'", 'sect': '§',
      'mdash': '—', 'ndash': '–',
      'lsquo': '‘', 'rsquo': '’',
      'ldquo': '“', 'rdquo': '”',
      'hellip': '…', 'raquo': '»', 'laquo': '«',
      'deg': '°', 'para': '¶', 'middot': '·',
      'frac12': '½', 'frac14': '¼', 'frac34': '¾'
    };
    s = s.replace(/&([a-zA-Z][a-zA-Z0-9]*);/g, function (m, name) {
      var lower = name.toLowerCase();
      return Object.prototype.hasOwnProperty.call(named, lower) ? named[lower] : m;
    });
    return s;
  }

  // Strip tags to readable text, preserving block structure as newlines.
  function htmlToText(frag) {
    var t = frag;
    // Drop script/style content entirely.
    t = t.replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, '');
    t = t.replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi, '');
    // <br> -> newline.
    t = t.replace(/<br\s*\/?>/gi, '\n');
    // Block-closing tags -> newline.
    t = t.replace(/<\/(p|div|li|section|h[1-6]|tr|ul|ol|blockquote|table)\s*>/gi, '\n');
    // Remaining tags -> removed.
    t = t.replace(/<[^>]+>/g, '');
    // Decode entities.
    t = decodeEntities(t);
    // Normalize NBSP to space.
    t = t.replace(/ /g, ' ');
    // Normalize line endings.
    t = t.replace(/\r\n?/g, '\n');
    // Collapse runs of spaces/tabs (not newlines).
    t = t.replace(/[ \t]+/g, ' ');
    // Trim spaces around newlines.
    t = t.replace(/[ \t]*\n[ \t]*/g, '\n');
    // Collapse 3+ newlines to 2.
    t = t.replace(/\n{3,}/g, '\n\n');
    return t.trim();
  }

  // Narrow to the statute content container if present, to avoid nav/footer.
  var scope = html;
  var startIdx = html.indexOf("id='va_code'");
  if (startIdx === -1) startIdx = html.indexOf('id="va_code"');
  if (startIdx !== -1) {
    var after = html.indexOf('>', startIdx);
    var bodyStart = after !== -1 ? after + 1 : startIdx;
    // The container closes right before </article>; bound the scope there.
    var artIdx = html.indexOf('</article>', bodyStart);
    scope = artIdx !== -1 ? html.slice(bodyStart, artIdx) : html.slice(bodyStart);
  }

  // Each section: <b>§ NUM. Title.</b> <section class='body'>...</section>
  // NUM = digits/dots/hyphens/colons (e.g. 55.1-1200, 55.1-1204.1, 55.1-1262:1),
  // non-greedily captured up to the period+space that precedes the catchline.
  // The final "." after the number is the separator and is consumed, not kept.
  var re = /<b>\s*(?:&#167;|&sect;|§)\s*([0-9][0-9A-Za-z.:\-]*?)\.\s+([\s\S]*?)<\/b>\s*<section[^>]*class\s*=\s*['"]body['"][^>]*>([\s\S]*?)<\/section>/gi;

  var m;
  while ((m = re.exec(scope)) !== null) {
    var number = m[1].trim().replace(/\.+$/, '');
    var rawTitle = m[2];
    var rawBody = m[3];

    // Title: strip tags, decode, collapse whitespace, trim trailing period.
    var title = htmlToText(rawTitle).replace(/\s+/g, ' ').trim();
    title = title.replace(/\.+\s*$/, '').trim();
    if (title === '') title = null;

    var text = htmlToText(rawBody);

    // Skip repealed/empty sections (body < 20 chars).
    if (!text || text.length < 20) continue;

    sections.push({ number: number, title: title, text: text });
  }

  return sections;
}

// ---- WA (249 sections tested) ----
function parseWA(html) {
  var sections = [];
  if (!html || typeof html !== 'string') return sections;

  // Decode HTML entities -> readable text
  function decodeEntities(s) {
    if (!s) return '';
    s = s.replace(/&#x([0-9a-fA-F]+);/g, function (_, h) {
      return String.fromCharCode(parseInt(h, 16));
    });
    s = s.replace(/&#(\d+);/g, function (_, n) {
      return String.fromCharCode(parseInt(n, 10));
    });
    var named = {
      'sect': '§', 'nbsp': ' ', 'amp': '&', 'lt': '<', 'gt': '>',
      'quot': '"', 'apos': "'", 'mdash': '—', 'ndash': '–',
      'lsquo': '‘', 'rsquo': '’', 'ldquo': '“', 'rdquo': '”',
      'hellip': '…', 'deg': '°', 'frac12': '½', 'frac14': '¼',
      'frac34': '¾', 'times': '×', 'eacute': 'é', 'copy': '©',
      'reg': '®', 'trade': '™', 'middot': '·', 'bull': '•'
    };
    s = s.replace(/&([a-zA-Z][a-zA-Z0-9]*);/g, function (m, name) {
      var lower = name.toLowerCase();
      if (named.hasOwnProperty(lower)) return named[lower];
      return m;
    });
    return s;
  }

  // Convert an HTML fragment to readable text, preserving block structure as newlines.
  function htmlToText(frag) {
    if (!frag) return '';
    var t = frag;
    t = t.replace(/<script[\s\S]*?<\/script>/gi, '');
    t = t.replace(/<style[\s\S]*?<\/style>/gi, '');
    t = t.replace(/<br\s*\/?>/gi, '\n');
    t = t.replace(/<\/(p|div|li|tr|h[1-6]|ul|ol|table|blockquote)>/gi, '\n');
    t = t.replace(/<[^>]+>/g, '');
    t = decodeEntities(t);
    t = t.replace(/\r\n?/g, '\n');
    t = t.replace(/[ \t\f\v ]+/g, ' ');
    t = t.replace(/ *\n */g, '\n');
    t = t.replace(/\n{3,}/g, '\n\n');
    t = t.replace(/\n{2,}/g, '\n');
    return t.trim();
  }

  // Locate all section anchors: <a name='59.18.260'></a>
  var anchorRe = /<a\s+name=['"](\d+\.\d+\.[0-9A-Za-z]+)['"][^>]*>\s*<\/a>/gi;
  var anchors = [];
  var m;
  while ((m = anchorRe.exec(html)) !== null) {
    anchors.push({ index: m.index, end: anchorRe.lastIndex, cite: m[1] });
  }
  if (anchors.length === 0) return sections;

  var seen = {};

  for (var i = 0; i < anchors.length; i++) {
    var cite = anchors[i].cite;
    if (seen[cite]) continue;
    seen[cite] = true;

    var segStart = anchors[i].end;
    var segEnd = (i + 1 < anchors.length) ? anchors[i + 1].index : html.length;
    var seg = html.slice(segStart, segEnd);

    // Title: the SECOND <h3> in the segment. The first <h3> is the RCW citation
    // header (contains a PDF button + RCW link); the second <h3> is the catchline.
    var h3Re = /<h3\b[^>]*>([\s\S]*?)<\/h3>/gi;
    var h3s = [];
    var hm;
    while ((hm = h3Re.exec(seg)) !== null) {
      h3s.push({ raw: hm[1], start: hm.index, end: h3Re.lastIndex });
    }
    var title = null;
    var titleEndPos = 0;
    if (h3s.length >= 2) {
      title = htmlToText(h3s[1].raw).replace(/\s+/g, ' ').trim();
      titleEndPos = h3s[1].end;
    } else if (h3s.length === 1) {
      titleEndPos = h3s[0].end;
    }
    if (title === '') title = null;

    // Body boundary: from end of the title h3 up to the FIRST historical citation
    // div: <div style="margin-top:15pt;margin-bottom:0pt;">[ ... ]</div>. That div,
    // plus any "NOTES:" block after it, are NOT part of the verbatim statute body.
    var bodyRegion = seg.slice(titleEndPos);

    var histIdx = bodyRegion.search(/<div[^>]*style=["'][^"']*margin-top:\s*15pt;\s*margin-bottom:\s*0pt;[^"']*["'][^>]*>/i);
    if (histIdx !== -1) {
      bodyRegion = bodyRegion.slice(0, histIdx);
    } else {
      var notesIdx = bodyRegion.search(/<h3\b[^>]*>\s*NOTES:\s*<\/h3>/i);
      if (notesIdx !== -1) bodyRegion = bodyRegion.slice(0, notesIdx);
    }

    // Remove the code-reviser "*** CHANGE IN YYYY ***" advisory div(s) - not statute text.
    bodyRegion = bodyRegion.replace(
      /<div[^>]*>\s*\*\*\*\s*CHANGE IN[\s\S]*?\*\*\*\s*<\/div>/gi,
      ' '
    );
    bodyRegion = bodyRegion.replace(/\*\*\*\s*CHANGE IN[\s\S]*?\*\*\*/gi, ' ');

    var text = htmlToText(bodyRegion);

    // Skip empty / repealed / reserved / decodified stubs (< 20 chars of body).
    if (!text || text.length < 20) continue;

    if (/^(\[?\s*)?(Repealed|Reserved|Decodified|Omitted|Recodified)\b/i.test(text) &&
        text.length < 120) {
      continue;
    }

    sections.push({ number: cite, title: title, text: text });
  }

  return sections;
}

// ---- MA (75 sections tested) ----
function parseMA(html) {
  if (typeof html !== 'string' || !html) return [];

  // ---- entity + tag helpers -------------------------------------------
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
      '&deg;': '°', '&para;': '¶', '&middot;': '·',
      '&frac12;': '½', '&frac14;': '¼', '&frac34;': '¾'
    };
    s = s.replace(/&[a-zA-Z]+;/g, function (m) {
      return named.hasOwnProperty(m) ? named[m] : m;
    });
    return s;
  }

  // Strip tags to readable text; block-closers + <br> become newlines.
  function htmlToText(frag) {
    if (!frag) return '';
    var t = frag;
    t = t.replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, '');
    t = t.replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi, '');
    // Remove screen-reader-only "link to an external site" noise if present.
    t = t.replace(/<p class="sr-only">[\s\S]*?<\/p>/gi, '');
    t = t.replace(/<br\s*\/?>/gi, '\n');
    t = t.replace(/<\/(p|div|li|tr|h[1-6]|ul|ol|table|blockquote)\s*>/gi, '\n');
    t = t.replace(/<[^>]+>/g, '');
    t = decodeEntities(t);
    t = t.replace(/ /g, ' ');
    t = t.replace(/\r\n?/g, '\n');
    t = t.replace(/[ \t]+/g, ' ');
    t = t.replace(/[ \t]*\n[ \t]*/g, '\n');
    t = t.replace(/\n{3,}/g, '\n\n');
    return t.trim();
  }

  var sections = [];
  var seen = {};

  // Each section is anchored by:
  //   <h2 id="skipTo" ...>Section NUM: <small>TITLE</small></h2>
  // followed by the body <p> block. Works on per-section pages and on a
  // multi-section document (splits on each skipTo heading).
  var headRe = /<h2\b[^>]*id="skipTo"[^>]*>([\s\S]*?)<\/h2>/gi;
  var heads = [];
  var hm;
  while ((hm = headRe.exec(html)) !== null) {
    heads.push({ inner: hm[1], start: hm.index, end: headRe.lastIndex });
  }

  for (var i = 0; i < heads.length; i++) {
    var head = heads[i];
    var headTxt = head.inner;

    // Number: "Section NUM" before the colon; NUM may carry a letter suffix.
    var numMatch = headTxt.match(/Section\s+([0-9]+[A-Za-z0-9\/.\-]*)/i);
    if (!numMatch) continue; // chapter heading or other non-section heading
    var number = numMatch[1].replace(/[.\s]+$/, '');

    // Title: inside <small>...</small>; fallback to text after the colon.
    var title = null;
    var smallMatch = headTxt.match(/<small\b[^>]*>([\s\S]*?)<\/small>/i);
    if (smallMatch) {
      title = htmlToText(smallMatch[1]).replace(/\n+/g, ' ').trim();
    } else {
      var after = headTxt.replace(/^[\s\S]*?Section\s+[0-9A-Za-z\/.\-]+\s*:?/i, '');
      title = htmlToText(after).replace(/\n+/g, ' ').trim();
    }
    if (title === '') title = null;

    // Body region: from end of this <h2> to the next skipTo heading (or EOD).
    var bodyEnd = (i + 1 < heads.length) ? heads[i + 1].start : html.length;
    var region = html.slice(head.end, bodyEnd);

    // Cut off trailing site chrome. The section content sits in a wrapper
    // <p>...</p> that closes before a run of closing </div>s. Prefer that
    // inner boundary; also guard against footer / script / sr-only blocks.
    var cutPoints = [];
    var footerIdx = region.search(/<div[^>]*\bclass="[^"]*\bfooter\b/i);
    if (footerIdx >= 0) cutPoints.push(footerIdx);
    var scriptIdx = region.search(/<script\b/i);
    if (scriptIdx >= 0) cutPoints.push(scriptIdx);
    var srOnlyIdx = region.search(/<h2[^>]*class="sr-only"/i);
    if (srOnlyIdx >= 0) cutPoints.push(srOnlyIdx);
    var wrapMatch = region.match(/<\/p>\s*(?:<\/div>\s*){2,}/i);
    if (wrapMatch) {
      var wrapEnd = region.indexOf(wrapMatch[0]);
      cutPoints.push(wrapEnd + wrapMatch[0].indexOf('</p>') + 4);
    }
    var cut = region.length;
    for (var c = 0; c < cutPoints.length; c++) {
      if (cutPoints[c] >= 0 && cutPoints[c] < cut) cut = cutPoints[c];
    }
    var bodyFrag = region.slice(0, cut);

    var text = htmlToText(bodyFrag);

    // Strip the leading "Section NUM." prefix so the number lives only in
    // `number`, keeping the verbatim sentence body intact.
    var leadRe = new RegExp(
      '^\\s*Section\\s+' +
      number.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') +
      '\\.?\\s*',
      'i'
    );
    text = text.replace(leadRe, '').trim();

    // Skip repealed / empty / sub-threshold bodies.
    if (text.length < 20) continue;

    if (seen[number]) continue;
    seen[number] = true;

    sections.push({ number: number, title: title, text: text });
  }

  return sections;
}

// ---- MO (209 sections tested) ----
function parseMO(html) {
  var sections = [];
  if (typeof html !== 'string' || !html) return sections;

  // ---- entity decoder ----
  function decodeEntities(s) {
    if (!s) return s;
    s = s.replace(/&#x([0-9a-fA-F]+);/g, function (_, h) {
      try { return String.fromCodePoint(parseInt(h, 16)); } catch (e) { return _; }
    });
    s = s.replace(/&#(\d+);/g, function (_, d) {
      try { return String.fromCodePoint(parseInt(d, 10)); } catch (e) { return _; }
    });
    var named = {
      'nbsp': ' ', 'amp': '&', 'lt': '<', 'gt': '>', 'quot': '"',
      'apos': "'", 'sect': '§', 'mdash': '—', 'ndash': '–',
      'rsquo': '’', 'lsquo': '‘', 'ldquo': '“', 'rdquo': '”',
      'hellip': '…', 'deg': '°', 'para': '¶', 'middot': '·',
      'frac12': '½', 'frac14': '¼', 'frac34': '¾', 'times': '×',
      'reg': '®', 'copy': '©', 'shy': '­'
    };
    s = s.replace(/&([a-zA-Z][a-zA-Z0-9]*);/g, function (m, n) {
      return Object.prototype.hasOwnProperty.call(named, n) ? named[n] : m;
    });
    return s;
  }

  // ---- tag -> text, preserving block structure as newlines ----
  function htmlToText(frag) {
    if (!frag) return '';
    var t = frag;
    // drop scripts/styles entirely
    t = t.replace(/<script[\s\S]*?<\/script>/gi, '');
    t = t.replace(/<style[\s\S]*?<\/style>/gi, '');
    // <br> -> newline
    t = t.replace(/<br\s*\/?>/gi, '\n');
    // block-closing tags -> newline
    t = t.replace(/<\/(p|div|li|tr|h[1-6]|ul|ol|table|blockquote)\s*>/gi, '\n');
    // opening block tags -> newline (so adjacent inline runs separate)
    t = t.replace(/<(p|div|li|tr|table|blockquote)\b[^>]*>/gi, '\n');
    // strip all remaining tags
    t = t.replace(/<[^>]+>/g, '');
    // decode entities AFTER tag strip
    t = decodeEntities(t);
    // normalize nbsp / unusual unicode spaces to regular space
    t = t.replace(/[       ﻿]/g, ' ');
    // soft hyphen -> remove
    t = t.replace(/­/g, '');
    // normalize CRLF
    t = t.replace(/\r\n?/g, '\n');
    // collapse runs of spaces/tabs (not newlines)
    t = t.replace(/[ \t]+/g, ' ');
    // trim spaces around each line
    t = t.replace(/[ \t]*\n[ \t]*/g, '\n');
    // collapse 3+ newlines to 2
    t = t.replace(/\n{3,}/g, '\n\n');
    return t.trim();
  }

  // ---- split into section-container blocks ----
  // Each statute section is wrapped in:
  //   <div class="norm" title="" style="background-color:#fffff7; ...">
  var DIV_RE = /<div class="norm" title="" style="background-color:#fffff7;/g;
  var starts = [];
  var m;
  while ((m = DIV_RE.exec(html)) !== null) {
    starts.push(m.index);
  }
  if (!starts.length) return sections;
  starts.push(html.length); // sentinel for last block end

  for (var i = 0; i < starts.length - 1; i++) {
    var block = html.slice(starts[i], starts[i + 1]);

    // The header: first <p class="norm"> contains
    //   <span class="bold">NUM.<span> </span>CATCHLINE — </span>BODY...
    // The bold span used inside bodies (defined terms like "Rent") is NOT keyed on;
    // we key the whole section on the container div, then read the FIRST bold span.
    var boldOpen = block.indexOf('<span class="bold">');
    if (boldOpen === -1) continue;

    var afterOpen = boldOpen + '<span class="bold">'.length;
    var headSearch = block.slice(afterOpen);

    // Remove the FIRST nested bare <span>...</span> (spacing) so the closing </span>
    // tags line up; the outer bold </span> then becomes the first </span> we hit.
    var innerSpan = headSearch.match(/<span>[\s\S]*?<\/span>/);
    var headClean = headSearch;
    if (innerSpan && headSearch.indexOf(innerSpan[0]) < 300) {
      headClean = headSearch.replace(innerSpan[0], ' ');
    }
    var closeIdx = headClean.indexOf('</span>');
    if (closeIdx === -1) continue;
    var headerInner = headClean.slice(0, closeIdx);            // num + catchline + trailing dash
    var bodyTail = headClean.slice(closeIdx + '</span>'.length); // body paragraphs after outer </span>

    // Header layout: NUM. <spacing> CATCHLINE — (trailing em-dash before body).
    // The catchline may itself contain internal em-dashes; the body lives ENTIRELY
    // in bodyTail. So catchline = header minus leading number minus single trailing separator.
    var headerText = htmlToText(headerInner).replace(/\n+/g, ' ').replace(/\s+/g, ' ').trim();

    // number = leading numeric token (e.g. 441.005, 700.010, 534.030)
    var numMatch = headerText.match(/^([0-9]+(?:\.[0-9]+)*)\.\s*/);
    if (!numMatch) continue;
    var number = numMatch[1];
    var rest = headerText.slice(numMatch[0].length).trim();

    // strip the single trailing separator dash (— – or -) and surrounding space
    var title = rest.replace(/\s*[—–-]\s*$/, '').trim();
    title = title.replace(/\s+/g, ' ').trim();
    if (!title) title = null;

    // ---- BODY ----
    // Body comes ONLY from bodyTail, EXCLUDING the <div class="foot"> footnote/citation
    // block (RSMo / Prior revisions / annotations are metadata, not statute text) and
    // the green date footer <p>.
    var footIdx = bodyTail.search(/<div class="foot"/);
    var bodyHtml = footIdx !== -1 ? bodyTail.slice(0, footIdx) : bodyTail;
    var greenIdx = bodyHtml.search(/<p style="margin:0em 0em \.5em 2em;/);
    if (greenIdx !== -1) bodyHtml = bodyHtml.slice(0, greenIdx);

    var fullBody = htmlToText(bodyHtml);
    fullBody = fullBody.replace(/[ \t]+/g, ' ').replace(/[ \t]*\n[ \t]*/g, '\n').replace(/\n{3,}/g, '\n\n').trim();

    // skip repealed / empty (< 20 chars of body)
    if (!fullBody || fullBody.length < 20) continue;

    sections.push({ number: number, title: title, text: fullBody });
  }

  return sections;
}

const CONFIGS = {
  OH: { state: 'OH', sourceDate: SRC_DATE, acts: [
    { actKey: 'residential', kind: 'whole', encoding: 'utf-8', urls: ['https://codes.ohio.gov/ohio-revised-code/chapter-5321', 'https://codes.ohio.gov/ohio-revised-code/chapter-5323'], parse: parseOH },
    { actKey: 'self_storage', kind: 'whole', encoding: 'utf-8', urls: ['https://codes.ohio.gov/ohio-revised-code/chapter-5322'], parse: parseOH },
    { actKey: 'manufactured_home_park', kind: 'whole', encoding: 'utf-8', urls: ['https://codes.ohio.gov/ohio-revised-code/chapter-4781'], parse: parseOH },
    { actKey: 'rv_park', kind: 'whole', encoding: 'utf-8', urls: ['https://codes.ohio.gov/ohio-revised-code/chapter-3729'], parse: parseOH },
    { actKey: 'eviction', kind: 'whole', encoding: 'utf-8', urls: ['https://codes.ohio.gov/ohio-revised-code/chapter-1923'], parse: parseOH },
  ] },
  NC: { state: 'NC', sourceDate: SRC_DATE, acts: [
    { actKey: 'residential', kind: 'whole', encoding: 'utf-8', urls: ['https://www.ncleg.gov/EnactedLegislation/Statutes/HTML/ByChapter/Chapter_42.html'], parse: parseNC },
    { actKey: 'general_landlord_tenant', kind: 'whole', encoding: 'utf-8', urls: ['https://www.ncleg.gov/EnactedLegislation/Statutes/HTML/ByChapter/Chapter_42A.html'], parse: parseNC },
  ] },
  MI: { state: 'MI', sourceDate: SRC_DATE, acts: [
    { actKey: 'residential', kind: 'whole', encoding: 'utf-16le', urls: ['https://www.legislature.mi.gov/documents/mcl/Chapter%20554.xml'], parse: parseMI },
    { actKey: 'eviction', kind: 'whole', encoding: 'utf-16le', urls: ['https://www.legislature.mi.gov/documents/mcl/Chapter%20600.xml'], parse: parseMI },
  ] },
  VA: { state: 'VA', sourceDate: SRC_DATE, acts: [
    { actKey: 'residential', kind: 'whole', encoding: 'utf-8', urls: ['https://law.lis.virginia.gov/vacodefull/title55.1/chapter12/'], parse: parseVA },
    { actKey: 'manufactured_home_park', kind: 'whole', encoding: 'utf-8', urls: ['https://law.lis.virginia.gov/vacodefull/title55.1/chapter13/'], parse: parseVA },
    { actKey: 'commercial', kind: 'whole', encoding: 'utf-8', urls: ['https://law.lis.virginia.gov/vacodefull/title55.1/chapter14/'], parse: parseVA },
    { actKey: 'self_storage', kind: 'whole', encoding: 'utf-8', urls: ['https://law.lis.virginia.gov/vacodefull/title55.1/chapter29/'], parse: parseVA },
  ] },
  WA: { state: 'WA', sourceDate: SRC_DATE, acts: [
    { actKey: 'general_landlord_tenant', kind: 'whole', encoding: 'utf-8', urls: ['https://app.leg.wa.gov/RCW/default.aspx?cite=59.04&full=true', 'https://app.leg.wa.gov/RCW/default.aspx?cite=59.08&full=true'], parse: parseWA },
    { actKey: 'eviction', kind: 'whole', encoding: 'utf-8', urls: ['https://app.leg.wa.gov/RCW/default.aspx?cite=59.12&full=true', 'https://app.leg.wa.gov/RCW/default.aspx?cite=59.16&full=true'], parse: parseWA },
    { actKey: 'residential', kind: 'whole', encoding: 'utf-8', urls: ['https://app.leg.wa.gov/RCW/default.aspx?cite=59.18&full=true', 'https://app.leg.wa.gov/RCW/default.aspx?cite=59.24&full=true', 'https://app.leg.wa.gov/RCW/default.aspx?cite=59.28&full=true'], parse: parseWA },
    { actKey: 'manufactured_home_park', kind: 'whole', encoding: 'utf-8', urls: ['https://app.leg.wa.gov/RCW/default.aspx?cite=59.20&full=true', 'https://app.leg.wa.gov/RCW/default.aspx?cite=59.21&full=true', 'https://app.leg.wa.gov/RCW/default.aspx?cite=59.22&full=true', 'https://app.leg.wa.gov/RCW/default.aspx?cite=59.30&full=true'], parse: parseWA },
  ] },
  MA: { state: 'MA', sourceDate: SRC_DATE, acts: [
    { actKey: 'residential', kind: 'whole', encoding: 'utf-8', urls: ['https://malegislature.gov/Laws/GeneralLaws/Partii/Titlei/Chapter186'], parse: parseMA },
    { actKey: 'eviction', kind: 'whole', encoding: 'utf-8', urls: ['https://malegislature.gov/Laws/GeneralLaws/PartIII/TitleIII/Chapter239'], parse: parseMA },
    { actKey: 'self_storage', kind: 'whole', encoding: 'utf-8', urls: ['https://malegislature.gov/Laws/GeneralLaws/PartI/TitleXV/Chapter105A'], parse: parseMA },
    { actKey: 'general_landlord_tenant', kind: 'whole', encoding: 'utf-8', urls: ['https://malegislature.gov/Laws/GeneralLaws/PartI/TitleXV/Chapter93a'], parse: parseMA },
  ] },
  MO: { state: 'MO', sourceDate: SRC_DATE, acts: [
    { actKey: 'residential', kind: 'whole', encoding: 'utf-8', urls: ['https://revisor.mo.gov/main/ViewChapter.aspx?chapter=441'], parse: parseMO },
    { actKey: 'eviction', kind: 'whole', encoding: 'utf-8', urls: ['https://revisor.mo.gov/main/ViewChapter.aspx?chapter=534'], parse: parseMO },
    { actKey: 'general_landlord_tenant', kind: 'whole', encoding: 'utf-8', urls: ['https://revisor.mo.gov/main/ViewChapter.aspx?chapter=535'], parse: parseMO },
    { actKey: 'self_storage', kind: 'whole', encoding: 'utf-8', urls: ['https://revisor.mo.gov/main/ViewChapter.aspx?chapter=415'], parse: parseMO },
    { actKey: 'manufactured_home_park', kind: 'whole', encoding: 'utf-8', urls: ['https://revisor.mo.gov/main/ViewChapter.aspx?chapter=700'], parse: parseMO },
  ] },
}

async function main() {
  const st = (process.argv[2] || 'ALL').toUpperCase()
  const targets = st === 'ALL' ? Object.keys(CONFIGS) : [st]
  for (const t of targets) {
    if (!CONFIGS[t]) { console.error('no config for', t); continue }
    await runState(CONFIGS[t])
  }
  process.exit(0)
}
main().catch((e) => { console.error(e); process.exit(1) })
