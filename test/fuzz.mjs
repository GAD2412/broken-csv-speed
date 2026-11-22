// Differential fuzzer: run(input) from ../solve.js against the reference csv-reader (path given on the command line,
// never copied into this repository). Every answer must serialise to the same JSON bytes (same values, same key order).
//
//   node test/fuzz.mjs <path to csv-reader index.js> [cases=200000] [seed=1]

import { pathToFileURL } from 'node:url';
import { run } from '../solve.js';

const refPath = process.argv[2];
if (!refPath) {
  console.error('usage: node test/fuzz.mjs <csv-reader index.js> [cases] [seed]');
  process.exit(2);
}
const { readCsv } = await import(pathToFileURL(refPath).href);
const total = Number(process.argv[3] ?? 200000);
let seed = Number(process.argv[4] ?? 1) >>> 0;

// mulberry32: small deterministic PRNG.
function rnd() {
  seed = (seed + 0x6d2b79f5) >>> 0;
  let t = seed;
  t = Math.imul(t ^ (t >>> 15), t | 1);
  t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
}
const int = (a, b) => a + Math.floor(rnd() * (b - a + 1));
const pick = (arr) => arr[Math.floor(rnd() * arr.length)];
const chance = (p) => rnd() < p;

// Single pieces, weighted towards the characters that matter.
const PIECES = [
  'a', 'b', 'c', 'x', 'y', '1', ' ', ',', ',', ',', '"', '"', '"', '""', '\n', '\n', '\r', '\r\n', '\r\n', '\r\r',
  '﻿', 'é', '東', '😀', '\ud800', '\udfff', '\t', '\\', '\u0000', ' ', '/', "'",
];
const WORDS = ['alpha', 'beta', '', '', 'Zürich', '數據', 'x"y', 'a,b', 'line\nbreak', 'cr\rhere', 'crlf\r\nin', '""', ' '];
const JUNK = ['kg', 'x', ' ', '!', 'x"y', '\r', '\rq', '"', '""', ',', ''];

function chaos(maxLen) {
  const n = int(0, maxLen);
  let s = '';
  for (let i = 0; i < n; i++) s += pick(PIECES);
  return s;
}

function field() {
  const k = int(0, 9);
  const w = pick(WORDS);
  if (k <= 3) return w.replace(/[",\r\n]/g, '');
  if (k <= 6) return `"${w.replaceAll('"', '""')}"`;
  if (k === 7) return `"${w.replaceAll('"', '""')}"${pick(JUNK)}`;
  if (k === 8) return `"${w}`; // maybe never closes
  return chaos(4);
}

function structured() {
  const eol = pick(['\n', '\r\n', '\r\n', '\r']);
  const width = int(1, 6);
  const recs = int(0, 12);
  let s = chance(0.3) ? '﻿' : '';
  for (let r = 0; r < recs; r++) {
    if (chance(0.1)) s += pick(['\n', '\r\n', eol, '\r', '\r\r\n']);
    const w = chance(0.7) ? width : int(1, width + 3);
    const parts = [];
    for (let f = 0; f < w; f++) parts.push(field());
    s += parts.join(',');
    if (r < recs - 1 || chance(0.6)) s += eol;
  }
  return s;
}

function mutate(s) {
  const times = int(1, 4);
  for (let t = 0; t < times; t++) {
    const at = int(0, s.length);
    const op = int(0, 2);
    if (op === 0) s = s.slice(0, at) + pick(['"', '\r', '\n', ',', '""', '\r\n']) + s.slice(at);
    else if (op === 1) s = s.slice(0, at) + s.slice(at + 1);
    else s = s.slice(0, at) + pick(PIECES) + s.slice(at);
  }
  return s;
}

function longCase() {
  // Long fields and long files of plain records with a few broken ones.
  const width = int(2, 12);
  const eol = pick(['\n', '\r\n']);
  const recs = int(50, 400);
  let s = '';
  for (let r = 0; r < recs; r++) {
    const w = chance(0.9) ? width : int(1, width + 3);
    const parts = [];
    for (let f = 0; f < w; f++) {
      if (chance(0.02)) parts.push('"' + 'q'.repeat(int(0, 3000)) + '""' + eol + 'z"');
      else if (chance(0.01)) parts.push('w' + '\r' + 'v');
      else parts.push(chance(0.5) ? pick(WORDS).replace(/[",\r\n]/g, '') : String(int(0, 1e6)));
    }
    s += parts.join(',') + eol;
  }
  if (chance(0.5)) {
    const at = int(0, s.length);
    s = s.slice(0, at) + '"' + s.slice(at).replaceAll('"', '');
  }
  return s;
}

function makeInput(i) {
  const m = i % 10;
  let text;
  if (m < 3) text = chaos(int(0, 40));
  else if (m < 7) text = structured();
  else if (m < 9) text = mutate(structured());
  else text = i % 100 === 9 ? longCase() : chaos(int(0, 200));
  const hv = int(0, 9);
  const header = hv < 5 ? true : hv < 9 ? false : pick([1, 'true', null, undefined]);
  return { text, header };
}

// Exhaustive part: one quote inserted at every position of a few fixed texts.
const BASES = ['a,b\nc,d\r\ne,f', '"x",y\r\n"z""w",v\n', 'h1,h2\n1,2,3\n4\n\n5,6\r', 'a\rb,"c\rd"e\r\n'];
const exhaustive = [];
for (const b of BASES) {
  for (let p = 0; p <= b.length; p++) {
    for (const ins of ['"', '\r', '""', '\n']) {
      const t = b.slice(0, p) + ins + b.slice(p);
      exhaustive.push({ text: t, header: true }, { text: t, header: false });
    }
  }
}

let fails = 0;
function check(input, label) {
  const want = JSON.stringify(readCsv(input));
  const got = JSON.stringify(run(input));
  if (want !== got) {
    fails++;
    if (fails <= 5) {
      console.log(`MISMATCH ${label}: input=${JSON.stringify(input)}`);
      console.log(`  want ${want.slice(0, 600)}`);
      console.log(`  got  ${got.slice(0, 600)}`);
    }
  }
}

for (let i = 0; i < exhaustive.length; i++) check(exhaustive[i], `exhaustive#${i}`);
check({ text: '', header: true }, 'empty');
check({ text: '', header: false }, 'empty');
check({ text: '﻿', header: true }, 'bom');
for (let i = 0; i < total; i++) check(makeInput(i), `case#${i}`);

console.log(`${exhaustive.length + 3 + total} cases, ${fails} mismatches`);
process.exit(fails === 0 ? 0 : 1);
