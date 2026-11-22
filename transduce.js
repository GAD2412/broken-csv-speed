// transduce.js: the fast path of main.ts. It reads the bytes of cases.json and writes the bytes of answers.json
// directly, never decoding the CSV text into JS strings: the same reading as solve.js (NOTES.md), done on the text's
// JSON-escaped form.
//
// Why that is exact: in the JSON text every character the CSV reading looks at is ASCII and appears as `,` or as the
// escapes \" (quote), \n (LF) and \r (CR). Every other code unit is opaque: raw UTF-8 bytes or another escape
// (\\, \t, \uXXXX, ...), and JSON escapes one character at a time, so a field's escaped bytes copied through are the
// escaped form of the field's value. A raw `"` byte can only end a JSON string.
//
// transduce(bytes) returns the answers.json bytes, or null when the file is not in the shape it expects (keys in
// another order, a header that is not true/false, \u escapes of a comma, quote, CR or LF, a \u escaped BOM,
// malformed JSON): main.ts then answers with run() from solve.js.

const BSL = 0x5c; // backslash
const QT = 0x22; // raw quote: only a string's end
const COMMA = 0x2c;
const LN = 0x6e; // n of \n
const LR = 0x72; // r of \r
const LU = 0x75; // u of \uXXXX
const CLOSE_BRACE = 0x7d;
const OPEN_BRACKET = 0x5b;
const CLOSE_BRACKET = 0x5d;

// Bytes that stop the plain-content loops: 1 outside quotes (comma, backslash, raw quote, control bytes),
// 2 the same inside quotes but commas.
const STOP = new Uint8Array(256);
for (let b = 0; b < 0x20; b++) STOP[b] = 1;
STOP[BSL] = 1;
STOP[QT] = 1;
STOP[COMMA] = 1;
const STOP_Q = STOP.slice();
STOP_Q[COMMA] = 0;

const ascii = (s) => {
  const a = new Uint8Array(s.length);
  for (let i = 0; i < s.length; i++) a[i] = s.charCodeAt(i);
  return a;
};
const ID_OPEN = ascii('{"id":"');
const TEXT_OPEN = ascii('","input":{"text":"');
const HEADER_KEY = ascii('","header":');
const TRUE_END = ascii('true}}');
const FALSE_END = ascii('false}}');
const COLUMNS = ascii('{"columns":');
const NULL_ROWS = ascii('null,"rows":[');
const ROWS = ascii(',"rows":[');
const EMPTY_ROWS = ascii('[],"rows":[');
const ERRORS = ascii('],"errors":[');
const CASE_END = ascii(']}');
const E_STRAY = ascii('{"code":"stray_cr","line":');
const E_JUNK = ascii('{"code":"quote_junk","line":');
const E_UNTERM = ascii('{"code":"unterminated_quote","line":');
const E_SHORT = ascii('{"code":"short_row","line":');
const E_LONG = ascii('{"code":"long_row","line":');
const E_ROW = ascii(',"row":');
const E_NULL = ascii('null');
const E_FIELDS = ascii(',"fields":');
const E_EXTRA = ascii(',"extra":[');

const GIVE_UP = new Error('not the expected cases.json shape');

// State of the transduction (module-level, reset by transduce).
let inp = new Uint8Array(0);
let out = new Uint8Array(0);
let o = 0;
let eb = new Uint8Array(0); // the current case's errors, joined after its rows
let eo = 0;
let errCount = 0;
let p = 0; // read position in inp
let te = 0; // end of the current case's text (its closing raw quote)
let line = 1;
let recLine = 1;
let recRow = 0;
let recRowNull = false;
let ended = 0; // how the last field ended: 0 comma, 1 line break, 2 end of text

function put(dst, at, bytes) {
  for (let k = 0; k < bytes.length; k++) dst[at + k] = bytes[k];
  return at + bytes.length;
}

function putInt(dst, at, v) {
  if (v < 10) {
    dst[at] = 48 + v;
    return at + 1;
  }
  let digits = 1;
  for (let x = v; x >= 10; x = Math.floor(x / 10)) digits++;
  let k = at + digits;
  for (let x = v; k > at; x = Math.floor(x / 10)) dst[--k] = 48 + (x % 10);
  return at + digits;
}

