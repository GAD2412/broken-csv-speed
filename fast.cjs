'use strict';
// fast.cjs: the harness program's work (main.ts only requires this file). Reads /input/cases.json, writes
// /output/answers.json, with the CSV reading done on the JSON-escaped bytes (as transduce.js, see its header for why
// that is exact) by an asm.js module: V8 validates it and compiles it ahead of time, so no time goes into warming up
// a JIT. The input is read whole into the asm heap; the output goes through a 1 MiB window, written out between
// records. Whenever the file is not of the expected shape, or a record does not fit the window, every case is
// answered again with run() from solve.js.

const fs = require('node:fs');
const v8 = require('node:v8');

// The house baseline's flag. (--single-threaded-gc set at run time can abort V8 when concurrent marking already ran,
// and this path hardly touches the JS heap, so it is left alone.)
v8.setFlagsFromString('--no-incremental-marking');
// Compile the asm.js module on this thread, not on helper threads.
v8.setFlagsFromString('--wasm-num-compilation-tasks=0');

function Csv(stdlib, foreign, heap) {
  'use asm';
  var H = new stdlib.Uint8Array(heap);
  var flush = foreign.flush;
  var STOP = foreign.STOP | 0; // 256-byte table: plain content outside quotes is 0
  var STOPQ = foreign.STOPQ | 0; // the same inside quotes (commas are content)
  var C = foreign.C | 0; // constant byte strings, each at C + its offset below
  var ERR = foreign.ERR | 0; // the current case's errors
  var ERREND = foreign.ERREND | 0;
  var XTRA = foreign.XTRA | 0; // a long row's cut fields
  var XTRAEND = foreign.XTRAEND | 0;
  var OUT = foreign.OUT | 0; // the output window
  var OUTEND = foreign.OUTEND | 0;
  var ROOM = foreign.ROOM | 0; // the window is written out before a record when less than this is left

  var o = 0; // output position (in the window, or in XTRA while cut fields are read)
  var oMax = 0; // field content may be written below this
  var e = 0; // error position
  var errCount = 0;
  var p = 0; // input position
  var te = 0; // end of the current text (its closing raw quote)
  var line = 0;
  var recLine = 0;
  var recRow = 0;
  var recNull = 0;
  var ended = 0; // 0 comma, 1 line break, 2 end of text
  var fail = 0;

  // Constants (offsets from C, lengths), laid out by the driver in this order.
  // 0 {"columns":  11 | 11 null,"rows":[  13 | 24 ,"rows":[  9 | 33 [],"rows":[  11 | 44 ],"errors":[  12
  // 56 ]}  2 | 58 {"code":"stray_cr","line":  26 | 84 {"code":"quote_junk","line":  28
  // 112 {"code":"unterminated_quote","line":  36 | 148 {"code":"short_row","line":  27
  // 175 {"code":"long_row","line":  26 | 201 ,"row":  7 | 208 null  4 | 212 ,"fields":  10 | 222 ,"extra":[  10

  function cp(dst, src, len) {
    dst = dst | 0;
    src = src | 0;
    len = len | 0;
    var i = 0;
    for (i = 0; (i | 0) < (len | 0); i = (i + 1) | 0) H[(dst + i) | 0] = H[(src + i) | 0] | 0;
    return (dst + len) | 0;
  }

  function putInt(dst, v) {
    dst = dst | 0;
    v = v | 0;
    var digits = 1;
    var x = 0;
    var k = 0;
    for (x = v; (x | 0) >= 10; x = ((x | 0) / 10) | 0) digits = (digits + 1) | 0;
    k = (dst + digits) | 0;
    x = v;
    while ((k | 0) > (dst | 0)) {
      k = (k - 1) | 0;
      H[k] = (48 + ((x | 0) % 10 | 0)) | 0;
      x = ((x | 0) / 10) | 0;
    }
    return (dst + digits) | 0;
  }

  function flushNow() {
    if ((o | 0) > (OUT | 0)) flush(OUT | 0, (o - OUT) | 0);
    o = OUT;
  }

  // {"code":...,"line":L,"row":R into the errors (the caller closes it).
  function errHead(code, codeLen) {
    code = code | 0;
    codeLen = codeLen | 0;
    if ((e | 0) > ((ERREND - 256) | 0)) {
      fail = 1;
      return;
    }
    if ((errCount | 0) != 0) {
      H[e] = 44;
      e = (e + 1) | 0;
    }
    errCount = (errCount + 1) | 0;
    e = cp(e, (C + code) | 0, codeLen) | 0;
    e = putInt(e, recLine) | 0;
    e = cp(e, (C + 201) | 0, 7) | 0;
    if ((recNull | 0) != 0) e = cp(e, (C + 208) | 0, 4) | 0;
    else e = putInt(e, recRow) | 0;
  }

  function simpleErr(code, codeLen) {
    code = code | 0;
    codeLen = codeLen | 0;
    errHead(code, codeLen);
    if ((fail | 0) == 0) {
      H[e] = 125;
      e = (e + 1) | 0;
    }
  }

  function hexVal(b) {
    b = b | 0;
    if (((b | 0) >= 48) & ((b | 0) <= 57)) return (b - 48) | 0;
    if (((b | 0) >= 97) & ((b | 0) <= 102)) return (b - 87) | 0;
    if (((b | 0) >= 65) & ((b | 0) <= 70)) return (b - 55) | 0;
    return -1;
  }

  // The code unit a \uXXXX at i spells, or -1 if it is malformed.
  function uValue(i) {
    i = i | 0;
    var a = 0;
    var b = 0;
    var c = 0;
    var d = 0;
    if (((i + 6) | 0) > (te | 0)) return -1;
    a = hexVal(H[(i + 2) | 0] | 0) | 0;
    b = hexVal(H[(i + 3) | 0] | 0) | 0;
    c = hexVal(H[(i + 4) | 0] | 0) | 0;
    d = hexVal(H[(i + 5) | 0] | 0) | 0;
    if ((((a | 0) < 0) | ((b | 0) < 0) | ((c | 0) < 0) | ((d | 0) < 0)) != 0) return -1;
    return (a << 12) | (b << 8) | (c << 4) | d;
  }

  // 1 when a \uXXXX at i must not be copied through: malformed, or a comma, quote, CR or LF.
  function badU(i) {
    i = i | 0;
    var c = 0;
    c = uValue(i) | 0;
    if ((c | 0) < 0) return 1;
    if ((((c | 0) == 10) | ((c | 0) == 13) | ((c | 0) == 34) | ((c | 0) == 44)) != 0) return 1;
    return 0;
  }

  // An unquoted field (or its rest) from p, content copied to o. Writes never outrun reads, so stopping the reads at
  // lim keeps the writes below oMax.
  function unq() {
    var i = 0;
    var k = 0;
    var b = 0;
    var c = 0;
    var lim = 0;
    i = p;
    k = o;
    lim = (i + ((oMax - k) | 0)) | 0;
    if ((lim | 0) > (te | 0)) lim = te;
    while ((i | 0) < (lim | 0)) {
      b = H[i] | 0;
      if ((H[(STOP + b) | 0] | 0) == 0) {
        H[k] = b;
        k = (k + 1) | 0;
        i = (i + 1) | 0;
        continue;
      }
      if ((b | 0) == 44) {
        o = k;
        p = (i + 1) | 0;
        ended = 0;
        return;
      }
      if ((b | 0) != 92) {
        fail = 1;
        return;
      }
      c = H[(i + 1) | 0] | 0;
      if ((c | 0) == 110) {
        o = k;
        p = (i + 2) | 0;
        line = (line + 1) | 0;
        ended = 1;
        return;
      }
      if ((c | 0) == 114) {
        if ((((H[(i + 2) | 0] | 0) == 92) & ((H[(i + 3) | 0] | 0) == 110)) != 0) {
          o = k;
          p = (i + 4) | 0;
          line = (line + 1) | 0;
          ended = 1;
          return;
        }
        simpleErr(58, 26);
        if ((fail | 0) != 0) return;
        i = (i + 2) | 0;
        continue;
      }
      if ((c | 0) == 117) {
        if ((badU(i) | 0) != 0) {
          fail = 1;
          return;
        }
        k = cp(k, i, 6) | 0;
        i = (i + 6) | 0;
        continue;
      }
      H[k] = 92;
      H[(k + 1) | 0] = c;
      k = (k + 2) | 0;
      i = (i + 2) | 0;
    }
    o = k;
    p = i;
    if ((i | 0) < (te | 0)) {
      fail = 1; // the field does not fit the window
      return;
    }
    ended = 2;
  }

  // 1 when a quoted field's closing quote comes before the end of the text, reading from i inside it.
  function closesFrom(i) {
    i = i | 0;
    var c = 0;
    while ((i | 0) < (te | 0)) {
      if ((H[i] | 0) == 92) {
        c = H[(i + 1) | 0] | 0;
        if ((c | 0) == 34) {
          if ((((H[(i + 2) | 0] | 0) == 92) & ((H[(i + 3) | 0] | 0) == 34)) != 0) {
            i = (i + 4) | 0;
            continue;
          }
          return 1;
        }
        i = (i + ((c | 0) == 117 ? 6 : 2)) | 0;
        continue;
      }
      i = (i + 1) | 0;
    }
    return 0;
  }

  // A quoted field whose opening \" is at p.
  function quo() {
    var i = 0;
    var k = 0;
    var b = 0;
    var c = 0;
    var lim = 0;
    var open = 0;
    var openLine = 0;
    var start = 0;
    var before = 0;
    open = p;
    openLine = line;
    start = o;
    i = (p + 2) | 0;
    k = o;
    lim = (i + ((oMax - k) | 0)) | 0;
    if ((lim | 0) > (te | 0)) lim = te;
    while ((i | 0) < (lim | 0)) {
      b = H[i] | 0;
      if ((H[(STOPQ + b) | 0] | 0) == 0) {
        H[k] = b;
        k = (k + 1) | 0;
        i = (i + 1) | 0;
        continue;
      }
      if ((b | 0) != 92) {
        fail = 1;
        return;
      }
      c = H[(i + 1) | 0] | 0;
      if ((c | 0) == 34) {
        if ((((H[(i + 2) | 0] | 0) == 92) & ((H[(i + 3) | 0] | 0) == 34)) != 0) {
          // "" inside quotes: one quote.
          H[k] = 92;
          H[(k + 1) | 0] = 34;
          k = (k + 2) | 0;
          i = (i + 4) | 0;
          continue;
        }
        // The closing quote.
        i = (i + 2) | 0;
        o = k;
        p = i;
        if ((i | 0) >= (te | 0)) {
          ended = 2;
          return;
        }
        b = H[i] | 0;
        if ((b | 0) == 44) {
          p = (i + 1) | 0;
          ended = 0;
          return;
        }
        if ((b | 0) == 92) {
          c = H[(i + 1) | 0] | 0;
          if ((c | 0) == 110) {
            p = (i + 2) | 0;
            line = (line + 1) | 0;
            ended = 1;
            return;
          }
          if ((((c | 0) == 114) & ((H[(i + 2) | 0] | 0) == 92) & ((H[(i + 3) | 0] | 0) == 110)) != 0) {
            p = (i + 4) | 0;
            line = (line + 1) | 0;
            ended = 1;
            return;
          }
        }
        // Junk after the closing quote, appended; quote_junk if anything was kept.
        before = o;
        unq();
        if ((fail | 0) != 0) return;
        if ((o | 0) > (before | 0)) simpleErr(84, 28);
        return;
      }
      if ((c | 0) == 114) {
        // CRLF or a lone CR inside quotes: one LF.
        H[k] = 92;
        H[(k + 1) | 0] = 110;
        k = (k + 2) | 0;
        line = (line + 1) | 0;
        if ((((H[(i + 2) | 0] | 0) == 92) & ((H[(i + 3) | 0] | 0) == 110)) != 0) i = (i + 4) | 0;
        else i = (i + 2) | 0;
        continue;
      }
      if ((c | 0) == 110) {
        line = (line + 1) | 0;
      } else if ((c | 0) == 117) {
        if ((badU(i) | 0) != 0) {
          fail = 1;
          return;
        }
        k = cp(k, i, 6) | 0;
        i = (i + 6) | 0;
        continue;
      }
      H[k] = 92;
      H[(k + 1) | 0] = c;
      k = (k + 2) | 0;
      i = (i + 2) | 0;
    }
    if ((i | 0) < (te | 0)) {
      // Stopped by the window: give up unless the quote never closes.
      if ((closesFrom(i) | 0) != 0) {
        fail = 1;
        return;
      }
    }
    // Never closes: a literal quote, and the rest read again as unquoted.
    line = openLine;
    simpleErr(112, 36);
    if ((fail | 0) != 0) return;
    H[start] = 92;
    H[(start + 1) | 0] = 34;
    o = (start + 2) | 0;
    p = (open + 2) | 0;
    unq();
  }

  // Appends one byte to the output (the brackets and commas between cases).
  function putByte(b) {
    b = b | 0;
    if ((o | 0) > ((OUTEND - 64) | 0)) flushNow();
    H[o] = b;
    o = (o + 1) | 0;
  }

  // Starts the output.
  function begin() {
    o = OUT;
  }

  // Writes out what is left in the window.
  function finish() {
    flushNow();
  }

  // One case's text H[ts, end) answered into the output: 0, or -1 to give up.
  function answer(ts, end, header) {
    ts = ts | 0;
    end = end | 0;
    header = header | 0;
    var rows = 0;
    var width = -1;
    var pending = 0;
    var recStart = 0;
    var count = 0;
    var inX = 0;
    var oRow = 0;
    var xEnd = 0;
    var lastQ = 0;
    var lastStart = 0;
    var f = 0;
    var c = 0;
    var n = 0;
    var room = 0;
    te = end;
    p = ts;
    line = 1;
    e = ERR;
    errCount = 0;
    fail = 0;
    if (((H[p] | 0) == 239) & ((H[(p + 1) | 0] | 0) == 187) & ((H[(p + 2) | 0] | 0) == 191) & (((p + 3) | 0) <= (end | 0))) {
      p = (p + 3) | 0;
    } else if ((((H[p] | 0) == 92) & ((H[(p + 1) | 0] | 0) == 117)) != 0) {
      c = uValue(p) | 0;
      if (((c | 0) == 65279) | ((c | 0) < 0)) return -1;
    }
    if ((o | 0) > ((OUTEND - ROOM) | 0)) flushNow();
    o = cp(o, C, 11) | 0;
    pending = header;
    if ((header | 0) == 0) o = cp(o, (C + 11) | 0, 13) | 0;

    for (;;) {
      // Blank lines (LF or CRLF) are no records.
      while ((p | 0) < (end | 0)) {
        if ((H[p] | 0) != 92) break;
        c = H[(p + 1) | 0] | 0;
        if ((c | 0) == 110) {
          p = (p + 2) | 0;
          line = (line + 1) | 0;
          continue;
        }
        if ((((c | 0) == 114) & ((H[(p + 2) | 0] | 0) == 92) & ((H[(p + 3) | 0] | 0) == 110)) != 0) {
          p = (p + 4) | 0;
          line = (line + 1) | 0;
          continue;
        }
        break;
      }
      if ((p | 0) >= (end | 0)) break;

      if ((o | 0) > ((OUTEND - ROOM) | 0)) flushNow();
      oMax = (OUTEND - 1024) | 0;
      recLine = line;
      recRow = rows;
      recNull = pending;
      recStart = o;
      if ((((pending | 0) == 0) & ((rows | 0) > 0)) != 0) {
        H[o] = 44;
        o = (o + 1) | 0;
      }
      H[o] = 91;
      o = (o + 1) | 0;
      count = 0;
      inX = 0;
      for (;;) {
        if ((count | 0) == (width | 0)) {
          // The cut fields of a long row go to XTRA.
          oRow = o;
          o = XTRA;
          oMax = (XTRAEND - 1024) | 0;
          inX = 1;
        } else if ((count | 0) > 0) {
          H[o] = 44;
          o = (o + 1) | 0;
        }
        if ((o | 0) > (oMax | 0)) return -1;
        H[o] = 34;
        o = (o + 1) | 0;
        lastStart = o;
        lastQ = ((H[p] | 0) == 92) & ((H[(p + 1) | 0] | 0) == 34);
        if ((lastQ | 0) != 0) quo();
        else unq();
        if ((fail | 0) != 0) return -1;
        H[o] = 34;
        o = (o + 1) | 0;
        count = (count + 1) | 0;
        if ((ended | 0) != 0) break;
      }
      if ((inX | 0) != 0) {
        xEnd = o;
        o = oRow;
      }

      // A line of stray CRs alone leaves nothing: no record (its errors stay).
      if ((((count | 0) == 1) & ((lastQ | 0) == 0) & ((o | 0) == ((lastStart + 1) | 0))) != 0) {
        o = recStart;
        continue;
      }
      if ((width | 0) < 0) width = count;
      if ((pending | 0) != 0) {
        H[o] = 93;
        o = (o + 1) | 0;
        o = cp(o, (C + 24) | 0, 9) | 0;
        pending = 0;
        continue;
      }
      if ((count | 0) < (width | 0)) {
        n = (((width - count) | 0) * 3) | 0;
        if ((((o + n) | 0) + 16 | 0) > (OUTEND | 0)) return -1;
        for (f = count; (f | 0) < (width | 0); f = (f + 1) | 0) {
          H[o] = 44;
          H[(o + 1) | 0] = 34;
          H[(o + 2) | 0] = 34;
          o = (o + 3) | 0;
        }
        errHead(148, 27);
        if ((fail | 0) != 0) return -1;
        e = cp(e, (C + 212) | 0, 10) | 0;
        e = putInt(e, count) | 0;
        H[e] = 125;
        e = (e + 1) | 0;
      } else if ((count | 0) > (width | 0)) {
        n = (xEnd - XTRA) | 0;
        if ((((e + n) | 0) + 512 | 0) > (ERREND | 0)) return -1;
        errHead(175, 26);
        if ((fail | 0) != 0) return -1;
        e = cp(e, (C + 222) | 0, 10) | 0;
        e = cp(e, XTRA, n) | 0;
        H[e] = 93;
        H[(e + 1) | 0] = 125;
        e = (e + 2) | 0;
      }
      H[o] = 93;
      o = (o + 1) | 0;
      rows = (rows + 1) | 0;
    }

    if ((o | 0) > ((OUTEND - 64) | 0)) flushNow();
    if ((pending | 0) != 0) o = cp(o, (C + 33) | 0, 11) | 0;
    o = cp(o, (C + 44) | 0, 12) | 0;
    // The errors, through the window.
    f = ERR;
    while ((f | 0) < (e | 0)) {
      room = (OUTEND - o) | 0;
      if ((room | 0) < 64) {
        flushNow();
        room = (OUTEND - o) | 0;
      }
      n = (e - f) | 0;
      if ((n | 0) > (room | 0)) n = room;
      o = cp(o, f, n) | 0;
      f = (f + n) | 0;
    }
    if ((o | 0) > ((OUTEND - 64) | 0)) flushNow();
    o = cp(o, (C + 56) | 0, 2) | 0;
    return 0;
  }

  return { begin: begin, putByte: putByte, answer: answer, finish: finish };
}

