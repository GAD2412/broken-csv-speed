// CPU-time race of harness programs on case sets, net of a do-nothing node process, like the contest's heat:
// each round runs every program once per set in turn; a program's time is the trimmed mean over rounds
// (2 lowest and 2 highest dropped when there are at least 7 rounds). Outputs are checked against the reference.
//
//   node test/bench.mjs <rounds> <set dir>[,<set dir>...] <main.ts> [<main.ts>...]

import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const [roundsArg, setsArg, ...progs] = process.argv.slice(2);
const rounds = Number(roundsArg);
const sets = setsArg.split(',').map((s) => resolve(s));
const hook = fileURLToPath(new URL('./cpu-exit.mjs', import.meta.url));
const out = mkdtempSync(join(tmpdir(), 'bench-'));

function cpuOf(args, setDir) {
  const r = spawnSync(process.execPath, ['--import', hook, ...args], {
    env: { ...process.env, MAKEFUN_INPUT_DIR: join(setDir, 'input'), MAKEFUN_OUTPUT_DIR: out },
    encoding: 'utf8',
  });
  if (r.status !== 0) throw new Error(`${args.join(' ')} failed: ${r.stderr}`);
  const m = /CPU_US (\d+)/.exec(r.stderr);
  return Number(m[1]);
}

// A JSON value with object keys sorted, as the scorer compares.
function canonical(v) {
  if (Array.isArray(v)) return `[${v.map(canonical).join(',')}]`;
  if (v !== null && typeof v === 'object') {
    return `{${Object.keys(v).sort().map((k) => `${JSON.stringify(k)}:${canonical(v[k])}`).join(',')}}`;
  }
  return JSON.stringify(v) ?? 'null';
}

function checkOutput(setDir, prog) {
  const want = JSON.parse(readFileSync(join(setDir, 'reference/expected.json'), 'utf8')).cases.map((c) => c.output);
  const got = JSON.parse(readFileSync(join(out, 'answers.json'), 'utf8'));
  if (got.length !== want.length) throw new Error(`${prog}: ${got.length} answers`);
  for (let i = 0; i < want.length; i++) {
    if (canonical(got[i]) !== canonical(want[i])) throw new Error(`${prog} wrong on ${setDir} case ${i}`);
  }
}

const trimmed = (xs) => {
  const s = [...xs].sort((a, b) => a - b);
  const t = s.length >= 7 ? s.slice(2, -2) : s;
  return t.reduce((a, b) => a + b, 0) / t.length;
};
const median = (xs) => [...xs].sort((a, b) => a - b)[Math.floor(xs.length / 2)];

for (const p of progs) for (const s of sets) {
  cpuOf([resolve(p)], s);
  checkOutput(s, p);
}

const nul = [];
const times = progs.map(() => []);
for (let r = 0; r < rounds; r++) {
  for (let i = 0; i < progs.length; i++) {
    let sum = 0;
    for (const s of sets) sum += cpuOf([resolve(progs[i])], s);
    times[i].push(sum / sets.length);
  }
  let n = 0;
  for (const s of sets) n += cpuOf(['-e', '0'], s);
  nul.push(n / sets.length);
}
const base = median(nul);
console.log(`null process: ${(base / 1000).toFixed(1)} ms`);
for (let i = 0; i < progs.length; i++) {
  const net = times[i].map((t) => t - base);
  console.log(`${progs[i]}: ${(trimmed(net) / 1000).toFixed(1)} ms net (min ${(Math.min(...net) / 1000).toFixed(1)})`);
}