// Uninitialised memory: pages never written are never touched.
const bytesOf = (n) => {
  const b = Buffer.allocUnsafeSlow(n);
  return new Uint8Array(b.buffer, b.byteOffset, n);
};

function growOut(need) {
  let n = out.length * 2;
  if (n < o + need) n = o + need;
  const b = bytesOf(n);
  b.set(out.subarray(0, o));
  out = b;
}

function growErr(need) {
  if (eo + need <= eb.length) return;
  let n = eb.length * 2;
  if (n < eo + need) n = eo + need;
  const b = new Uint8Array(n);
  b.set(eb.subarray(0, eo));
  eb = b;
}

// Starts an error record: {"code":...,"line":L,"row":R (the caller closes it).
function errHead(code) {
  growErr(96);
  if (errCount++ > 0) eb[eo++] = COMMA;
  eo = put(eb, eo, code);
  eo = putInt(eb, eo, recLine);
  eo = put(eb, eo, E_ROW);
  eo = recRowNull ? put(eb, eo, E_NULL) : putInt(eb, eo, recRow);
}

function simpleErr(code) {
  errHead(code);
  eb[eo++] = CLOSE_BRACE;
}

function hexVal(b) {
  if (b >= 0x30 && b <= 0x39) return b - 0x30;
  if (b >= 0x61 && b <= 0x66) return b - 0x57;
  if (b >= 0x41 && b <= 0x46) return b - 0x37;
  throw GIVE_UP;
}

// \uXXXX at i (i at the backslash): fine unless it spells a character the CSV reading looks at.
function checkU(i) {
  if (i + 6 > te) throw GIVE_UP;
  const c = (hexVal(inp[i + 2]) << 12) | (hexVal(inp[i + 3]) << 8) | (hexVal(inp[i + 4]) << 4) | hexVal(inp[i + 5]);
  if (c === 0x0a || c === 0x0d || c === 0x22 || c === 0x2c) throw GIVE_UP;
}

// An unquoted field (or the rest of one) from p: content bytes are written to out as they are read; an escaped CR
// not followed by an escaped LF is dropped with stray_cr. Sets p and ended.
function unquoted() {
  const s = inp;
  const d = out;
  const end = te;
  let i = p;
  let k = o;
  while (i < end) {
    const b = s[i];
    if (STOP[b] === 0) {
      d[k++] = b;
      i++;
      continue;
    }
    if (b === COMMA) {
      o = k;
      p = i + 1;
      ended = 0;
      return;
    }
    if (b !== BSL) throw GIVE_UP;
    const e = s[i + 1];
    if (e === LN) {
      o = k;
      p = i + 2;
      line++;
      ended = 1;
      return;
    }
    if (e === LR) {
      if (s[i + 2] === BSL && s[i + 3] === LN) {
        o = k;
        p = i + 4;
        line++;
        ended = 1;
        return;
      }
      simpleErr(E_STRAY);
      i += 2;
      continue;
    }
    if (e === LU) {
      checkU(i);
      d[k] = b;
      d[k + 1] = e;
      d[k + 2] = s[i + 2];
      d[k + 3] = s[i + 3];
      d[k + 4] = s[i + 4];
      d[k + 5] = s[i + 5];
      k += 6;
      i += 6;
      continue;
    }
    // \" (a literal quote here), \\, \t, \b, \f, \/: content, kept escaped.
    d[k] = b;
    d[k + 1] = e;
    k += 2;
    i += 2;
  }
  o = k;
  p = i;
  ended = 2;
}