const CONSTANTS = [
  '{"columns":',
  'null,"rows":[',
  ',"rows":[',
  '[],"rows":[',
  '],"errors":[',
  ']}',
  '{"code":"stray_cr","line":',
  '{"code":"quote_junk","line":',
  '{"code":"unterminated_quote","line":',
  '{"code":"short_row","line":',
  '{"code":"long_row","line":',
  ',"row":',
  'null',
  ',"fields":',
  ',"extra":[',
];
// The offsets Csv uses for them (its comment lists them).
const OFFSETS = [0, 11, 24, 33, 44, 56, 58, 84, 112, 148, 175, 201, 208, 212, 222];

const KB = 1024;
const MB = 1024 * KB;
const C = 0;
const STOP = 1 * KB;
const STOPQ = 2 * KB;
const ERR = 4 * KB;
const ERREND = ERR + 2 * MB;
const XTRA = ERREND;
const XTRAEND = XTRA + 256 * KB;
const OUT = XTRAEND;
// The output window: 1 MiB, written out before a record when less than a quarter is left. (Tests pass a few KiB,
// so that every path through the window's writes is taken on small inputs.)
const WINDOW = 1 * MB;

const ascii = (u8, at, s) => {
  for (let i = 0; i < s.length; i++) u8[at + i] = s.charCodeAt(i);
};

