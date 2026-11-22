'use strict';
// fast.cjs: the harness program (main.ts only calls main()). Reads /input/cases.json and writes
// /output/answers.json, doing the CSV reading on the text's JSON-escaped bytes, never decoding it into JS strings.
//
// Why that is exact: in the JSON text every character the CSV reading looks at is ASCII and appears as `,` or as the
// escapes \" (quote), \n (LF) and \r (CR). Every other code unit is opaque: raw UTF-8 bytes or another escape
// (\\, \t, \uXXXX, ...), and JSON escapes one character at a time, so a field's escaped bytes copied through are the
// escaped form of the field's value. A raw `"` byte can only end a JSON string: it ends the text.
//
// The reader is a WebAssembly module. Its code is written below as data (part 2: a program in a small JSON notation,
// read with JSON.parse) and turned into the module's bytes at run time by one emitter function (part 1): compiled
// ahead of its run, no time goes into warming up a JIT, and building it costs little. Input and output go through
// 512 KiB windows in its memory, refilled and written out between records (part 3). The text comes before its
// "header" flag in the file, and the flag changes only the answer's first bytes, the separator after the first
// record and the errors' row numbers: so each text is read first, with fixed-size placeholders for those bytes (the
// padding is JSON whitespace) and errors kept as numbers, and the placeholders are filled in (in the window, or in
// the file if already written) and the errors written once the flag is read.
//
// One file on purpose: on this runtime a second module loaded with require() costs some 4 MB of fresh memory, and
// fresh memory is what the grader's sandbox makes expensive.
//
// Whenever the file is not of the expected shape, or a record does not fit a window, every case is answered again
// with run() from solve.js.

const fs = require('node:fs');
const v8 = require('node:v8');

// The house baseline's flag. (--single-threaded-gc set at run time can abort V8 when concurrent marking already ran,
// and this path hardly touches the JS heap, so it is left alone.)
v8.setFlagsFromString('--no-incremental-marking');
// Compile the module on this thread, with the baseline compiler only (Liftoff): on the grader, an optimising
// compile costs more than it saves (dev timing: 100 ms with it, 70 ms without).
v8.setFlagsFromString('--wasm-num-compilation-tasks=0');
v8.setFlagsFromString('--liftoff-only');

// ---------------------------------------------------------------------------------------------------------------
// Part 1: the emitter. The program is a list of functions {n: name, p: params, r: 1 if it returns an i32, l: i32
// locals, v: v128 locals, x: 1 if exported, b: body}. A body is a list of nodes:
//   a number: i32.const;  "$NAME": i32.const of a layout offset;  "name": local.get
//   ["=", x, e] local.set;  ["g", x] global.get;  ["g=", x, e] global.set;  ["inc", x, k], ["ginc", x, k]
//   ["+", a, b] and the other i32 operators (signed comparisons);  ["all", ...] / ["any", ...]: & / | of them
//   ["ld8" | "ld32" | "vld", addr, off], ["st8" | "st32" | "vst", addr, value, off], ["mcopy", dst, src, len]
//   ["splat", e], ["veq", a, b], ["vltu", a, b], ["vor", a, b], ["vand", a, b], ["bitmask", a], ["swizzle", a, b],
//   ["LOW8"], ["Q8"], ["specials", v], ["commas", v], ["expand", src, r, m] (macros, below)
//   ["if", cond, then, else], ["while", label, cond, body], ["loop", label, body] (for ever; "break" and "continue"
//   name the label), ["ret", e], ["call", f, ...args], ["drop", e], ["select", a, b, cond]

const I32 = 0x7f;
const V128 = 0x7b;

function uleb(n, out = []) {
  do {
    let b = n & 0x7f;
    n = Math.floor(n / 128);
    if (n > 0) b |= 0x80;
    out.push(b);
  } while (n > 0);
  return out;
}

function sleb(v, out = []) {
  // Values here fit 32 bits.
  let x = v | 0;
  for (;;) {
    const b = x & 0x7f;
    x >>= 7;
    if ((x === 0 && (b & 0x40) === 0) || (x === -1 && (b & 0x40) !== 0)) {
      out.push(b);
      return out;
    }
    out.push(b | 0x80);
  }
}

const str = (s) => {
  const b = [...Buffer.from(s, 'utf8')];
  return [...uleb(b.length), ...b];
};
const vec = (items) => [...uleb(items.length), ...items.flat()];
const section = (id, body) => (body.length === 0 ? [] : [id, ...uleb(body.length), ...body]);

// One-byte (or SIMD, 0xfd-prefixed) opcodes of the operators with operands only.
const OPS = {
  '+': [0x6a], '-': [0x6b], '*': [0x6c], '/u': [0x6e], '%u': [0x70], '&': [0x71], '|': [0x72], '<<': [0x74],
  '>>u': [0x76], '!': [0x45], '==': [0x46], '!=': [0x47], '<': [0x48], '>': [0x4a], '<=': [0x4c], '>=': [0x4e],
  clz: [0x67], ctz: [0x68], popcnt: [0x69], select: [0x1b],
  splat: [0xfd, 0x0f], veq: [0xfd, 0x23], vltu: [0xfd, 0x26], vor: [0xfd, 0x50], vand: [0xfd, 0x4e],
  bitmask: [0xfd, 0x64], swizzle: [0xfd, 0x0e],
};
const LOADS = { ld8: [0x2d], ld32: [0x28], vld: [0xfd, 0x00] };
const STORES = { st8: [0x3a], st32: [0x36], vst: [0xfd, 0x0b] };
const LOW8 = [0xfd, 0x0c, 255, 255, 255, 255, 255, 255, 255, 255, 0, 0, 0, 0, 0, 0, 0, 0];
const Q8 = [0xfd, 0x0c, 0, 0, 0, 0, 0, 0, 0, 0, 34, 0, 0, 0, 0, 0, 0, 0];
const MCOPY = [0xfc, 0x0a, 0, 0];

