'use strict';
// fast.cjs: the harness program (main.ts only calls main()). Reads /input/cases.json and writes
// /output/answers.json, doing the CSV reading on the text's JSON-escaped bytes, never decoding it into JS strings.
//
// Why that is exact: in the JSON text every character the CSV reading looks at is ASCII and appears as `,` or as the
// escapes \" (quote), \n (LF) and \r (CR). Every other code unit is opaque: raw UTF-8 bytes or another escape
// (\\, \t, \uXXXX, ...), and JSON escapes one character at a time, so a field's escaped bytes copied through are the
// escaped form of the field's value. A raw `"` byte can only end a JSON string: it ends the text.
//
// The reader is an asm.js module: V8 validates it and compiles it ahead of time, so no time goes into warming up a
// JIT. Input and output go through 512 KiB windows in its heap, refilled and written out between records.
// The text comes before its "header" flag in the file, and the flag changes only the answer's first bytes, the
// separator after the first record and the errors' row numbers: so each text is read first, with fixed-size
// placeholders for those bytes (the padding is JSON whitespace) and errors kept as numbers, and the placeholders are
// filled in (in the window, or in the file if already written) and the errors written once the flag is read.
//
// Whenever the file is not of the expected shape, or a record does not fit a window, every case is answered again
// with run() from solve.js.

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
  var H32 = new stdlib.Int32Array(heap);
  var flush = foreign.flush; // flush(start, len): write H[start, start + len) at the end of the file
  var patchFile = foreign.patchFile; // patchFile(at, src, len): write H[src, src + len) at file offset `at`
  var STOP = foreign.STOP | 0; // 256-byte table: plain content outside quotes is 0
  var STOPQ = foreign.STOPQ | 0; // the same inside quotes (commas are content)
  var ERR = foreign.ERR | 0; // the current case's errors, 20 bytes each: code, line, record, a, b
  var ERREND = foreign.ERREND | 0;
  var XA = foreign.XA | 0; // the current case's cut fields (long rows)
  var XAEND = foreign.XAEND | 0;
  var OUT = foreign.OUT | 0; // the output window
  var OUTEND = foreign.OUTEND | 0;
  var ROOM = foreign.ROOM | 0; // the window is written out before a record when less than this is left
  var IN = foreign.IN | 0; // the input window
  var LOOK = foreign.LOOK | 0; // the input window is refilled before a record when fewer bytes than this are left
  var refill = foreign.refill; // refill(p): moves H[p, inEnd) to IN, reads more after it; its new end, or -1 at EOF
  // Constant byte strings (their lengths are in the comments).
  var K_F1 = foreign.K_F1 | 0; // {"columns":null,"rows":[  24
  var K_T1 = foreign.K_T1 | 0; // {"columns":  + 13 spaces  24
  var K_E1 = foreign.K_E1 | 0; // {"columns":[],"rows":[  + 2 spaces  24
  var K_T2 = foreign.K_T2 | 0; // ,"rows":[  9
  var K_F2A = foreign.K_F2A | 0; // , + 8 spaces  9
  var K_F2B = foreign.K_F2B | 0; // 9 spaces  9
  var K_ERRS = foreign.K_ERRS | 0; // ],"errors":[  12
  var K_CEND = foreign.K_CEND | 0; // ]}  2
  var K_STRAY = foreign.K_STRAY | 0; // {"code":"stray_cr","line":  26
  var K_JUNK = foreign.K_JUNK | 0; // {"code":"quote_junk","line":  28
  var K_UNT = foreign.K_UNT | 0; // {"code":"unterminated_quote","line":  36
  var K_SHORT = foreign.K_SHORT | 0; // {"code":"short_row","line":  27
  var K_LONG = foreign.K_LONG | 0; // {"code":"long_row","line":  26
  var K_ROW = foreign.K_ROW | 0; // ,"row":  7
  var K_NUL = foreign.K_NUL | 0; // null  4
  var K_FIELDS = foreign.K_FIELDS | 0; // ,"fields":  10
  var K_EXTRA = foreign.K_EXTRA | 0; // ,"extra":[  10

  var o = 0; // output position (in the window, or in XA while cut fields are read)
  var oMax = 0; // field content may be written below this
  var e = 0; // next error record
  var xa = 0; // next free byte of XA
  var p = 0; // input position
  var inEnd = 0; // end of the bytes in the input window
  var eof = 0; // 1 once the whole file has been read
  var te = 0; // end of the current text: its closing raw quote once met (teFound), inEnd until then
  var teFound = 0;
  var line = 0;
  var recLine = 0; // the line the current record starts on
  var rec = 0; // records kept so far in this text (the header among them): the current record's index
  var ended = 0; // how the last field ended: 0 comma, 1 line break, 2 end of text
  var fail = 0;
  var flushed = 0; // bytes written to the file so far: the window starts at this file offset
  var p1 = 0; // file offset of the answer's first 24 bytes
  var p2 = 0; // file offset of the 9 bytes after the first record

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
    if ((o | 0) > (OUT | 0)) {
      flush(OUT | 0, (o - OUT) | 0);
      flushed = (flushed + ((o - OUT) | 0)) | 0;
    }
    o = OUT;
  }

  // Room for n more bytes in the window.
  function need(n) {
    n = n | 0;
    if ((o | 0) > ((OUTEND - n) | 0)) flushNow();
  }

  // Writes H[src, src + len) at output file offset `at`: in the window if it is still there, else in the file.
  function patch(at, src, len) {
    at = at | 0;
    src = src | 0;
    len = len | 0;
    var x = 0;
    if ((at | 0) >= (flushed | 0)) x = cp((OUT + ((at - flushed) | 0)) | 0, src, len) | 0;
    else patchFile(at | 0, src | 0, len | 0);
  }

  // An error of the current record: 1 stray_cr, 2 quote_junk, 3 unterminated_quote, 4 short_row (a: its fields),
  // 5 long_row (a, b: where its cut fields are in XA and how many bytes they take).
  function addErr(code, a, b) {
    code = code | 0;
    a = a | 0;
    b = b | 0;
    if ((e | 0) > ((ERREND - 32) | 0)) {
      fail = 1;
      return;
    }
    H32[e >> 2] = code;
    H32[(e + 4) >> 2] = recLine;
    H32[(e + 8) >> 2] = rec;
    H32[(e + 12) >> 2] = a;
    H32[(e + 16) >> 2] = b;
    e = (e + 20) | 0;
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
      if ((b | 0) == 34) {
        // The text's closing quote.
        te = i;
        teFound = 1;
        o = k;
        p = i;
        ended = 2;
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
        addErr(1, 0, 0);
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
    if ((((i | 0) < (te | 0)) | ((teFound | 0) == 0)) != 0) {
      fail = 1; // the field does not fit the output window, or runs past the input window
      return;
    }
    ended = 2;
  }

  // 1 when a quoted field's closing quote comes before the end of the text, reading from i inside it; 0 when the
  // text ends first (teFound then set), or the input window does (teFound still 0).
  function closesFrom(i) {
    i = i | 0;
    var b = 0;
    var c = 0;
    while ((i | 0) < (te | 0)) {
      b = H[i] | 0;
      if ((b | 0) == 34) {
        te = i;
        teFound = 1;
        return 0;
      }
      if ((b | 0) == 92) {
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
      if ((b | 0) == 34) {
        // The text ends inside the quotes.
        te = i;
        teFound = 1;
        break;
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
        b = H[i] | 0;
        if ((b | 0) == 34) {
          te = i;
          teFound = 1;
          ended = 2;
          return;
        }
        if ((i | 0) >= (te | 0)) {
          if ((teFound | 0) == 0) fail = 1; // past the input window
          ended = 2;
          return;
        }
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
        if ((o | 0) > (before | 0)) addErr(2, 0, 0);
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
    if ((((i | 0) < (te | 0)) | ((teFound | 0) == 0)) != 0) {
      // Stopped by a window: give up unless the quote surely never closes (the text's end is met first).
      if ((closesFrom(i) | 0) != 0) {
        fail = 1;
        return;
      }
      if ((teFound | 0) == 0) {
        fail = 1;
        return;
      }
    }
    // Never closes: a literal quote, and the rest read again as unquoted.
    line = openLine;
    addErr(3, 0, 0);
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
    need(64);
    H[o] = b;
    o = (o + 1) | 0;
  }

  // Starts the output.
  function begin() {
    o = OUT;
    flushed = 0;
  }

  // Writes out what is left in the window.
  function finish() {
    flushNow();
  }

  // Where the last text read ended (its closing quote).
  function textEnd() {
    return te | 0;
  }

  // The driver read more input itself (between texts): the window now ends at n.
  function setEnd(n) {
    n = n | 0;
    inEnd = n;
  }

  // Before a record: at least LOOK bytes ahead in the input window, unless the file is all read.
  function lookAhead() {
    var n = 0;
    if ((eof | 0) != 0) return;
    if ((((inEnd - p) | 0) | 0) >= (LOOK | 0)) return;
    n = refill(p | 0) | 0;
    if ((n | 0) < 0) {
      eof = 1;
      return;
    }
    inEnd = n;
    p = IN;
    te = n;
  }

  // Reads the text that starts at ts up to its closing quote, writing its records: 0, or -1 to give up.
  function answer(ts) {
    ts = ts | 0;
    var recStart = 0;
    var count = 0;
    var width = -1;
    var inX = 0;
    var oRow = 0;
    var xStart = 0;
    var xEnd = 0;
    var lastQ = 0;
    var lastStart = 0;
    var f = 0;
    var c = 0;
    var n = 0;
    te = inEnd;
    teFound = 0;
    p = ts;
    line = 1;
    e = ERR;
    xa = XA;
    rec = 0;
    fail = 0;
    if (((H[p] | 0) == 239) & ((H[(p + 1) | 0] | 0) == 187) & ((H[(p + 2) | 0] | 0) == 191)) {
      p = (p + 3) | 0;
    } else if ((((H[p] | 0) == 92) & ((H[(p + 1) | 0] | 0) == 117)) != 0) {
      c = uValue(p) | 0;
      if (((c | 0) == 65279) | ((c | 0) < 0)) return -1;
    }
    need(ROOM);
    p1 = (flushed + ((o - OUT) | 0)) | 0;
    o = cp(o, K_F1, 24) | 0;

    for (;;) {
      lookAhead();
      // Blank lines (LF or CRLF) are no records.
      while ((p | 0) < (te | 0)) {
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
      if ((p | 0) >= (te | 0)) break; // no closing quote in the input: the driver gives up
      if ((H[p] | 0) == 34) {
        te = p;
        teFound = 1;
        break;
      }

      need(ROOM);
      oMax = (OUTEND - 1024) | 0;
      recLine = line;
      recStart = o;
      if ((rec | 0) >= 2) {
        H[o] = 44;
        o = (o + 1) | 0;
      }
      H[o] = 91;
      o = (o + 1) | 0;
      count = 0;
      inX = 0;
      for (;;) {
        if ((count | 0) == (width | 0)) {
          // The cut fields of a long row go to XA.
          oRow = o;
          o = xa;
          xStart = xa;
          oMax = (XAEND - 1024) | 0;
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
      if ((count | 0) < (width | 0)) {
        n = (((width - count) | 0) * 3) | 0;
        if ((((o + n) | 0) + 16 | 0) > (OUTEND | 0)) return -1;
        for (f = count; (f | 0) < (width | 0); f = (f + 1) | 0) {
          H[o] = 44;
          H[(o + 1) | 0] = 34;
          H[(o + 2) | 0] = 34;
          o = (o + 3) | 0;
        }
        addErr(4, count, 0);
        if ((fail | 0) != 0) return -1;
      } else if ((count | 0) > (width | 0)) {
        addErr(5, xStart, (xEnd - xStart) | 0);
        if ((fail | 0) != 0) return -1;
        xa = xEnd;
      }
      H[o] = 93;
      o = (o + 1) | 0;
      if ((rec | 0) == 0) {
        // Room for the separator after the first record: `,"rows":[`, or a comma, or nothing.
        p2 = (flushed + ((o - OUT) | 0)) | 0;
        o = cp(o, K_F2B, 9) | 0;
      }
      rec = (rec + 1) | 0;
    }
    return 0;
  }

  // Finishes the answer of the text just read, now that its header flag is known.
  function close(header) {
    header = header | 0;
    var q = 0;
    var code = 0;
    var r = 0;
    var a = 0;
    var b = 0;
    var room = 0;
    var n = 0;
    if ((header | 0) != 0) {
      if ((rec | 0) == 0) patch(p1, K_E1, 24);
      else patch(p1, K_T1, 24);
    }
    if ((rec | 0) > 0) {
      if ((header | 0) != 0) patch(p2, K_T2, 9);
      else if ((rec | 0) >= 2) patch(p2, K_F2A, 9);
    }
    need(64);
    o = cp(o, K_ERRS, 12) | 0;
    for (q = ERR; (q | 0) < (e | 0); q = (q + 20) | 0) {
      code = H32[q >> 2] | 0;
      r = H32[(q + 8) >> 2] | 0;
      a = H32[(q + 12) >> 2] | 0;
      b = H32[(q + 16) >> 2] | 0;
      need(128);
      if ((q | 0) > (ERR | 0)) {
        H[o] = 44;
        o = (o + 1) | 0;
      }
      if ((code | 0) == 1) o = cp(o, K_STRAY, 26) | 0;
      else if ((code | 0) == 2) o = cp(o, K_JUNK, 28) | 0;
      else if ((code | 0) == 3) o = cp(o, K_UNT, 36) | 0;
      else if ((code | 0) == 4) o = cp(o, K_SHORT, 27) | 0;
      else o = cp(o, K_LONG, 26) | 0;
      o = putInt(o, H32[(q + 4) >> 2] | 0) | 0;
      o = cp(o, K_ROW, 7) | 0;
      if ((header | 0) != 0) {
        if ((r | 0) == 0) o = cp(o, K_NUL, 4) | 0;
        else o = putInt(o, (r - 1) | 0) | 0;
      } else {
        o = putInt(o, r) | 0;
      }
      if ((code | 0) == 4) {
        o = cp(o, K_FIELDS, 10) | 0;
        o = putInt(o, a) | 0;
        H[o] = 125;
        o = (o + 1) | 0;
      } else if ((code | 0) == 5) {
        o = cp(o, K_EXTRA, 10) | 0;
        while ((b | 0) > 0) {
          need(64);
          room = (OUTEND - o - 16) | 0;
          n = (b | 0) < (room | 0) ? b : room;
          o = cp(o, a, n) | 0;
          a = (a + n) | 0;
          b = (b - n) | 0;
        }
        need(64);
        H[o] = 93;
        H[(o + 1) | 0] = 125;
        o = (o + 2) | 0;
      } else {
        H[o] = 125;
        o = (o + 1) | 0;
      }
    }
    need(64);
    o = cp(o, K_CEND, 2) | 0;
  }

  return {
    begin: begin,
    putByte: putByte,
    setEnd: setEnd,
    answer: answer,
    textEnd: textEnd,
    close: close,
    finish: finish,
  };
}

const CONSTANTS = {
  K_F1: '{"columns":null,"rows":[',
  K_T1: '{"columns":' + ' '.repeat(13),
  K_E1: '{"columns":[],"rows":[' + ' '.repeat(2),
  K_T2: ',"rows":[',
  K_F2A: ',' + ' '.repeat(8),
  K_F2B: ' '.repeat(9),
  K_ERRS: '],"errors":[',
  K_CEND: ']}',
  K_STRAY: '{"code":"stray_cr","line":',
  K_JUNK: '{"code":"quote_junk","line":',
  K_UNT: '{"code":"unterminated_quote","line":',
  K_SHORT: '{"code":"short_row","line":',
  K_LONG: '{"code":"long_row","line":',
  K_ROW: ',"row":',
  K_NUL: 'null',
  K_FIELDS: ',"fields":',
  K_EXTRA: ',"extra":[',
};
// The lengths Csv takes them to have (its comments).
const LENGTHS = { K_F1: 24, K_T1: 24, K_E1: 24, K_T2: 9, K_F2A: 9, K_F2B: 9, K_ERRS: 12, K_CEND: 2, K_STRAY: 26,
  K_JUNK: 28, K_UNT: 36, K_SHORT: 27, K_LONG: 26, K_ROW: 7, K_NUL: 4, K_FIELDS: 10, K_EXTRA: 10 };

const KB = 1024;
const MB = 1024 * KB;
const STOP = 1 * KB;
const STOPQ = 2 * KB;
const ERR = 4 * KB;
const ERREND = ERR + 256 * KB;
const XA = ERREND;
const XAEND = XA + 256 * KB;
const OUT = XAEND;
// The windows: output written out before a record when less than a quarter is left; input refilled before a record
// when less than LOOK_AHEAD is left (a record, or the tail after a quote that never closes, longer than that makes
// the fast path give up). Tests pass a few KiB, so that every path through the windows is taken on small inputs.
const OUT_WINDOW = 512 * KB;
const IN_WINDOW = 512 * KB;
const LOOK_AHEAD = 64 * KB;

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
function fastPath(inPath, outPath, outWindow = OUT_WINDOW, inWindow = IN_WINDOW, look = LOOK_AHEAD) {
  const OUTEND = OUT + outWindow;
  const ROOM = outWindow >> 2;
  const IN = OUTEND + 4 * KB;
  const IN_MAX = IN + inWindow;
  // asm.js heaps are a power of two from 4 KiB (or a multiple of 16 MiB): the smallest that holds the windows.
  let size = 64 * KB;
  while (size < IN_MAX + 4 * KB) size *= 2;
  const heap = new ArrayBuffer(size);
  const u8 = new Uint8Array(heap);
  const offsets = {};
  let at = 0;
  for (const [name, s] of Object.entries(CONSTANTS)) {
    if (s.length !== LENGTHS[name]) throw new Error(`constant ${name} is not ${LENGTHS[name]} bytes`);
    offsets[name] = at;
    for (let i = 0; i < s.length; i++) u8[at + i] = s.charCodeAt(i);
    at += s.length;
  }
  for (let b = 0; b < 0x20; b++) u8[STOP + b] = u8[STOPQ + b] = 1;
  u8[STOP + 0x22] = u8[STOPQ + 0x22] = 1;
  u8[STOP + 0x5c] = u8[STOPQ + 0x5c] = 1;
  u8[STOP + 0x2c] = 1;

  const fd = fs.openSync(inPath, 'r');
  const n = fs.fstatSync(fd).size;
  let pos = 0; // file offset of the next byte to read
  let inEnd = IN; // end of the bytes in the input window
  // Moves u8[from, inEnd) to IN and reads more after it: the window's new end, or -1 when the file is all read.
  const refill = (from) => {
    if (pos >= n) return -1;
    u8.copyWithin(IN, from, inEnd);
    inEnd = IN + (inEnd - from);
    while (inEnd < IN_MAX && pos < n) {
      const r = fs.readSync(fd, u8, inEnd, Math.min(IN_MAX - inEnd, n - pos), pos);
      if (r <= 0) throw new Error('short read');
      inEnd += r;
      pos += r;
    }
    return inEnd;
  };

  const out = fs.openSync(outPath, 'w', 0o644);
  const flush = (start, len) => {
    let done = 0;
    while (done < len) done += fs.writeSync(out, u8, start + done, len - done);
  };
  const patchFile = (pos, src, len) => {
    let done = 0;
    while (done < len) done += fs.writeSync(out, u8, src + done, len - done, pos + done);
  };
  const m = Csv(
    globalThis,
    { flush, patchFile, refill, STOP, STOPQ, ERR, ERREND, XA, XAEND, OUT, OUTEND, ROOM, IN, LOOK: look, ...offsets },
    heap,
  );
  // At least k bytes from `at` in the window (unless the file is all read): where `at` is then.
  const ensure = (at, k) => {
    if (inEnd - at >= k || pos >= n) return at;
    m.setEnd(refill(at));
    return IN;
  };
  let ok = false;
  try {
    m.begin();
    m.setEnd(refill(IN));
    at = IN;
    if (u8[at++] !== 0x5b) return false;
    m.putByte(0x5b); // [
    if (u8[at] === 0x5d) {
      at++;
    } else {
      for (let c = 0; ; c++) {
        if (c > 0) m.putByte(0x2c); // , between answers
        at = ensure(at, 1024);
        if (!matches(u8, at, '{"id":"')) return false;
        at = stringEnd(u8, at + 7, inEnd);
        if (at < 0 || !matches(u8, at, '","input":{"text":"')) return false;
        if (m.answer(at + 19) !== 0) return false;
        // The text read up to its closing quote, which must be followed by its header flag.
        at = ensure(m.textEnd(), 1024);
        if (at >= inEnd || !matches(u8, at, '","header":')) return false;
        at += 11;
        let header;
        if (matches(u8, at, 'true}}')) {
          header = 1;
          at += 6;
        } else if (matches(u8, at, 'false}}')) {
          header = 0;
          at += 7;
        } else return false;
        m.close(header);
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
    if (at !== inEnd || pos !== n) return false;
    m.putByte(0x5d); // ]
    m.finish();
    ok = true;
    return true;
  } finally {
    fs.closeSync(fd);
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