// The bytes of a JSON-escaped string at i in buf end at its closing raw quote.
function stringEnd(buf, i, n) {
  while (i < n) {
    const b = buf[i];
    if (b === 0x22) return i;
    if (b === 0x5c) i += 2;
    else if (b < 0x20) return -1;
    else i++;
  }
  return -1;
}

function matches(buf, at, s) {
  for (let k = 0; k < s.length; k++) if (buf[at + k] !== s.charCodeAt(k)) return false;
  return true;
}

/** Answers inPath into outPath with the asm.js reader; false when the file must be answered by run() instead. */
function fastPath(inPath, outPath, window = WINDOW) {
  const OUTEND = OUT + window;
  const ROOM = window >> 2;
  const IN = OUTEND + 64 * KB;
  const fd = fs.openSync(inPath, 'r');
  const n = fs.fstatSync(fd).size;
  // asm.js heaps are a power of two from 4 KiB, or a multiple of 16 MiB.
  const size = Math.ceil((IN + n + 64 * KB) / (16 * MB)) * 16 * MB;
  const heap = new ArrayBuffer(size);
  const u8 = new Uint8Array(heap);
  for (let i = 0; i < CONSTANTS.length; i++) {
    if (i > 0 && OFFSETS[i] !== OFFSETS[i - 1] + CONSTANTS[i - 1].length) throw new Error('constant layout');
    ascii(u8, C + OFFSETS[i], CONSTANTS[i]);
  }
  for (let b = 0; b < 0x20; b++) u8[STOP + b] = u8[STOPQ + b] = 1;
  u8[STOP + 0x22] = u8[STOPQ + 0x22] = 1;
  u8[STOP + 0x5c] = u8[STOPQ + 0x5c] = 1;
  u8[STOP + 0x2c] = 1;
  let got = 0;
  while (got < n) {
    const r = fs.readSync(fd, u8, IN + got, n - got, got);
    if (r <= 0) break;
    got += r;
  }
  fs.closeSync(fd);
  if (got !== n) return false;

  const out = fs.openSync(outPath, 'w', 0o644);
  const flush = (start, len) => {
    let done = 0;
    while (done < len) done += fs.writeSync(out, u8, start + done, len - done);
  };
  const m = Csv(globalThis, { flush, STOP, STOPQ, C, ERR, ERREND, XTRA, XTRAEND, OUT, OUTEND, ROOM }, heap);
  const buf = Buffer.from(heap, IN, n);
  const end = IN + n;
  let ok = false;
  try {
    m.begin();
    let at = IN;
    if (u8[at++] !== 0x5b) return false;
    m.putByte(0x5b); // [
    if (u8[at] === 0x5d) {
      at++;
    } else {
      for (let c = 0; ; c++) {
        if (c > 0) m.putByte(0x2c); // , between answers
        if (!matches(u8, at, '{"id":"')) return false;
        at = stringEnd(u8, at + 7, end);
        if (at < 0 || !matches(u8, at, '","input":{"text":"')) return false;
        const ts = at + 19;
        // The text holds no raw quote, so it ends at the first `","header":` (the reader gives up on a raw quote).
        const te = buf.indexOf('","header":', ts - IN, 'latin1') + IN;
        if (te < IN) return false;
        at = te + 11;
        let header;
        if (matches(u8, at, 'true}}')) {
          header = 1;
          at += 6;
        } else if (matches(u8, at, 'false}}')) {
          header = 0;
          at += 7;
        } else return false;
        if (m.answer(ts, te, header) !== 0) return false;
        if (u8[at] === 0x2c) {
          at++;
          continue;
        }
        if (u8[at] === 0x5d) {
          at++;
          break;
        }
        return false;
      }
    }
    if (at !== end) return false;
    m.putByte(0x5d); // ]
    m.finish();
    ok = true;
    return true;
  } finally {
    fs.closeSync(out);
    if (!ok) fs.rmSync(outPath, { force: true });
  }
}

// run() for every case, as the house driver does.
async function slowPath(inPath, outPath) {
  const { run } = await import('./solve.js');
  const cases = JSON.parse(fs.readFileSync(inPath, 'utf8'));
  const answers = new Array(cases.length);
  for (let i = 0; i < cases.length; i++) answers[i] = run(cases[i].input);
  fs.writeFileSync(outPath, JSON.stringify(answers), { mode: 0o644 });
}

function main() {
  const inPath = (process.env.MAKEFUN_INPUT_DIR ?? '/input') + '/cases.json';
  const outPath = (process.env.MAKEFUN_OUTPUT_DIR ?? '/output') + '/answers.json';
  let done = false;
  try {
    done = fastPath(inPath, outPath);
  } catch {
    // Anything unexpected on the fast path: answer with run() all the same.
    fs.rmSync(outPath, { force: true });
  }
  if (!done) return slowPath(inPath, outPath);
}

module.exports = { Csv, fastPath, slowPath, main };