// The r (1 to 8) bytes at src, plain bytes and commas (m: the commas' bits), written at k with each comma as `","`,
// k moved past them. One shuffle when they fit 16 bytes (at most 4 commas); else byte by byte. It uses the caller's
// locals k, xs, xr, xm, xj, xb.
const expandMacro = (src, r, m) => [
  ['=', 'xs', src],
  ['=', 'xr', r],
  ['=', 'xm', m],
  ['if', ['<=', ['popcnt', 'xm'], 4], [
    ['vst', 'k', ['swizzle', ['vor', ['vand', ['vld', 'xs'], ['LOW8']], ['Q8']], ['vld', ['<<', 'xm', 4], '$TBL']]],
    ['=', 'k', ['+', 'k', ['+', 'xr', ['<<', ['popcnt', 'xm'], 1]]]],
  ], [
    ['=', 'xj', 0],
    ['while', 'J', ['<', 'xj', 'xr'], [
      ['=', 'xb', ['ld8', ['+', 'xs', 'xj']]],
      ['if', ['==', 'xb', 44], [['st8', 'k', 34], ['st8', 'k', 44, 1], ['st8', 'k', 34, 2], ['inc', 'k', 3]],
        [['st8', 'k', 'xb'], ['inc', 'k']]],
      ['inc', 'xj'],
    ]],
  ]],
];

/** The module's bytes for the program `prog` and layout L (offsets by name, pages). */
function assemble(prog, L) {
  const imports = [['flush', [I32, I32], null], ['patchFile', [I32, I32, I32], null], ['refill', [I32], I32]];
  const globalNames = ['o', 'oMax', 'e', 'xa', 'p', 'inEnd', 'eof', 'te', 'teFound', 'line', 'recLine', 'rec',
    'ended', 'fail', 'flushed', 'p1', 'p2'];
  const globalIndex = new Map(globalNames.map((n, i) => [n, i]));
  const funcIndex = new Map();
  imports.forEach(([n], i) => funcIndex.set(n, i));
  prog.forEach((f, i) => funcIndex.set(f.n, imports.length + i));
  const types = [];
  const typeOf = (params, result) => {
    const t = [0x60, ...vec(params.map((p) => [p])), ...vec(result == null ? [] : [[result]])];
    const key = t.join(',');
    let i = types.findIndex((x) => x.join(',') === key);
    if (i < 0) i = types.push(t) - 1;
    return i;
  };
  const constant = (s) => {
    const v = L[s.slice(1)];
    if (v === undefined) throw new Error(`no constant ${s}`);
    return v;
  };

  // The function bodies, emitted straight into one byte buffer (each body's size written in front of it after).
  X.L = L;
  X.funcIndex = funcIndex;
  X.globalIndex = globalIndex;
  X.constant = constant;
  bp = 0;
  for (let i = 0; i < prog.length; i++) {
    const f = prog[i];
    X.f = f;
    X.labels.length = 0;
    X.locals.clear();
    for (let j = 0; j < f.p.length; j++) X.locals.set(f.p[j], X.locals.size);
    for (let j = 0; j < f.l.length; j++) X.locals.set(f.l[j], X.locals.size);
    for (let j = 0; j < f.v.length; j++) X.locals.set(f.v[j], X.locals.size);
    const start = bp;
    bp += 5; // room for the size
    BUF[bp++] = (f.l.length > 0 ? 1 : 0) + (f.v.length > 0 ? 1 : 0);
    if (f.l.length > 0) {
      u(f.l.length);
      BUF[bp++] = I32;
    }
    if (f.v.length > 0) {
      u(f.v.length);
      BUF[bp++] = V128;
    }
    for (let j = 0; j < f.b.length; j++) E(f.b[j]);
    if (f.r) BUF[bp++] = 0x00;
    BUF[bp++] = 0x0b;
    const size = uleb(bp - start - 5);
    BUF.copyWithin(start + size.length, start + 5, bp);
    BUF.set(size, start);
    bp -= 5 - size.length;
  }

  const pages = L.pages;
  const importSec = [
    [...str('e'), ...str('mem'), 0x02, 0x01, ...uleb(pages), ...uleb(pages)],
    ...imports.map(([n, params, result]) => [...str('e'), ...str(n), 0x00, ...uleb(typeOf(params, result))]),
  ];
  const funcTypes = prog.map((f) => uleb(typeOf(f.p.map(() => I32), f.r ? I32 : null)));
  const globals = globalNames.map(() => [I32, 0x01, 0x41, 0x00, 0x0b]);
  const exports = prog.filter((f) => f.x).map((f) => [...str(f.n), 0x00, ...uleb(funcIndex.get(f.n))]);
  const count = uleb(prog.length);
  const head = [
    0x00, 0x61, 0x73, 0x6d, 0x01, 0x00, 0x00, 0x00,
    ...section(1, vec(types)),
    ...section(2, vec(importSec)),
    ...section(3, vec(funcTypes)),
    ...section(6, vec(globals)),
    ...section(7, vec(exports)),
    10, ...uleb(count.length + bp), ...count,
  ];
  const bytes = new Uint8Array(head.length + bp);
  bytes.set(head, 0);
  bytes.set(BUF.subarray(0, bp), head.length);
  return bytes;
}

// The emitter's state: the output buffer and position, and what the function being emitted names.
const BUF = new Uint8Array(1 << 16);
let bp = 0;
const X = { L: null, funcIndex: null, globalIndex: null, constant: null, f: null, labels: [], locals: new Map() };

function u(n) {
  do {
    let b = n & 0x7f;
    n = Math.floor(n / 128);
    if (n > 0) b |= 0x80;
    BUF[bp++] = b;
  } while (n > 0);
}

function s(v) {
  let x = v | 0;
  for (;;) {
    const b = x & 0x7f;
    x >>= 7;
    if ((x === 0 && (b & 0x40) === 0) || (x === -1 && (b & 0x40) !== 0)) {
      BUF[bp++] = b;
      return;
    }
    BUF[bp++] = b | 0x80;
  }
}

function bytesOut(a) {
  for (let i = 0; i < a.length; i++) BUF[bp++] = a[i];
}

function local(n) {
  const i = X.locals.get(n);
  if (i === undefined) throw new Error(`${X.f.n}: no local ${n}`);
  return i;
}

function depth(name) {
  const i = X.labels.lastIndexOf(name);
  if (i < 0) throw new Error(`${X.f.n}: no label ${name}`);
  return X.labels.length - 1 - i;
}

function list(nodes) {
  for (let i = 0; i < nodes.length; i++) E(nodes[i]);
}

