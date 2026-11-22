// solve.js: a fast reader of broken CSV text that answers exactly as csv-reader 1.0.0 does.
// run({text, header}) -> {columns, rows, errors}. See NOTES.md for the reading rules.
// Version 1: one left-to-right pass over UTF-16 code units with charCodeAt; every field is a slice of the text
// (joined from pieces only where a quoted field holds "" or a CR, or junk follows its closing quote).

const QUOTE = 34;
const COMMA = 44;
const LF = 10;
const CR = 13;

// How the last field read ended.
const AT_COMMA = 0;
const AT_BREAK = 1;
const AT_END = 2;

// Reading state of the current call (reset by run; nothing survives between calls that matters).
let src = '';
let len = 0;
let pos = 0;
let line = 1;
let ended = AT_END;
let added = 0;
let errs = [];
let recLine = 1;
let recRow = null;

// Unquoted characters from pos, appended to `prefix`, up to a comma, a line break or the end.
// A CR not followed by LF is dropped (stray_cr). Sets `ended` and `added` (characters kept).
function readUnquoted(prefix) {
  const s = src;
  const n = len;
  let value = prefix;
  let keep = 0;
  let start = pos;
  let i = pos;
  while (i < n) {
    const c = s.charCodeAt(i);
    if (c === COMMA) {
      keep += i - start;
      value += s.slice(start, i);
      pos = i + 1;
      ended = AT_COMMA;
      added = keep;
      return value;
    }
    if (c === LF) {
      keep += i - start;
      value += s.slice(start, i);
      pos = i + 1;
      line++;
      ended = AT_BREAK;
      added = keep;
      return value;
    }
    if (c === CR) {
      keep += i - start;
      value += s.slice(start, i);
      if (s.charCodeAt(i + 1) === LF) {
        pos = i + 2;
        line++;
        ended = AT_BREAK;
        added = keep;
        return value;
      }
      errs.push({ code: 'stray_cr', line: recLine, row: recRow });
      i++;
      start = i;
      continue;
    }
    i++;
  }
  keep += i - start;
  value += s.slice(start, i);
  pos = i;
  ended = AT_END;
  added = keep;
  return value;
}

// A quoted field whose opening quote is at pos.
function readQuoted() {
  const s = src;
  const n = len;
  const open = pos;
  const openLine = line;
  let value = '';
  let i = pos + 1;
  let start = i;
  let closed = false;
  while (i < n) {
    const c = s.charCodeAt(i);
    if (c === QUOTE) {
      if (s.charCodeAt(i + 1) === QUOTE) {
        value += s.slice(start, i + 1);
        i += 2;
        start = i;
        continue;
      }
      value += s.slice(start, i);
      i++;
      closed = true;
      break;
    }
    if (c === CR) {
      value += s.slice(start, i) + '\n';
      line++;
      i += s.charCodeAt(i + 1) === LF ? 2 : 1;
      start = i;
      continue;
    }
    if (c === LF) line++;
    i++;
  }
  if (!closed) {
    // Never closes: the quote is a literal character and the rest is read again as unquoted.
    pos = open + 1;
    line = openLine;
    errs.push({ code: 'unterminated_quote', line: recLine, row: recRow });
    return readUnquoted('"');
  }
  pos = i;
  if (i >= n) {
    ended = AT_END;
    return value;
  }
  const c = s.charCodeAt(i);
  if (c === COMMA) {
    pos = i + 1;
    ended = AT_COMMA;
    return value;
  }
  if (c === LF) {
    pos = i + 1;
    line++;
    ended = AT_BREAK;
    return value;
  }
  if (c === CR && s.charCodeAt(i + 1) === LF) {
    pos = i + 2;
    line++;
    ended = AT_BREAK;
    return value;
  }
  // Junk after the closing quote is appended as it stands.
  const v = readUnquoted(value);
  if (added > 0) errs.push({ code: 'quote_junk', line: recLine, row: recRow });
  return v;
}

export function run(input) {
  const text = String(input.text);
  const header = input.header === true;
  src = text;
  len = text.length;
  pos = text.charCodeAt(0) === 0xfeff ? 1 : 0;
  line = 1;
  errs = [];
  const errors = errs;
  const rows = [];
  let columns = null;
  let width = -1;
  const n = len;
  // The first quote and the first CR at or after pos (n when none): found with indexOf and kept until pos passes them,
  // so a line can be told clean (no quote, no CR but its CRLF ending) without looking at its characters one by one.
  let nextQuote = -1;
  let nextCR = -1;

  for (;;) {
    // Blank lines (LF or CRLF) are no records.
    while (pos < n) {
      const c = text.charCodeAt(pos);
      if (c === LF) {
        pos++;
        line++;
      } else if (c === CR && text.charCodeAt(pos + 1) === LF) {
        pos += 2;
        line++;
      } else {
        break;
      }
    }
    if (pos >= n) break;

    recLine = line;
    recRow = header && columns === null ? null : rows.length;
    let fields;

    if (nextQuote < pos) {
      nextQuote = text.indexOf('"', pos);
      if (nextQuote < 0) nextQuote = n;
    }
    if (nextCR < pos) {
      nextCR = text.indexOf('\r', pos);
      if (nextCR < 0) nextCR = n;
    }
    const nl = text.indexOf('\n', pos);
    const lineEnd = nl < 0 ? n : nl;
    // The record's last character: before the CR of a CRLF ending.
    const end = nl > 0 && text.charCodeAt(nl - 1) === CR ? nl - 1 : lineEnd;

    if (nextQuote >= lineEnd && nextCR >= end) {
      // Clean line: unquoted fields split at commas (native split), never empty (blank lines were skipped).
      fields = text.slice(pos, end).split(',');
      if (nl < 0) {
        pos = n;
      } else {
        pos = nl + 1;
        line++;
      }
    } else {
      fields = [];
      let quoted = false;
      do {
        quoted = text.charCodeAt(pos) === QUOTE;
        fields.push(quoted ? readQuoted() : readUnquoted(''));
      } while (ended === AT_COMMA);

      // A line of stray CRs alone leaves nothing: no record.
      if (fields.length === 1 && !quoted && fields[0] === '') continue;
    }

    if (width < 0) width = fields.length;
    if (header && columns === null) {
      columns = fields;
      continue;
    }
    if (fields.length < width) {
      errors.push({ code: 'short_row', line: recLine, row: recRow, fields: fields.length });
      while (fields.length < width) fields.push('');
    } else if (fields.length > width) {
      errors.push({ code: 'long_row', line: recLine, row: recRow, extra: fields.splice(width) });
    }
    rows.push(fields);
  }
  src = '';
  errs = [];
  return { columns: header ? (columns ?? []) : null, rows, errors };
}
