'use strict';
// reader.cjs: the CSV reader of fast.cjs as a WebAssembly module, written with wasm.cjs. It reads the JSON-escaped
// text of one case at a time from the input window and writes its answer's bytes to the output window (fast.cjs's
// header says why that is exact and how the windows and the header flag work). Every layout offset is known when the
// module is built, so it is written into the code as a constant.

const W = require('./wasm.cjs');
const {
  I32, V128, get, set, gget, gset, c, add, sub, mul, divU, remU, and, or, shl, shrU, eqz, eq, ne, lt, gt, le, ge,
  clz, ctz, popcnt, select, ld8, st8, mcopy, vld, vst, vconst, splat8, veq8, vltU8, vor, vand, vbitmask8, vswizzle,
  If, While, Continue, Break, Forever, Ret, call, drop, assemble,
} = W;

// Lanes 0-7 kept, and a quote in lane 8: what the expansion shuffles pick from.
const LOW8 = vconst([255, 255, 255, 255, 255, 255, 255, 255, 0, 0, 0, 0, 0, 0, 0, 0]);
const Q8 = vconst([0, 0, 0, 0, 0, 0, 0, 0, 34, 0, 0, 0, 0, 0, 0, 0]);
// 16-bit mask of the bytes of v that end plain content: backslash, raw quote, control byte (and, outside quotes,
// commas, kept apart).
const specials = (v) => vbitmask8(vor(vor(veq8(v, splat8(c(92))), veq8(v, splat8(c(34)))), vltU8(v, splat8(c(32)))));
const commas = (v) => vbitmask8(veq8(v, splat8(c(44))));

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

const inc = (n, k = 1) => set(n, add(get(n), c(k)));
const ginc = (n, k = 1) => gset(n, add(gget(n), c(k)));
const all = (...conds) => conds.reduce((a, b) => and(a, b));
const any = (...conds) => conds.reduce((a, b) => or(a, b));
const at = (a, k) => ld8(a, k); // byte at address a + k

/**
 * The module's bytes for layout L: {STOP, STOPQ, ERR, ERREND, XA, XAEND, OUT, OUTEND, ROOM, IN, LOOK, K: {name:
 * offset}, pages}.
 */