// The value of a constant node (a number or "$NAME"), or null.
function constOf(n) {
  if (typeof n === 'number') return n;
  if (typeof n === 'string' && n.charCodeAt(0) === 36) return X.constant(n);
  return null;
}

// 16-bit mask of the bytes of local v equal to c (i8x16.eq of v and splat c, then bitmask), without the bitmask.
function eqSplat(v, c, cmp) {
  BUF[bp++] = 0x20;
  u(local(v));
  BUF[bp++] = 0x41;
  s(c);
  BUF[bp++] = 0xfd;
  BUF[bp++] = 0x0f;
  BUF[bp++] = 0xfd;
  BUF[bp++] = cmp;
}

function E(n) {
  if (typeof n === 'number') {
    BUF[bp++] = 0x41;
    s(n);
    return;
  }
  if (typeof n === 'string') {
    if (n.charCodeAt(0) === 36) {
      BUF[bp++] = 0x41;
      s(X.constant(n));
    } else {
      BUF[bp++] = 0x20;
      u(local(n));
    }
    return;
  }
  const op = n[0];
  // A sum or difference of constants is one constant.
  if ((op === '+' || op === '-') && n.length === 3) {
    const a = constOf(n[1]);
    const b = constOf(n[2]);
    if (a !== null && b !== null) {
      BUF[bp++] = 0x41;
      s(op === '+' ? a + b : a - b);
      return;
    }
  }
  const ops = OPS[op];
  if (ops !== undefined) {
    for (let i = 1; i < n.length; i++) E(n[i]);
    bytesOut(ops);
    return;
  }
  const load = LOADS[op];
  if (load !== undefined) {
    E(n[1]);
    bytesOut(load);
    BUF[bp++] = 0;
    u(n.length > 2 ? (typeof n[2] === 'string' ? X.constant(n[2]) : n[2]) : 0);
    return;
  }
  const store = STORES[op];
  if (store !== undefined) {
    E(n[1]);
    E(n[2]);
    bytesOut(store);
    BUF[bp++] = 0;
    u(n.length > 3 ? n[3] : 0);
    return;
  }
  switch (op) {
    case '=':
      E(n[2]);
      BUF[bp++] = 0x21;
      u(local(n[1]));
      return;
    case 'g':
      BUF[bp++] = 0x23;
      u(X.globalIndex.get(n[1]));
      return;
    case 'g=':
      E(n[2]);
      BUF[bp++] = 0x24;
      u(X.globalIndex.get(n[1]));
      return;
    case 'inc':
      BUF[bp++] = 0x20;
      u(local(n[1]));
      BUF[bp++] = 0x41;
      s(n.length > 2 ? n[2] : 1);
      BUF[bp++] = 0x6a;
      BUF[bp++] = 0x21;
      u(local(n[1]));
      return;
    case 'ginc':
      BUF[bp++] = 0x23;
      u(X.globalIndex.get(n[1]));
      BUF[bp++] = 0x41;
      s(n.length > 2 ? n[2] : 1);
      BUF[bp++] = 0x6a;
      BUF[bp++] = 0x24;
      u(X.globalIndex.get(n[1]));
      return;
    case 'all':
    case 'any':
      E(n[1]);
      for (let i = 2; i < n.length; i++) {
        E(n[i]);
        BUF[bp++] = op === 'all' ? 0x71 : 0x72;
      }
      return;
    case 'LOW8':
      bytesOut(LOW8);
      return;
    case 'Q8':
      bytesOut(Q8);
      return;
    case 'specials':
      // 16-bit mask of the bytes that end plain content: backslash, raw quote, control byte.
      eqSplat(n[1], 92, 0x23);
      eqSplat(n[1], 34, 0x23);
      BUF[bp++] = 0xfd;
      BUF[bp++] = 0x50;
      eqSplat(n[1], 32, 0x26);
      BUF[bp++] = 0xfd;
      BUF[bp++] = 0x50;
      BUF[bp++] = 0xfd;
      BUF[bp++] = 0x64;
      return;
    case 'commas':
      eqSplat(n[1], 44, 0x23);
      BUF[bp++] = 0xfd;
      BUF[bp++] = 0x64;
      return;
    case 'expand':
      list(expandMacro(n[1], n[2], n[3]));
      return;
    case 'mcopy':
      E(n[1]);
      E(n[2]);
      E(n[3]);
      bytesOut(MCOPY);
      return;
    case 'if':
      E(n[1]);
      BUF[bp++] = 0x04;
      BUF[bp++] = 0x40;
      X.labels.push(null);
      list(n[2]);
      if (n.length > 3) {
        BUF[bp++] = 0x05;
        list(n[3]);
      }
      X.labels.pop();
      BUF[bp++] = 0x0b;
      return;
    case 'while':
      // block L! (loop L (br_if L! (eqz cond)) body (br L))
      BUF[bp++] = 0x02;
      BUF[bp++] = 0x40;
      X.labels.push(`${n[1]}!`);
      BUF[bp++] = 0x03;
      BUF[bp++] = 0x40;
      X.labels.push(n[1]);
      E(n[2]);
      BUF[bp++] = 0x45;
      BUF[bp++] = 0x0d;
      BUF[bp++] = 1;
      list(n[3]);
      BUF[bp++] = 0x0c;
      BUF[bp++] = 0;
      BUF[bp++] = 0x0b;
      BUF[bp++] = 0x0b;
      X.labels.length -= 2;
      return;
    case 'loop':
      BUF[bp++] = 0x02;
      BUF[bp++] = 0x40;
      X.labels.push(`${n[1]}!`);
      BUF[bp++] = 0x03;
      BUF[bp++] = 0x40;
      X.labels.push(n[1]);
      list(n[2]);
      BUF[bp++] = 0x0c;
      BUF[bp++] = 0;
      BUF[bp++] = 0x0b;
      BUF[bp++] = 0x0b;
      X.labels.length -= 2;
      return;
    case 'break':
      BUF[bp++] = 0x0c;
      u(depth(`${n[1]}!`));
      return;
    case 'continue':
      BUF[bp++] = 0x0c;
      u(depth(n[1]));
      return;
    case 'ret':
      if (n.length > 1) E(n[1]);
      BUF[bp++] = 0x0f;
      return;
    case 'call': {
      for (let i = 2; i < n.length; i++) E(n[i]);
      const i = X.funcIndex.get(n[1]);
      if (i === undefined) throw new Error(`${X.f.n}: no function ${n[1]}`);
      BUF[bp++] = 0x10;
      u(i);
      return;
    }
    case 'drop':
      E(n[1]);
      BUF[bp++] = 0x1a;
      return;
    default:
      throw new Error(`${X.f.n}: no operator ${op}`);
  }
}

