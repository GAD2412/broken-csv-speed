'use strict';
// fast.cjs: the harness program (main.ts only calls main()). Reads /input/cases.json and writes
// /output/answers.json, doing the CSV reading on the text's JSON-escaped bytes, never decoding it into JS strings.
//
// Why that is exact: in the JSON text every character the CSV reading looks at is ASCII and appears as `,` or as the
// escapes \" (quote), \n (LF) and \r (CR). Every other code unit is opaque: raw UTF-8 bytes or another escape
// (\\, \t, \uXXXX, ...), and JSON escapes one character at a time, so a field's escaped bytes copied through are the
// escaped form of the field's value. A raw `"` byte can only end a JSON string: it ends the text.
//
// The reader is a WebAssembly module (reader.cjs, assembled at run time by wasm.cjs): compiled ahead of its run, no
// time goes into warming up a JIT. Input and output go through 512 KiB windows in its memory, refilled and written
// out between records. The text comes before its "header" flag in the file, and the flag changes only the answer's
// first bytes, the separator after the first record and the errors' row numbers: so each text is read first, with
// fixed-size placeholders for those bytes (the padding is JSON whitespace) and errors kept as numbers, and the
// placeholders are filled in (in the window, or in the file if already written) and the errors written once the
// flag is read.
//
// Whenever the file is not of the expected shape, or a record does not fit a window, every case is answered again
// with run() from solve.js.

const fs = require('node:fs');
const v8 = require('node:v8');

// The house baseline's flag. (--single-threaded-gc set at run time can abort V8 when concurrent marking already ran,
// and this path hardly touches the JS heap, so it is left alone.)
v8.setFlagsFromString('--no-incremental-marking');
// Compile the module on this thread, not on helper threads, and with the baseline compiler only: on one CPU, a
// background optimising recompile of the hot functions costs about what it saves.
v8.setFlagsFromString('--wasm-num-compilation-tasks=0');
v8.setFlagsFromString('--liftoff-only');

const { build, expansionTable } = require('./reader.cjs');

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
// The lengths the reader takes them to have.
const LENGTHS = { K_F1: 24, K_T1: 24, K_E1: 24, K_T2: 9, K_F2A: 9, K_F2B: 9, K_ERRS: 12, K_CEND: 2, K_STRAY: 26,
  K_JUNK: 28, K_UNT: 36, K_SHORT: 27, K_LONG: 26, K_ROW: 7, K_NUL: 4, K_FIELDS: 10, K_EXTRA: 10 };

const KB = 1024;
const STOP = 1 * KB; // 256-byte table: plain content outside quotes is 0
const STOPQ = 2 * KB; // the same inside quotes (commas are content)
const TBL = 4 * KB; // the comma expansion shuffles (reader.cjs expansionTable), 4 KiB
const ERR = 8 * KB; // the current case's errors, 20 bytes each
const ERREND = ERR + 256 * KB;
const XA = ERREND; // the current case's cut fields (long rows)
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

/** Answers inPath into outPath with the wasm reader; false when the file must be answered by run() instead. */
function fastPath(inPath, outPath, outWindow = OUT_WINDOW, inWindow = IN_WINDOW, look = LOOK_AHEAD) {
  const OUTEND = OUT + outWindow;
  const ROOM = outWindow >> 2;
  const IN = OUTEND + 4 * KB;
  const IN_MAX = IN + inWindow;
  const pages = Math.ceil((IN_MAX + 64 * KB) / (64 * KB)); // the reader may read a few bytes past the window
  const memory = new WebAssembly.Memory({ initial: pages, maximum: pages });
  const u8 = new Uint8Array(memory.buffer);
  const K = {};
  let at = 0;
  for (const [name, s] of Object.entries(CONSTANTS)) {
    if (s.length !== LENGTHS[name]) throw new Error(`constant ${name} is not ${LENGTHS[name]} bytes`);
    K[name] = at;
    for (let i = 0; i < s.length; i++) u8[at + i] = s.charCodeAt(i);
    at += s.length;
  }
  for (let b = 0; b < 0x20; b++) u8[STOP + b] = u8[STOPQ + b] = 1;
  u8[STOP + 0x22] = u8[STOPQ + 0x22] = 1;
  u8[STOP + 0x5c] = u8[STOPQ + 0x5c] = 1;
  u8[STOP + 0x2c] = 1;
  expansionTable(u8, TBL);

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
  const bytes = build({ STOP, STOPQ, TBL, ERR, ERREND, XA, XAEND, OUT, OUTEND, ROOM, IN, LOOK: look, K, pages });
  const m = new WebAssembly.Instance(new WebAssembly.Module(bytes), { e: { mem: memory, flush, patchFile, refill } })
    .exports;
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

module.exports = { fastPath, slowPath, main };