// A quoted field whose opening \" is at p.
function quoted() {
  const s = inp;
  const d = out;
  const end = te;
  const open = p;
  const openLine = line;
  const start = o;
  let i = p + 2;
  let k = o;
  let closed = false;
  while (i < end) {
    const b = s[i];
    if (STOP_Q[b] === 0) {
      d[k++] = b;
      i++;
      continue;
    }
    if (b !== BSL) throw GIVE_UP;
    const e = s[i + 1];
    if (e === QT) {
      if (s[i + 2] === BSL && s[i + 3] === QT) {
        // "" inside quotes: one quote.
        d[k] = BSL;
        d[k + 1] = QT;
        k += 2;
        i += 4;
        continue;
      }
      i += 2;
      closed = true;
      break;
    }
    if (e === LR) {
      // CRLF or a lone CR inside quotes: one LF.
      d[k] = BSL;
      d[k + 1] = LN;
      k += 2;
      line++;
      i += s[i + 2] === BSL && s[i + 3] === LN ? 4 : 2;
      continue;
    }
    if (e === LN) line++;
    else if (e === LU) {
      checkU(i);
      d[k] = b;
      d[k + 1] = e;
      d[k + 2] = s[i + 2];
      d[k + 3] = s[i + 3];
      d[k + 4] = s[i + 4];
      d[k + 5] = s[i + 5];
      k += 6;
      i += 6;
      continue;
    }
    d[k] = b;
    d[k + 1] = e;
    k += 2;
    i += 2;
  }
  if (!closed) {
    // Never closes: a literal quote, and the rest read again as unquoted.
    line = openLine;
    simpleErr(E_UNTERM);
    d[start] = BSL;
    d[start + 1] = QT;
    o = start + 2;
    p = open + 2;
    unquoted();
    return;
  }
  o = k;
  p = i;
  if (i >= end) {
    ended = 2;
    return;
  }
  const c = s[i];
  if (c === COMMA) {
    p = i + 1;
    ended = 0;
    return;
  }
  if (c === BSL && s[i + 1] === LN) {
    p = i + 2;
    line++;
    ended = 1;
    return;
  }
  if (c === BSL && s[i + 1] === LR && s[i + 2] === BSL && s[i + 3] === LN) {
    p = i + 4;
    line++;
    ended = 1;
    return;
  }
  // Junk after the closing quote, appended; quote_junk if anything was kept.
  const before = o;
  unquoted();
  if (o > before) simpleErr(E_JUNK);
}

// One case's text, inp[ts, te), answered into out.
function answerText(ts, end, header) {
  te = end;
  p = ts;
  line = 1;
  eo = 0;
  errCount = 0;
  if (inp[p] === 0xef && inp[p + 1] === 0xbb && inp[p + 2] === 0xbf && p + 3 <= end) p += 3;
  else if (inp[p] === BSL && inp[p + 1] === LU) {
    const c = (hexVal(inp[p + 2]) << 12) | (hexVal(inp[p + 3]) << 8) | (hexVal(inp[p + 4]) << 4) | hexVal(inp[p + 5]);
    if (c === 0xfeff) throw GIVE_UP;
  }
  if (o + 64 > out.length) growOut(64);
  o = put(out, o, COLUMNS);
  let headerPending = header;
  if (!header) o = put(out, o, NULL_ROWS);
  let rows = 0;
  let width = -1;

  for (;;) {
    // Blank lines (LF or CRLF) are no records.
    while (p < end && inp[p] === BSL) {
      if (inp[p + 1] === LN) {
        p += 2;
        line++;
      } else if (inp[p + 1] === LR && inp[p + 2] === BSL && inp[p + 3] === LN) {
        p += 4;
        line++;
      } else {
        break;
      }
    }
    if (p >= end) break;

    // Room for the whole record: at most 3 output bytes an input byte, plus padding and brackets.
    const need = 3 * (end - p) + 3 * (width > 0 ? width : 0) + 64;
    if (o + need > out.length) growOut(need);

    recLine = line;
    recRow = rows;
    recRowNull = headerPending;
    const recStart = o;
    if (!headerPending && rows > 0) out[o++] = COMMA;
    out[o++] = OPEN_BRACKET;
    let count = 0;
    let extraAt = -1;
    let lastQuoted = false;
    let lastStart = 0;
    do {
      if (count === width) extraAt = o;
      if (count > 0) out[o++] = COMMA;
      out[o++] = QT;
      lastStart = o;
      lastQuoted = inp[p] === BSL && inp[p + 1] === QT;
      if (lastQuoted) quoted();
      else unquoted();
      out[o++] = QT;
      count++;
    } while (ended === 0);

    // A line of stray CRs alone leaves nothing: no record (its errors stay).
    if (count === 1 && !lastQuoted && o === lastStart + 1) {
      o = recStart;
      continue;
    }
    if (width < 0) width = count;
    if (headerPending) {
      out[o++] = CLOSE_BRACKET;
      o = put(out, o, ROWS);
      headerPending = false;
      continue;
    }
    if (count < width) {
      for (let f = count; f < width; f++) {
        out[o] = COMMA;
        out[o + 1] = QT;
        out[o + 2] = QT;
        o += 3;
      }
      errHead(E_SHORT);
      eo = put(eb, eo, E_FIELDS);
      eo = putInt(eb, eo, count);
      eb[eo++] = CLOSE_BRACE;
    } else if (count > width) {
      // The cut fields move from the row into the error: out[extraAt + 1, o) holds them, comma-joined.
      const len = o - extraAt - 1;
      errHead(E_LONG);
      growErr(len + 16);
      eo = put(eb, eo, E_EXTRA);
      eb.set(out.subarray(extraAt + 1, o), eo);
      eo += len;
      eb[eo++] = CLOSE_BRACKET;
      eb[eo++] = CLOSE_BRACE;
      o = extraAt;
    }
    out[o++] = CLOSE_BRACKET;
    rows++;
  }

  if (o + eo + 64 > out.length) growOut(eo + 64);
  if (headerPending) o = put(out, o, EMPTY_ROWS);
  o = put(out, o, ERRORS);
  out.set(eb.subarray(0, eo), o);
  o += eo;
  o = put(out, o, CASE_END);
}