// ---------------------------------------------------------------------------------------------------------------
// Part 2: the reader. It reads the JSON-escaped text of one case at a time from the input window and writes its
// answer's bytes to the output window. Globals: o output position (in the window, or in XA while a long row's cut
// fields are read); oMax: field content may be written below it; e next error record; xa next free byte of XA; p
// input position; inEnd end of the bytes in the input window; eof 1 once the file is all read; te end of the current
// text (its closing raw quote once met, teFound; inEnd until then); line; recLine the line the current record starts
// on; rec records kept so far in this text (the header among them), the current record's index; ended how the last
// field ended (0 comma, 1 line break, 2 end of text); fail; flushed bytes written to the file so far (the window
// starts at that file offset); p1, p2 file offsets of the answer's first 24 bytes and of the 9 after its first record.
// Errors are 20 bytes each: code (1 stray_cr, 2 quote_junk, 3 unterminated_quote, 4 short_row with a its fields,
// 5 long_row with a, b where its cut fields are in XA and how many bytes), line, record, a, b.
// Lines starting with // are comments (taken out before JSON.parse).

const PROGRAM = `[
// cp(dst, src, len): dst + len.
{"n":"cp","p":["dst","src","len"],"r":1,"l":[],"v":[],"b":[["mcopy","dst","src","len"],["ret",["+","dst","len"]]]},
// putInt(dst, v): v in decimal at dst; the end.
{"n":"putInt","p":["dst","v"],"r":1,"l":["digits","x","k"],"v":[],"b":[
  ["=","digits",1],["=","x","v"],
  ["while","d",[">=","x",10],[["inc","digits"],["=","x",["/u","x",10]]]],
  ["=","k",["+","dst","digits"]],["=","x","v"],
  ["while","w",[">","k","dst"],[["=","k",["-","k",1]],["st8","k",["+",48,["%u","x",10]]],["=","x",["/u","x",10]]]],
  ["ret",["+","dst","digits"]]]},
{"n":"flushNow","p":[],"r":0,"l":[],"v":[],"b":[
  ["if",[">",["g","o"],"$OUT"],[
    ["call","flush","$OUT",["-",["g","o"],"$OUT"]],
    ["g=","flushed",["+",["g","flushed"],["-",["g","o"],"$OUT"]]]]],
  ["g=","o","$OUT"]]},
// Room for n more bytes in the window.
{"n":"need","p":["n"],"r":0,"l":[],"v":[],"b":[["if",[">",["g","o"],["-","$OUTEND","n"]],[["call","flushNow"]]]]},
// Writes [src, src + len) at output file offset pos: in the window if it is still there, else in the file.
{"n":"patch","p":["pos","src","len"],"r":0,"l":[],"v":[],"b":[
  ["if",[">=","pos",["g","flushed"]],
    [["drop",["call","cp",["+","$OUT",["-","pos",["g","flushed"]]],"src","len"]]],
    [["call","patchFile","pos","src","len"]]]]},
// An error of the current record.
{"n":"addErr","p":["code","a","b"],"r":0,"l":[],"v":[],"b":[
  ["if",[">",["g","e"],["-","$ERREND",32]],[["g=","fail",1],["ret"]]],
  ["st32",["g","e"],"code"],["st32",["g","e"],["g","recLine"],4],["st32",["g","e"],["g","rec"],8],
  ["st32",["g","e"],"a",12],["st32",["g","e"],"b",16],
  ["ginc","e",20]]},
{"n":"hexVal","p":["b"],"r":1,"l":[],"v":[],"b":[
  ["if",["all",[">=","b",48],["<=","b",57]],[["ret",["-","b",48]]]],
  ["if",["all",[">=","b",97],["<=","b",102]],[["ret",["-","b",87]]]],
  ["if",["all",[">=","b",65],["<=","b",70]],[["ret",["-","b",55]]]],
  ["ret",-1]]},
// The code unit a \\uXXXX at i spells, or -1 if it is malformed.
{"n":"uValue","p":["i"],"r":1,"l":["a","b","c","d"],"v":[],"b":[
  ["if",[">",["+","i",6],["g","te"]],[["ret",-1]]],
  ["=","a",["call","hexVal",["ld8","i",2]]],["=","b",["call","hexVal",["ld8","i",3]]],
  ["=","c",["call","hexVal",["ld8","i",4]]],["=","d",["call","hexVal",["ld8","i",5]]],
  ["if",["any",["<","a",0],["<","b",0],["<","c",0],["<","d",0]],[["ret",-1]]],
  ["ret",["|",["|",["<<","a",12],["<<","b",8]],["|",["<<","c",4],"d"]]]]},
// 1 when a \\uXXXX at i must not be copied through: malformed, or a comma, quote, CR or LF.
{"n":"badU","p":["i"],"r":1,"l":["v"],"v":[],"b":[
  ["=","v",["call","uValue","i"]],
  ["if",["<","v",0],[["ret",1]]],
  ["ret",["any",["==","v",10],["==","v",13],["==","v",34],["==","v",44]]]]},
// An unquoted field (or its rest) from p, content copied to o. Writes never outrun reads, so stopping the reads at
// lim keeps the writes below oMax.
{"n":"unq","p":[],"r":0,"l":["i","k","b","ch","lim"],"v":[],"b":[
  ["=","i",["g","p"]],["=","k",["g","o"]],
  ["=","lim",["+","i",["-",["g","oMax"],"k"]]],
  ["if",[">","lim",["g","te"]],[["=","lim",["g","te"]]]],
  ["while","L",["<","i","lim"],[
    ["=","b",["ld8","i"]],
    ["if",["!",["ld8","b","$STOP"]],[["st8","k","b"],["inc","k"],["inc","i"],["continue","L"]]],
    ["if",["==","b",44],[["g=","o","k"],["g=","p",["+","i",1]],["g=","ended",0],["ret"]]],
// The text's closing quote.
    ["if",["==","b",34],[["g=","te","i"],["g=","teFound",1],["g=","o","k"],["g=","p","i"],["g=","ended",2],["ret"]]],
    ["if",["!=","b",92],[["g=","fail",1],["ret"]]],
    ["=","ch",["ld8","i",1]],
    ["if",["==","ch",110],[["g=","o","k"],["g=","p",["+","i",2]],["ginc","line"],["g=","ended",1],["ret"]]],
    ["if",["==","ch",114],[
      ["if",["all",["==",["ld8","i",2],92],["==",["ld8","i",3],110]],
        [["g=","o","k"],["g=","p",["+","i",4]],["ginc","line"],["g=","ended",1],["ret"]]],
      ["call","addErr",1,0,0],["if",["g","fail"],[["ret"]]],
      ["inc","i",2],["continue","L"]]],
    ["if",["==","ch",117],[
      ["if",["call","badU","i"],[["g=","fail",1],["ret"]]],
      ["=","k",["call","cp","k","i",6]],["inc","i",6],["continue","L"]]],
    ["st8","k",92],["st8","k","ch",1],["inc","k",2],["inc","i",2]]],
  ["g=","o","k"],["g=","p","i"],
// The field does not fit the output window, or runs past the input window.
  ["if",["|",["<","i",["g","te"]],["!",["g","teFound"]]],[["g=","fail",1],["ret"]]],
  ["g=","ended",2]]},
// 1 when a quoted field's closing quote comes before the end of the text, reading from i inside it; 0 when the
// text ends first (teFound then set), or the input window does (teFound still 0).
{"n":"closesFrom","p":["i"],"r":1,"l":["b","ch"],"v":[],"b":[
  ["while","L",["<","i",["g","te"]],[
    ["=","b",["ld8","i"]],
    ["if",["==","b",34],[["g=","te","i"],["g=","teFound",1],["ret",0]]],
    ["if",["==","b",92],[
      ["=","ch",["ld8","i",1]],
      ["if",["==","ch",34],[
        ["if",["all",["==",["ld8","i",2],92],["==",["ld8","i",3],34]],[["inc","i",4],["continue","L"]]],
        ["ret",1]]],
      ["if",["==","ch",117],[["inc","i",6]],[["inc","i",2]]],
      ["continue","L"]]],
    ["inc","i"]]],
  ["ret",0]]},
// A quoted field whose opening \\" is at p.
{"n":"quo","p":[],"r":0,"l":["i","k","b","ch","lim","open","openLine","start","before","s"],"v":["v","c92","c34","c32"],"b":[
// The comparison vectors, made once a call (the baseline compiler would make them anew at each use).
  ["=","c92",["splat",92]],["=","c34",["splat",34]],["=","c32",["splat",32]],
  ["=","open",["g","p"]],["=","openLine",["g","line"]],["=","start",["g","o"]],
  ["=","i",["+",["g","p"],2]],["=","k",["g","o"]],
  ["=","lim",["+","i",["-",["g","oMax"],"k"]]],
  ["if",[">","lim",["g","te"]],[["=","lim",["g","te"]]]],
  ["while","L",["<","i","lim"],[
// 16 bytes at a time up to the next backslash, raw quote or control byte (commas are content here).
    ["if",["<=",["+","i",16],"lim"],[
      ["=","v",["vld","i"]],["vst","k","v"],
      ["=","s",["ctz",["|",["bitmask",["vor",["vor",["veq","v","c92"],["veq","v","c34"]],["vltu","v","c32"]]],65536]]],
      ["=","i",["+","i","s"]],["=","k",["+","k","s"]],
      ["if",["==","s",16],[["continue","L"]]]]],
    ["=","b",["ld8","i"]],
    ["if",["!",["ld8","b","$STOPQ"]],[["st8","k","b"],["inc","k"],["inc","i"],["continue","L"]]],
// The text ends inside the quotes.
    ["if",["==","b",34],[["g=","te","i"],["g=","teFound",1],["break","L"]]],
    ["if",["!=","b",92],[["g=","fail",1],["ret"]]],
    ["=","ch",["ld8","i",1]],
    ["if",["==","ch",34],[
// "" inside quotes: one quote.
      ["if",["all",["==",["ld8","i",2],92],["==",["ld8","i",3],34]],
        [["st8","k",92],["st8","k",34,1],["inc","k",2],["inc","i",4],["continue","L"]]],
// The closing quote.
      ["inc","i",2],["g=","o","k"],["g=","p","i"],["=","b",["ld8","i"]],
      ["if",["==","b",34],[["g=","te","i"],["g=","teFound",1],["g=","ended",2],["ret"]]],
      ["if",[">=","i",["g","te"]],[["if",["!",["g","teFound"]],[["g=","fail",1]]],["g=","ended",2],["ret"]]],
      ["if",["==","b",44],[["g=","p",["+","i",1]],["g=","ended",0],["ret"]]],
      ["if",["==","b",92],[
        ["=","ch",["ld8","i",1]],
        ["if",["==","ch",110],[["g=","p",["+","i",2]],["ginc","line"],["g=","ended",1],["ret"]]],
        ["if",["all",["==","ch",114],["==",["ld8","i",2],92],["==",["ld8","i",3],110]],
          [["g=","p",["+","i",4]],["ginc","line"],["g=","ended",1],["ret"]]]]],
// Junk after the closing quote, appended; quote_junk if anything was kept.
      ["=","before",["g","o"]],["call","unq"],["if",["g","fail"],[["ret"]]],
      ["if",[">",["g","o"],"before"],[["call","addErr",2,0,0]]],
      ["ret"]]],
// CRLF or a lone CR inside quotes: one LF.
    ["if",["==","ch",114],[
      ["st8","k",92],["st8","k",110,1],["inc","k",2],["ginc","line"],
      ["if",["all",["==",["ld8","i",2],92],["==",["ld8","i",3],110]],[["inc","i",4]],[["inc","i",2]]],
      ["continue","L"]]],
    ["if",["==","ch",110],[["ginc","line"]]],
    ["if",["==","ch",117],[
      ["if",["call","badU","i"],[["g=","fail",1],["ret"]]],
      ["=","k",["call","cp","k","i",6]],["inc","i",6],["continue","L"]]],
    ["st8","k",92],["st8","k","ch",1],["inc","k",2],["inc","i",2]]],
// Stopped by a window: give up unless the quote surely never closes (the text's end is met first).
  ["if",["|",["<","i",["g","te"]],["!",["g","teFound"]]],[
    ["if",["call","closesFrom","i"],[["g=","fail",1],["ret"]]],
    ["if",["!",["g","teFound"]],[["g=","fail",1],["ret"]]]]],
// Never closes: a literal quote, and the rest read again as unquoted.
  ["g=","line","openLine"],
  ["call","addErr",3,0,0],["if",["g","fail"],[["ret"]]],
  ["st8","start",92],["st8","start",34,1],
  ["g=","o",["+","start",2]],["g=","p",["+","open",2]],
  ["call","unq"]]},
// Appends one byte to the output (the brackets and commas between cases).
{"n":"putByte","p":["b"],"r":0,"l":[],"v":[],"x":1,"b":[["call","need",64],["st8",["g","o"],"b"],["ginc","o"]]},
{"n":"begin","p":[],"r":0,"l":[],"v":[],"x":1,"b":[["g=","o","$OUT"],["g=","flushed",0]]},
{"n":"finish","p":[],"r":0,"l":[],"v":[],"x":1,"b":[["call","flushNow"]]},
{"n":"textEnd","p":[],"r":1,"l":[],"v":[],"x":1,"b":[["ret",["g","te"]]]},
// The driver read more input itself (between texts): the window now ends at n.
{"n":"setEnd","p":["n"],"r":0,"l":[],"v":[],"x":1,"b":[["g=","inEnd","n"]]},
// Before a record: at least LOOK bytes ahead in the input window, unless the file is all read.
{"n":"lookAhead","p":[],"r":0,"l":["n"],"v":[],"b":[
  ["if",["g","eof"],[["ret"]]],
  ["if",[">=",["-",["g","inEnd"],["g","p"]],"$LOOK"],[["ret"]]],
  ["=","n",["call","refill",["g","p"]]],
  ["if",["<","n",0],[["g=","eof",1],["ret"]]],
  ["g=","inEnd","n"],["g=","p","$IN"],["g=","te","n"]]},
// Reads the text that starts at ts up to its closing quote, writing its records: 0, or -1 to give up.
{"n":"answer","p":["ts"],"r":1,"x":1,"v":["v","c92","c34","c32","c44","lo8","q8"],"l":["recStart","count","width",
  "inX","oRow","xStart","xEnd","lastQ","lastStart","f","ch","n","i","k","b","lim","fs","s","pm","nc","tl","q","kk",
  "p0","p1","xs","xr","xm","xj","xb"],"b":[
// The comparison and shuffle vectors, made once a call (the baseline compiler would make them anew at each use).
  ["=","c92",["splat",92]],["=","c34",["splat",34]],["=","c32",["splat",32]],["=","c44",["splat",44]],
  ["=","lo8",["LOW8"]],["=","q8",["Q8"]],
  ["=","width",-1],["g=","te",["g","inEnd"]],["g=","teFound",0],["g=","p","ts"],["g=","line",1],
  ["g=","e","$ERR"],["g=","xa","$XA"],["g=","rec",0],["g=","fail",0],
  ["if",["all",["==",["ld8",["g","p"]],239],["==",["ld8",["g","p"],1],187],["==",["ld8",["g","p"],2],191]],
    [["g=","p",["+",["g","p"],3]]],
    [["if",["all",["==",["ld8",["g","p"]],92],["==",["ld8",["g","p"],1],117]],[
      ["=","ch",["call","uValue",["g","p"]]],
      ["if",["|",["==","ch",65279],["<","ch",0]],[["ret",-1]]]]]]],
  ["call","need","$ROOM"],
  ["g=","p1",["+",["g","flushed"],["-",["g","o"],"$OUT"]]],
  ["g=","o",["call","cp",["g","o"],"$K_F1",24]],
  ["loop","R",[
    ["call","lookAhead"],
// Blank lines (LF or CRLF) are no records.
    ["while","B",["<",["g","p"],["g","te"]],[
      ["if",["!=",["ld8",["g","p"]],92],[["break","B"]]],
      ["=","ch",["ld8",["g","p"],1]],
      ["if",["==","ch",110],[["g=","p",["+",["g","p"],2]],["ginc","line"],["continue","B"]]],
      ["if",["all",["==","ch",114],["==",["ld8",["g","p"],2],92],["==",["ld8",["g","p"],3],110]],
        [["g=","p",["+",["g","p"],4]],["ginc","line"],["continue","B"]]],
      ["break","B"]]],
// No closing quote in the input: the driver gives up.
    ["if",[">=",["g","p"],["g","te"]],[["break","R"]]],
    ["if",["==",["ld8",["g","p"]],34],[["g=","te",["g","p"]],["g=","teFound",1],["break","R"]]],
    ["call","need","$ROOM"],
    ["g=","oMax",["-","$OUTEND",1024]],
    ["g=","recLine",["g","line"]],
    ["=","recStart",["g","o"]],
    ["if",[">=",["g","rec"],2],[["st8",["g","o"],44],["ginc","o"]]],
    ["st8",["g","o"],91],["ginc","o"],
    ["=","count",0],["=","inX",0],
    ["loop","F",[
// The cut fields of a long row go to XA.
      ["if",["==","count","width"],
        [["=","oRow",["g","o"]],["g=","o",["g","xa"]],["=","xStart",["g","xa"]],["g=","oMax",["-","$XAEND",1024]],["=","inX",1]],
        [["if",[">","count",0],[["st8",["g","o"],44],["ginc","o"]]]]],
      ["if",[">",["g","o"],["g","oMax"]],[["ret",-1]]],
      ["st8",["g","o"],34],["ginc","o"],
      ["=","lastStart",["g","o"]],
      ["=","lastQ",["all",["==",["ld8",["g","p"]],92],["==",["ld8",["g","p"],1],34]]],
      ["if","lastQ",[["call","quo"]],[
// Most of a row: plain fields. 16 bytes at a time: the bytes up to the first backslash, raw quote or control
// byte, with every comma among them written as "," (each one ends a field), as long as no comma there starts a
// long row's cut fields. fs: where the content of the field now read starts; i, k: input and output positions;
// tl: the last block start in the text.
        ["=","fs",["g","o"]],["=","i",["g","p"]],["=","k",["g","o"]],["=","tl",["-",["g","te"],16]],
        ["loop","V",[
          ["if",[">","i","tl"],[["break","V"]]],
          ["if",[">","k",["-","$OUTEND",1088]],[["break","V"]]],
          ["=","v",["vld","i"]],
          ["=","s",["ctz",["|",["bitmask",["vor",["vor",["veq","v","c92"],["veq","v","c34"]],["vltu","v","c32"]]],65536]]],
          ["=","pm",["&",["bitmask",["veq","v","c44"]],["-",["<<",1,"s"],1]]],
          ["=","p0",["popcnt",["&","pm",255]]],["=","p1",["popcnt",[">>u","pm",8]]],
          ["=","nc",["+","p0","p1"]],
// The common block: 16 plain bytes and commas, at most 4 commas in each half, no long-row boundary.
          ["if",["all",["==","s",16],["<=","p0",4],["<=","p1",4],["|",["<","width",0],["<",["+","count","nc"],"width"]]],[
            ["vst","k",["swizzle",["vor",["vand","v","lo8"],"q8"],["vld",["<<",["&","pm",255],4],"$TBL"]]],
            ["=","k",["+","k",["+",8,["<<","p0",1]]]],
            ["vst","k",["swizzle",["vor",["vand",["vld","i",8],"lo8"],"q8"],["vld",["<<",[">>u","pm",8],4],"$TBL"]]],
            ["=","k",["+","k",["+",8,["<<","p1",1]]]],
            ["if","nc",[["=","count",["+","count","nc"]],["=","fs",["-","k",["-",16,["-",32,["clz","pm"]]]]]]],
            ["inc","i",16],["continue","V"]]],
          ["if",["&",[">=","width",0],[">=",["+","count","nc"],"width"]],[["break","V"]]],
          ["expand","i",["select","s",8,["<","s",8]],["&","pm",255]],
          ["if",[">","s",8],[["expand",["+","i",8],["-","s",8],[">>u","pm",8]]]],
          ["if","nc",[["=","count",["+","count","nc"]],["=","fs",["-","k",["-","s",["-",32,["clz","pm"]]]]]]],
          ["=","i",["+","i","s"]],
          ["if",["<","s",16],[
// A quoted field opening right here, at a field's start: taken in this loop too when nothing in it needs care
// and its closing quote is followed by a comma (that comma not starting cut fields). Anything else is left as it
// is, for the code below.
            ["if",["all",["==","k","fs"],["==",["ld8","i"],92],["==",["ld8","i",1],34],
                ["|",["<","width",0],["<",["+","count",1],"width"]]],[
              ["=","q",["+","i",2]],["=","kk","k"],
              ["loop","Q",[
                ["if",[">","q","tl"],[["break","V"]]],
                ["if",[">","kk",["-","$OUTEND",1088]],[["break","V"]]],
                ["=","v",["vld","q"]],["vst","kk","v"],
                ["=","s",["ctz",["|",["bitmask",["vor",["vor",["veq","v","c92"],["veq","v","c34"]],["vltu","v","c32"]]],65536]]],
                ["=","q",["+","q","s"]],["=","kk",["+","kk","s"]],
                ["if",["<","s",16],[["break","Q"]]]]],
              ["if",["all",["==",["ld8","q"],92],["==",["ld8","q",1],34],["==",["ld8","q",2],44]],[
                ["st8","kk",34],["st8","kk",44,1],["st8","kk",34,2],
                ["=","k",["+","kk",3]],["=","fs","k"],["=","i",["+","q",3]],["inc","count"],
                ["continue","V"]]]]],
            ["break","V"]]]]],
        ["g=","p","i"],["g=","o","k"]]],
// A comma just read starts a quoted field.
      ["if",["&",["!","lastQ"],["all",["==",["g","o"],"fs"],["==",["ld8",["g","p"]],92],["==",["ld8",["g","p"],1],34]]],
        [["=","lastQ",1],["call","quo"]],
        [["if",["!","lastQ"],[
// Plain bytes, then a comma or the end of a row (\\n or \\r\\n). Copied here; anything else goes on in unq().
          ["=","i",["g","p"]],["=","k",["g","o"]],
          ["=","lim",["+","i",["-",["g","oMax"],"k"]]],
          ["if",[">","lim",["g","te"]],[["=","lim",["g","te"]]]],
          ["while","P",["<","i","lim"],[
            ["=","b",["ld8","i"]],["if",["ld8","b","$STOP"],[["break","P"]]],
            ["st8","k","b"],["inc","k"],["inc","i"]]],
          ["g=","o","k"],["g=","p","i"],
          ["if",["all",["<","i","lim"],["==",["ld8","i"],44]],[["g=","p",["+","i",1]],["g=","ended",0]],[
            ["if",["all",["<","i","lim"],["==",["ld8","i"],92],["==",["ld8","i",1],110]],
              [["g=","p",["+","i",2]],["ginc","line"],["g=","ended",1]],
              [["if",["all",["<","i","lim"],["==",["ld8","i"],92],["==",["ld8","i",1],114],["==",["ld8","i",2],92],
                  ["==",["ld8","i",3],110]],
                [["g=","p",["+","i",4]],["ginc","line"],["g=","ended",1]],
                [["call","unq"]]]]]]]]]]],
      ["if",["g","fail"],[["ret",-1]]],
      ["st8",["g","o"],34],["ginc","o"],["inc","count"],
      ["if",["g","ended"],[["break","F"]]]]],
    ["if","inX",[["=","xEnd",["g","o"]],["g=","o","oRow"]]],
// A line of stray CRs alone leaves nothing: no record (its errors stay).
    ["if",["all",["==","count",1],["!","lastQ"],["==",["g","o"],["+","lastStart",1]]],
      [["g=","o","recStart"],["continue","R"]]],
    ["if",["<","width",0],[["=","width","count"]]],
    ["if",["<","count","width"],[
      ["=","n",["*",["-","width","count"],3]],
      ["if",[">",["+",["+",["g","o"],"n"],16],"$OUTEND"],[["ret",-1]]],
      ["=","f","count"],
      ["while","Pad",["<","f","width"],[
        ["st8",["g","o"],44],["st8",["g","o"],34,1],["st8",["g","o"],34,2],["ginc","o",3],["inc","f"]]],
      ["call","addErr",4,"count",0],["if",["g","fail"],[["ret",-1]]]],
     [["if",[">","count","width"],[
       ["call","addErr",5,"xStart",["-","xEnd","xStart"]],["if",["g","fail"],[["ret",-1]]],
       ["g=","xa","xEnd"]]]]],
    ["st8",["g","o"],93],["ginc","o"],
// Room for the separator after the first record: ,"rows":[ or a comma, or nothing.
    ["if",["!",["g","rec"]],[
      ["g=","p2",["+",["g","flushed"],["-",["g","o"],"$OUT"]]],
      ["g=","o",["call","cp",["g","o"],"$K_F2B",9]]]],
    ["ginc","rec"]]],
  ["ret",0]]},
// Finishes the answer of the text just read, now that its header flag is known.
{"n":"close","p":["header"],"r":0,"x":1,"l":["q","code","r","a","b","room","n"],"v":[],"b":[
  ["if","header",[["if",["!",["g","rec"]],[["call","patch",["g","p1"],"$K_E1",24]],[["call","patch",["g","p1"],"$K_T1",24]]]]],
  ["if",[">",["g","rec"],0],[["if","header",[["call","patch",["g","p2"],"$K_T2",9]],
    [["if",[">=",["g","rec"],2],[["call","patch",["g","p2"],"$K_F2A",9]]]]]]],
  ["call","need",64],
  ["g=","o",["call","cp",["g","o"],"$K_ERRS",12]],
  ["=","q","$ERR"],
  ["while","E",["<","q",["g","e"]],[
    ["=","code",["ld32","q"]],["=","r",["ld32","q",8]],["=","a",["ld32","q",12]],["=","b",["ld32","q",16]],
    ["call","need",128],
    ["if",[">","q","$ERR"],[["st8",["g","o"],44],["ginc","o"]]],
    ["if",["==","code",1],[["g=","o",["call","cp",["g","o"],"$K_STRAY",26]]],
     [["if",["==","code",2],[["g=","o",["call","cp",["g","o"],"$K_JUNK",28]]],
      [["if",["==","code",3],[["g=","o",["call","cp",["g","o"],"$K_UNT",36]]],
       [["if",["==","code",4],[["g=","o",["call","cp",["g","o"],"$K_SHORT",27]]],
        [["g=","o",["call","cp",["g","o"],"$K_LONG",26]]]]]]]]]],
    ["g=","o",["call","putInt",["g","o"],["ld32","q",4]]],
    ["g=","o",["call","cp",["g","o"],"$K_ROW",7]],
    ["if","header",
      [["if",["!","r"],[["g=","o",["call","cp",["g","o"],"$K_NUL",4]]],[["g=","o",["call","putInt",["g","o"],["-","r",1]]]]]],
      [["g=","o",["call","putInt",["g","o"],"r"]]]],
    ["if",["==","code",4],[
      ["g=","o",["call","cp",["g","o"],"$K_FIELDS",10]],["g=","o",["call","putInt",["g","o"],"a"]],
      ["st8",["g","o"],125],["ginc","o"]],
     [["if",["==","code",5],[
       ["g=","o",["call","cp",["g","o"],"$K_EXTRA",10]],
       ["while","X",[">","b",0],[
         ["call","need",64],
         ["=","room",["-",["-","$OUTEND",["g","o"]],16]],
         ["=","n",["select","b","room",["<","b","room"]]],
         ["g=","o",["call","cp",["g","o"],"a","n"]],
         ["=","a",["+","a","n"]],["=","b",["-","b","n"]]]],
       ["call","need",64],
       ["st8",["g","o"],93],["st8",["g","o"],125,1],["ginc","o",2]],
      [["st8",["g","o"],125],["ginc","o"]]]]],
    ["inc","q",20]]],
  ["call","need",64],
  ["g=","o",["call","cp",["g","o"],"$K_CEND",2]]]}
]`;