function build(L) {
  const K = L.K;
  const globals = [
    ['o', 0], // output position (in the window, or in XA while cut fields are read)
    ['oMax', 0], // field content may be written below this
    ['e', 0], // next error record
    ['xa', 0], // next free byte of XA
    ['p', 0], // input position
    ['inEnd', 0], // end of the bytes in the input window
    ['eof', 0], // 1 once the whole file has been read
    ['te', 0], // end of the current text: its closing raw quote once met (teFound), inEnd until then
    ['teFound', 0],
    ['line', 0],
    ['recLine', 0], // the line the current record starts on
    ['rec', 0], // records kept so far in this text (the header among them): the current record's index
    ['ended', 0], // how the last field ended: 0 comma, 1 line break, 2 end of text
    ['fail', 0],
    ['flushed', 0], // bytes written to the file so far: the window starts at this file offset
    ['p1', 0], // file offset of the answer's first 24 bytes
    ['p2', 0], // file offset of the 9 bytes after the first record
  ];
  const funcs = [];
  const fn = (name, params, result, locals, body, exp = false) =>
    funcs.push({ name, params: params.map((n) => [n, I32]), result, locals, body, export: exp });
  const i32s = (...names) => names.map((n) => [n, I32]);

  // The r (1 to 8) bytes at src, plain bytes and commas (m: the commas' bits), written at k with each comma as
  // `","`, k moved past them. One shuffle when they fit 16 bytes (at most 4 commas); else byte by byte. Written
  // into the caller (a call costs a spill of every local in the baseline compiler); uses its locals k, xs, xr, xm,
  // xj, xb.
  const expand = (src, r, m) => [
    set('xs', src),
    set('xr', r),
    set('xm', m),
    If(le(popcnt(get('xm')), c(4)), [
      vst(get('k'), vswizzle(vor(vand(vld(get('xs')), LOW8), Q8), vld(shl(get('xm'), c(4)), L.TBL))),
      set('k', add(get('k'), add(get('xr'), shl(popcnt(get('xm')), c(1))))),
    ], [
      set('xj', c(0)),
      While('J', lt(get('xj'), get('xr')), [
        set('xb', ld8(add(get('xs'), get('xj')))),
        If(eq(get('xb'), c(44)), [
          st8(get('k'), c(34)),
          st8(get('k'), c(44), 1),
          st8(get('k'), c(34), 2),
          inc('k', 3),
        ], [st8(get('k'), get('xb')), inc('k')]),
        inc('xj'),
      ]),
    ]),
  ];

  // cp(dst, src, len): dst + len.
  fn('cp', ['dst', 'src', 'len'], I32, [], [mcopy(get('dst'), get('src'), get('len')), Ret(add(get('dst'), get('len')))]);
  // putInt(dst, v): v in decimal at dst; the end.
  fn('putInt', ['dst', 'v'], I32, i32s('digits', 'x', 'k'), [
    set('digits', c(1)),
    set('x', get('v')),
    While('d', ge(get('x'), c(10)), [inc('digits'), set('x', divU(get('x'), c(10)))]),
    set('k', add(get('dst'), get('digits'))),
    set('x', get('v')),
    While('w', gt(get('k'), get('dst')), [
      set('k', sub(get('k'), c(1))),
      st8(get('k'), add(c(48), remU(get('x'), c(10)))),
      set('x', divU(get('x'), c(10))),
    ]),
    Ret(add(get('dst'), get('digits'))),
  ]);
  fn('flushNow', [], null, [], [
    If(gt(gget('o'), c(L.OUT)), [
      call('flush', c(L.OUT), sub(gget('o'), c(L.OUT))),
      gset('flushed', add(gget('flushed'), sub(gget('o'), c(L.OUT)))),
    ]),
    gset('o', c(L.OUT)),
  ]);
  // Room for n more bytes in the window.
  fn('need', ['n'], null, [], [If(gt(gget('o'), sub(c(L.OUTEND), get('n'))), [call('flushNow')])]);
  // Writes [src, src + len) at output file offset `pos`: in the window if it is still there, else in the file.
  fn('patch', ['pos', 'src', 'len'], null, [], [
    If(
      ge(get('pos'), gget('flushed')),
      [drop(call('cp', add(c(L.OUT), sub(get('pos'), gget('flushed'))), get('src'), get('len')))],
      [call('patchFile', get('pos'), get('src'), get('len'))],
    ),
  ]);
  // An error of the current record: 1 stray_cr, 2 quote_junk, 3 unterminated_quote, 4 short_row (a: its fields),
  // 5 long_row (a, b: where its cut fields are in XA and how many bytes they take). 20 bytes each.
  fn('addErr', ['code', 'a', 'b'], null, [], [
    If(gt(gget('e'), c(L.ERREND - 32)), [gset('fail', c(1)), Ret()]),
    W.st32(gget('e'), get('code')),
    W.st32(gget('e'), gget('recLine'), 4),
    W.st32(gget('e'), gget('rec'), 8),
    W.st32(gget('e'), get('a'), 12),
    W.st32(gget('e'), get('b'), 16),
    ginc('e', 20),
  ]);
  fn('hexVal', ['b'], I32, [], [
    If(all(ge(get('b'), c(48)), le(get('b'), c(57))), [Ret(sub(get('b'), c(48)))]),
    If(all(ge(get('b'), c(97)), le(get('b'), c(102))), [Ret(sub(get('b'), c(87)))]),
    If(all(ge(get('b'), c(65)), le(get('b'), c(70))), [Ret(sub(get('b'), c(55)))]),
    Ret(c(-1)),
  ]);
  // The code unit a \uXXXX at i spells, or -1 if it is malformed.
  fn('uValue', ['i'], I32, i32s('a', 'b', 'c', 'd'), [
    If(gt(add(get('i'), c(6)), gget('te')), [Ret(c(-1))]),
    set('a', call('hexVal', at(get('i'), 2))),
    set('b', call('hexVal', at(get('i'), 3))),
    set('c', call('hexVal', at(get('i'), 4))),
    set('d', call('hexVal', at(get('i'), 5))),
    If(any(lt(get('a'), c(0)), lt(get('b'), c(0)), lt(get('c'), c(0)), lt(get('d'), c(0))), [Ret(c(-1))]),
    Ret(or(or(W.shl(get('a'), c(12)), W.shl(get('b'), c(8))), or(W.shl(get('c'), c(4)), get('d')))),
  ]);
  // 1 when a \uXXXX at i must not be copied through: malformed, or a comma, quote, CR or LF.
  fn('badU', ['i'], I32, i32s('v'), [
    set('v', call('uValue', get('i'))),
    If(lt(get('v'), c(0)), [Ret(c(1))]),
    Ret(any(eq(get('v'), c(10)), eq(get('v'), c(13)), eq(get('v'), c(34)), eq(get('v'), c(44)))),
  ]);

  // An unquoted field (or its rest) from p, content copied to o. Writes never outrun reads, so stopping the reads at
  // lim keeps the writes below oMax.
  fn('unq', [], null, i32s('i', 'k', 'b', 'ch', 'lim'), [
    set('i', gget('p')),
    set('k', gget('o')),
    set('lim', add(get('i'), sub(gget('oMax'), get('k')))),
    If(gt(get('lim'), gget('te')), [set('lim', gget('te'))]),
    While('L', lt(get('i'), get('lim')), [
      set('b', ld8(get('i'))),
      If(eqz(ld8(get('b'), L.STOP)), [st8(get('k'), get('b')), inc('k'), inc('i'), Continue('L')]),
      If(eq(get('b'), c(44)), [gset('o', get('k')), gset('p', add(get('i'), c(1))), gset('ended', c(0)), Ret()]),
      If(eq(get('b'), c(34)), [
        // The text's closing quote.
        gset('te', get('i')),
        gset('teFound', c(1)),
        gset('o', get('k')),
        gset('p', get('i')),
        gset('ended', c(2)),
        Ret(),
      ]),
      If(ne(get('b'), c(92)), [gset('fail', c(1)), Ret()]),
      set('ch', at(get('i'), 1)),
      If(eq(get('ch'), c(110)), [
        gset('o', get('k')),
        gset('p', add(get('i'), c(2))),
        ginc('line'),
        gset('ended', c(1)),
        Ret(),
      ]),
      If(eq(get('ch'), c(114)), [
        If(all(eq(at(get('i'), 2), c(92)), eq(at(get('i'), 3), c(110))), [
          gset('o', get('k')),
          gset('p', add(get('i'), c(4))),
          ginc('line'),
          gset('ended', c(1)),
          Ret(),
        ]),
        call('addErr', c(1), c(0), c(0)),
        If(gget('fail'), [Ret()]),
        inc('i', 2),
        Continue('L'),
      ]),
      If(eq(get('ch'), c(117)), [
        If(call('badU', get('i')), [gset('fail', c(1)), Ret()]),
        set('k', call('cp', get('k'), get('i'), c(6))),
        inc('i', 6),
        Continue('L'),
      ]),
      st8(get('k'), c(92)),
      st8(get('k'), get('ch'), 1),
      inc('k', 2),
      inc('i', 2),
    ]),
    gset('o', get('k')),
    gset('p', get('i')),
    // The field does not fit the output window, or runs past the input window.
    If(or(lt(get('i'), gget('te')), eqz(gget('teFound'))), [gset('fail', c(1)), Ret()]),
    gset('ended', c(2)),
  ]);

  // 1 when a quoted field's closing quote comes before the end of the text, reading from i inside it; 0 when the
  // text ends first (teFound then set), or the input window does (teFound still 0).
  fn('closesFrom', ['i'], I32, i32s('b', 'ch'), [
    While('L', lt(get('i'), gget('te')), [
      set('b', ld8(get('i'))),
      If(eq(get('b'), c(34)), [gset('te', get('i')), gset('teFound', c(1)), Ret(c(0))]),
      If(eq(get('b'), c(92)), [
        set('ch', at(get('i'), 1)),
        If(eq(get('ch'), c(34)), [
          If(all(eq(at(get('i'), 2), c(92)), eq(at(get('i'), 3), c(34))), [inc('i', 4), Continue('L')]),
          Ret(c(1)),
        ]),
        If(eq(get('ch'), c(117)), [inc('i', 6)], [inc('i', 2)]),
        Continue('L'),
      ]),
      inc('i'),
    ]),
    Ret(c(0)),
  ]);

  // A quoted field whose opening \" is at p.
  fn('quo', [], null, [...i32s('i', 'k', 'b', 'ch', 'lim', 'open', 'openLine', 'start', 'before', 's'), ['v', V128]], [
    set('open', gget('p')),
    set('openLine', gget('line')),
    set('start', gget('o')),
    set('i', add(gget('p'), c(2))),
    set('k', gget('o')),
    set('lim', add(get('i'), sub(gget('oMax'), get('k')))),
    If(gt(get('lim'), gget('te')), [set('lim', gget('te'))]),
    While('L', lt(get('i'), get('lim')), [
      // 16 bytes at a time up to the next backslash, raw quote or control byte (commas are content here).
      If(le(add(get('i'), c(16)), get('lim')), [
        set('v', vld(get('i'))),
        vst(get('k'), get('v')),
        set('s', ctz(or(specials(get('v')), c(0x10000)))),
        set('i', add(get('i'), get('s'))),
        set('k', add(get('k'), get('s'))),
        If(eq(get('s'), c(16)), [Continue('L')]),
      ]),
      set('b', ld8(get('i'))),
      If(eqz(ld8(get('b'), L.STOPQ)), [st8(get('k'), get('b')), inc('k'), inc('i'), Continue('L')]),
      // The text ends inside the quotes.
      If(eq(get('b'), c(34)), [gset('te', get('i')), gset('teFound', c(1)), Break('L')]),
      If(ne(get('b'), c(92)), [gset('fail', c(1)), Ret()]),
      set('ch', at(get('i'), 1)),
      If(eq(get('ch'), c(34)), [
        If(all(eq(at(get('i'), 2), c(92)), eq(at(get('i'), 3), c(34))), [
          // "" inside quotes: one quote.
          st8(get('k'), c(92)),
          st8(get('k'), c(34), 1),
          inc('k', 2),
          inc('i', 4),
          Continue('L'),
        ]),
        // The closing quote.
        inc('i', 2),
        gset('o', get('k')),
        gset('p', get('i')),
        set('b', ld8(get('i'))),
        If(eq(get('b'), c(34)), [gset('te', get('i')), gset('teFound', c(1)), gset('ended', c(2)), Ret()]),
        If(ge(get('i'), gget('te')), [
          If(eqz(gget('teFound')), [gset('fail', c(1))]), // past the input window
          gset('ended', c(2)),
          Ret(),
        ]),
        If(eq(get('b'), c(44)), [gset('p', add(get('i'), c(1))), gset('ended', c(0)), Ret()]),
        If(eq(get('b'), c(92)), [
          set('ch', at(get('i'), 1)),
          If(eq(get('ch'), c(110)), [gset('p', add(get('i'), c(2))), ginc('line'), gset('ended', c(1)), Ret()]),
          If(all(eq(get('ch'), c(114)), eq(at(get('i'), 2), c(92)), eq(at(get('i'), 3), c(110))), [
            gset('p', add(get('i'), c(4))),
            ginc('line'),
            gset('ended', c(1)),
            Ret(),
          ]),
        ]),
        // Junk after the closing quote, appended; quote_junk if anything was kept.
        set('before', gget('o')),
        call('unq'),
        If(gget('fail'), [Ret()]),
        If(gt(gget('o'), get('before')), [call('addErr', c(2), c(0), c(0))]),
        Ret(),
      ]),
      If(eq(get('ch'), c(114)), [
        // CRLF or a lone CR inside quotes: one LF.
        st8(get('k'), c(92)),
        st8(get('k'), c(110), 1),
        inc('k', 2),
        ginc('line'),
        If(all(eq(at(get('i'), 2), c(92)), eq(at(get('i'), 3), c(110))), [inc('i', 4)], [inc('i', 2)]),
        Continue('L'),
      ]),
      If(eq(get('ch'), c(110)), [ginc('line')]),
      If(eq(get('ch'), c(117)), [
        If(call('badU', get('i')), [gset('fail', c(1)), Ret()]),
        set('k', call('cp', get('k'), get('i'), c(6))),
        inc('i', 6),
        Continue('L'),
      ]),
      st8(get('k'), c(92)),
      st8(get('k'), get('ch'), 1),
      inc('k', 2),
      inc('i', 2),
    ]),
    If(or(lt(get('i'), gget('te')), eqz(gget('teFound'))), [
      // Stopped by a window: give up unless the quote surely never closes (the text's end is met first).
      If(call('closesFrom', get('i')), [gset('fail', c(1)), Ret()]),
      If(eqz(gget('teFound')), [gset('fail', c(1)), Ret()]),
    ]),
    // Never closes: a literal quote, and the rest read again as unquoted.
    gset('line', get('openLine')),
    call('addErr', c(3), c(0), c(0)),
    If(gget('fail'), [Ret()]),
    st8(get('start'), c(92)),
    st8(get('start'), c(34), 1),
    gset('o', add(get('start'), c(2))),
    gset('p', add(get('open'), c(2))),
    call('unq'),
  ]);

  // Appends one byte to the output (the brackets and commas between cases).
  fn('putByte', ['b'], null, [], [call('need', c(64)), st8(gget('o'), get('b')), ginc('o')], true);
  fn('begin', [], null, [], [gset('o', c(L.OUT)), gset('flushed', c(0))], true);
  fn('finish', [], null, [], [call('flushNow')], true);
  fn('textEnd', [], I32, [], [Ret(gget('te'))], true);
  // The driver read more input itself (between texts): the window now ends at n.
  fn('setEnd', ['n'], null, [], [gset('inEnd', get('n'))], true);
  // Before a record: at least LOOK bytes ahead in the input window, unless the file is all read.
  fn('lookAhead', [], null, i32s('n'), [
    If(gget('eof'), [Ret()]),
    If(ge(sub(gget('inEnd'), gget('p')), c(L.LOOK)), [Ret()]),
    set('n', call('refill', gget('p'))),
    If(lt(get('n'), c(0)), [gset('eof', c(1)), Ret()]),
    gset('inEnd', get('n')),
    gset('p', c(L.IN)),
    gset('te', get('n')),
  ]);

  // Reads the text that starts at ts up to its closing quote, writing its records: 0, or -1 to give up.
  fn('answer', ['ts'], I32, [...i32s('recStart', 'count', 'width', 'inX', 'oRow', 'xStart', 'xEnd', 'lastQ',
    'lastStart', 'f', 'ch', 'n', 'i', 'k', 'b', 'lim', 'fs', 's', 'pm', 'nc', 'tl', 'xs', 'xr', 'xm', 'xj', 'xb'),
    ['v', V128]], [
    set('width', c(-1)),
    gset('te', gget('inEnd')),
    gset('teFound', c(0)),
    gset('p', get('ts')),
    gset('line', c(1)),
    gset('e', c(L.ERR)),
    gset('xa', c(L.XA)),
    gset('rec', c(0)),
    gset('fail', c(0)),
    If(all(eq(ld8(gget('p')), c(239)), eq(at(gget('p'), 1), c(187)), eq(at(gget('p'), 2), c(191))), [
      gset('p', add(gget('p'), c(3))),
    ], [
      If(all(eq(ld8(gget('p')), c(92)), eq(at(gget('p'), 1), c(117))), [
        set('ch', call('uValue', gget('p'))),
        If(or(eq(get('ch'), c(0xfeff)), lt(get('ch'), c(0))), [Ret(c(-1))]),
      ]),
    ]),
    call('need', c(L.ROOM)),
    gset('p1', add(gget('flushed'), sub(gget('o'), c(L.OUT)))),
    gset('o', call('cp', gget('o'), c(K.K_F1), c(24))),

    Forever('R', [
      call('lookAhead'),
      // Blank lines (LF or CRLF) are no records.
      While('B', lt(gget('p'), gget('te')), [
        If(ne(ld8(gget('p')), c(92)), [Break('B')]),
        set('ch', at(gget('p'), 1)),
        If(eq(get('ch'), c(110)), [gset('p', add(gget('p'), c(2))), ginc('line'), Continue('B')]),
        If(all(eq(get('ch'), c(114)), eq(at(gget('p'), 2), c(92)), eq(at(gget('p'), 3), c(110))), [
          gset('p', add(gget('p'), c(4))),
          ginc('line'),
          Continue('B'),
        ]),
        Break('B'),
      ]),
      If(ge(gget('p'), gget('te')), [Break('R')]), // no closing quote in the input: the driver gives up
      If(eq(ld8(gget('p')), c(34)), [gset('te', gget('p')), gset('teFound', c(1)), Break('R')]),

      call('need', c(L.ROOM)),
      gset('oMax', c(L.OUTEND - 1024)),
      gset('recLine', gget('line')),
      set('recStart', gget('o')),
      If(ge(gget('rec'), c(2)), [st8(gget('o'), c(44)), ginc('o')]),
      st8(gget('o'), c(91)),
      ginc('o'),
      set('count', c(0)),
      set('inX', c(0)),
      Forever('F', [
        If(eq(get('count'), get('width')), [
          // The cut fields of a long row go to XA.
          set('oRow', gget('o')),
          gset('o', gget('xa')),
          set('xStart', gget('xa')),
          gset('oMax', c(L.XAEND - 1024)),
          set('inX', c(1)),
        ], [
          If(gt(get('count'), c(0)), [st8(gget('o'), c(44)), ginc('o')]),
        ]),
        If(gt(gget('o'), gget('oMax')), [Ret(c(-1))]),
        st8(gget('o'), c(34)),
        ginc('o'),
        set('lastStart', gget('o')),
        set('lastQ', all(eq(ld8(gget('p')), c(92)), eq(at(gget('p'), 1), c(34)))),
        If(get('lastQ'), [call('quo')], [
          // Most of a row: plain fields. 16 bytes at a time: the bytes up to the first backslash, raw quote or
          // control byte, with every comma among them written as `","` (each one ends a field), as long as no
          // comma there starts a long row's cut fields. fs: where the content of the field now read starts.
          // (i, k: input and output positions, kept in locals here; tl: the last block start in the text.)
          set('fs', gget('o')),
          set('i', gget('p')),
          set('k', gget('o')),
          set('tl', sub(gget('te'), c(16))),
          Forever('V', [
            If(gt(get('i'), get('tl')), [Break('V')]),
            If(gt(get('k'), c(L.OUTEND - 1024 - 64)), [Break('V')]),
            set('v', vld(get('i'))),
            set('s', ctz(or(specials(get('v')), c(0x10000)))),
            If(eqz(get('s')), [Break('V')]),
            set('pm', and(commas(get('v')), sub(shl(c(1), get('s')), c(1)))),
            set('nc', popcnt(get('pm'))),
            If(and(ge(get('width'), c(0)), ge(add(get('count'), get('nc')), get('width'))), [Break('V')]),
            ...expand(get('i'), select(get('s'), c(8), lt(get('s'), c(8))), and(get('pm'), c(0xff))),
            If(gt(get('s'), c(8)), expand(add(get('i'), c(8)), sub(get('s'), c(8)), shrU(get('pm'), c(8)))),
            If(get('nc'), [
              set('count', add(get('count'), get('nc'))),
              set('fs', sub(get('k'), sub(get('s'), sub(c(32), clz(get('pm')))))),
            ]),
            set('i', add(get('i'), get('s'))),
            If(lt(get('s'), c(16)), [Break('V')]),
          ]),
          gset('p', get('i')),
          gset('o', get('k')),
        ]),
        If(and(eqz(get('lastQ')), all(eq(gget('o'), get('fs')), eq(ld8(gget('p')), c(92)), eq(at(gget('p'), 1), c(34)))), [
          // A comma just read starts a quoted field.
          set('lastQ', c(1)),
          call('quo'),
        ], [If(eqz(get('lastQ')), [
          // Plain bytes, then a comma. Copied here; anything else goes on in unq().
          set('i', gget('p')),
          set('k', gget('o')),
          set('lim', add(get('i'), sub(gget('oMax'), get('k')))),
          If(gt(get('lim'), gget('te')), [set('lim', gget('te'))]),
          While('P', lt(get('i'), get('lim')), [
            set('b', ld8(get('i'))),
            If(ld8(get('b'), L.STOP), [Break('P')]),
            st8(get('k'), get('b')),
            inc('k'),
            inc('i'),
          ]),
          gset('o', get('k')),
          gset('p', get('i')),
          If(all(lt(get('i'), get('lim')), eq(ld8(get('i')), c(44))), [
            gset('p', add(get('i'), c(1))),
            gset('ended', c(0)),
          ], [
            // The end of a row (\n or \r\n) here too; anything else goes on in unq().
            If(all(lt(get('i'), get('lim')), eq(ld8(get('i')), c(92)), eq(at(get('i'), 1), c(110))), [
              gset('p', add(get('i'), c(2))),
              ginc('line'),
              gset('ended', c(1)),
            ], [
              If(all(lt(get('i'), get('lim')), eq(ld8(get('i')), c(92)), eq(at(get('i'), 1), c(114)),
                eq(at(get('i'), 2), c(92)), eq(at(get('i'), 3), c(110))), [
                gset('p', add(get('i'), c(4))),
                ginc('line'),
                gset('ended', c(1)),
              ], [call('unq')]),
            ]),
          ]),
        ])]),
        If(gget('fail'), [Ret(c(-1))]),
        st8(gget('o'), c(34)),
        ginc('o'),
        inc('count'),
        If(gget('ended'), [Break('F')]),
      ]),
      If(get('inX'), [set('xEnd', gget('o')), gset('o', get('oRow'))]),

      // A line of stray CRs alone leaves nothing: no record (its errors stay).
      If(all(eq(get('count'), c(1)), eqz(get('lastQ')), eq(gget('o'), add(get('lastStart'), c(1)))), [
        gset('o', get('recStart')),
        Continue('R'),
      ]),
      If(lt(get('width'), c(0)), [set('width', get('count'))]),
      If(lt(get('count'), get('width')), [
        set('n', mul(sub(get('width'), get('count')), c(3))),
        If(gt(add(add(gget('o'), get('n')), c(16)), c(L.OUTEND)), [Ret(c(-1))]),
        set('f', get('count')),
        While('Pad', lt(get('f'), get('width')), [
          st8(gget('o'), c(44)),
          st8(gget('o'), c(34), 1),
          st8(gget('o'), c(34), 2),
          ginc('o', 3),
          inc('f'),
        ]),
        call('addErr', c(4), get('count'), c(0)),
        If(gget('fail'), [Ret(c(-1))]),
      ], [
        If(gt(get('count'), get('width')), [
          call('addErr', c(5), get('xStart'), sub(get('xEnd'), get('xStart'))),
          If(gget('fail'), [Ret(c(-1))]),
          gset('xa', get('xEnd')),
        ]),
      ]),
      st8(gget('o'), c(93)),
      ginc('o'),
      If(eqz(gget('rec')), [
        // Room for the separator after the first record: `,"rows":[`, or a comma, or nothing.
        gset('p2', add(gget('flushed'), sub(gget('o'), c(L.OUT)))),
        gset('o', call('cp', gget('o'), c(K.K_F2B), c(9))),
      ]),
      ginc('rec'),
    ]),
    Ret(c(0)),
  ], true);

  // Finishes the answer of the text just read, now that its header flag is known.
  fn('close', ['header'], null, i32s('q', 'code', 'r', 'a', 'b', 'room', 'n'), [
    If(get('header'), [
      If(eqz(gget('rec')), [call('patch', gget('p1'), c(K.K_E1), c(24))], [call('patch', gget('p1'), c(K.K_T1), c(24))]),
    ]),
    If(gt(gget('rec'), c(0)), [
      If(get('header'), [call('patch', gget('p2'), c(K.K_T2), c(9))], [
        If(ge(gget('rec'), c(2)), [call('patch', gget('p2'), c(K.K_F2A), c(9))]),
      ]),
    ]),
    call('need', c(64)),
    gset('o', call('cp', gget('o'), c(K.K_ERRS), c(12))),
    set('q', c(L.ERR)),
    While('E', lt(get('q'), gget('e')), [
      set('code', W.ld32(get('q'))),
      set('r', W.ld32(get('q'), 8)),
      set('a', W.ld32(get('q'), 12)),
      set('b', W.ld32(get('q'), 16)),
      call('need', c(128)),
      If(gt(get('q'), c(L.ERR)), [st8(gget('o'), c(44)), ginc('o')]),
      If(eq(get('code'), c(1)), [gset('o', call('cp', gget('o'), c(K.K_STRAY), c(26)))], [
        If(eq(get('code'), c(2)), [gset('o', call('cp', gget('o'), c(K.K_JUNK), c(28)))], [
          If(eq(get('code'), c(3)), [gset('o', call('cp', gget('o'), c(K.K_UNT), c(36)))], [
            If(eq(get('code'), c(4)), [gset('o', call('cp', gget('o'), c(K.K_SHORT), c(27)))], [
              gset('o', call('cp', gget('o'), c(K.K_LONG), c(26))),
            ]),
          ]),
        ]),
      ]),
      gset('o', call('putInt', gget('o'), W.ld32(get('q'), 4))),
      gset('o', call('cp', gget('o'), c(K.K_ROW), c(7))),
      If(get('header'), [
        If(eqz(get('r')), [gset('o', call('cp', gget('o'), c(K.K_NUL), c(4)))], [
          gset('o', call('putInt', gget('o'), sub(get('r'), c(1)))),
        ]),
      ], [gset('o', call('putInt', gget('o'), get('r')))]),
      If(eq(get('code'), c(4)), [
        gset('o', call('cp', gget('o'), c(K.K_FIELDS), c(10))),
        gset('o', call('putInt', gget('o'), get('a'))),
        st8(gget('o'), c(125)),
        ginc('o'),
      ], [
        If(eq(get('code'), c(5)), [
          gset('o', call('cp', gget('o'), c(K.K_EXTRA), c(10))),
          While('X', gt(get('b'), c(0)), [
            call('need', c(64)),
            set('room', sub(sub(c(L.OUTEND), gget('o')), c(16))),
            set('n', W.select(get('b'), get('room'), lt(get('b'), get('room')))),
            gset('o', call('cp', gget('o'), get('a'), get('n'))),
            set('a', add(get('a'), get('n'))),
            set('b', sub(get('b'), get('n'))),
          ]),
          call('need', c(64)),
          st8(gget('o'), c(93)),
          st8(gget('o'), c(125), 1),
          ginc('o', 2),
        ], [st8(gget('o'), c(125)), ginc('o')]),
      ]),
      inc('q', 20),
    ]),
    call('need', c(64)),
    gset('o', call('cp', gget('o'), c(K.K_CEND), c(2))),
  ], true);

  return assemble({
    memory: { module: 'e', name: 'mem', pages: L.pages },
    imports: [
      { module: 'e', name: 'flush', params: [I32, I32], result: null },
      { module: 'e', name: 'patchFile', params: [I32, I32, I32], result: null },
      { module: 'e', name: 'refill', params: [I32], result: I32 },
    ],
    globals,
    funcs,
  });
}

module.exports = { build, expansionTable };