function expect(at, bytes) {
  for (let k = 0; k < bytes.length; k++) if (inp[at + k] !== bytes[k]) throw GIVE_UP;
  return at + bytes.length;
}

// The end of the JSON string whose content starts at i: its closing raw quote (escapes skipped).
function stringEnd(i) {
  const n = inp.length;
  while (i < n) {
    const b = inp[i];
    if (b === QT) return i;
    if (b === BSL) i += 2;
    else if (b < 0x20) throw GIVE_UP;
    else i++;
  }
  throw GIVE_UP;
}

const HEADER_KEY_BUF = Buffer.from(HEADER_KEY);

/** answers.json bytes for the cases.json bytes, or null when the file is not of the expected shape. */
export function transduce(bytes) {
  inp = new Uint8Array(bytes.buffer, bytes.byteOffset, bytes.length);
  const n = inp.length;
  out = bytesOf(3 * n + 4096);
  eb = new Uint8Array(1 << 16);
  o = 0;
  try {
    let at = 0;
    if (inp[at++] !== OPEN_BRACKET) throw GIVE_UP;
    out[o++] = OPEN_BRACKET;
    if (inp[at] === CLOSE_BRACKET) {
      at++;
    } else {
      for (let c = 0; ; c++) {
        if (c > 0) out[o++] = COMMA;
        at = expect(at, ID_OPEN);
        at = stringEnd(at);
        at = expect(at, TEXT_OPEN);
        const ts = at;
        // The text holds no raw quote, so its end is the first `","header":` after it (answerText checks that no
        // raw quote comes before: STOP stops at one and gives up).
        const end = bytes.indexOf(HEADER_KEY_BUF, ts);
        if (end < 0) throw GIVE_UP;
        at = end + HEADER_KEY.length;
        let header;
        if (inp[at] === 0x74) {
          at = expect(at, TRUE_END);
          header = true;
        } else {
          at = expect(at, FALSE_END);
          header = false;
        }
        answerText(ts, end, header);
        if (inp[at] === COMMA) {
          at++;
          continue;
        }
        if (inp[at] === CLOSE_BRACKET) {
          at++;
          break;
        }
        throw GIVE_UP;
      }
    }
    if (at !== n) throw GIVE_UP;
    if (o + 1 > out.length) growOut(1);
    out[o++] = CLOSE_BRACKET;
    return out.subarray(0, o);
  } catch (e) {
    if (e === GIVE_UP) return null;
    throw e;
  } finally {
    inp = new Uint8Array(0);
    eb = new Uint8Array(0);
  }
}