/**
 * The expansion table, written into t at `at`: for each 8-bit mask of commas among 8 bytes, the shuffle (16 lane
 * indices into the LOW8|Q8 source) that writes the bytes with each comma as `","` (only for masks of at most 4
 * commas, which fit 16 bytes).
 */
function expansionTable(t, at) {
  for (let m = 0; m < 256; m++) {
    let n = 0;
    for (let j = 0; j < 8; j++) if ((m >> j) & 1) n++;
    if (n > 4) continue;
    let k = at + m * 16;
    for (let j = 0; j < 8; j++) {
      if ((m >> j) & 1) {
        t[k++] = 8;
        t[k++] = j;
        t[k++] = 8;
      } else t[k++] = j;
    }
    for (const end = at + m * 16 + 16; k < end; ) t[k++] = 0x80;
  }
}

/** The module's bytes for layout L: offsets (STOP, STOPQ, TBL, ERR, ERREND, XA, XAEND, OUT, OUTEND, ROOM, IN, LOOK
 * and the constants' K_...) and pages. */
function build(L) {
  return assemble(JSON.parse(PROGRAM.replace(/^\s*\/\/.*$/gm, '')), L);
}

// ---------------------------------------------------------------------------------------------------------------
// Part 3: the driver.

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
const TBL = 4 * KB; // the comma expansion shuffles (expansionTable), 4 KiB
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
  const L = { STOP, STOPQ, TBL, ERR, ERREND, XA, XAEND, OUT, OUTEND, ROOM, IN, LOOK: look, pages };
  let at = 0;
  for (const [name, s] of Object.entries(CONSTANTS)) {
    if (s.length !== LENGTHS[name]) throw new Error(`constant ${name} is not ${LENGTHS[name]} bytes`);
    L[name] = at;
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
  const m = new WebAssembly.Instance(new WebAssembly.Module(build(L)), { e: { mem: memory, flush, patchFile, refill } })
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

module.exports = { fastPath, slowPath, main, build };
