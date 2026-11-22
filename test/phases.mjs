// Where the time goes, phase by phase, in one fresh process (like one timed run):
//   node test/phases.mjs <set dir> [solve.js path]
import { readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { setFlagsFromString } from 'node:v8';

setFlagsFromString('--no-incremental-marking');
// Extra V8 flags to try at run time, as main.ts would set them: V8FLAGS="--a --b".
for (const f of (process.env.V8FLAGS ?? '').split(' ').filter(Boolean)) setFlagsFromString(f);
const solvePath = resolve(process.argv[3] ?? fileURLToPath(new URL('../solve.js', import.meta.url)));
const { run } = await import(pathToFileURL(solvePath).href);

const cpu = () => {
  const u = process.cpuUsage();
  return (u.user + u.system) / 1000;
};
let t = cpu();
const lap = (name) => {
  const now = cpu();
  console.log(`${name.padEnd(12)} ${(now - t).toFixed(1)} ms`);
  t = now;
};

const raw = readFileSync(join(process.argv[2], 'input/cases.json'), 'utf8');
lap('read');
const cases = JSON.parse(raw);
lap('JSON.parse');
const answers = [];
for (const c of cases) answers.push(run(c.input));
lap('run x6');
const s = JSON.stringify(answers);
lap('stringify');
const b = Buffer.from(s);
lap('utf8 encode');
console.log(`output ${b.length} bytes`);
