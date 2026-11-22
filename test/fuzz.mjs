// Differential fuzzer: run(input) from ../solve.js against the reference csv-reader (path given on the command line,
// never copied into this repository). Every answer must serialise to the same JSON bytes (same values, same key order).
//
//   node test/fuzz.mjs <path to csv-reader index.js> [cases=200000] [seed=1]

import { pathToFileURL } from 'node:url';
import { mkdtempSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { run } from '../solve.js';

// The fast path main.ts takes, run on a cases.json file as main.ts runs it: the answers.json bytes, or null when it
// gives up (main.ts then answers with run()).
const { fastPath } = createRequire(import.meta.url)('../fast.cjs');
const work = mkdtempSync(join(tmpdir(), 'fuzz-'));
function transduce(bytes, window) {
  writeFileSync(join(work, 'cases.json'), bytes);
  if (!fastPath(join(work, 'cases.json'), join(work, 'answers.json'), window)) {
    if (existsSync(join(work, 'answers.json'))) throw new Error('a partial answers.json was left behind');
    return null;
  }
  return readFileSync(join(work, 'answers.json'));
}

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

// A JSON value with object keys sorted, as the scorer compares.
function canonical(v) {
  if (Array.isArray(v)) return `[${v.map(canonical).join(',')}]`;
  if (v !== null && typeof v === 'object') {
    return `{${Object.keys(v).sort().map((k) => `${JSON.stringify(k)}:${canonical(v[k])}`).join(',')}}`;
  }
  return JSON.stringify(v) ?? 'null';
}

// The cases.json text with some characters written as \uXXXX escapes (valid JSON another writer could produce).
function escapeSome(json) {
  let s = '';
  let inString = false;
  for (let i = 0; i < json.length; i++) {
    const c = json[i];
    if (c === '\\' && inString) {
      const n = json[i + 1] === 'u' ? 6 : 2;
      s += json.slice(i, i + n);
      i += n - 1;
      continue;
    }
    if (c === '"') inString = !inString;
    if (inString && c !== '"' && chance(0.05)) s += '\\u' + c.charCodeAt(0).toString(16).padStart(4, '0');
    else s += c;
  }
  return s;
}

let fails = 0;
const tstats = { bytes: 0, value: 0, gaveUp: 0, gaveUpCanonical: 0, small: 0, smallGaveUp: 0 };
function report(label, input, want, got) {
  fails++;
  if (fails <= 5) {
    console.log(`MISMATCH ${label}: input=${JSON.stringify(input).slice(0, 2000)}`);
    console.log(`  want ${String(want).slice(0, 600)}`);
    console.log(`  got  ${String(got).slice(0, 600)}`);
  }
}

function check(input, label) {
  const want = JSON.stringify(readCsv(input));
  const got = JSON.stringify(run(input));
  if (want !== got) report(label, input, want, got);
}

// The transducer on a batch of inputs as one cases.json: identical bytes, or identical values (escapes can differ,
// e.g. two lone surrogates joined into a pair), or a give-up (main.ts then answers with run()).
function checkBatch(batch, label, noncanonical) {
  const cases = batch.map((input, i) => ({ id: `g-${String(i + 1).padStart(4, '0')}`, input }));
  let json = JSON.stringify(cases);
  if (noncanonical) json = escapeSome(json);
  // What an entry is handed is the file's bytes: the expected answers are the reference's on exactly those.
  const bytes = Buffer.from(json, 'utf8');
  const handed = JSON.parse(bytes.toString('utf8'));
  const want = JSON.stringify(handed.map((c) => readCsv(c.input)));
  // A 4 KiB window: the window is written out between records all the time; a record too big for it gives up.
  const small = transduce(bytes, 4096);
  if (small === null) tstats.smallGaveUp++;
  else {
    tstats.small++;
    const text = Buffer.from(small).toString('utf8');
    let same = text === want;
    if (!same) {
      try {
        same = canonical(JSON.parse(text)) === canonical(JSON.parse(want));
      } catch {}
    }
    if (!same) report(`${label} small window`, batch, want, text);
  }
  const got = transduce(bytes);
  if (got === null) {
    tstats.gaveUp++;
    if (!noncanonical && batch.every((x) => x.header === true || x.header === false)) {
      tstats.gaveUpCanonical++;
      report(`${label} gave up on canonical`, batch, want, 'null');
    }
    return;
  }
  const text = Buffer.from(got).toString('utf8');
  if (text === want) tstats.bytes++;
  else {
    let same = false;
    try {
      same = canonical(JSON.parse(text)) === canonical(JSON.parse(want));
    } catch {}
    if (same) tstats.value++;
    else report(`${label} transducer`, batch, want, text);
  }
}

for (let i = 0; i < exhaustive.length; i++) check(exhaustive[i], `exhaustive#${i}`);
for (let i = 0; i < exhaustive.length; i += 7) checkBatch(exhaustive.slice(i, i + 7), `exhaustive-batch#${i}`, false);
const specials = [{ text: '', header: true }, { text: '', header: false }, { text: '﻿', header: true }];
for (const x of specials) check(x, 'special');
checkBatch(specials, 'specials', false);
checkBatch([], 'no cases', false);
let batch = [];
for (let i = 0; i < total; i++) {
  const input = makeInput(i);
  check(input, `case#${i}`);
  batch.push(input);
  if (batch.length >= 1 + (i % 5)) {
    checkBatch(batch, `batch@${i}`, false);
    if (i % 4 === 0) checkBatch(batch, `noncanonical@${i}`, true);
    batch = [];
  }
}

console.log(`${exhaustive.length + specials.length + total} cases, ${fails} mismatches`);
console.log(`transducer: ${tstats.bytes} batches byte-identical, ${tstats.value} value-identical, ${tstats.gaveUp} gave up (${tstats.gaveUpCanonical} on canonical boolean-header input)`);
console.log(`4 KiB window: ${tstats.small} batches identical, ${tstats.smallGaveUp} gave up`);
process.exit(fails === 0 ? 0 : 1);
